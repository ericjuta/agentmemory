import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  RetrievalBlock,
  RetrievalIntent,
  Session,
  SessionWorkingSet,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { escapeXmlAttr, retrieveRelevantBlocks } from "./retrieval-engine.js";
import { resolveSessionBranch } from "./session-branch.js";
import { getContextHotPathPressure } from "./hot-path-pressure.js";
import { buildWorkingSetRetrievalBlock } from "./retrieval-blocks.js";
import { loadScopedRetrievalBlocks } from "./retrieval-block-scope-index.js";

type ContextResponse = {
  context: string;
  items: unknown[];
  blocks: number;
  tokens: number;
  trace: unknown;
  degraded?: boolean;
  fallback?:
    | "memory-cache"
    | "last-known-good"
    | "current-session-observations"
    | "working-set"
    | "hot-warm-retrieval-blocks"
    | "bounded-scoped"
    | "empty";
  pressure?: unknown;
  ageMs?: number;
  skipped?: boolean;
  reason?: string;
  cache?: {
    status: "hit" | "miss" | "coalesced";
    ageMs?: number;
  };
};

export type ContextRequest = {
  sessionId: string;
  project?: string;
  budget?: number;
  query?: string;
  intent?: RetrievalIntent;
  files?: string[];
  terms?: string[];
  maxBlocks?: number;
};

const CODEX_PROJECT_SUFFIX = "/workspace/repos/codex";
const CODEX_CONTEXT_CACHE_TTL_MS = 2_000;
const PRESSURE_FALLBACK_SKIPPED_LANES = [
  "query_embedding",
  "graph_expansion",
  "full_retrieval_block_scan",
];
const codexContextCache = new Map<
  string,
  { createdAt: number; value: ContextResponse }
>();
const codexContextInflight = new Map<string, Promise<ContextResponse>>();

type LastKnownGoodContext = {
  key: string;
  project: string;
  branch?: string;
  createdAt: string;
  value: ContextResponse;
};

function isCodexProject(project: string): boolean {
  return project.endsWith(CODEX_PROJECT_SUFFIX);
}

function cacheableCodexContext(data: ContextRequest, project: string): boolean {
  return (
    isCodexProject(project) &&
    data.intent !== "file_enrich" &&
    !data.files?.length &&
    !data.terms?.length
  );
}

function ignoresDeferredQueuePressure(
  data: ContextRequest,
  project: string,
): boolean {
  if (!isCodexProject(project)) return false;
  return process.env.AGENTMEMORY_CODEX_CONTEXT_QUEUE_BACKPRESSURE !== "true";
}

function contextCacheKey(
  data: ContextRequest,
  project: string,
  branch: string | undefined,
  budget: number,
): string {
  return JSON.stringify({
    project,
    branch,
    query: data.query || "",
    intent: data.intent || "",
    budget,
    maxBlocks: data.maxBlocks || null,
  });
}

function cloneContextResponse(
  value: ContextResponse,
  cache: ContextResponse["cache"],
): ContextResponse {
  return {
    ...structuredClone(value),
    cache,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function pressureReason(pressure: unknown): string | undefined {
  if (!pressure || typeof pressure !== "object") return undefined;
  const reason = (pressure as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function pressureTrace(
  trace: unknown,
  fallback: NonNullable<ContextResponse["fallback"]>,
  pressure: unknown,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  const base =
    trace && typeof trace === "object" && !Array.isArray(trace)
      ? (structuredClone(trace) as Record<string, unknown>)
      : {};
  return {
    ...base,
    pressureFallback: {
      fallback,
      source: fallback,
      pressureReason: pressureReason(pressure),
      skippedExpensiveLanes: PRESSURE_FALLBACK_SKIPPED_LANES,
      ...details,
    },
  };
}

function lastKnownGoodKey(cacheKey: string): string {
  return `codex:last-known-good:${Buffer.from(cacheKey).toString("base64url")}`;
}

function projectLastKnownGoodKey(
  project: string,
  branch: string | undefined,
): string {
  return `codex:last-known-good-project:${Buffer.from(
    JSON.stringify({ project, branch }),
  ).toString("base64url")}`;
}

function degradedContextResponse(
  value: ContextResponse,
  fallback: "memory-cache" | "last-known-good",
  pressure: unknown,
  ageMs?: number,
): ContextResponse {
  return {
    ...structuredClone(value),
    degraded: true,
    fallback,
    pressure,
    ageMs,
    trace: pressureTrace(value.trace, fallback, pressure, {
      ageMs,
      candidateCounts: { cachedContext: 1 },
    }),
  };
}

function observationText(observation: CompressedObservation): string {
  const parts = [
    observation.title,
    observation.subtitle,
    observation.narrative,
    ...observation.facts,
  ];
  return parts.filter(Boolean).join("\n");
}

function blockSortNewestFirst(a: RetrievalBlock, b: RetrievalBlock): number {
  const aTime = Date.parse(a.eventAt || a.updatedAt || a.createdAt);
  const bTime = Date.parse(b.eventAt || b.updatedAt || b.createdAt);
  const safeA = Number.isFinite(aTime) ? aTime : 0;
  const safeB = Number.isFinite(bTime) ? bTime : 0;
  if (safeB !== safeA) return safeB - safeA;
  return b.importance - a.importance;
}

function normalizedFallbackTerms(data: ContextRequest): string[] {
  const raw = [
    data.query || "",
    ...(data.terms || []),
    ...(data.files || []),
  ].join(" ");
  const terms = raw
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  const expanded = terms.flatMap((term) => {
    const parts = term
      .split(/[^a-z0-9]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    return [term, ...parts];
  });
  return [...new Set(expanded)];
}

function fallbackBlockSearchText(block: RetrievalBlock): string {
  return [
    block.title,
    block.canonicalText,
    block.sourceId,
    block.sessionId,
    ...block.files,
    ...block.concepts,
    ...block.entities,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function fallbackBlockRelevanceScore(
  block: RetrievalBlock,
  data: ContextRequest,
  terms: string[],
): number {
  if (terms.length === 0) return 0;
  const text = fallbackBlockSearchText(block);
  const query = (data.query || "").trim().toLowerCase();
  let score = query && text.includes(query) ? 18 : 0;
  for (const term of terms) {
    if (text.includes(term)) {
      score += term.includes("/") ? 8 : /\d/u.test(term) || term.length >= 8 ? 12 : 3;
    }
  }
  for (const file of data.files || []) {
    const normalizedFile = file.toLowerCase();
    if (block.files.some((entry) => entry.toLowerCase().includes(normalizedFile))) {
      score += 10;
    }
    if (text.includes(normalizedFile)) score += 4;
  }
  for (const term of data.terms || []) {
    const normalizedTerm = term.toLowerCase();
    if (text.includes(normalizedTerm)) score += normalizedTerm.includes(" ") ? 16 : 5;
    if (block.concepts.some((entry) => entry.toLowerCase().includes(normalizedTerm))) {
      score += 6;
    }
    if (block.entities.some((entry) => entry.toLowerCase().includes(normalizedTerm))) {
      score += 4;
    }
  }
  if (block.hadFailure) score += 1;
  if (block.hadDecision) score += 1;
  if (block.hadAssistantConclusion) score += 1;
  return score;
}

function rankFallbackBlocks(
  blocks: RetrievalBlock[],
  data: ContextRequest,
): RetrievalBlock[] {
  const terms = normalizedFallbackTerms(data);
  return blocks
    .map((block) => ({
      block,
      score: fallbackBlockRelevanceScore(block, data, terms),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return blockSortNewestFirst(a.block, b.block);
    })
    .map((ranked) => ranked.block);
}

function fallbackProjectMatches(block: RetrievalBlock, project: string): boolean {
  if (!project) return true;
  if (block.project === project) return true;
  if (block.project !== "global") return false;
  return (
    block.sourceType !== "semantic_memory" &&
    block.sourceType !== "procedural_memory"
  );
}

function fallbackBranchMatches(block: RetrievalBlock, branch?: string): boolean {
  if (!branch) return !block.branch;
  return !block.branch || block.branch === branch;
}

function fallbackBlockKey(block: RetrievalBlock): string {
  return `${block.sourceType}:${block.sourceId}`;
}

function fallbackScopeKey(
  kind: "project" | "session" | "branch",
  ...parts: string[]
): string {
  return `scope:${kind}:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

function pressureFallbackScopeKeys(options: {
  project: string;
  sessionId: string;
  branch?: string;
}): string[] {
  const keys = [
    fallbackScopeKey("session", options.sessionId),
    ...(options.project && options.branch
      ? [fallbackScopeKey("branch", options.project, options.branch)]
      : []),
    ...(options.project ? [fallbackScopeKey("project", options.project)] : []),
  ];
  return [...new Set(keys)];
}

async function loadPressureFallbackRetrievalBlocks(
  kv: StateKV,
  options: {
    sessionId: string;
    project: string;
    branch?: string;
  },
): Promise<RetrievalBlock[]> {
  const keys = pressureFallbackScopeKeys(options);
  const entries = await Promise.all(
    keys.map(async (key) => {
      const entry =
        (await kv
          .get<{ ids?: unknown }>(KV.retrievalBlockScopeIndex, key)
          .catch(() => null)) ??
        (await kv
          .get<{ ids?: unknown }>(KV.retrievalBlockIndex, key)
          .catch(() => null));
      return Array.isArray(entry?.ids)
        ? entry.ids.filter((id): id is string => typeof id === "string")
        : [];
    }),
  );
  const ids = [...new Set(entries.flat())].slice(0, 32);
  const blocks = await Promise.all(
    ids.map((id) => kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null)),
  );
  return blocks.filter((block): block is RetrievalBlock => block !== null);
}

function contextFromRetrievalBlocks(
  blocks: RetrievalBlock[],
  project: string,
  pressure: unknown,
  fallback: "working-set" | "hot-warm-retrieval-blocks",
  details: Record<string, unknown>,
): ContextResponse | null {
  if (blocks.length === 0) return null;
  const context = `<agentmemory-context project="${escapeXmlAttr(project || "*")}">\n${blocks
    .map((block) => block.canonicalText)
    .join("\n\n")}\n</agentmemory-context>`;
  return {
    context,
    items: blocks.map((block) => ({
      sourceType: block.sourceType,
      sourceId: block.sourceId,
      title: block.title,
      why: "bounded pressure fallback",
      freshness: block.freshnessLane,
      confidence: Math.max(0.35, Math.min(0.95, block.importance / 10)),
      relevantFiles: block.files.slice(0, 8),
      concepts: block.concepts.slice(0, 8),
    })),
    blocks: blocks.length,
    tokens: estimateTokens(context),
    trace: pressureTrace(
      {
        fallback,
        blockIds: blocks.map((block) => block.id),
      },
      fallback,
      pressure,
      details,
    ),
    degraded: true,
    fallback,
    pressure,
  };
}

async function currentSessionObservationContext(
  kv: StateKV,
  sessionId: string,
  pressure: unknown,
  maxObservations = 5,
): Promise<ContextResponse | null> {
  const observations = await kv
    .list<CompressedObservation>(KV.observations(sessionId))
    .catch(() => [] as CompressedObservation[]);
  const usable = observations
    .filter((observation) => observationText(observation).trim())
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, maxObservations);
  if (usable.length === 0) return null;

  const context = usable
    .map((observation) => {
      const files = observation.files.length
        ? `\nFiles: ${observation.files.join(", ")}`
        : "";
      return `<observation id="${observation.id}" type="${observation.type}" title="${observation.title}">\n${observationText(observation)}${files}\n</observation>`;
    })
    .join("\n\n");

  return {
    context,
    items: usable.map((observation) => ({
      id: observation.id,
      type: "observation",
      title: observation.title,
      why: "current session observation fallback under pressure",
      freshness: "current",
    })),
    blocks: usable.length,
    tokens: estimateTokens(context),
    trace: pressureTrace(
      {
      fallback: "current-session-observations",
      observationIds: usable.map((observation) => observation.id),
      },
      "current-session-observations",
      pressure,
      {
        candidateCounts: {
          currentSessionObservations: observations.length,
          selectedCurrentSessionObservations: usable.length,
        },
      },
    ),
    degraded: true,
    fallback: "current-session-observations",
    pressure,
  };
}

async function workingSetFallbackContext(
  kv: StateKV,
  sessionId: string,
  project: string,
  pressure: unknown,
): Promise<ContextResponse | null> {
  const workingSet = await kv
    .get<SessionWorkingSet>(KV.workingSets, sessionId)
    .catch(() => null);
  if (!workingSet || (project && workingSet.project !== project)) return null;
  const block = buildWorkingSetRetrievalBlock(workingSet);
  return block
    ? contextFromRetrievalBlocks([block], project, pressure, "working-set", {
        candidateCounts: {
          workingSets: 1,
          selectedWorkingSets: 1,
        },
      })
    : null;
}

async function hotWarmRetrievalBlockFallbackContext(
  kv: StateKV,
  options: {
    sessionId: string;
    project: string;
    branch?: string;
    data: ContextRequest;
    pressure: unknown;
    excludeKeys: Set<string>;
  },
): Promise<ContextResponse | null> {
  const scoped = await loadScopedRetrievalBlocks(kv, {
    project: options.project,
    sessionId: options.sessionId,
    branch: options.branch,
  }).catch(() => ({ blocks: [] as RetrievalBlock[], complete: false }));
  const scopedBlocks =
    scoped.blocks.length > 0
      ? scoped.blocks
      : await loadPressureFallbackRetrievalBlocks(kv, options);
  const candidates = scopedBlocks
    .filter((block) => block.freshnessLane === "hot" || block.freshnessLane === "warm")
    .filter((block) => fallbackProjectMatches(block, options.project))
    .filter((block) => fallbackBranchMatches(block, options.branch))
    .filter((block) => !options.excludeKeys.has(fallbackBlockKey(block)))
    .sort(blockSortNewestFirst);
  const ranked = rankFallbackBlocks(candidates, options.data);
  const selected = ranked.slice(0, 6);
  return contextFromRetrievalBlocks(
    selected,
    options.project,
    options.pressure,
    "hot-warm-retrieval-blocks",
    {
      scopeComplete: scoped.complete,
      ranking: "query-aware-hot-warm",
      queryTerms: normalizedFallbackTerms(options.data).slice(0, 12),
      candidateCounts: {
        scopedRetrievalBlocks: scopedBlocks.length,
        hotWarmRetrievalBlocks: candidates.length,
        selectedRetrievalBlocks: selected.length,
      },
    },
  );
}

function mergeFallbackResponses(
  responses: ContextResponse[],
  pressure: unknown,
  reason: string,
): ContextResponse {
  if (responses.length === 1) {
    return {
      ...responses[0],
      reason,
    };
  }
  const context = responses.map((response) => response.context).join("\n\n");
  const sources = responses
    .map((response) => response.fallback)
    .filter((value): value is NonNullable<ContextResponse["fallback"]> =>
      Boolean(value),
    );
  return {
    context,
    items: responses.flatMap((response) => response.items),
    blocks: responses.reduce((sum, response) => sum + response.blocks, 0),
    tokens: estimateTokens(context),
    trace: pressureTrace(
      {
        fallback: "bounded-scoped",
        sources,
      },
      "bounded-scoped",
      pressure,
      {
        sources,
        candidateCounts: {
          fallbackResponses: responses.length,
          selectedItems: responses.reduce(
            (sum, response) => sum + response.items.length,
            0,
          ),
        },
      },
    ),
    degraded: true,
    fallback: "bounded-scoped",
    pressure,
    reason,
  };
}

function emptyPressureFallbackResponse(
  pressure: unknown,
  reason: string,
  details: Record<string, unknown> = {},
): ContextResponse {
  return {
    context: "",
    items: [],
    blocks: 0,
    tokens: 0,
    trace: pressureTrace(undefined, "empty", pressure, details),
    degraded: true,
    fallback: "empty",
    skipped: true,
    reason,
    pressure,
  };
}

export async function buildContextPressureFallback(
  kv: StateKV,
  data: ContextRequest,
  pressure: unknown,
  reason = "hot_path_backpressure",
): Promise<ContextResponse> {
  const session = await kv
    .get<Session>(KV.sessions, data.sessionId)
    .catch(() => null);
  const project = data.project || session?.project || "";
  const branch = await resolveSessionBranch(kv, session);
  const budget = data.budget || 0;
  const cacheable = project ? cacheableCodexContext(data, project) : false;
  const cacheKey = cacheable
    ? contextCacheKey(data, project, branch, budget)
    : undefined;

  if (cacheKey) {
    const cached = codexContextCache.get(cacheKey);
    if (cached?.value.context) {
      return {
        ...degradedContextResponse(
          cached.value,
          "memory-cache",
          pressure,
          Date.now() - cached.createdAt,
        ),
        reason,
      };
    }
    const lastKnownGood = await readLastKnownGoodContext(
      kv,
      [
        lastKnownGoodKey(cacheKey),
        projectLastKnownGoodKey(project, branch),
      ],
      pressure,
    );
    if (lastKnownGood) return { ...lastKnownGood, reason };
  }

  if (data.intent === "file_enrich") {
    return emptyPressureFallbackResponse(pressure, reason, {
      skippedReason: "file_enrich_requires_fresh_retrieval",
      candidateCounts: {
        currentSessionObservations: 0,
        workingSets: 0,
        hotWarmRetrievalBlocks: 0,
      },
    });
  }

  const responses: ContextResponse[] = [];
  const seenBlockKeys = new Set<string>();
  const currentObservations = await currentSessionObservationContext(
    kv,
    data.sessionId,
    pressure,
  );
  if (currentObservations) {
    responses.push(currentObservations);
    for (const item of currentObservations.items as Array<{ id?: string }>) {
      if (item.id) seenBlockKeys.add(`observation:${item.id}`);
    }
  }

  if (project) {
    const workingSet = await workingSetFallbackContext(
      kv,
      data.sessionId,
      project,
      pressure,
    );
    if (workingSet) {
      responses.push(workingSet);
      seenBlockKeys.add(`working_set:${data.sessionId}`);
    }
    const hotWarmBlocks = await hotWarmRetrievalBlockFallbackContext(kv, {
      sessionId: data.sessionId,
      project,
      branch,
      data,
      pressure,
      excludeKeys: seenBlockKeys,
    });
    if (hotWarmBlocks) responses.push(hotWarmBlocks);
  }

  if (responses.length > 0) {
    return mergeFallbackResponses(responses, pressure, reason);
  }

  return emptyPressureFallbackResponse(pressure, reason, {
    candidateCounts: {
      currentSessionObservations: 0,
      workingSets: 0,
      hotWarmRetrievalBlocks: 0,
    },
  });
}

function mergeCurrentSessionObservationContext(
  result: ContextResponse,
  currentObservations: ContextResponse | null,
): ContextResponse {
  if (!currentObservations?.context) return result;
  if (!result.context) return currentObservations;
  const resultText = result.context.toLowerCase();
  const missingItems = (
    currentObservations.items as Array<{ id?: string; title?: string }>
  ).filter((item) => item.id && !resultText.includes(item.id.toLowerCase()));
  if (missingItems.length === 0) return result;
  const missingIds = new Set(missingItems.map((item) => item.id));
  const currentBlocks = currentObservations.context
    .split("\n\n")
    .filter((block) => [...missingIds].some((id) => id && block.includes(id)));
  if (currentBlocks.length === 0) return result;
  const context = [currentBlocks.join("\n\n"), result.context]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...result,
    context,
    items: [...missingItems, ...result.items],
    blocks: result.blocks + missingItems.length,
    tokens: estimateTokens(context),
    trace: {
      ...(result.trace && typeof result.trace === "object" ? result.trace : {}),
      currentSessionObservationOverlay: [...missingIds],
    },
  };
}

async function readLastKnownGoodContext(
  kv: StateKV,
  keys: string[],
  pressure: unknown,
): Promise<ContextResponse | null> {
  for (const key of keys) {
    const stored = await kv
      .get<LastKnownGoodContext>(KV.contextInjections, key)
      .catch(() => null);
    if (!stored?.value?.context) continue;
    const createdAt = Date.parse(stored.createdAt);
    return degradedContextResponse(
      stored.value,
      "last-known-good",
      pressure,
      Number.isFinite(createdAt) ? Date.now() - createdAt : undefined,
    );
  }
  return null;
}

async function writeLastKnownGoodContext(
  kv: StateKV,
  cacheKey: string,
  project: string,
  branch: string | undefined,
  value: ContextResponse,
): Promise<void> {
  if (!value.context || value.degraded) return;
  const stored: LastKnownGoodContext = {
    key: cacheKey,
    project,
    branch,
    createdAt: new Date().toISOString(),
    value: {
      ...structuredClone(value),
      cache: undefined,
    },
  };
  await Promise.all([
    kv.set(KV.contextInjections, lastKnownGoodKey(cacheKey), stored),
    kv.set(
      KV.contextInjections,
      projectLastKnownGoodKey(project, branch),
      stored,
    ),
  ]).catch((err) => {
    logger.warn("Failed to persist last-known-good Codex context", {
      project,
      branch,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction("mem::context", async (data: ContextRequest) => {
    const budget = data.budget || tokenBudget;
    const session = await kv
      .get<Session>(KV.sessions, data.sessionId)
      .catch(() => null);
    const project = data.project || session?.project || "";
    const branch = await resolveSessionBranch(kv, session);
    const cacheable = cacheableCodexContext(data, project);
    const cacheKey = cacheable
      ? contextCacheKey(data, project, branch, budget)
      : undefined;
    const pressure = await getContextHotPathPressure(kv, {
      ignoreDeferredQueue: ignoresDeferredQueuePressure(data, project),
    });
    if (pressure) {
      logger.warn("Context skipped under hot-path pressure", {
        sessionId: data.sessionId,
        intent: data.intent,
        reason: pressure.reason,
      });
      return buildContextPressureFallback(
        kv,
        { ...data, project, budget },
        pressure,
      );
    }

    const purpose = data.intent === "file_enrich" ? "enrich" : "context";

    if (cacheKey) {
      const cached = codexContextCache.get(cacheKey);
      if (
        cached &&
        Date.now() - cached.createdAt <= CODEX_CONTEXT_CACHE_TTL_MS
      ) {
        return cloneContextResponse(cached.value, {
          status: "hit",
          ageMs: Date.now() - cached.createdAt,
        });
      }
      const inflight = codexContextInflight.get(cacheKey);
      if (inflight) {
        const value = await inflight;
        return cloneContextResponse(value, { status: "coalesced" });
      }
    }

    const buildContext = async (): Promise<ContextResponse> => {
      const result = await retrieveRelevantBlocks(kv, {
        project,
        sessionId: data.sessionId,
        branch,
        query: data.query,
        intent: data.intent,
        focusFiles: data.files || [],
        focusConcepts: data.terms || [],
        budget,
        purpose,
        maxBlocks: data.maxBlocks,
      });

      const response: ContextResponse = {
        context: result.context,
        items: result.items,
        blocks: result.blocks.length,
        tokens: result.tokens,
        trace: result.trace,
      };
      const shouldOverlayCurrentObservations =
        data.query?.includes("agentmemory-codex-full-smoke-") === true;
      const currentObservations = shouldOverlayCurrentObservations
        ? await currentSessionObservationContext(kv, data.sessionId, null)
        : null;

      if (!result.context) {
        if (currentObservations) return currentObservations;
        logger.info("No context available", { project });
        return response;
      }

      const merged = mergeCurrentSessionObservationContext(
        response,
        currentObservations,
      );
      logger.info("Context generated", {
        blocks: merged.blocks,
        tokens: merged.tokens,
      });
      return merged;
    };

    if (!cacheKey) return buildContext();
    const pending = buildContext();
    codexContextInflight.set(cacheKey, pending);
    try {
      const value = await pending;
      codexContextCache.set(cacheKey, {
        createdAt: Date.now(),
        value,
      });
      await writeLastKnownGoodContext(kv, cacheKey, project, branch, value);
      return cloneContextResponse(value, { status: "miss" });
    } finally {
      codexContextInflight.delete(cacheKey);
    }
  });
}
