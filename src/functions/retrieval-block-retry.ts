import type { ISdk } from "iii-sdk";

import { logger } from "../logger.js";
import {
  indexRetrievalBlock,
  nextRetrievalBlockRetryAttemptAt,
} from "../state/retrieval-block-indexing.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { RetrievalBlock, RetrievalBlockRetryEntry } from "../types.js";
import { reconcileRetrievalBlocksFromState } from "./retrieval-blocks.js";
import { upsertRetrievalBlockScopeMembership } from "./retrieval-block-scope-index.js";

const MAX_RETRIES = 3;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_REFRESH_SESSION_LIMIT = 4;
const DEFAULT_TIME_BUDGET_MS = 20_000;
const MIN_RETRY_WORK_MS = 250;
const TIMEOUT = Symbol("timeout");

const DIAGNOSTIC_SOURCE_TYPES = new Set([
  "observation",
  "turn_capsule",
  "working_set",
  "session_summary",
] satisfies RetrievalBlock["sourceType"][]);

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

type FreshnessLane = RetrievalBlock["freshnessLane"];

const RETRY_LANE_PRIORITY: Record<FreshnessLane, number> = {
  hot: 0,
  warm: 1,
  cold: 2,
};

type RetrievalBlockRetryPayload = {
  batchSize?: number;
  refreshFromState?: boolean;
  fullRefresh?: boolean;
  refreshSessionLimit?: number;
  ignoreBackoff?: boolean;
  timeBudgetMs?: number;
};

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

function isDue(entry: RetrievalBlockRetryEntry, nowMs: number): boolean {
  if (!entry.nextAttemptAt) return true;
  const nextAttemptMs = Date.parse(entry.nextAttemptAt);
  return Number.isNaN(nextAttemptMs) || nextAttemptMs <= nowMs;
}

function isOperatorDiagnosticRetryEntry(entry: RetrievalBlockRetryEntry): boolean {
  if (!DIAGNOSTIC_SOURCE_TYPES.has(entry.sourceType)) return false;
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

function retryTimestamp(entry: RetrievalBlockRetryEntry): number {
  const parsed = Date.parse(entry.firstFailedAt || entry.lastFailedAt || "");
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function sortRetryEntriesByFreshness(
  entries: RetrievalBlockRetryEntry[],
): RetrievalBlockRetryEntry[] {
  return [...entries].sort((a, b) => {
    const laneDelta =
      RETRY_LANE_PRIORITY[laneForRetryEntry(a)] -
      RETRY_LANE_PRIORITY[laneForRetryEntry(b)];
    if (laneDelta !== 0) return laneDelta;
    return retryTimestamp(a) - retryTimestamp(b);
  });
}

async function coalesceRetryEntries(
  kv: StateKV,
  entries: RetrievalBlockRetryEntry[],
): Promise<{
  entries: RetrievalBlockRetryEntry[];
  diagnosticsRemoved: number;
}> {
  const kept: RetrievalBlockRetryEntry[] = [];
  let diagnosticsRemoved = 0;
  for (const entry of entries) {
    if (isOperatorDiagnosticRetryEntry(entry)) {
      await kv.delete(KV.retrievalBlockRetry, entry.blockId).catch(() => {});
      diagnosticsRemoved++;
      continue;
    }
    kept.push(entry);
  }
  return { entries: kept, diagnosticsRemoved };
}

function remainingBudgetMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function settleWithin<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (timeoutMs <= 0) return { timedOut: true };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  const result = await Promise.race([work, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (result === TIMEOUT) {
    work.catch((error) => {
      logger.warn(`${label} finished after retry time budget with error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { timedOut: true };
  }
  return { timedOut: false, value: result as T };
}

export function registerRetrievalBlockRetryFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-block-retry", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object"
        ? (payload as RetrievalBlockRetryPayload)
        : {};
    const batchSize = positiveInteger(
      data.batchSize ?? process.env.RETRIEVAL_BLOCK_RETRY_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
    );
    const timeBudgetMs = positiveInteger(
      data.timeBudgetMs ?? process.env.RETRIEVAL_BLOCK_RETRY_TIME_BUDGET_MS,
      DEFAULT_TIME_BUDGET_MS,
    );
    const deadlineMs = Date.now() + timeBudgetMs;
    let timedOut = false;
    let refreshTimedOut = false;
    let refreshReport: Awaited<ReturnType<typeof reconcileRetrievalBlocksFromState>> | null =
      null;
    if (data.refreshFromState === true) {
      const refresh = await settleWithin(
        reconcileRetrievalBlocksFromState(kv, {
          indexChanged: true,
          maxChanged: batchSize,
          partial: data.fullRefresh !== true,
          sessionLimit: positiveInteger(
            data.refreshSessionLimit ??
              process.env.RETRIEVAL_BLOCK_RETRY_REFRESH_SESSION_LIMIT,
            DEFAULT_REFRESH_SESSION_LIMIT,
          ),
        }),
        Math.max(0, remainingBudgetMs(deadlineMs) - MIN_RETRY_WORK_MS),
        "Retrieval block source refresh",
      );
      if (refresh.timedOut) {
        timedOut = true;
        refreshTimedOut = true;
      } else {
        refreshReport = refresh.value;
      }
    }
    const listedEntries = await kv.list<RetrievalBlockRetryEntry>(
      KV.retrievalBlockRetry,
    );
    const coalescedEntries = await coalesceRetryEntries(kv, listedEntries);
    const entries = sortRetryEntriesByFreshness(coalescedEntries.entries);
    const nowMs = Date.now();
    let retried = 0;
    let removed = coalescedEntries.diagnosticsRemoved;
    let succeeded = 0;
    let skipped = 0;
    let deferred = 0;
    let processed = 0;

    for (const entry of entries) {
      if (data.ignoreBackoff !== true && !isDue(entry, nowMs)) {
        skipped++;
        continue;
      }
      if (processed >= batchSize) {
        deferred++;
        continue;
      }
      if (remainingBudgetMs(deadlineMs) <= MIN_RETRY_WORK_MS) {
        timedOut = true;
        deferred++;
        continue;
      }
      processed++;

      if (entry.retries >= MAX_RETRIES) {
        await kv.delete(KV.retrievalBlockRetry, entry.blockId).catch(() => {});
        removed++;
        continue;
      }

      let block = await kv
        .get<RetrievalBlock>(KV.retrievalBlocks, entry.blockId)
        .catch(() => null);
      if (!block && entry.block) {
        block = entry.block;
        await kv.set(KV.retrievalBlocks, block.id, block);
        await upsertRetrievalBlockScopeMembership(kv, block, null).catch(() => {});
      }
      if (!block && entry.operation === "upsert") {
        const refresh = await settleWithin(
          reconcileRetrievalBlocksFromState(kv, {
            indexChanged: false,
            maxChanged: 1,
            partial: true,
            sessionLimit: 1,
          }),
          Math.max(0, remainingBudgetMs(deadlineMs) - MIN_RETRY_WORK_MS),
          "Retrieval block retry upsert refresh",
        );
        if (refresh.timedOut) {
          timedOut = true;
          deferred++;
          continue;
        }
        block = await kv
          .get<RetrievalBlock>(KV.retrievalBlocks, entry.blockId)
          .catch(() => null);
      }
      if (!block) {
        await kv.delete(KV.retrievalBlockRetry, entry.blockId).catch(() => {});
        removed++;
        continue;
      }

      const indexed = await settleWithin(
        indexRetrievalBlock(kv, block, { queueRetry: false }),
        remainingBudgetMs(deadlineMs),
        "Retrieval block retry indexing",
      );
      if (indexed.timedOut) {
        timedOut = true;
        deferred++;
        continue;
      }
      const result = indexed.value;
      if (result.success) {
        succeeded++;
        continue;
      }

      if (!result.retriable) {
        await kv.delete(KV.retrievalBlockRetry, entry.blockId).catch(() => {});
        removed++;
        continue;
      }

      const retries = entry.retries + 1;
      const now = new Date();
      await kv
        .set(KV.retrievalBlockRetry, entry.blockId, {
          ...entry,
          sourceType: block.sourceType,
          retries,
          lastFailedAt: now.toISOString(),
          nextAttemptAt: nextRetrievalBlockRetryAttemptAt(
            entry.blockId,
            retries,
            now,
          ),
          lastError: result.error || entry.lastError,
        } satisfies RetrievalBlockRetryEntry)
        .catch(() => {});
      retried++;
    }

    if (
      retried > 0 ||
      removed > 0 ||
      succeeded > 0 ||
      skipped > 0 ||
      deferred > 0
    ) {
      logger.info("Retrieval block retry complete", {
        retried,
        removed,
        succeeded,
        skipped,
        deferred,
        processed,
        refreshed: refreshReport?.changed ?? 0,
        diagnosticsRemoved: coalescedEntries.diagnosticsRemoved,
        timedOut,
      });
    }

    const timeoutFields = timedOut
      ? {
          timedOut: true,
          timeBudgetMs,
          refreshTimedOut,
        }
      : {};

    return refreshReport
      ? {
          retried,
          removed,
          succeeded,
          skipped,
          deferred,
          processed,
          refreshed: refreshReport.changed,
          refreshIndexed: refreshReport.indexed,
          refreshIndexFailures: refreshReport.indexFailures,
          refreshLimited: refreshReport.limited,
          diagnosticsRemoved: coalescedEntries.diagnosticsRemoved,
          ...timeoutFields,
        }
      : {
          retried,
          removed,
          succeeded,
          skipped,
          deferred,
          processed,
          diagnosticsRemoved: coalescedEntries.diagnosticsRemoved,
          ...timeoutFields,
        };
 });
}
