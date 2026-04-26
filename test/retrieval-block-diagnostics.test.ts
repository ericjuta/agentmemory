import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerRetrievalBlockDiagnosticsFunction } from "../src/functions/retrieval-block-diagnostics.js";
import {
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { RetrievalBlock } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeBlock(id: string): RetrievalBlock {
  return {
    id,
    sourceType: "memory",
    sourceId: id,
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: `Retrieval block ${id}`,
    title: `Retrieval block ${id}`,
    files: [],
    concepts: ["retrieval"],
    entities: [],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 5,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    eventAt: "2026-04-24T12:00:00.000Z",
  };
}

describe("mem::retrieval-blocks-diagnostics", () => {
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

  it("uses manifest and scope memberships without listing all retrieval blocks", async () => {
    const sdk = mockSdk();
    const baseKv = mockKV();
    const list = vi.fn(async () => {
      throw new Error("full scan should not run");
    });
    const kv = { ...baseKv, list };
    const block = makeBlock("rblk_1");
    await baseKv.set(KV.retrievalBlocks, block.id, block);
    await baseKv.set(KV.retrievalBlockIndex, "scope:global", {
      ids: [],
      updatedAt: "2026-04-24T12:00:00.000Z",
    });
    await baseKv.set(KV.retrievalBlockIndex, "scope:project:%2Fproject", {
      ids: [block.id],
      updatedAt: "2026-04-24T12:00:00.000Z",
    });
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      persistenceStatus: () => ({
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "ok",
        manifest: {
          savedAt: "2026-04-24T12:00:00.000Z",
          bm25Shards: 3,
          vectorShards: 0,
          bm25Bytes: 1024,
          vectorBytes: 0,
          documentCount: 123,
          vectorCount: 0,
        },
      }),
    });
    registerRetrievalBlockDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-blocks-diagnostics", {
      project: "/project",
      sampleLimit: 1,
      largeScanThreshold: 100,
    })) as {
      fullScanAvoided: boolean;
      manifestDocumentCount: number;
      estimatedFullScanCount: number;
      scanRisk: { level: string };
      quality: {
        bm25Coverage: number;
        vectorCoverage: number;
        vectorMissingCount: number;
        deferredFreshnessLag: { queuedCount: number };
      };
      sampleCount: number;
      samples: Array<{ id: string; project?: string }>;
    };

    expect(result.fullScanAvoided).toBe(true);
    expect(result.manifestDocumentCount).toBe(123);
    expect(result.estimatedFullScanCount).toBe(123);
    expect(result.scanRisk.level).toBe("high");
    expect(result.quality).toMatchObject({
      bm25Coverage: 0,
      vectorCoverage: 0,
      vectorEligibleCount: 1,
      vectorIndexedCount: 0,
      vectorMissingCount: 1,
      deferredFreshnessLag: { queuedCount: 0 },
    });
    expect(result.sampleCount).toBe(1);
    expect(result.samples[0]).toMatchObject({ id: block.id, project: "/project" });
    expect(list.mock.calls.some(([scope]) => scope === KV.retrievalBlocks)).toBe(
      false,
    );
  });

  it("reports scoped vector coverage from the live vector index", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const block = makeBlock("rblk_vector");
    const vectorIndex = new VectorIndex();
    vectorIndex.add(block.id, block.project, new Float32Array([1, 0, 0]));
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      block.canonicalText,
    );
    await kv.set(KV.retrievalBlocks, block.id, block);
    await kv.set(KV.retrievalBlockIndex, "scope:project:%2Fproject", {
      ids: [block.id],
      updatedAt: "2026-04-24T12:00:00.000Z",
    });
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex,
      persistenceStatus: () => ({
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "ok",
        manifest: {
          savedAt: "2026-04-24T12:00:00.000Z",
          bm25Shards: 1,
          vectorShards: 0,
          bm25Bytes: 256,
          vectorBytes: 0,
          documentCount: 99,
          vectorCount: 0,
        },
      }),
    });
    registerRetrievalBlockDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-blocks-diagnostics", {
      project: "/project",
    })) as {
      quality: {
        bm25Coverage: number;
        vectorCoverage: number;
        vectorEligibleCount: number;
        vectorIndexedCount: number;
        vectorMissingCount: number;
      };
    };

    expect(result.quality).toMatchObject({
      bm25Coverage: 1,
      vectorCoverage: 1,
      vectorEligibleCount: 1,
      vectorIndexedCount: 1,
      vectorMissingCount: 0,
    });
  });
});
