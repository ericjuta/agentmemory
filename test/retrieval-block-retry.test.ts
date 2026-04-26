import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRetrievalBlockRetryFunction } from "../src/functions/retrieval-block-retry.js";
import { KV } from "../src/state/schema.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type {
  EmbeddingProvider,
  Memory,
  RetrievalBlock,
  RetrievalBlockRetryEntry,
} from "../src/types.js";
import { configureRetrievalBlockIndexingRuntime } from "../src/state/retrieval-block-indexing.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeBlock(id: string): RetrievalBlock {
  return {
    id,
    sourceType: "memory",
    sourceId: id,
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: `## Memory\n${id}`,
    title: id,
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

function makeMemory(id: string): Memory {
  return {
    id,
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:00:00.000Z",
    type: "architecture",
    title: "Auth memory",
    content: "Auth handler uses token validation.",
    concepts: ["auth"],
    files: ["/project/src/auth.ts"],
    project: "/project",
    sessionIds: ["ses_1"],
    strength: 0.8,
    version: 1,
    isLatest: true,
  };
}

describe("retrieval block retry", () => {
  afterEach(() => {
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
    });
  });

  it("retries queued retrieval block indexing and clears successful entries", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: new VectorIndex(),
      scheduleSave: vi.fn(),
    });

    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    const block = makeBlock("rblk-retry");
    const entry: RetrievalBlockRetryEntry = {
      blockId: block.id,
      sourceType: block.sourceType,
      retries: 0,
      firstFailedAt: "2026-04-23T14:55:48.000Z",
      lastFailedAt: "2026-04-23T14:55:48.000Z",
      lastError: "Gemini embedding failed (429): RESOURCE_EXHAUSTED",
    };

    await kv.set(KV.retrievalBlocks, block.id, block);
    await kv.set(KV.retrievalBlockRetry, block.id, entry);

    const result = await sdk.trigger("mem::retrieval-block-retry", {});

    expect(result).toEqual({
      retried: 0,
      removed: 0,
      succeeded: 1,
      skipped: 0,
      deferred: 0,
      processed: 1,
    });
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toBeNull();
    expect(await kv.get(KV.retrievalBlockEmbeddings(block.id), "data")).toBeTruthy();
  });

  it("increments retry counts for retriable failures and drops exhausted entries", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi
        .fn<() => Promise<Float32Array>>()
        .mockRejectedValue(new Error("StateKV state::set timed out after 5000ms")),
      embedBatch: vi.fn(async () => []),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: new VectorIndex(),
      scheduleSave: vi.fn(),
    });

    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    const block = makeBlock("rblk-retry-fail");
    await kv.set(KV.retrievalBlocks, block.id, block);
    await kv.set(KV.retrievalBlockRetry, block.id, {
      blockId: block.id,
      sourceType: block.sourceType,
      retries: 1,
      firstFailedAt: "2026-04-23T14:55:48.000Z",
      lastFailedAt: "2026-04-23T14:55:48.000Z",
      lastError: "StateKV state::set timed out after 5000ms",
    } satisfies RetrievalBlockRetryEntry);

    const first = (await sdk.trigger("mem::retrieval-block-retry", {})) as {
      retried: number;
      removed: number;
      succeeded: number;
    };
    const updated = await kv.get<RetrievalBlockRetryEntry>(KV.retrievalBlockRetry, block.id);

    expect(first).toMatchObject({ retried: 1, removed: 0, succeeded: 0 });
    expect(updated?.retries).toBe(2);
    expect(updated?.nextAttemptAt).toEqual(expect.any(String));

    await kv.set(KV.retrievalBlockRetry, block.id, {
      ...updated!,
      nextAttemptAt: "2026-04-23T14:55:48.000Z",
    });

    const second = (await sdk.trigger("mem::retrieval-block-retry", {})) as {
      retried: number;
      removed: number;
      succeeded: number;
    };

    expect(second).toMatchObject({ retried: 1, removed: 0, succeeded: 0 });
    const exhausted = await kv.get<RetrievalBlockRetryEntry>(
      KV.retrievalBlockRetry,
      block.id,
    );
    expect(exhausted?.retries).toBe(3);

    await kv.set(KV.retrievalBlockRetry, block.id, {
      ...exhausted!,
      nextAttemptAt: "2026-04-23T14:55:48.000Z",
    });

    const third = (await sdk.trigger("mem::retrieval-block-retry", {})) as {
      retried: number;
      removed: number;
      succeeded: number;
    };

    expect(third).toMatchObject({ retried: 0, removed: 1, succeeded: 0 });
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toBeNull();
  });

  it("skips queued entries whose next attempt is in the future", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: new VectorIndex(),
      scheduleSave: vi.fn(),
    });
    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    const block = makeBlock("rblk-future");
    await kv.set(KV.retrievalBlocks, block.id, block);
    await kv.set(KV.retrievalBlockRetry, block.id, {
      blockId: block.id,
      sourceType: block.sourceType,
      retries: 0,
      firstFailedAt: "2026-04-23T14:55:48.000Z",
      lastFailedAt: "2026-04-23T14:55:48.000Z",
      nextAttemptAt: "2999-01-01T00:00:00.000Z",
      lastError: "Gemini embedding failed (429): RESOURCE_EXHAUSTED",
    } satisfies RetrievalBlockRetryEntry);

    const result = await sdk.trigger("mem::retrieval-block-retry", {});

    expect(result).toEqual({
      retried: 0,
      removed: 0,
      succeeded: 0,
      skipped: 1,
      deferred: 0,
      processed: 0,
    });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toBeTruthy();
  });

  it("can ignore retry backoff for operator-initiated catch-up", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: new VectorIndex(),
      scheduleSave: vi.fn(),
    });
    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    const block = makeBlock("rblk-future-catch-up");
    await kv.set(KV.retrievalBlocks, block.id, block);
    await kv.set(KV.retrievalBlockRetry, block.id, {
      blockId: block.id,
      sourceType: block.sourceType,
      retries: 0,
      firstFailedAt: "2026-04-23T14:55:48.000Z",
      lastFailedAt: "2026-04-23T14:55:48.000Z",
      nextAttemptAt: "2999-01-01T00:00:00.000Z",
      lastError: "StateKV state::set timed out after 5000ms",
    } satisfies RetrievalBlockRetryEntry);

    const result = await sdk.trigger("mem::retrieval-block-retry", {
      ignoreBackoff: true,
    });

    expect(result).toMatchObject({ succeeded: 1, skipped: 0, processed: 1 });
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toBeNull();
  });

  it("processes no more than the configured retry batch cap", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };

    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex: new VectorIndex(),
      scheduleSave: vi.fn(),
    });
    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    for (let i = 0; i < 3; i++) {
      const block = makeBlock(`rblk-cap-${i}`);
      await kv.set(KV.retrievalBlocks, block.id, block);
      await kv.set(KV.retrievalBlockRetry, block.id, {
        blockId: block.id,
        sourceType: block.sourceType,
        retries: 0,
        firstFailedAt: "2026-04-23T14:55:48.000Z",
        lastFailedAt: "2026-04-23T14:55:48.000Z",
        lastError: "Gemini embedding failed (429): RESOURCE_EXHAUSTED",
      } satisfies RetrievalBlockRetryEntry);
    }

    const result = await sdk.trigger("mem::retrieval-block-retry", {
      batchSize: 2,
    });

    expect(result).toEqual({
      retried: 0,
      removed: 0,
      succeeded: 2,
      skipped: 0,
      deferred: 1,
      processed: 2,
    });
    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(await kv.list(KV.retrievalBlockRetry)).toHaveLength(1);
  });

  it("refreshes missing source-derived retrieval blocks during catch-up", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const originalList = kv.list.bind(kv);
    const listSpy = vi.spyOn(kv, "list").mockImplementation(async (scope: string) => {
      if (scope === KV.retrievalBlocks) {
        throw new Error("full retrieval block list should not run");
      }
      return originalList(scope);
    });
    const memory = makeMemory("mem_source");
    await kv.set(KV.memories, memory.id, memory);
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: vi.fn(),
    });
    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-block-retry", {
      refreshFromState: true,
      batchSize: 5,
    })) as { refreshed: number; refreshIndexed: number };

    expect(result).toMatchObject({ refreshed: 1, refreshIndexed: 1 });
    expect(listSpy).not.toHaveBeenCalledWith(KV.retrievalBlocks);
    listSpy.mockRestore();
    const blocks = await kv.list<RetrievalBlock>(KV.retrievalBlocks);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      sourceType: "memory",
      sourceId: memory.id,
      project: "/project",
    });
  });

  it("persists queued upsert blocks before retrying their index", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const block = makeBlock("rblk-upsert");
    await kv.set(KV.retrievalBlockRetry, block.id, {
      blockId: block.id,
      sourceType: block.sourceType,
      operation: "upsert",
      block,
      retries: 0,
      firstFailedAt: "2026-04-23T14:55:48.000Z",
      lastFailedAt: "2026-04-23T14:55:48.000Z",
      lastError: "health_unhealthy",
    } satisfies RetrievalBlockRetryEntry);
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: vi.fn(),
    });
    registerRetrievalBlockRetryFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::retrieval-block-retry", {});

    expect(result).toMatchObject({ succeeded: 1, removed: 0 });
    expect(await kv.get(KV.retrievalBlocks, block.id)).toEqual(block);
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toBeNull();
  });
});
