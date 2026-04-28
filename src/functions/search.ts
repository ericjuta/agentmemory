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
        await indexCompressedObservation(kv, idx, obs, {
          scheduleSave: false,
          syncEmbedding: false,
        });
        count++;
      }
    }
  }
  return count;
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 3));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 16) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 15).trimEnd()}...[truncated]`;
}

function truncateList(values: string[], maxItems: number, maxChars: number): string[] {
  return values.slice(0, maxItems).map((value) => truncateText(value, maxChars));
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

function budgetedNarrativeResult(
  item: RetrievalSearchResult,
  tokenBudget: number,
): {
  blockId: string;
  title: string;
  sourceType: RetrievalSearchResult["block"]["sourceType"];
  narrative: string;
  score: number;
  timestamp: string;
} | null {
  let charLimit = Math.max(80, Math.min(2400, tokenBudget * 2));
  while (charLimit >= 40) {
    const candidate = {
      blockId: item.block.id,
      title: item.block.title,
      sourceType: item.block.sourceType,
      narrative: truncateText(item.block.canonicalText, charLimit),
      score: item.score,
      timestamp: item.block.eventAt,
    };
    if (estimateTokens(candidate) <= tokenBudget) return candidate;
    charLimit = Math.floor(charLimit * 0.7);
  }
  const minimal = {
    blockId: item.block.id,
    title: item.block.title,
    sourceType: item.block.sourceType,
    narrative: truncateText(item.block.canonicalText, 40),
    score: item.score,
    timestamp: item.block.eventAt,
  };
  return estimateTokens(minimal) <= tokenBudget ? minimal : null;
}

function budgetedFullResult(
  item: RetrievalSearchResult,
  tokenBudget: number,
) {
  let charLimit = Math.max(120, Math.min(3600, tokenBudget * 2));
  while (charLimit >= 60) {
    const content = truncateText(item.block.canonicalText, charLimit);
    const candidate = {
      block: {
        ...item.block,
        canonicalText: content,
        files: truncateList(item.block.files, 12, 160),
        concepts: truncateList(item.block.concepts, 12, 80),
        entities: truncateList(item.block.entities, 12, 80),
        sourceObservationIds: item.block.sourceObservationIds.slice(0, 12),
      },
      observation: item.observation
        ? {
            id: item.observation.id,
            sessionId: item.observation.sessionId,
            timestamp: item.observation.timestamp,
            source: item.observation.source,
            payloadVersion: item.observation.payloadVersion,
            eventId: item.observation.eventId,
            sourceTimestamp: item.observation.sourceTimestamp,
            capabilities: item.observation.capabilities?.slice(0, 8),
            persistenceClass: item.observation.persistenceClass,
            turnId: item.observation.turnId,
            type: item.observation.type,
            title: item.observation.title,
            subtitle: item.observation.subtitle,
            facts: truncateList(item.observation.facts, 4, 220),
            narrative: truncateText(item.observation.narrative, Math.max(80, Math.floor(charLimit / 2))),
            concepts: truncateList(item.observation.concepts, 12, 80),
            files: truncateList(item.observation.files, 12, 160),
            importance: item.observation.importance,
            confidence: item.observation.confidence,
          }
        : null,
      score: item.score,
      lexicalScore: item.lexicalScore,
      vectorScore: item.vectorScore,
      graphScore: item.graphScore,
      sessionId: item.sessionId,
      title: item.block.title,
      content,
    };
    if (estimateTokens(candidate) <= tokenBudget) return candidate;
    charLimit = Math.floor(charLimit * 0.7);
  }

  const content = truncateText(item.block.canonicalText, 60);
  const minimal = {
    block: {
      id: item.block.id,
      sourceType: item.block.sourceType,
      sourceId: item.block.sourceId,
      project: item.block.project,
      branch: item.block.branch,
      sessionId: item.block.sessionId,
      turnId: item.block.turnId,
      scope: item.block.scope,
      freshnessLane: item.block.freshnessLane,
      canonicalText: content,
      title: item.block.title,
      files: [],
      concepts: [],
      entities: [],
      sourceObservationIds: item.block.sourceObservationIds.slice(0, 1),
      hadFailure: item.block.hadFailure,
      hadDecision: item.block.hadDecision,
      hadAssistantConclusion: item.block.hadAssistantConclusion,
      isResumeArtifact: item.block.isResumeArtifact,
      importance: item.block.importance,
      createdAt: item.block.createdAt,
      updatedAt: item.block.updatedAt,
      eventAt: item.block.eventAt,
      embeddingModel: item.block.embeddingModel,
      embeddingVersion: item.block.embeddingVersion,
    },
    observation: null,
    score: item.score,
    lexicalScore: item.lexicalScore,
    vectorScore: item.vectorScore,
    graphScore: item.graphScore,
    sessionId: item.sessionId,
    title: item.block.title,
    content,
  };
  return estimateTokens(minimal) <= tokenBudget ? minimal : null;
}

export function registerSearchFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::search",
    async (data: {
      query: string;
      limit?: number;
      project?: string;
      cwd?: string;
      branch?: string;
      global?: boolean;
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
        project: data.global === true ? "global" : data.project || data.cwd,
        branch: data.branch,
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
        let budgetTrimmed = false;
        const narrative = fullResults
          .map((item) => {
            if (!tokenBudget) {
              return {
                blockId: item.block.id,
                title: item.block.title,
                sourceType: item.block.sourceType,
                narrative: item.block.canonicalText,
                score: item.score,
                timestamp: item.block.eventAt,
              };
            }
            const result = budgetedNarrativeResult(item, tokenBudget);
            if (!result || result.narrative !== item.block.canonicalText) {
              budgetTrimmed = true;
            }
            return result;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);
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
          truncated: packed.truncated || budgetTrimmed,
        };
      }

      let budgetTrimmed = false;
      const verbose = fullResults
        .map((item) => {
          if (!tokenBudget) {
            return {
              block: item.block,
              observation: item.observation,
              score: item.score,
              lexicalScore: item.lexicalScore,
              vectorScore: item.vectorScore,
              graphScore: item.graphScore,
              sessionId: item.sessionId,
              title: item.block.title,
              content: item.block.canonicalText,
            };
          }
          const result = budgetedFullResult(item, tokenBudget);
          if (!result || result.content !== item.block.canonicalText) {
            budgetTrimmed = true;
          }
          return result;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
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
        truncated: packed.truncated || budgetTrimmed,
      };
    },
  );
}
