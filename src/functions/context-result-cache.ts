import type { UnifiedRetrievalQuery, UnifiedRetrievalResult } from "./retrieval-engine.js";

const CONTEXT_CACHE_TTL_MS = 15_000;
const CONTEXT_CACHE_MAX_ENTRIES = 64;

type CachedContextResult = {
  cachedAt: number;
  generation: number;
  result: UnifiedRetrievalResult;
};

const cache = new Map<string, CachedContextResult>();
let generation = 0;

export function contextResultCacheKey(
  query: UnifiedRetrievalQuery,
): string | null {
  if (query.purpose !== "context") return null;
  if (query.query?.trim()) return null;
  if ((query.focusFiles?.length || 0) > 0) return null;
  if ((query.focusConcepts?.length || 0) > 0) return null;
  return JSON.stringify({
    project: query.project || "",
    sessionId: query.sessionId || "",
    branch: query.branch || "",
    budget: query.budget,
    maxBlocks: query.maxBlocks || null,
  });
}

export function getCachedContextResult(
  key: string,
): UnifiedRetrievalResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.generation !== generation || Date.now() - entry.cachedAt > CONTEXT_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return structuredClone(entry.result);
}

export function setCachedContextResult(
  key: string,
  result: UnifiedRetrievalResult,
): void {
  cache.set(key, {
    cachedAt: Date.now(),
    generation,
    result: structuredClone(result),
  });
  while (cache.size > CONTEXT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    cache.delete(oldestKey);
  }
}

export function invalidateContextResultCache(): void {
  generation += 1;
  cache.clear();
}

export function resetContextResultCacheForTests(): void {
  generation = 0;
  cache.clear();
}
