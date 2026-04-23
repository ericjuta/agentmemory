import type { ISdk } from "iii-sdk";

import { logger } from "../logger.js";
import { indexRetrievalBlock } from "../state/retrieval-block-indexing.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { RetrievalBlock, RetrievalBlockRetryEntry } from "../types.js";

const MAX_RETRIES = 3;

export function registerRetrievalBlockRetryFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-block-retry", async () => {
    const entries = await kv.list<RetrievalBlockRetryEntry>(KV.retrievalBlockRetry);
    let retried = 0;
    let removed = 0;
    let succeeded = 0;

    for (const entry of entries) {
      if (entry.retries >= MAX_RETRIES) {
        await kv.delete(KV.retrievalBlockRetry, entry.blockId).catch(() => {});
        removed++;
        continue;
      }

      const block = await kv
        .get<RetrievalBlock>(KV.retrievalBlocks, entry.blockId)
        .catch(() => null);
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

      await kv
        .set(KV.retrievalBlockRetry, entry.blockId, {
          ...entry,
          sourceType: block.sourceType,
          retries: entry.retries + 1,
          lastFailedAt: new Date().toISOString(),
          lastError: result.error || entry.lastError,
        } satisfies RetrievalBlockRetryEntry)
        .catch(() => {});
      retried++;
    }

    if (retried > 0 || removed > 0 || succeeded > 0) {
      logger.info("Retrieval block retry complete", { retried, removed, succeeded });
    }

    return { retried, removed, succeeded };
  });
}
