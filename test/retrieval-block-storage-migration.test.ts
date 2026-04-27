import { describe, expect, it, vi } from "vitest";

import { registerRetrievalBlockStorageMigrationFunction } from "../src/functions/retrieval-block-storage-migration.js";
import { KV, retrievalBlockShardScope } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("mem::retrieval-blocks-migrate-shards", () => {
  it("moves legacy retrieval blocks into shard scopes and deletes legacy rows", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const block = {
      id: "rblk_1",
      sourceType: "memory",
      sourceId: "mem_1",
      canonicalText: "Memory one",
    };
    await kv.set(KV.retrievalBlocks, block.id, block);
    registerRetrievalBlockStorageMigrationFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-blocks-migrate-shards", {
      batchSize: 10,
    })) as {
      success: boolean;
      legacyCount: number;
      migrated: number;
      deletedLegacy: number;
      remainingEstimate: number;
    };

    expect(result).toMatchObject({
      success: true,
      legacyCount: 1,
      migrated: 1,
      deletedLegacy: 1,
      remainingEstimate: 0,
    });
    await expect(kv.get(KV.retrievalBlocks, block.id)).resolves.toBeNull();
    await expect(
      kv.get(retrievalBlockShardScope(block.id), block.id),
    ).resolves.toEqual(block);
  });

  it("supports dry-run without moving rows", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const block = {
      id: "rblk_2",
      sourceType: "memory",
      sourceId: "mem_2",
      canonicalText: "Memory two",
    };
    await kv.set(KV.retrievalBlocks, block.id, block);
    registerRetrievalBlockStorageMigrationFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-blocks-migrate-shards", {
      dryRun: true,
    })) as { dryRun: boolean; migrated: number; remainingEstimate: number };

    expect(result).toMatchObject({
      dryRun: true,
      migrated: 1,
      remainingEstimate: 1,
    });
    await expect(kv.get(KV.retrievalBlocks, block.id)).resolves.toEqual(block);
    await expect(
      kv.get(retrievalBlockShardScope(block.id), block.id),
    ).resolves.toBeNull();
  });

  it("keeps partial migration batches incomplete", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    for (const id of ["rblk_3", "rblk_4"]) {
      await kv.set(KV.retrievalBlocks, id, {
        id,
        sourceType: "memory",
        sourceId: "mem_" + id,
      });
    }
    registerRetrievalBlockStorageMigrationFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-blocks-migrate-shards", {
      batchSize: 1,
    })) as {
      completed: boolean;
      processed: number;
      remainingEstimate: number;
    };

    expect(result).toMatchObject({
      completed: false,
      processed: 1,
      remainingEstimate: 1,
    });
  });

  it("migrates by indexed candidate ids without listing the legacy scope", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const block = {
      id: "rblk_5",
      sourceType: "memory",
      sourceId: "mem_5",
    };
    await kv.set(KV.retrievalBlocks, block.id, block);
    const list = vi.fn(async () => {
      throw new Error("legacy list should not run");
    });
    const candidateKv = { ...kv, list };
    registerRetrievalBlockStorageMigrationFunction(
      sdk as never,
      candidateKv as never,
      { candidateIds: () => [block.id] },
    );

    const result = (await sdk.trigger("mem::retrieval-blocks-migrate-shards", {
      batchSize: 10,
    })) as {
      completed: boolean;
      source: string;
      candidateCount: number;
      legacyCount: number;
      migrated: number;
      deletedLegacy: number;
    };

    expect(result).toMatchObject({
      completed: true,
      source: "index-candidates",
      candidateCount: 1,
      legacyCount: 1,
      migrated: 1,
      deletedLegacy: 1,
    });
    expect(list).not.toHaveBeenCalled();
    await expect(kv.get(KV.retrievalBlocks, block.id)).resolves.toBeNull();
    await expect(
      kv.get(retrievalBlockShardScope(block.id), block.id),
    ).resolves.toEqual(block);
  });
});
