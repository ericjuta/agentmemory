import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerRetrievalIndexVerifyFunction } from "../src/functions/retrieval-index-verify.js";
import {
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { EmbeddingProvider, RetrievalBlock } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeBlock(id: string): RetrievalBlock {
  return {
    id,
    sourceType: "memory",
    sourceId: id,
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: `## Memory\nRetrieval verify ${id}`,
    title: `Retrieval verify ${id}`,
    files: ["/project/src/state/retrieval-block-indexing.ts"],
    concepts: ["retrieval", "verify"],
    entities: [],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 7,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    eventAt: "2026-04-24T12:00:00.000Z",
  };
}

async function storeBlocks(
  kv: ReturnType<typeof mockKV>,
  count: number,
): Promise<RetrievalBlock[]> {
  const blocks: RetrievalBlock[] = [];
  for (let i = 0; i < count; i++) {
    const block = makeBlock(`rblk-verify-${i}`);
    await kv.set(KV.retrievalBlocks, block.id, block);
    blocks.push(block);
  }
  return blocks;
}

describe("mem::retrieval-index-verify", () => {
  beforeEach(() => {
    getRetrievalSearchIndex().clear();
  });

  afterEach(() => {
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
      persistenceStatus: undefined,
    });
    getRetrievalSearchIndex().clear();
  });

  it("returns no-op verification results when the retrieval index is aligned", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const scheduleSave = vi.fn();
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave,
      persistenceStatus: () => ({
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "ok",
      }),
    });
    const [block] = await storeBlocks(kv, 1);
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      block.canonicalText,
    );
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-index-verify", {})) as {
      blockCount: number;
      bm25Size: number;
      repaired: boolean;
      persistence?: { status: string };
    };

    expect(result).toMatchObject({
      blockCount: 1,
      bm25Size: 1,
      repaired: false,
      persistence: { status: "ok" },
    });
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it("rebuilds and schedules save when retrieval BM25 drift is over threshold", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const scheduleSave = vi.fn();
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave,
    });
    await storeBlocks(kv, 60);
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-index-verify", {})) as {
      blockCount: number;
      bm25Size: number;
      rebuilt: number;
      repaired: boolean;
    };

    expect(result).toMatchObject({
      blockCount: 60,
      bm25Size: 0,
      rebuilt: 60,
      repaired: true,
    });
    expect(getRetrievalSearchIndex().size).toBe(60);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
  });

  it("can report drift without repairing when repair is disabled", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const scheduleSave = vi.fn();
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave,
    });
    await storeBlocks(kv, 60);
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-index-verify", {
      repair: false,
    })) as {
      blockCount: number;
      bm25Size: number;
      bm25Drift: number;
      rebuilt: number;
      repaired: boolean;
    };

    expect(result).toMatchObject({
      blockCount: 60,
      bm25Size: 0,
      bm25Drift: 60,
      rebuilt: 0,
      repaired: false,
    });
    expect(getRetrievalSearchIndex().size).toBe(0);
    expect(scheduleSave).not.toHaveBeenCalled();
  });

  it("can verify from the persistence manifest without scanning retrieval blocks", async () => {
    const sdk = mockSdk();
    const kv = {
      ...mockKV(),
      list: vi.fn(async () => {
        throw new Error("scan should not run");
      }),
    };
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      persistenceStatus: () => ({
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "ok",
        manifest: {
          savedAt: "2026-04-24T12:00:00.000Z",
          bm25Shards: 2,
          vectorShards: 1,
          bm25Bytes: 500,
          vectorBytes: 100,
          documentCount: 42,
          vectorCount: 10,
        },
      }),
    });
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-index-verify", {
      scanBlocks: false,
    })) as {
      blockCount: number;
      bm25Size: number;
      bm25Drift: number;
      repaired: boolean;
    };

    expect(result).toMatchObject({
      blockCount: 42,
      bm25Size: 0,
      bm25Drift: 42,
      repaired: false,
    });
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("reports observation and retrieval persistence scopes separately", async () => {
    const sdk = mockSdk();
    const kv = {
      ...mockKV(),
      list: vi.fn(async () => {
        throw new Error("scan should not run");
      }),
    };
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      persistenceStatus: () => ({
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "ok",
      }),
    });
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never, {
      observationPersistenceStatus: () => ({
        scope: KV.bm25Index,
        mode: "sharded",
        status: "ok",
      }),
    });

    const result = (await sdk.trigger("mem::retrieval-index-verify", {
      scanBlocks: false,
    })) as {
      persistenceScopes?: {
        observation?: { scope: string; mode: string; status: string };
        retrieval?: { scope: string; mode: string; status: string };
      };
    };

    expect(result.persistenceScopes).toEqual({
      observation: {
        scope: KV.bm25Index,
        mode: "sharded",
        status: "ok",
      },
      retrieval: {
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "ok",
      },
    });
    expect(kv.list).not.toHaveBeenCalled();
  });

  it("defers direct vector backfill while LLM work is health-gated", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const vectorIndex = new VectorIndex();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex,
      scheduleSave: vi.fn(),
    });
    const [block] = await storeBlocks(kv, 1);
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      block.canonicalText,
    );
    await kv.set(KV.health, "latest", {
      connectionState: "connected",
      workers: [],
      memory: { heapUsed: 1, heapTotal: 2, rss: 3, external: 0 },
      cpu: { userMicros: 1, systemMicros: 1, percent: 99 },
      eventLoopLagMs: 0,
      uptimeSeconds: 1,
      kvConnectivity: { status: "ok" },
      snapshotPersistence: { status: "ok", consecutiveFailures: 0 },
      status: "critical",
      alerts: ["cpu pressure"],
    });
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-index-verify", {})) as {
      vectorBackfilled: number;
      vectorBackfillDeferred: number;
      writeGates?: { llmWork?: string | null };
    };

    expect(result.vectorBackfilled).toBe(0);
    expect(result.vectorBackfillDeferred).toBe(1);
    expect(result.writeGates?.llmWork).toBe("cpu pressure");
    expect(provider.embed).not.toHaveBeenCalled();
    expect(vectorIndex.size).toBe(0);
  });
});

describe("api::retrieval-index-verify", () => {
  it("requires API auth when a secret is configured", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalIndexVerifyFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::retrieval-index-verify", {
      body: {},
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response).toEqual({
      status_code: 401,
      body: { error: "unauthorized" },
    });
  });

  it("validates and forwards whitelisted verify options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::retrieval-index-verify", async (payload) => {
      forwarded = payload;
      return { blockCount: 0, repaired: false };
    });

    const response = (await sdk.trigger("api::retrieval-index-verify", {
      body: {
        bm25DriftRatio: "0.05",
        vectorDriftRatio: 0.1,
        minAbsoluteDrift: 10,
        scheduleSave: false,
        repair: false,
        vectorBackfill: false,
        vectorBackfillLimit: "7",
        ignored: "field",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { blockCount: number } };

    expect(response.status_code).toBe(200);
    expect(response.body.blockCount).toBe(0);
    expect(forwarded).toEqual({
      bm25DriftRatio: 0.05,
      vectorDriftRatio: 0.1,
      minAbsoluteDrift: 10,
      scheduleSave: false,
      repair: false,
      vectorBackfill: false,
      vectorBackfillLimit: 7,
      scanBlocks: false,
    });
  });

  it("rejects invalid verify options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::retrieval-index-verify", {
      body: { minAbsoluteDrift: -1 },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("must be non-negative numbers");
  });

  it("validates and forwards retrieval vector backfill options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::retrieval-vector-backfill", async (payload) => {
      forwarded = payload;
      return { success: true, backfilled: 1 };
    });

    const response = (await sdk.trigger("api::retrieval-vector-backfill", {
      body: {
        batchSize: "4",
        candidateScanLimit: 40,
        timeBudgetMs: "1000",
        coverageTarget: "0.98",
        concurrency: 2,
        scheduleSave: false,
        resetCursor: true,
        dryRun: true,
        ignored: "field",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { backfilled: number } };

    expect(response.status_code).toBe(200);
    expect(response.body.backfilled).toBe(1);
    expect(forwarded).toEqual({
      batchSize: 4,
      candidateScanLimit: 40,
      timeBudgetMs: 1000,
      coverageTarget: 0.98,
      concurrency: 2,
      scheduleSave: false,
      resetCursor: true,
      dryRun: true,
    });
  });

  it("rejects invalid retrieval vector backfill options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::retrieval-vector-backfill", {
      body: { batchSize: 0 },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("batchSize");
  });
});
