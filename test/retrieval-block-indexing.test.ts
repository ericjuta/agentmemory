import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { EmbeddingProvider, RetrievalBlock } from "../src/types.js";
import {
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  indexRetrievalBlock,
  rebuildRetrievalBlockIndex,
  verifyRetrievalBlockIndex,
} from "../src/state/retrieval-block-indexing.js";
import { logger } from "../src/logger.js";

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

async function storeBlocks(
  kv: ReturnType<typeof mockKV>,
  count: number,
): Promise<RetrievalBlock[]> {
  const blocks: RetrievalBlock[] = [];
  for (let i = 0; i < count; i++) {
    const block = makeBlock(`rblk-${i}`, `Auth memory ${i}`);
    await kv.set(KV.retrievalBlocks, block.id, block);
    blocks.push(block);
  }
  return blocks;
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

  it("chunks stale embeddings during retrieval block rebuilds", async () => {
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
    await storeBlocks(kv, 5);

    await rebuildRetrievalBlockIndex(kv as never, { embeddingBatchSize: 2 });

    expect(provider.embedBatch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(provider.embedBatch).mock.calls.map(([texts]) => texts.length)).toEqual([
      2,
      2,
      1,
    ]);
    expect(vectorIndex.size).toBe(5);
  });

  it("queues retriable embedding failures and clears them after a later success", async () => {
    const kv = mockKV();
    const scheduleSave = vi.fn();
    const vectorIndex = new VectorIndex();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi
        .fn<() => Promise<Float32Array>>()
        .mockRejectedValueOnce(
          new Error('Gemini embedding failed (429): {"error":{"status":"RESOURCE_EXHAUSTED"}}'),
        )
        .mockResolvedValueOnce(new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex,
      scheduleSave,
    });

    const block = makeBlock("rblk-queue", "Queued memory");
    const failed = await indexRetrievalBlock(kv as never, block);
    const queued = await kv.get<any>(KV.retrievalBlockRetry, block.id);

    expect(failed).toEqual({
      success: false,
      retriable: true,
      error: 'Gemini embedding failed (429): {"error":{"status":"RESOURCE_EXHAUSTED"}}',
    });
    expect(queued).toMatchObject({
      blockId: block.id,
      sourceType: block.sourceType,
      retries: 0,
      nextAttemptAt: expect.any(String),
    });
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to index retrieval block embedding",
      expect.objectContaining({
        blockId: block.id,
        retriable: true,
        queuedRetry: true,
      }),
    );

    const recovered = await indexRetrievalBlock(kv as never, block);

    expect(recovered).toEqual({ success: true, retriable: false });
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toBeNull();
    expect(scheduleSave).toHaveBeenCalledTimes(2);
    expect(vectorIndex.size).toBe(1);
  });

  it("queues StateKV embedding persistence timeouts for deferred retry", async () => {
    const kv = mockKV();
    const originalSet = kv.set;
    const scheduleSave = vi.fn();
    const vectorIndex = new VectorIndex();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.3, 0.2, 0.1])),
      embedBatch: vi.fn(async () => []),
    };

    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.retrievalBlockEmbeddings("rblk-kv")) {
        throw new Error("StateKV state::set timed out after 5000ms");
      }
      return originalSet(scope, key, data);
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex,
      scheduleSave,
    });

    const block = makeBlock("rblk-kv", "KV timeout memory");
    const result = await indexRetrievalBlock(kv as never, block);

    expect(result).toEqual({
      success: false,
      retriable: true,
      error: "StateKV state::set timed out after 5000ms",
    });
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toMatchObject({
      blockId: block.id,
      lastError: "StateKV state::set timed out after 5000ms",
      nextAttemptAt: expect.any(String),
    });
  });

  it("verifier triggers rebuild when retrieval BM25 drift exceeds threshold", async () => {
    const kv = mockKV();
    const scheduleSave = vi.fn();
    const rebuild = vi.fn(async () => 60);
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave,
    });
    await storeBlocks(kv, 60);

    const result = await verifyRetrievalBlockIndex(kv as never, { rebuild });

    expect(result).toMatchObject({
      blockCount: 60,
      bm25Size: 0,
      bm25Drift: 60,
      rebuilt: 60,
      repaired: true,
    });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });

  it("verifier triggers rebuild when retrieval vector index is empty but blocks exist", async () => {
    const kv = mockKV();
    const vectorIndex = new VectorIndex();
    const scheduleSave = vi.fn();
    const rebuild = vi.fn(async () => 2);
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex,
      scheduleSave,
    });
    const blocks = await storeBlocks(kv, 2);
    for (const block of blocks) {
      getRetrievalSearchIndex().addDocument(
        block.id,
        block.project,
        block.canonicalText,
      );
    }

    const result = await verifyRetrievalBlockIndex(kv as never, { rebuild });

    expect(result).toMatchObject({
      blockCount: 2,
      bm25Size: 2,
      vectorSize: 0,
      expectedVectorCount: 2,
      vectorDrift: 2,
      rebuilt: 2,
      repaired: true,
    });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });

  it("verifier does not rebuild for tiny harmless retrieval index drift", async () => {
    const kv = mockKV();
    const rebuild = vi.fn(async () => 10);
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: vi.fn(),
    });
    const blocks = await storeBlocks(kv, 10);
    for (const block of blocks.slice(0, 9)) {
      getRetrievalSearchIndex().addDocument(
        block.id,
        block.project,
        block.canonicalText,
      );
    }

    const result = await verifyRetrievalBlockIndex(kv as never, { rebuild });

    expect(result).toMatchObject({
      blockCount: 10,
      bm25Size: 9,
      bm25Drift: 1,
      rebuilt: 0,
      repaired: false,
    });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("verifier reports rebuild failures without throwing", async () => {
    const kv = mockKV();
    const rebuild = vi.fn(async () => {
      throw new Error("rebuild unavailable");
    });
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: vi.fn(),
    });
    await storeBlocks(kv, 60);

    const result = await verifyRetrievalBlockIndex(kv as never, { rebuild });

    expect(result).toMatchObject({
      rebuilt: 0,
      repaired: false,
      error: "rebuild unavailable",
    });
  });
});
