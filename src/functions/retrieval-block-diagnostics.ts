import type { ISdk } from "iii-sdk";

import type { RetrievalBlock, RetrievalBlockRetryEntry } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  getRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  getRetrievalVectorIndex,
} from "../state/retrieval-block-indexing.js";
import {
  RETRIEVAL_QUALITY_SUMMARY_KEY,
  loadRetrievalQualitySummary,
  type RetrievalQualitySummary,
} from "./retrieval-quality-summary.js";

interface DiagnosticsPayload {
  project?: unknown;
  sessionId?: unknown;
  branch?: unknown;
  sampleLimit?: unknown;
  largeScanThreshold?: unknown;
}

interface ScopeEntry {
  ids?: unknown;
  updatedAt?: unknown;
}

type FreshnessLane = RetrievalBlock["freshnessLane"];

const BLOCKING_FRESHNESS_LANES = new Set<FreshnessLane>(["hot", "warm"]);

const OPERATOR_DIAGNOSTIC_MARKERS = [
  "/agentmemory/health",
  "/agentmemory/livez",
  "/agentmemory/retrieval-proof",
  "/agentmemory/retrieval-blocks/diagnostics",
  "/agentmemory/retrieval-index/verify",
  "/agentmemory/retrieval-vector/backfill",
  "/agentmemory/retrieval-blocks/retry",
  "/agentmemory/compress-retry",
  "docker compose ps",
  "docker compose logs",
  "git status --short --branch",
  "git log --oneline",
];

function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function scopeKey(kind: "global" | "project" | "session" | "branch", ...parts: string[]): string {
  if (kind === "global") return "scope:global";
  return `scope:${kind}:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

function requestedScopeKeys(options: {
  project?: string;
  sessionId?: string;
  branch?: string;
}): string[] {
  const keys = [scopeKey("global")];
  if (options.project) keys.push(scopeKey("project", options.project));
  if (options.sessionId) keys.push(scopeKey("session", options.sessionId));
  if (options.project && options.branch) {
    keys.push(scopeKey("branch", options.project, options.branch));
  }
  return [...new Set(keys)];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function retryTimestamp(entry: RetrievalBlockRetryEntry): string {
  return entry.firstFailedAt || entry.lastFailedAt;
}

function laneForRetryEntry(entry: RetrievalBlockRetryEntry): FreshnessLane {
  if (entry.block?.freshnessLane) return entry.block.freshnessLane;
  if (entry.sourceType === "turn_capsule" || entry.sourceType === "working_set") {
    return "hot";
  }
  if (
    entry.sourceType === "observation" ||
    entry.sourceType === "guardrail" ||
    entry.sourceType === "decision" ||
    entry.sourceType === "dossier" ||
    entry.sourceType === "handoff" ||
    entry.sourceType === "branch_overlay"
  ) {
    return "warm";
  }
  return "cold";
}

function isOperatorDiagnosticRetryEntry(entry: RetrievalBlockRetryEntry): boolean {
  const block = entry.block;
  if (!block) return false;
  const haystack = [
    block.title,
    block.canonicalText,
    ...block.files,
    ...block.concepts,
    ...block.entities,
    entry.lastError,
  ]
    .join("\n")
    .toLowerCase();
  return OPERATOR_DIAGNOSTIC_MARKERS.some((marker) =>
    haystack.includes(marker),
  );
}

function retryCountByLane(entries: RetrievalBlockRetryEntry[]): Record<FreshnessLane, number> {
  const counts: Record<FreshnessLane, number> = { hot: 0, warm: 0, cold: 0 };
  for (const entry of entries) counts[laneForRetryEntry(entry)]++;
  return counts;
}

async function readScopeEntry(
  kv: StateKV,
  key: string,
): Promise<{ key: string; count: number; updatedAt?: string; ids: string[]; error?: string }> {
  try {
    const entry = await kv.get<ScopeEntry>(KV.retrievalBlockIndex, key);
    const ids = Array.isArray(entry?.ids)
      ? entry.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return {
      key,
      count: ids.length,
      updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : undefined,
      ids,
    };
  } catch (error) {
    return {
      key,
      count: 0,
      ids: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerRetrievalBlockDiagnosticsFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-blocks-diagnostics", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object" ? (payload as DiagnosticsPayload) : {};
    const project = stringValue(data.project);
    const sessionId = stringValue(data.sessionId);
    const branch = stringValue(data.branch);
    const sampleLimit = parseNonNegativeInt(data.sampleLimit, 10);
    const largeScanThreshold = parseNonNegativeInt(data.largeScanThreshold, 5_000);
    const persistence = getRetrievalBlockIndexingRuntime().persistenceStatus?.();
    const manifestDocumentCount = persistence?.manifest?.documentCount;
    const manifestVectorCount = persistence?.manifest?.vectorCount;
    const bm25Size = getRetrievalSearchIndex().size;
    const vectorIndex = getRetrievalVectorIndex();
    const vectorSize = vectorIndex?.size ?? 0;
    const retryEntries = await kv
      .list<RetrievalBlockRetryEntry>(KV.retrievalBlockRetry)
      .catch(() => []);
   const retryLaneCounts = retryCountByLane(retryEntries);
    const diagnosticQueuedCount = retryEntries.filter((entry) =>
      isOperatorDiagnosticRetryEntry(entry),
    ).length;
    const blockingQueuedCount =
     retryEntries.filter((entry) =>
       BLOCKING_FRESHNESS_LANES.has(laneForRetryEntry(entry)) &&
       !isOperatorDiagnosticRetryEntry(entry),
      ).length;
    const oldestRetryAt = retryEntries.reduce<string | undefined>(
      (oldest, entry) => {
        const timestamp = retryTimestamp(entry);
        if (!timestamp) return oldest;
        if (!oldest) return timestamp;
        return new Date(timestamp).getTime() < new Date(oldest).getTime()
          ? timestamp
          : oldest;
      },
      undefined,
    );
    const evalSummaryResult = await loadRetrievalQualitySummary(kv);
    const evalSummary = evalSummaryResult.summary;
    const scopeEntries = await Promise.all(
      requestedScopeKeys({ project, sessionId, branch }).map((key) =>
        readScopeEntry(kv, key),
      ),
    );
    const scopedIds = [...new Set(scopeEntries.flatMap((entry) => entry.ids))];
    const activeEligibleCount =
      scopedIds.length > 0 ? scopedIds.length : manifestDocumentCount ?? bm25Size;
    const activeVectorIndexedCount =
      scopedIds.length > 0 && vectorIndex
        ? scopedIds.filter((id) => vectorIndex.has(id)).length
        : Math.min(manifestVectorCount ?? vectorSize, activeEligibleCount);
    const activeVectorMissingCount = Math.max(
      0,
      activeEligibleCount - activeVectorIndexedCount,
    );
    const sampleIds = scopedIds.slice(0, sampleLimit);
    const samples = await Promise.all(
      sampleIds.map(async (id) => {
        const block = await kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null);
        return block
          ? {
              id,
              sourceType: block.sourceType,
              sourceId: block.sourceId,
              project: block.project,
              scope: block.scope,
              updatedAt: block.updatedAt,
            }
          : { id, missing: true };
      }),
    );
    const estimatedFullScanCount = manifestDocumentCount ?? scopedIds.length;
    const scanRisk =
      estimatedFullScanCount >= largeScanThreshold
        ? {
            level: "high",
            reason: "manifest_or_scope_index_exceeds_threshold",
            threshold: largeScanThreshold,
          }
        : {
            level: "normal",
            reason: "manifest_or_scope_index_below_threshold",
            threshold: largeScanThreshold,
          };

    return {
      success: true,
      fullScanAvoided: true,
      source: "retrieval-index-manifest-and-scope-memberships",
      persistence,
      manifestDocumentCount,
      bm25Size,
      vectorSize,
      quality: {
        bm25Coverage: ratio(bm25Size, activeEligibleCount),
        vectorCoverage: ratio(activeVectorIndexedCount, activeEligibleCount),
        vectorEligibleCount: activeEligibleCount,
        vectorIndexedCount: activeVectorIndexedCount,
        vectorMissingCount: activeVectorMissingCount,
        deferredFreshnessLag: {
          queuedCount: retryEntries.length,
          blockingQueuedCount: Math.max(0, blockingQueuedCount),
          diagnosticQueuedCount,
          byLane: retryLaneCounts,
          blockingLanes: [...BLOCKING_FRESHNESS_LANES],
          oldestQueuedAt: oldestRetryAt,
          oldestAgeMs: oldestRetryAt
            ? Math.max(0, Date.now() - new Date(oldestRetryAt).getTime())
            : 0,
          affectedSourceTypes: [
            ...new Set(retryEntries.map((entry) => entry.sourceType)),
          ],
          affectedProjects: [
            ...new Set(
              retryEntries
                .map((entry) => entry.block?.project)
                .filter((value): value is string => Boolean(value)),
            ),
          ],
          affectedSessions: [
            ...new Set(
              retryEntries
                .map((entry) => entry.block?.sessionId)
                .filter((value): value is string => Boolean(value)),
            ),
          ],
        },
        duplicateRate: evalSummary?.duplicateRate ?? null,
        lastEvalGrade: evalSummary?.grade ?? null,
        lastEvalAt: evalSummary?.evaluatedAt ?? null,
        lastEvalRecallAt3: evalSummary?.recallAt3 ?? null,
        lastEvalLeakageCount: evalSummary?.leakageCount ?? null,
        lastEvalSummarySource: evalSummaryResult.source,
        lastEvalSummaryError: evalSummaryResult.error,
      },
      estimatedFullScanCount,
      scanRisk,
      scopes: scopeEntries.map(({ ids, ...entry }) => entry),
      sampleCount: samples.length,
      samples,
    };
  });
}
