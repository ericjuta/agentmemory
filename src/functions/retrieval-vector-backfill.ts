import type { ISdk } from "iii-sdk";

import type { RetrievalBlock } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  getRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  indexRetrievalBlock,
} from "../state/retrieval-block-indexing.js";
import { getLlmWorkPauseReason } from "../health/write-gate.js";

const CURSOR_KEY = "retrieval-vector-backfill-cursor";
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_CANDIDATE_SCAN_LIMIT = 80;
const DEFAULT_TIME_BUDGET_MS = 8_000;
const DEFAULT_CONCURRENCY = 1;

interface RetrievalVectorBackfillCursor {
  lastBlockId?: string;
  passes: number;
  updatedAt: string;
  completedAt?: string;
}

interface RetrievalVectorBackfillPayload {
  project?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  branch?: unknown;
  batchSize?: unknown;
  candidateScanLimit?: unknown;
  timeBudgetMs?: unknown;
  coverageTarget?: unknown;
  concurrency?: unknown;
  scheduleSave?: unknown;
  resetCursor?: unknown;
  dryRun?: unknown;
}

interface ScopeEntry {
  ids?: unknown;
}

interface CandidateScope {
  project?: string;
  sessionId?: string;
  branch?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveRatio(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function blockTime(block: RetrievalBlock): number {
  return new Date(block.updatedAt || block.eventAt || block.createdAt).getTime();
}

function lanePriority(block: RetrievalBlock): number {
  if (block.freshnessLane === "hot") return 0;
  if (block.freshnessLane === "warm") return 1;
  return 2;
}

function scopeKey(kind: "global" | "project" | "session" | "branch", ...parts: string[]): string {
  if (kind === "global") return "scope:global";
  return `scope:${kind}:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

function candidateScopeKeys(scope: CandidateScope): string[] {
  const keys: string[] = [];
  if (scope.sessionId) keys.push(scopeKey("session", scope.sessionId));
  if (scope.project && scope.branch) {
    keys.push(scopeKey("branch", scope.project, scope.branch));
  }
  if (scope.project && scope.project !== "global") {
    keys.push(scopeKey("project", scope.project));
  }
  return uniqueStrings(keys);
}

function cursorKey(scope: CandidateScope): string {
  if (!scope.project && !scope.sessionId && !scope.branch) return CURSOR_KEY;
  return `${CURSOR_KEY}:${Buffer.from(JSON.stringify(scope)).toString("base64url")}`;
}

function rotateAfterCursor(ids: string[], cursor?: string): string[] {
  if (!cursor) return ids;
  const index = ids.indexOf(cursor);
  if (index < 0 || index >= ids.length - 1) return ids;
  return [...ids.slice(index + 1), ...ids.slice(0, index + 1)];
}

function countPresentVectors(
  ids: string[],
  vectorIndex: { has(id: string): boolean } | null,
): number {
  if (!vectorIndex) return 0;
  let present = 0;
  for (const id of ids) {
    if (vectorIndex.has(id)) present += 1;
  }
  return present;
}

async function loadScopedCandidateIds(
  kv: StateKV,
  scope: CandidateScope,
): Promise<{
  ids: string[];
  source: "active-scope-index" | "active-scope-index-unavailable";
  error?: string;
}> {
  const keys = candidateScopeKeys(scope);
  if (keys.length === 0) return { ids: [], source: "active-scope-index" };
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        const entry =
          (await kv.get<ScopeEntry>(KV.retrievalBlockScopeIndex, key).catch(() => null)) ??
          (await kv.get<ScopeEntry>(KV.retrievalBlockIndex, key).catch(() => null));
        return { key, entry };
      } catch (error) {
        return { key, error: errorMessage(error) };
      }
    }),
  );
  const failed = entries.find((entry) => "error" in entry);
  if (failed && "error" in failed) {
    return {
      ids: [],
      source: "active-scope-index-unavailable",
      error: failed.error,
    };
  }
  return {
    ids: uniqueStrings(
      entries.flatMap((entry) =>
        Array.isArray(entry.entry?.ids)
          ? entry.entry.ids.filter((id): id is string => typeof id === "string")
          : [],
      ),
    ),
    source: "active-scope-index",
  };
}

async function loadCandidateIds(kv: StateKV, scope: CandidateScope): Promise<{
  ids: string[];
  source:
    | "active-scope-index"
    | "active-scope-index-unavailable"
    | "retrieval-bm25-index"
    | "scope-index"
    | "retrieval-block-scan"
    | "scope-index-unavailable";
  error?: string;
}> {
  if (scope.project || scope.sessionId) {
    const scoped = await loadScopedCandidateIds(kv, scope);
    if (scoped.ids.length > 0 || scoped.error) return scoped;
  }

  const indexedIds = uniqueStrings(getRetrievalSearchIndex().documentIds()).sort();
  if (indexedIds.length > 0) {
    return { ids: indexedIds, source: "retrieval-bm25-index" };
  }

  const scopeEntriesResult = await kv
    .list<ScopeEntry>(KV.retrievalBlockScopeIndex)
    .then(async (entries) => {
      if (entries.length > 0) return { entries };
      return { entries: await kv.list<ScopeEntry>(KV.retrievalBlockIndex) };
    })
    .catch((error: unknown) => ({ entries: [], error: errorMessage(error) }));
  if (scopeEntriesResult.error) {
    return {
      ids: [],
      source: "scope-index-unavailable",
      error: scopeEntriesResult.error,
    };
  }
  const scopeEntries = scopeEntriesResult.entries;
  const scopeIds = uniqueStrings(
    scopeEntries.flatMap((entry) =>
      Array.isArray(entry?.ids)
        ? entry.ids.filter((id): id is string => typeof id === "string")
        : [],
    ),
  ).sort();
  if (scopeIds.length > 0) {
    return { ids: scopeIds, source: "scope-index" };
  }

  const blocks = await kv
    .list<RetrievalBlock>(KV.retrievalBlocks)
    .catch((error: unknown) => ({ error: errorMessage(error) }));
  if (!Array.isArray(blocks)) {
    return { ids: [], source: "retrieval-block-scan", error: blocks.error };
  }
  return {
    ids: uniqueStrings(blocks.map((block) => block.id)).sort(),
    source: "retrieval-block-scan",
  };
}

async function selectMissingVectorBlocks(
  kv: StateKV,
  ids: string[],
  cursor: RetrievalVectorBackfillCursor | null,
  limit: number,
  scanLimit: number,
  startedAt: number,
  timeBudgetMs: number,
): Promise<{
  blocks: RetrievalBlock[];
  inspected: number;
  nextCursorId?: string;
  completedPass: boolean;
}> {
  const vectorIndex = getRetrievalBlockIndexingRuntime().vectorIndex;
  if (!vectorIndex || ids.length === 0) {
    return { blocks: [], inspected: 0, completedPass: true };
  }
  const rotated = rotateAfterCursor(ids, cursor?.lastBlockId);
  const missing: RetrievalBlock[] = [];
  let inspected = 0;
  let nextCursorId: string | undefined;
  const maxInspect = Math.min(ids.length, Math.max(limit, scanLimit));

  for (const id of rotated) {
    if (Date.now() - startedAt >= timeBudgetMs) break;
    inspected += 1;
    nextCursorId = id;
    if (!vectorIndex.has(id)) {
      const block = await kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null);
      if (block && !vectorIndex.has(block.id)) {
        missing.push(block);
      }
    }
    if (inspected >= maxInspect) break;
  }

  missing.sort((a, b) => {
    const laneDelta = lanePriority(a) - lanePriority(b);
    if (laneDelta !== 0) return laneDelta;
    return blockTime(b) - blockTime(a);
  });
  return {
    blocks: missing.slice(0, limit),
    inspected,
    nextCursorId,
    completedPass: inspected >= ids.length || !nextCursorId,
  };
}

async function runLimited<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<boolean>,
): Promise<{ succeeded: number; failed: number }> {
  let index = 0;
  let succeeded = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      const ok = await worker(item);
      if (ok) succeeded += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  return { succeeded, failed };
}

export function registerRetrievalVectorBackfillFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-vector-backfill", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object"
        ? (payload as RetrievalVectorBackfillPayload)
        : {};
    const startedAt = Date.now();
    const runtime = getRetrievalBlockIndexingRuntime();
    const batchSize = Math.min(
      256,
      positiveInteger(
        data.batchSize ?? process.env.RETRIEVAL_VECTOR_BACKFILL_BATCH_SIZE,
        DEFAULT_BATCH_SIZE,
      ),
    );
    const candidateScanLimit = positiveInteger(
      data.candidateScanLimit ?? process.env.RETRIEVAL_VECTOR_BACKFILL_SCAN_LIMIT,
      Math.max(DEFAULT_CANDIDATE_SCAN_LIMIT, batchSize * 20),
    );
    const timeBudgetMs = positiveInteger(
      data.timeBudgetMs ?? process.env.RETRIEVAL_VECTOR_BACKFILL_TIME_BUDGET_MS,
      DEFAULT_TIME_BUDGET_MS,
    );
    const concurrency = Math.min(
      8,
      positiveInteger(
        data.concurrency ?? process.env.RETRIEVAL_VECTOR_BACKFILL_CONCURRENCY,
        DEFAULT_CONCURRENCY,
      ),
    );
    const coverageTarget = positiveRatio(
      data.coverageTarget ?? process.env.RETRIEVAL_VECTOR_BACKFILL_COVERAGE_TARGET,
      0.98,
    );
    const scheduleSave = booleanValue(data.scheduleSave, false);
    const dryRun = booleanValue(data.dryRun, false);
    const scope = {
      project: stringValue(data.project) || stringValue(data.cwd),
      sessionId: stringValue(data.sessionId),
      branch: stringValue(data.branch),
    };
    const progressKey = cursorKey(scope);

    if (!runtime.embeddingProvider || !runtime.vectorIndex) {
      return {
        success: true,
        attempted: 0,
        backfilled: 0,
        failed: 0,
        deferred: 0,
        pauseReason: "embedding_provider_unavailable",
      };
    }

    const llmPauseReason = await getLlmWorkPauseReason(kv);
    if (llmPauseReason) {
      return {
        success: true,
        attempted: 0,
        backfilled: 0,
        failed: 0,
        deferred: 0,
        pauseReason: llmPauseReason,
      };
    }

    if (data.resetCursor === true) {
      await kv.delete(KV.config, progressKey).catch(() => {});
    }
    const cursor = await kv
      .get<RetrievalVectorBackfillCursor>(KV.config, progressKey)
      .catch(() => null);
    const { ids, source, error } = await loadCandidateIds(kv, scope);
    if (error) {
      return {
        success: true,
        source,
        eligibleCount: 0,
        vectorPresentBefore: 0,
        vectorMissingBefore: 0,
        vectorCoverageRatioBefore: 1,
        inspected: 0,
        dryRun,
        attempted: 0,
        backfilled: 0,
        failed: 0,
        deferred: 0,
        vectorPresentAfter: 0,
        vectorMissingAfter: 0,
        vectorCoverageRatioAfter: 1,
        coverageTarget,
        complete: false,
        completedPass: false,
        partial: true,
        pauseReason: error,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const eligibleCount = ids.length;
    const presentBefore = countPresentVectors(ids, runtime.vectorIndex);
    const missingBefore = Math.max(0, eligibleCount - presentBefore);
    const selected = await selectMissingVectorBlocks(
      kv,
      ids,
      cursor,
      batchSize,
      candidateScanLimit,
      startedAt,
      timeBudgetMs,
    );

    const { succeeded, failed } = dryRun
      ? { succeeded: 0, failed: 0 }
      : await runLimited(selected.blocks, concurrency, async (block) => {
          const result = await indexRetrievalBlock(kv, block, {
            scheduleSave: false,
          });
          return result.success;
        });

    if (succeeded > 0 && scheduleSave && !dryRun) {
      getRetrievalBlockIndexingRuntime().scheduleSave?.();
    }

    const now = new Date().toISOString();
    const nextCursor: RetrievalVectorBackfillCursor = selected.completedPass
      ? {
          passes: (cursor?.passes ?? 0) + 1,
          updatedAt: now,
          completedAt: now,
        }
      : {
          lastBlockId: selected.nextCursorId,
          passes: cursor?.passes ?? 0,
          updatedAt: now,
        };
    if (!dryRun) {
      await kv.set(KV.config, progressKey, nextCursor).catch(() => nextCursor);
    }

    const presentAfter = countPresentVectors(ids, runtime.vectorIndex);
    const missingAfter = Math.max(0, eligibleCount - presentAfter);
    return {
      success: true,
      source,
      eligibleCount,
      vectorPresentBefore: presentBefore,
      vectorMissingBefore: missingBefore,
      vectorCoverageRatioBefore:
        eligibleCount > 0 ? presentBefore / eligibleCount : 1,
      inspected: selected.inspected,
      dryRun,
      attempted: selected.blocks.length,
      backfilled: succeeded,
      failed,
      deferred: Math.max(0, missingAfter),
      vectorPresentAfter: presentAfter,
      vectorMissingAfter: missingAfter,
      vectorCoverageRatioAfter:
        eligibleCount > 0 ? presentAfter / eligibleCount : 1,
      coverageTarget,
      complete:
        eligibleCount > 0 ? presentAfter / eligibleCount >= coverageTarget : true,
      completedPass: selected.completedPass,
      cursor: nextCursor,
      cursorKey: progressKey,
      scope,
      elapsedMs: Date.now() - startedAt,
    };
  });
}
