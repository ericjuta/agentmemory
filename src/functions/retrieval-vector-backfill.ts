import type { ISdk } from "iii-sdk";

import type { RetrievalBlock } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  getRetrievalBlockIndexingRuntime,
  indexRetrievalBlock,
} from "../state/retrieval-block-indexing.js";
import { getLlmWorkPauseReason } from "../health/write-gate.js";

const CURSOR_KEY = "retrieval-vector-backfill-cursor";
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_CANDIDATE_SCAN_LIMIT = 640;
const DEFAULT_TIME_BUDGET_MS = 25_000;
const DEFAULT_CONCURRENCY = 1;

interface RetrievalVectorBackfillCursor {
  lastBlockId?: string;
  passes: number;
  updatedAt: string;
  completedAt?: string;
}

interface RetrievalVectorBackfillPayload {
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

function blockTime(block: RetrievalBlock): number {
  return new Date(block.updatedAt || block.eventAt || block.createdAt).getTime();
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

async function loadCandidateIds(kv: StateKV): Promise<{
  ids: string[];
  source: "scope-index" | "retrieval-block-scan" | "scope-index-unavailable";
  error?: string;
}> {
  const scopeEntriesResult = await kv
    .list<ScopeEntry>(KV.retrievalBlockIndex)
    .then((entries) => ({ entries }))
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
    if (missing.length >= limit || inspected >= maxInspect) break;
  }

  missing.sort((a, b) => blockTime(a) - blockTime(b));
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
      await kv.delete(KV.config, CURSOR_KEY).catch(() => {});
    }
    const cursor = await kv
      .get<RetrievalVectorBackfillCursor>(KV.config, CURSOR_KEY)
      .catch(() => null);
    const { ids, source, error } = await loadCandidateIds(kv);
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
      await kv.set(KV.config, CURSOR_KEY, nextCursor).catch(() => nextCursor);
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
      elapsedMs: Date.now() - startedAt,
    };
  });
}
