import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { registerIndexPersistenceCompactionFunction } from "../src/functions/index-persistence-compaction.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function writeScopeFile(dataDir: string, scope: string, bytes: number): void {
  writeFileSync(join(dataDir, encodeURIComponent(scope) + ".bin"), "x".repeat(bytes));
}

describe("mem::index-persistence-compact", () => {
  it("defers compaction while the index write gate is closed", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const save = vi.fn();
    await kv.set(KV.health, "latest", {
      status: "critical",
      alerts: ["cpu_critical_95%"],
      connectionState: "connected",
      kvConnectivity: { status: "ok" },
      snapshotPersistence: { status: "ok" },
    });
    registerIndexPersistenceCompactionFunction(sdk as never, kv as never, {
      observation: {
        save,
        status: () => ({ scope: KV.bm25Index, mode: "sharded", status: "ok" }),
      },
      retrieval: {
        save,
        status: () => ({
          scope: KV.retrievalBlockIndex,
          mode: "sharded",
          status: "ok",
        }),
      },
    });

    const result = (await sdk.trigger("mem::index-persistence-compact", {})) as {
      status: string;
      reason: string;
    };

    expect(result.status).toBe("deferred");
    expect(result.reason).toBe("cpu_critical_95%");
    expect(save).not.toHaveBeenCalled();
  });

  it("runs forced compaction and verifies retrieval drift", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const observationSave = vi.fn();
    const retrievalSave = vi.fn();
    sdk.registerFunction("mem::retrieval-index-verify", async () => ({
      blockCount: 2,
      bm25Size: 2,
      vectorSize: 2,
      bm25Drift: 0,
      vectorDrift: 0,
    }));
    registerIndexPersistenceCompactionFunction(sdk as never, kv as never, {
      observation: {
        save: observationSave,
        status: () => ({
          scope: KV.bm25Index,
          mode: "sharded",
          status: "ok",
          manifest: {
            savedAt: "2026-04-27T00:00:00.000Z",
            bm25Shards: 1,
            vectorShards: 1,
            bm25Bytes: 10,
            vectorBytes: 10,
            documentCount: 1,
            vectorCount: 1,
            manifestVersion: 2,
            physicalScopeMode: "physical-scope",
          },
        }),
      },
      retrieval: {
        save: retrievalSave,
        status: () => ({
          scope: KV.retrievalBlockIndex,
          mode: "sharded",
          status: "ok",
          manifest: {
            savedAt: "2026-04-27T00:00:00.000Z",
            bm25Shards: 1,
            vectorShards: 1,
            bm25Bytes: 10,
            vectorBytes: 10,
            documentCount: 2,
            vectorCount: 2,
            manifestVersion: 2,
            physicalScopeMode: "physical-scope",
          },
        }),
      },
    });

    const result = (await sdk.trigger("mem::index-persistence-compact", {
      force: true,
    })) as {
      success: boolean;
      results: Array<{ target: string; compacted: boolean }>;
      verification: { bm25Drift: number; vectorDrift: number };
    };

    expect(result.success).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({ target: "observation", compacted: true }),
      expect.objectContaining({ target: "retrieval", compacted: true }),
    ]);
    expect(result.verification).toMatchObject({ bm25Drift: 0, vectorDrift: 0 });
    expect(observationSave).toHaveBeenCalledWith({ allowShrink: true });
    expect(retrievalSave).toHaveBeenCalledWith({ allowShrink: true });
  });

  it("reports physical scope diagnostics during dry-run without writes", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const dataDir = mkdtempSync(join(tmpdir(), "agentmemory-statekv-"));
    const save = vi.fn();
    const verify = vi.fn(async () => ({ ok: true }));
    sdk.registerFunction("mem::retrieval-index-verify", verify);
    writeScopeFile(dataDir, KV.indexManifest(KV.retrievalBlockIndex), 10);
    writeScopeFile(
      dataDir,
      KV.indexShard(KV.retrievalBlockIndex, "bm25", "stable-a", 0),
      50,
    );
    writeScopeFile(
      dataDir,
      KV.indexShard(KV.retrievalBlockIndex, "bm25", "stable-b", 0),
      60,
    );
    writeScopeFile(dataDir, KV.retrievalBlocks, 70);
    writeScopeFile(dataDir, KV.retrievalBlockIndex, 20);

    try {
      registerIndexPersistenceCompactionFunction(sdk as never, kv as never, {
        observation: {
          save,
          status: () => ({ scope: KV.bm25Index, mode: "sharded", status: "ok" }),
        },
        retrieval: {
          save,
          status: () => ({
            scope: KV.retrievalBlockIndex,
            manifestScope: KV.indexManifest(KV.retrievalBlockIndex),
            mode: "sharded",
            status: "ok",
          }),
          physicalScopeReferences: () => ({
            parentScope: KV.retrievalBlockIndex,
            manifestScope: KV.indexManifest(KV.retrievalBlockIndex),
            shardScopes: [
              {
                scope: KV.indexShard(
                  KV.retrievalBlockIndex,
                  "bm25",
                  "stable-a",
                  0,
                ),
                key: "data",
                kind: "bm25",
                generation: "stable-a",
                index: 0,
                byteLength: 50,
              },
            ],
          }),
        },
      });

      const result = (await sdk.trigger("mem::index-persistence-compact", {
        target: "retrieval",
        dryRun: true,
        dataDir,
      })) as {
        dryRun: boolean;
        results: Array<{
          target: string;
          dryRun: boolean;
          estimatedRemovableBytes: number;
          estimatedRemovableFiles: number;
        }>;
        scopeDiagnostics: {
          totalBytes: number;
          cleanupCandidates: { files: number; bytes: number };
          largest: Array<{ scope: string; classification: string }>;
        };
      };

      expect(result.dryRun).toBe(true);
      expect(result.scopeDiagnostics.totalBytes).toBe(210);
      expect(result.scopeDiagnostics.cleanupCandidates).toMatchObject({
        files: 1,
        bytes: 60,
      });
      expect(result.scopeDiagnostics.largest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: KV.indexShard(
              KV.retrievalBlockIndex,
              "bm25",
              "stable-a",
              0,
            ),
            classification: "active_shard_payload",
          }),
          expect.objectContaining({
            scope: KV.indexShard(
              KV.retrievalBlockIndex,
              "bm25",
              "stable-b",
              0,
            ),
            classification: "orphan_cleanup_candidate",
          }),
          expect.objectContaining({
            scope: KV.indexManifest(KV.retrievalBlockIndex),
            classification: "manifest",
          }),
          expect.objectContaining({
            scope: KV.retrievalBlocks,
            classification: "active_scope",
          }),
        ]),
      );
      expect(result.results).toEqual([
        expect.objectContaining({
          target: "retrieval",
          dryRun: true,
          estimatedRemovableBytes: 60,
          estimatedRemovableFiles: 1,
        }),
      ]);
      expect(save).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses forced mutating compaction while runtime health is unsafe", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const save = vi.fn();
    await kv.set(KV.health, "latest", {
      status: "degraded",
      alerts: ["event_loop_lag_high"],
      connectionState: "connected",
      kvConnectivity: { status: "ok" },
      snapshotPersistence: { status: "ok" },
    });
    registerIndexPersistenceCompactionFunction(sdk as never, kv as never, {
      observation: {
        save,
        status: () => ({ scope: KV.bm25Index, mode: "sharded", status: "ok" }),
      },
      retrieval: {
        save,
        status: () => ({
          scope: KV.retrievalBlockIndex,
          mode: "sharded",
          status: "ok",
        }),
      },
    });

    const result = (await sdk.trigger("mem::index-persistence-compact", {
      force: true,
    })) as { success: boolean; status: string; reason: string };

    expect(result.success).toBe(false);
    expect(result.status).toBe("refused");
    expect(result.reason).toBe("event_loop_lag_high");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("api::index-persistence-compact", () => {
  it("forwards only whitelisted compaction options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::index-persistence-compact", async (payload) => {
      forwarded = payload;
      return { success: true };
    });

    const response = (await sdk.trigger("api::index-persistence-compact", {
      body: {
        target: "retrieval",
        force: true,
        verify: false,
        dryRun: true,
        timeBudgetMs: 1000,
        rebuildObservation: true,
        ignored: true,
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      target: "retrieval",
      force: true,
      verify: false,
      dryRun: true,
      timeBudgetMs: 1000,
      rebuildObservation: true,
    });
  });

  it("rejects invalid compaction options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::index-persistence-compact", {
      body: { target: "everything" },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("target must be");
  });
});
