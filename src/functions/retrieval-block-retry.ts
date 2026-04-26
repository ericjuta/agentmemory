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

type RetrievalBlockRetryPayload = {
  batchSize?: number;
  refreshFromState?: boolean;
  fullRefresh?: boolean;
  refreshSessionLimit?: number;
  ignoreBackoff?: boolean;
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

export function registerRetrievalBlockRetryFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-block-retry", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object"
        ? (payload as RetrievalBlockRetryPayload)
        : {};
    const entries = await kv.list<RetrievalBlockRetryEntry>(
      KV.retrievalBlockRetry,
    );
    const batchSize = positiveInteger(
      data.batchSize ?? process.env.RETRIEVAL_BLOCK_RETRY_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
    );
    const refreshReport =
      data.refreshFromState === true
        ? await reconcileRetrievalBlocksFromState(kv, {
            indexChanged: true,
            maxChanged: batchSize,
            partial: data.fullRefresh !== true,
            sessionLimit: positiveInteger(
              data.refreshSessionLimit ??
                process.env.RETRIEVAL_BLOCK_RETRY_REFRESH_SESSION_LIMIT,
              DEFAULT_REFRESH_SESSION_LIMIT,
            ),
          })
        : null;
    const nowMs = Date.now();
    let retried = 0;
    let removed = 0;
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
      if (!block) {
        await kv.delete(KV.retrievalBlockRetry, entry.blockId).catch(() => {});
        removed++;
        continue;
      }

      const result = await indexRetrievalBlock(kv, block, { queueRetry: false });
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
      });
    }

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
        }
      : { retried, removed, succeeded, skipped, deferred, processed };
  });
}
