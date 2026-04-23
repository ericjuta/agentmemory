import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
} from "../src/types.js";
import {
  configureObservationIndexingRuntime,
  indexCompressedObservation,
  resetObservationIndexingRuntime,
} from "../src/state/observation-indexing.js";
import { getSearchIndex, rebuildIndex } from "../src/functions/search.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    confidence: 0.8,
    ...overrides,
  };
}

describe("observation indexing", () => {
  beforeEach(() => {
    resetObservationIndexingRuntime();
    getSearchIndex().clear();
  });

  afterEach(() => {
    resetObservationIndexingRuntime();
    getSearchIndex().clear();
  });

  it("indexes compressed observations into BM25, vectors, and stored embeddings", async () => {
    const kv = mockKV();
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    const scheduleSave = vi.fn();
    const embed = vi.fn(async () => new Float32Array([0.1, 0.2, 0.3]));
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed,
      embedBatch: vi.fn(),
    };

    configureObservationIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: vector,
      scheduleSave,
    });

    await indexCompressedObservation(kv as never, bm25, makeObs());

    expect(bm25.search("auth")).toHaveLength(1);
    expect(vector.size).toBe(1);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
    const stored = await kv.get<any>(KV.embeddings("obs_1"), "data");
    expect(stored).toMatchObject({
      sessionId: "ses_1",
      provider: "test-embeddings",
      dimensions: 3,
    });
  });

  it("reuses cached embeddings when the indexed text has not changed", async () => {
    const kv = mockKV();
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    const scheduleSave = vi.fn();
    const embed = vi.fn(async () => new Float32Array([0.1, 0.2, 0.3]));
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed,
      embedBatch: vi.fn(),
    };

    configureObservationIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: vector,
      scheduleSave,
    });

    const obs = makeObs();
    await indexCompressedObservation(kv as never, bm25, obs);
    vector.clear();
    bm25.clear();

    await indexCompressedObservation(kv as never, bm25, obs);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(vector.size).toBe(1);
  });

  it("can skip embedding sync while still updating BM25", async () => {
    const kv = mockKV();
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    const scheduleSave = vi.fn();
    const embed = vi.fn(async () => new Float32Array([0.1, 0.2, 0.3]));
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed,
      embedBatch: vi.fn(),
    };

    configureObservationIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: vector,
      scheduleSave,
    });

    await indexCompressedObservation(kv as never, bm25, makeObs(), {
      syncEmbedding: false,
    });

    expect(bm25.search("auth")).toHaveLength(1);
    expect(vector.size).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    expect(await kv.get<any>(KV.embeddings("obs_1"), "data")).toBeNull();
  });

  it("rebuildIndex repopulates the vector index from stored compressed observations", async () => {
    const kv = mockKV();
    const vector = new VectorIndex();
    const scheduleSave = vi.fn();
    const embed = vi.fn(async () => new Float32Array([0.4, 0.5, 0.6]));
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed,
      embedBatch: vi.fn(),
    };

    configureObservationIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: vector,
      scheduleSave,
    });

    await indexCompressedObservation(kv as never, getSearchIndex(), makeObs());
    vector.clear();
    getSearchIndex().clear();
    embed.mockClear();

    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      startedAt: new Date().toISOString(),
      project: "/project",
    });
    await kv.set(KV.observations("ses_1"), "obs_1", makeObs());

    const rebuilt = await rebuildIndex(kv as never);

    expect(rebuilt).toBe(1);
    expect(getSearchIndex().search("auth")).toHaveLength(1);
    expect(vector.size).toBe(1);
    expect(embed).not.toHaveBeenCalled();
  });
});
