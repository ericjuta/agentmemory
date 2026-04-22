import type { ISdk } from "iii-sdk";
import type {
  CompactSearchResult,
  CompressedObservation,
  RetrievalBlock,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";
import {
  collectRetrievalBlocksFromState,
  refreshRetrievalBlocksFromState,
} from "./retrieval-blocks.js";

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

export function registerSmartSearchFunction(
  sdk: ISdk,
  kv: StateKV,
  _legacySearchFn?: (query: string, limit: number) => Promise<unknown>,
): void {
  sdk.registerFunction(
    "mem::smart-search",
    async (data: {
      query?: string;
      expandIds?: Array<string | { obsId?: string; blockId?: string; sessionId?: string }>;
      limit?: number;
      project?: string;
    }) => {
      if (data.expandIds && data.expandIds.length > 0) {
        const requested = data.expandIds.slice(0, 20).map((entry) => {
          if (typeof entry === "string") return { id: entry, sessionId: undefined as string | undefined };
          if (entry?.blockId) return { id: entry.blockId, sessionId: entry.sessionId };
          if (entry?.obsId) return { id: entry.obsId, sessionId: entry.sessionId };
          return null;
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        let allBlocks = await kv.list<RetrievalBlock>(KV.retrievalBlocks).catch(() => []);
        if (allBlocks.length === 0) {
          await refreshRetrievalBlocksFromState(kv).catch(() => {});
          allBlocks = await kv.list<RetrievalBlock>(KV.retrievalBlocks).catch(() => []);
        }
        if (allBlocks.length === 0) {
          allBlocks = await collectRetrievalBlocksFromState(kv).catch(() => []);
        }
        const expanded = await Promise.all(
          requested.map(async ({ id, sessionId }) => {
            const block =
              (await kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null)) ||
              allBlocks.find((candidate) => candidate.sourceId === id);
            if (!block) return null;
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

        void recordAccessBatch(
          kv,
          results.map((item) =>
            item.block.sourceType === "observation"
              ? item.block.sourceId
              : item.block.id,
          ),
        );

        const truncated = data.expandIds.length > requested.length;
        logger.info("Smart search expanded", {
          requested: data.expandIds.length,
          attempted: requested.length,
          returned: results.length,
          truncated,
        });
        return { mode: "expanded", results, truncated };
      }

      if (!data.query || typeof data.query !== "string" || !data.query.trim()) {
        return { mode: "compact", results: [], error: "query is required" };
      }

      const limit = Math.max(1, Math.min(data.limit ?? 20, 100));
      const retrieval = await retrieveRelevantBlocks(kv, {
        project: data.project,
        query: data.query,
        budget: limit * 300,
        purpose: "smart-search",
        maxBlocks: Math.max(limit * 4, 20),
      });

      const compact = retrieval.searchResults
        .slice(0, limit)
        .map((item) => toCompact(item.block, item.score));

      void recordAccessBatch(
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
        query: data.query,
        results: compact.length,
      });
      return { mode: "compact", results: compact };
    },
  );
}
