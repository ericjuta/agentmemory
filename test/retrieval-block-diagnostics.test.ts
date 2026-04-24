import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerRetrievalBlockDiagnosticsFunction } from "../src/functions/retrieval-block-diagnostics.js";
import {
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
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
      sampleCount: number;
      samples: Array<{ id: string; project?: string }>;
    };

    expect(result.fullScanAvoided).toBe(true);
    expect(result.manifestDocumentCount).toBe(123);
    expect(result.estimatedFullScanCount).toBe(123);
    expect(result.scanRisk.level).toBe("high");
    expect(result.sampleCount).toBe(1);
    expect(result.samples[0]).toMatchObject({ id: block.id, project: "/project" });
    expect(list).not.toHaveBeenCalled();
  });
});
