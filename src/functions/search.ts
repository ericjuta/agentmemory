import type {
  CompactSearchResult,
  CompressedObservation,
  RetrievalSearchResult,
  Session,
} from "../types.js";
import type { ISdk } from "iii-sdk";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { SearchIndex } from "../state/search-index.js";
import { deferRecordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import {
  getObservationIndexingRuntime,
  indexCompressedObservation,
} from "../state/observation-indexing.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";

let index: SearchIndex | null = null;

export function getSearchIndex(): SearchIndex {
  if (!index) index = new SearchIndex();
  return index;
}

export async function rebuildIndex(kv: StateKV): Promise<number> {
  const idx = getSearchIndex();
  idx.clear();
  getObservationIndexingRuntime().vectorIndex?.clear();

  const sessions = await kv.list<Session>(KV.sessions);
  if (!sessions.length) return 0;

  let count = 0;
  const obsPerSession: CompressedObservation[][] = [];
  const failedSessions: string[] = [];
  for (let batch = 0; batch < sessions.length; batch += 10) {
    const chunk = sessions.slice(batch, batch + 10);
    const results = await Promise.all(
      chunk.map(async (s) => {
        try {
          return await kv.list<CompressedObservation>(KV.observations(s.id));
        } catch {
          failedSessions.push(s.id);
          return [] as CompressedObservation[];
        }
      }),
    );
    obsPerSession.push(...results);
  }
  if (failedSessions.length > 0) {
    logger.warn("rebuildIndex: failed to load observations for sessions", { failedSessions });
  }
  for (const observations of obsPerSession) {
    for (const obs of observations) {
      if (obs.title && obs.narrative) {
        await indexCompressedObservation(kv, idx, obs, { scheduleSave: false });
        count++;
      }
    }
  }
  return count;
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 3));
}

function compactResult(item: RetrievalSearchResult): CompactSearchResult {
  const legacyId =
    item.block.sourceType === "observation" ? item.block.sourceId : item.block.id;
  return {
    obsId: legacyId,
    blockId: item.block.id,
    sessionId: item.sessionId || "",
    title: item.block.title,
    type: item.block.sourceType,
    score: item.score,
    timestamp: item.block.eventAt,
    sourceType: item.block.sourceType,
    sourceId: item.block.sourceId,
  };
}

export function registerSearchFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::search",
    async (data: {
      query: string;
      limit?: number;
      project?: string;
      cwd?: string;
      format?: string;
      token_budget?: number;
    }) => {
      if (typeof data?.query !== "string" || !data.query.trim()) {
        throw new Error("mem::search: query must be a non-empty string");
      }
      const query = data.query.trim();
      const MAX_LIMIT = 100;
      let effectiveLimit = 20;
      if (data.limit !== undefined) {
        if (!Number.isInteger(data.limit) || data.limit < 1) {
          throw new Error("mem::search: limit must be a positive integer");
        }
        effectiveLimit = Math.min(data.limit, MAX_LIMIT);
      }
      const format = typeof data.format === "string" ? data.format : "full";
      if (!["full", "compact", "narrative"].includes(format)) {
        throw new Error("mem::search: format must be one of 'full', 'compact', or 'narrative'");
      }
      let tokenBudget: number | undefined;
      if (data.token_budget !== undefined) {
        if (!Number.isInteger(data.token_budget) || data.token_budget < 1) {
          throw new Error("mem::search: token_budget must be a positive integer");
        }
        tokenBudget = data.token_budget;
      }

      const retrieval = await retrieveRelevantBlocks(kv, {
        project: data.project || data.cwd,
        query,
        budget: Math.max(tokenBudget || 3000, effectiveLimit * 300),
        purpose: "search",
        maxBlocks: Math.max(effectiveLimit * 4, 20),
      });

      const fullResults = retrieval.searchResults.slice(0, effectiveLimit * 4);

      const applyTokenBudget = <T>(items: T[]): {
        items: T[];
        used: number;
        truncated: boolean;
      } => {
        if (!tokenBudget) {
          return {
            items,
            used: items.reduce((sum, item) => sum + estimateTokens(item), 0),
            truncated: false,
          };
        }
        const selected: T[] = [];
        let used = 0;
        for (const item of items) {
          const itemTokens = estimateTokens(item);
          if (used + itemTokens > tokenBudget) {
            return { items: selected, used, truncated: selected.length < items.length };
          }
          selected.push(item);
          used += itemTokens;
        }
        return { items: selected, used, truncated: false };
      };

      if (format === "compact") {
        const compact = fullResults.map(compactResult).slice(0, effectiveLimit);
        const packed = applyTokenBudget(compact);
        deferRecordAccessBatch(
          kv,
          packed.items.map((item) => item.sourceId || item.obsId),
        );
        return {
          format,
          results: packed.items,
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
        };
      }

      if (format === "narrative") {
        const narrative = fullResults.map((item) => ({
          blockId: item.block.id,
          title: item.block.title,
          sourceType: item.block.sourceType,
          narrative: item.block.canonicalText,
          score: item.score,
          timestamp: item.block.eventAt,
        }));
        const packed = applyTokenBudget(narrative);
        deferRecordAccessBatch(
          kv,
          packed.items.map((item) => item.blockId),
        );
        return {
          format,
          results: packed.items,
          text: packed.items
            .map((item, index) => `${index + 1}. ${item.title}\n${item.narrative}`)
            .join("\n\n"),
          tokens_used: packed.used,
          tokens_budget: tokenBudget,
          truncated: packed.truncated,
        };
      }

      const verbose = fullResults
        .map((item) => ({
          block: item.block,
          observation: item.observation,
          score: item.score,
          lexicalScore: item.lexicalScore,
          vectorScore: item.vectorScore,
          graphScore: item.graphScore,
          sessionId: item.sessionId,
          title: item.block.title,
          content: item.block.canonicalText,
        }))
        .slice(0, effectiveLimit);
      const packed = applyTokenBudget(verbose);
      deferRecordAccessBatch(
        kv,
        packed.items.map((item) => item.block.id),
      );
      logger.info("Search completed", {
        query,
        results: packed.items.length,
        hasProjectFilter: !!data.project,
        hasCwdFilter: !!data.cwd,
      });
      return {
        format,
        results: packed.items,
        tokens_used: packed.used,
        tokens_budget: tokenBudget,
        truncated: packed.truncated,
      };
    },
  );
}
