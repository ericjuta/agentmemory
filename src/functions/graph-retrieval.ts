import type {
  GraphNode,
  GraphEdge,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

export interface GraphRetrievalResult {
  obsId: string;
  sessionId: string;
  score: number;
  graphContext: string;
  pathLength: number;
}

type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  adjacency: Map<string, GraphEdge[]>;
};

type GraphSnapshotCacheEntry = {
  snapshot?: GraphSnapshot;
  expiresAt: number;
  loading: Promise<GraphSnapshot> | null;
};

const graphSnapshotCache = new WeakMap<StateKV, GraphSnapshotCacheEntry>();
const DEFAULT_GRAPH_SNAPSHOT_CACHE_TTL_MS = 30_000;
const DEFAULT_GRAPH_SNAPSHOT_STALE_TTL_MS = 2_000;

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function graphSnapshotCacheTtlMs(): number {
  return readNonNegativeIntegerEnv(
    "AGENTMEMORY_GRAPH_SNAPSHOT_CACHE_TTL_MS",
    DEFAULT_GRAPH_SNAPSHOT_CACHE_TTL_MS,
  );
}

function graphSnapshotStaleTtlMs(): number {
  return readNonNegativeIntegerEnv(
    "AGENTMEMORY_GRAPH_SNAPSHOT_STALE_TTL_MS",
    DEFAULT_GRAPH_SNAPSHOT_STALE_TTL_MS,
  );
}

function buildGraphSnapshot(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
): GraphSnapshot {
  const nodes = rawNodes.filter((n) => !n.stale);
  const edges = rawEdges.filter((e) => !e.stale);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.sourceNodeId)) {
      adjacency.set(edge.sourceNodeId, []);
    }
    adjacency.get(edge.sourceNodeId)!.push(edge);
    if (!adjacency.has(edge.targetNodeId)) {
      adjacency.set(edge.targetNodeId, []);
    }
    adjacency.get(edge.targetNodeId)!.push(edge);
  }
  return { nodes, edges, nodesById, adjacency };
}

function getCacheEntry(kv: StateKV): GraphSnapshotCacheEntry {
  let entry = graphSnapshotCache.get(kv);
  if (!entry) {
    entry = { expiresAt: 0, loading: null };
    graphSnapshotCache.set(kv, entry);
  }
  return entry;
}

export function invalidateGraphSnapshotCache(kv: StateKV): void {
  const deleted = graphSnapshotCache.delete(kv);
  if (deleted) {
    logger.debug("Graph snapshot cache invalidated", { cacheKey: "graph" });
  }
}

async function loadFreshSnapshotFromKV(
  kv: StateKV,
): Promise<GraphSnapshot> {
  const [rawNodes, rawEdges] = await Promise.all([
    kv.list<GraphNode>(KV.graphNodes),
    kv.list<GraphEdge>(KV.graphEdges),
  ]);
  return buildGraphSnapshot(rawNodes, rawEdges);
}

async function loadGraphSnapshot(kv: StateKV): Promise<GraphSnapshot> {
  const ttlMs = graphSnapshotCacheTtlMs();
  if (ttlMs <= 0) {
    return loadFreshSnapshotFromKV(kv);
  }

  const now = Date.now();
  const entry = getCacheEntry(kv);

  if (entry.snapshot && entry.expiresAt > now && !entry.loading) {
    return entry.snapshot;
  }

  if (!entry.loading) {
    const staleSnapshot = entry.snapshot;
    entry.loading = (async () => {
      const snapshot = await loadFreshSnapshotFromKV(kv);
      entry.snapshot = snapshot;
      entry.expiresAt = Date.now() + ttlMs;
      return snapshot;
    })().catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("Graph snapshot refresh failed; using cached snapshot", {
        error: msg,
        hadSnapshot: Boolean(staleSnapshot),
      });
      if (staleSnapshot) {
        entry.expiresAt = Date.now() + graphSnapshotStaleTtlMs();
        return staleSnapshot;
      }
      throw error;
    }).finally(() => {
      entry.loading = null;
    });
  }

  return entry.loading!;
}

function buildGraphContext(
  path: Array<{ node: GraphNode; edge?: GraphEdge }>,
): string {
  const parts: string[] = [];
  for (const step of path) {
    const props = Object.entries(step.node.properties)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    let line = `[${step.node.type}] ${step.node.name}`;
    if (props) line += ` (${props})`;
    if (step.edge) {
      line += ` --${step.edge.type}-->`;
      if (step.edge.context?.reasoning) {
        line += ` [${step.edge.context.reasoning}]`;
      }
      if (step.edge.tvalid) {
        line += ` @${step.edge.tvalid}`;
      }
    }
    parts.push(line);
  }
  return parts.join(" ");
}

export class GraphRetrieval {
  constructor(private kv: StateKV) {}

  private async loadSnapshot(): Promise<GraphSnapshot> {
    return loadGraphSnapshot(this.kv);
  }

  async searchByEntities(
    entityNames: string[],
    maxDepth = 2,
    maxResults = 20,
  ): Promise<GraphRetrievalResult[]> {
    const snapshot = await this.loadSnapshot();

    const matchingNodes = snapshot.nodes.filter((n) => {
      const nameLower = n.name.toLowerCase();
      return entityNames.some(
        (e) =>
          nameLower.includes(e.toLowerCase()) ||
          e.toLowerCase().includes(nameLower),
      );
    });

    if (matchingNodes.length === 0) return [];

    const results: GraphRetrievalResult[] = [];
    const visitedObs = new Set<string>();

    for (const startNode of matchingNodes) {
      const paths = this.bfsTraversal(
        startNode,
        snapshot,
        maxDepth,
      );

      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        for (const obsId of lastNode.sourceObservationIds) {
          if (visitedObs.has(obsId)) continue;
          visitedObs.add(obsId);

          const pathLength = path.length;
          const edgeWeights = path
            .filter((s) => s.edge)
            .map((s) => s.edge!.weight);
          const avgWeight =
            edgeWeights.length > 0
              ? edgeWeights.reduce((a, b) => a + b, 0) / edgeWeights.length
              : 0.5;
          const score = avgWeight * (1 / pathLength);

          results.push({
            obsId,
            sessionId: "",
            score,
            graphContext: buildGraphContext(path),
            pathLength,
          });
        }
      }

      for (const obsId of startNode.sourceObservationIds) {
        if (visitedObs.has(obsId)) continue;
        visitedObs.add(obsId);
        results.push({
          obsId,
          sessionId: "",
          score: 1.0,
          graphContext: `[${startNode.type}] ${startNode.name}`,
          pathLength: 0,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async expandFromChunks(
    obsIds: string[],
    maxDepth = 1,
    maxResults = 10,
  ): Promise<GraphRetrievalResult[]> {
    const snapshot = await this.loadSnapshot();

    const linkedNodes = snapshot.nodes.filter((n) =>
      n.sourceObservationIds.some((id) => obsIds.includes(id)),
    );

    const results: GraphRetrievalResult[] = [];
    const visitedObs = new Set<string>(obsIds);

    for (const node of linkedNodes) {
      const paths = this.bfsTraversal(node, snapshot, maxDepth);
      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        for (const obsId of lastNode.sourceObservationIds) {
          if (visitedObs.has(obsId)) continue;
          visitedObs.add(obsId);

          const pathLength = path.length;
          const score = 0.5 * (1 / (pathLength + 1));

          results.push({
            obsId,
            sessionId: "",
            score,
            graphContext: buildGraphContext(path),
            pathLength,
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async temporalQuery(
    entityName: string,
    asOf?: string,
  ): Promise<{
    entity: GraphNode | null;
    currentState: GraphEdge[];
    history: GraphEdge[];
  }> {
    const snapshot = await this.loadSnapshot();

    const entity = snapshot.nodes.find(
      (n) => n.name.toLowerCase() === entityName.toLowerCase(),
    );
    if (!entity) return { entity: null, currentState: [], history: [] };

    const relatedEdges = snapshot.edges.filter(
      (e) => e.sourceNodeId === entity.id || e.targetNodeId === entity.id,
    );

    if (!asOf) {
      const latestEdges = this.getLatestEdges(relatedEdges);
      const historicalEdges = relatedEdges.filter(
        (e) => !latestEdges.some((le) => le.id === e.id),
      );
      return { entity, currentState: latestEdges, history: historicalEdges };
    }

    const asOfDate = new Date(asOf).getTime();
    const validEdges = relatedEdges.filter((e) => {
      const commitDate = new Date(e.tcommit || e.createdAt).getTime();
      if (commitDate > asOfDate) return false;
      if (e.tvalid) {
        const validDate = new Date(e.tvalid).getTime();
        if (validDate > asOfDate) return false;
      }
      if (e.tvalidEnd) {
        const endDate = new Date(e.tvalidEnd).getTime();
        if (endDate < asOfDate) return false;
      }
      return true;
    });

    return {
      entity,
      currentState: this.getLatestEdges(validEdges),
      history: validEdges,
    };
  }

  private getLatestEdges(edges: GraphEdge[]): GraphEdge[] {
    const byKey = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = `${e.sourceNodeId}|${e.targetNodeId}|${e.type}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(e);
    }

    const latest: GraphEdge[] = [];
    for (const group of byKey.values()) {
      if (group.length === 0) continue;
      group.sort(
        (a, b) =>
          new Date(b.tcommit || b.createdAt).getTime() -
          new Date(a.tcommit || a.createdAt).getTime(),
      );
      const newest = group.find((e) => e.isLatest !== false) || group[0];
      latest.push(newest);
    }
    return latest;
  }

  private bfsTraversal(
    startNode: GraphNode,
    snapshot: GraphSnapshot,
    maxDepth: number,
  ): Array<Array<{ node: GraphNode; edge?: GraphEdge }>> {
    const paths: Array<Array<{ node: GraphNode; edge?: GraphEdge }>> = [];
    const visited = new Set<string>();
    const queue: Array<{
      nodeId: string;
      depth: number;
      path: Array<{ node: GraphNode; edge?: GraphEdge }>;
    }> = [{ nodeId: startNode.id, depth: 0, path: [{ node: startNode }] }];

    visited.add(startNode.id);

    while (queue.length > 0) {
      const { nodeId, depth, path } = queue.shift()!;
      paths.push(path);

      if (depth >= maxDepth) continue;

      const neighborEdges = snapshot.adjacency.get(nodeId) || [];

      for (const edge of neighborEdges) {
        const nextId =
          edge.sourceNodeId === nodeId
            ? edge.targetNodeId
            : edge.sourceNodeId;
        if (visited.has(nextId)) continue;
        visited.add(nextId);

        const nextNode = snapshot.nodesById.get(nextId);
        if (!nextNode) continue;

        queue.push({
          nodeId: nextId,
          depth: depth + 1,
          path: [...path, { node: nextNode, edge }],
        });
      }
    }

    return paths;
  }
}
