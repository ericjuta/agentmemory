import type { ISdk } from "iii-sdk";
import type {
  CompactSearchResult,
  CompressedObservation,
  RetrievalBlock,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { deferRecordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";
import { loadScopedRetrievalBlocks } from "./retrieval-block-scope-index.js";

type SmartSearchExpandId =
  | string
  | { obsId?: string; blockId?: string; sessionId?: string };

type SmartSearchInput = {
  query?: string;
  expandIds?: SmartSearchExpandId[];
  limit?: number;
  project?: string;
  cwd?: string;
  branch?: string;
  global?: boolean;
  trace?: boolean;
  scope_required?: boolean;
  scopeRequired?: boolean;
};

type SmartSearchScope = {
  project?: string;
  branch?: string;
};

function parseOptionalString(
  data: Record<string, unknown>,
  field: string,
): { value?: string; error?: string } {
  const raw = data[field];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return { error: `${field} must be a string` };
  const value = raw.trim();
  return value ? { value } : {};
}

function parseOptionalBoolean(
  data: Record<string, unknown>,
  field: string,
): { value?: boolean; error?: string } {
  const raw = data[field];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "boolean") return { error: `${field} must be a boolean` };
  return { value: raw };
}

function normalizeScope(data: Record<string, unknown>): {
  scope?: SmartSearchScope;
  error?: string;
} {
  const project = parseOptionalString(data, "project");
  if (project.error) return { error: project.error };
  const cwd = parseOptionalString(data, "cwd");
  if (cwd.error) return { error: cwd.error };
  const branch = parseOptionalString(data, "branch");
  if (branch.error) return { error: branch.error };
  const global = parseOptionalBoolean(data, "global");
  if (global.error) return { error: global.error };
  const scopeRequiredSnake = parseOptionalBoolean(data, "scope_required");
  if (scopeRequiredSnake.error) return { error: scopeRequiredSnake.error };
  const scopeRequiredCamel = parseOptionalBoolean(data, "scopeRequired");
  if (scopeRequiredCamel.error) return { error: scopeRequiredCamel.error };

  const isGlobalScope = global.value === true;
  const scopedProject = isGlobalScope ? "global" : project.value || cwd.value;
  if (!scopedProject) {
    return { error: "scope is required: provide project, cwd, or global" };
  }
  return {
    scope: {
      ...(scopedProject ? { project: scopedProject } : {}),
      ...(branch.value ? { branch: branch.value } : {}),
    },
  };
}

function projectMatchesScope(block: RetrievalBlock, project?: string): boolean {
  if (!project) return true;
  if (block.project === project) return true;
  if (block.project !== "global") return false;
  return (
    block.sourceType !== "semantic_memory" &&
    block.sourceType !== "procedural_memory"
  );
}

function branchMatchesScope(block: RetrievalBlock, branch?: string): boolean {
  if (!branch) return !block.branch;
  return !block.branch || block.branch === branch;
}

function toCompact(block: RetrievalBlock, score: number): CompactSearchResult {
  const legacyId = block.sourceType === "observation" ? block.sourceId : block.id;
  return {
    obsId: legacyId,
    blockId: block.id,
    sessionId: block.sessionId || "",
    title: block.title,
    type: block.sourceType,
    score,
    timestamp: block.eventAt,
    sourceType: block.sourceType,
    sourceId: block.sourceId,
  };
}

async function loadExpandableBlockById(
  kv: StateKV,
  id: string,
  scope: SmartSearchScope,
): Promise<RetrievalBlock | null> {
  const direct = await kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null);
  if (direct) return direct;
  const scopedBlocks = await loadScopedRetrievalBlocks(kv, {
    project: scope.project,
    branch: scope.branch,
  }).catch(() => ({ blocks: [] as RetrievalBlock[] }));
  return scopedBlocks.blocks.find((candidate) => candidate.sourceId === id) || null;
}

export function registerSmartSearchFunction(
  sdk: ISdk,
  kv: StateKV,
  _legacySearchFn?: (query: string, limit: number) => Promise<unknown>,
): void {
  sdk.registerFunction(
    "mem::smart-search",
    async (data: SmartSearchInput) => {
      const input = (data || {}) as SmartSearchInput;
      const scopeResult = normalizeScope(input as Record<string, unknown>);
      if (scopeResult.error) {
        return { mode: "compact", results: [], error: scopeResult.error };
      }
      const scope = scopeResult.scope || {};
      if (input.trace !== undefined && typeof input.trace !== "boolean") {
        return { mode: "compact", results: [], error: "trace must be a boolean" };
      }

      if (input.expandIds !== undefined && !Array.isArray(input.expandIds)) {
        return { mode: "compact", results: [], error: "expandIds must be an array" };
      }

      if (input.expandIds && input.expandIds.length > 0) {
        const requested = input.expandIds.slice(0, 20).map((entry) => {
          if (typeof entry === "string") return { id: entry, sessionId: undefined as string | undefined };
          if (entry?.blockId) return { id: entry.blockId, sessionId: entry.sessionId };
          if (entry?.obsId) return { id: entry.obsId, sessionId: entry.sessionId };
          return null;
        }).filter((item): item is NonNullable<typeof item> => item !== null);
        const expanded = await Promise.all(
          requested.map(async ({ id, sessionId }) => {
            const block = await loadExpandableBlockById(kv, id, scope);
            if (!block) return null;
            if (
              !projectMatchesScope(block, scope.project) ||
              !branchMatchesScope(block, scope.branch)
            ) {
              return null;
            }
            const observation =
              block.sourceType === "observation" && (block.sessionId || sessionId)
                ? await kv
                    .get<CompressedObservation>(
                      KV.observations(block.sessionId || sessionId!),
                      block.sourceId,
                    )
                    .catch(() => null)
                : null;
            return {
              obsId: id,
              blockId: block.id,
              sessionId: block.sessionId || sessionId || "",
              block,
              observation,
            };
          }),
        );
        const results = expanded.filter((item): item is NonNullable<typeof item> => item !== null);

        deferRecordAccessBatch(
          kv,
          results.map((item) =>
            item.block.sourceType === "observation"
              ? item.block.sourceId
              : item.block.id,
          ),
        );

        const truncated = input.expandIds.length > requested.length;
        logger.info("Smart search expanded", {
          requested: input.expandIds.length,
          attempted: requested.length,
          returned: results.length,
          truncated,
        });
        return { mode: "expanded", results, truncated };
      }

      if (!input.query || typeof input.query !== "string" || !input.query.trim()) {
        return { mode: "compact", results: [], error: "query is required" };
      }

      if (
        input.limit !== undefined &&
        (typeof input.limit !== "number" ||
          !Number.isInteger(input.limit) ||
          input.limit <= 0)
      ) {
        return { mode: "compact", results: [], error: "limit must be a positive integer" };
      }
      const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
      const retrieval = await retrieveRelevantBlocks(kv, {
        project: scope.project,
        branch: scope.branch,
        query: input.query,
        budget: limit * 300,
        purpose: "smart-search",
        maxBlocks: Math.max(limit * 4, 20),
      });

      const compact = retrieval.searchResults
        .slice(0, limit)
        .map((item) => toCompact(item.block, item.score));

      deferRecordAccessBatch(
        kv,
        retrieval.searchResults
          .slice(0, limit)
          .map((item) =>
            item.block.sourceType === "observation"
              ? item.block.sourceId
              : item.block.id,
          ),
      );

      logger.info("Smart search compact", {
        query: input.query,
        results: compact.length,
      });
      return {
        mode: "compact",
        results: compact,
        ...(input.trace === true ? { trace: retrieval.trace } : {}),
      };
    },
  );
}
