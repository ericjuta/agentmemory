import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { EmbeddingProvider, RetrievalBlock } from "../src/types.js";
import {
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  rebuildRetrievalBlockIndex,
} from "../src/state/retrieval-block-indexing.js";

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

function makeBlock(id: string, title: string): RetrievalBlock {
  return {
    id,
    sourceType: "memory",
    sourceId: id,
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: `## Memory\n${title}`,
    title,
    files: ["/project/src/auth.ts"],
    concepts: ["auth"],
    entities: ["auth"],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: true,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 8,
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:00:00.000Z",
    eventAt: "2026-03-29T12:00:00.000Z",
  };
}

describe("retrieval block indexing", () => {
  beforeEach(() => {
    getRetrievalSearchIndex().clear();
  });

  afterEach(() => {
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
    });
    getRetrievalSearchIndex().clear();
  });

  it("uses embedBatch during retrieval block rebuilds and then reuses cached vectors", async () => {
    const kv = mockKV();
    const vectorIndex = new VectorIndex();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map((_, index) => new Float32Array([index + 1, index + 2, index + 3])),
      ),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex,
      scheduleSave: undefined,
    });

    const first = makeBlock("rblk-1", "Auth memory one");
    const second = makeBlock("rblk-2", "Auth memory two");
    await kv.set(KV.retrievalBlocks, first.id, first);
    await kv.set(KV.retrievalBlocks, second.id, second);

    const rebuilt = await rebuildRetrievalBlockIndex(kv as never);

    expect(rebuilt).toBe(2);
    expect(provider.embedBatch).toHaveBeenCalledTimes(1);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(vectorIndex.size).toBe(2);
    expect(getRetrievalSearchIndex().searchDocuments("auth memory")).toHaveLength(2);

    vectorIndex.clear();
    getRetrievalSearchIndex().clear();
    vi.mocked(provider.embedBatch).mockClear();

    await rebuildRetrievalBlockIndex(kv as never);

    expect(provider.embedBatch).not.toHaveBeenCalled();
    expect(vectorIndex.size).toBe(2);
  });
});
