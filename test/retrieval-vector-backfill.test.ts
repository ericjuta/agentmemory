import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerRetrievalVectorBackfillFunction } from "../src/functions/retrieval-vector-backfill.js";
import {
  buildRetrievalBlockLexicalText,
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import { warmRetrievalBlockScopeMemberships } from "../src/functions/retrieval-block-scope-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { EmbeddingProvider, RetrievalBlock } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeBlock(id: string, eventAt: string): RetrievalBlock {
  return {
    id,
    sourceType: "memory",
    sourceId: id,
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: `Retrieval vector backfill block ${id}`,
    title: `Vector block ${id}`,
    files: ["src/functions/retrieval-vector-backfill.ts"],
    concepts: ["retrieval", "vector"],
    entities: [],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 7,
    createdAt: eventAt,
    updatedAt: eventAt,
    eventAt,
  };
}

async function storeBlocks(
  kv: ReturnType<typeof mockKV>,
  blocks: RetrievalBlock[],
): Promise<void> {
  for (const block of blocks) {
    await kv.set(KV.retrievalBlocks, block.id, block);
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      buildRetrievalBlockLexicalText(block),
    );
  }
  await warmRetrievalBlockScopeMemberships(kv as never, blocks);
}

describe("mem::retrieval-vector-backfill", () => {
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

  it("backfills only missing vectors and persists a cursor", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const vectorIndex = new VectorIndex();
    const scheduleSave = vi.fn();
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
    const blocks = [
      makeBlock("rblk-a", "2026-04-24T12:00:00.000Z"),
      makeBlock("rblk-b", "2026-04-24T12:01:00.000Z"),
      makeBlock("rblk-c", "2026-04-24T12:02:00.000Z"),
    ];
    await storeBlocks(kv, blocks);
    vectorIndex.add(blocks[0].id, blocks[0].project, new Float32Array([1, 0, 0]));
    registerRetrievalVectorBackfillFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-vector-backfill", {
      batchSize: 1,
      candidateScanLimit: 10,
      scheduleSave: true,
    })) as {
      eligibleCount: number;
      attempted: number;
      backfilled: number;
      vectorMissingAfter: number;
      cursor: { lastBlockId?: string };
    };

    expect(result.eligibleCount).toBe(3);
    expect(result.attempted).toBe(1);
    expect(result.backfilled).toBe(1);
    expect(result.vectorMissingAfter).toBe(1);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(vectorIndex.size).toBe(2);
    expect(scheduleSave).toHaveBeenCalledTimes(1);
    expect(result.cursor.lastBlockId).toBeDefined();
    expect(await kv.get(KV.config, "retrieval-vector-backfill-cursor")).toMatchObject({
      updatedAt: expect.any(String),
    });
  });

  it("pauses under LLM work gate without embedding or queueing retries", async () => {
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
    await storeBlocks(kv, [
      makeBlock("rblk-paused", "2026-04-24T12:00:00.000Z"),
    ]);
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
    registerRetrievalVectorBackfillFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-vector-backfill", {})) as {
      pauseReason?: string;
      attempted: number;
    };

    expect(result.pauseReason).toBe("cpu pressure");
    expect(result.attempted).toBe(0);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(await kv.list(KV.retrievalBlockRetry)).toHaveLength(0);
  });

  it("returns a bounded partial result when scope IDs cannot be listed", async () => {
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
    await storeBlocks(kv, [
      makeBlock("rblk-scope-timeout", "2026-04-24T12:00:00.000Z"),
    ]);
    const rawList = kv.list.bind(kv);
    const listSpy = vi.fn(async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.retrievalBlockIndex) {
        throw new Error("scope index timeout");
      }
      if (scope === KV.retrievalBlocks) {
        throw new Error("full retrieval block scan should not run");
      }
      return rawList(scope);
    });
    kv.list = listSpy as typeof kv.list;
    registerRetrievalVectorBackfillFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-vector-backfill", {
      dryRun: true,
    })) as {
      attempted: number;
      partial?: boolean;
      pauseReason?: string;
      source?: string;
    };

    expect(result).toMatchObject({
      attempted: 0,
      partial: true,
      pauseReason: "scope index timeout",
      source: "scope-index-unavailable",
    });
    expect(listSpy.mock.calls.some(([scope]) => scope === KV.retrievalBlocks)).toBe(false);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("reports failed provider calls through the existing retry queue", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const vectorIndex = new VectorIndex();
    const provider: EmbeddingProvider = {
      name: "test-embeddings",
      dimensions: 3,
      embed: vi.fn(async () => {
        throw new Error('Gemini embedding failed (429): {"error":{"status":"RESOURCE_EXHAUSTED"}}');
      }),
      embedBatch: vi.fn(async () => []),
    };
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: provider,
      vectorIndex,
      scheduleSave: vi.fn(),
    });
    const block = makeBlock("rblk-429", "2026-04-24T12:00:00.000Z");
    await storeBlocks(kv, [block]);
    registerRetrievalVectorBackfillFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-vector-backfill", {
      batchSize: 1,
    })) as { attempted: number; failed: number; backfilled: number };

    expect(result).toMatchObject({ attempted: 1, failed: 1, backfilled: 0 });
    expect(await kv.get(KV.retrievalBlockRetry, block.id)).toMatchObject({
      blockId: block.id,
      sourceType: block.sourceType,
    });
  });

  it("dry-runs missing vectors without embedding or advancing the cursor", async () => {
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
    await storeBlocks(kv, [
      makeBlock("rblk-dry-run", "2026-04-24T12:00:00.000Z"),
    ]);
    registerRetrievalVectorBackfillFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-vector-backfill", {
      dryRun: true,
      coverageTarget: 0.98,
    })) as { dryRun: boolean; attempted: number; complete: boolean };

    expect(result).toMatchObject({
      dryRun: true,
      attempted: 1,
      complete: false,
    });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(await kv.get(KV.config, "retrieval-vector-backfill-cursor")).toBeNull();
  });

  it("computes coverage from active IDs instead of raw vector index size", async () => {
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
    const blocks = [
      makeBlock("rblk-active-vector", "2026-04-24T12:00:00.000Z"),
      makeBlock("rblk-missing-vector", "2026-04-24T12:01:00.000Z"),
    ];
    await storeBlocks(kv, blocks);
    vectorIndex.add(blocks[0].id, blocks[0].project, new Float32Array([1, 0, 0]));
    vectorIndex.add("rblk-stale-vector", "/other", new Float32Array([0, 1, 0]));
    registerRetrievalVectorBackfillFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-vector-backfill", {
      dryRun: true,
      coverageTarget: 0.98,
    })) as {
      eligibleCount: number;
      vectorPresentBefore: number;
      vectorMissingBefore: number;
      vectorCoverageRatioBefore: number;
      complete: boolean;
    };

    expect(result).toMatchObject({
      eligibleCount: 2,
      vectorPresentBefore: 1,
      vectorMissingBefore: 1,
      vectorCoverageRatioBefore: 0.5,
      complete: false,
    });
    expect(provider.embed).not.toHaveBeenCalled();
  });
});
