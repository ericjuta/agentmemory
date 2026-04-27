import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation } from "../src/types.js";
import { logger } from "../src/logger.js";

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
    keys: (scope: string): string[] => Array.from(store.get(scope)?.keys() ?? []),
    scopes: (): string[] => Array.from(store.keys()),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
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
    ...overrides,
  };
}

describe("IndexPersistence", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.useFakeTimers();
    kv = mockKV();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves and loads BM25 index round-trip", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));

    const persistence = new IndexPersistence(kv as never, bm25, null);
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.size).toBe(1);
    const results = loaded.bm25!.search("auth");
    expect(results.length).toBe(1);
  });

  it("saves and loads vector index round-trip", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    vector.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));

    const persistence = new IndexPersistence(kv as never, bm25, vector);
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("scheduleSave debounces multiple calls", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();
    persistence.scheduleSave();
    persistence.scheduleSave();

    await expect(kv.get("mem:index:bm25", "data")).resolves.toBeNull();

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    const saved = await kv.get<string>("mem:index:bm25", "data");
    expect(saved).not.toBeNull();
  });

  it("stop clears the pending timer", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();
    persistence.stop();

    vi.advanceTimersByTime(10000);
    const saved = await kv.get<string>("mem:index:bm25", "data");
    expect(saved).toBeNull();
  });

  it("returns null indexes when nothing has been saved", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null);

    const loaded = await persistence.load();
    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });

  it("swallows deferred save failures and logs them", async () => {
    const bm25 = new SearchIndex();
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        throw new Error("state unavailable");
      }),
    };
    const persistence = new IndexPersistence(failingKv as never, bm25, null);

    persistence.scheduleSave();

    await vi.advanceTimersByTimeAsync(5000);

    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to persist index",
      expect.objectContaining({
        scope: "mem:index:bm25",
        error: "state unavailable",
      }),
    );
  });

  it("does not start a second deferred save while one is still in flight", async () => {
    const bm25 = new SearchIndex();
    let resolveSet: (() => void) | null = null;
    const pendingSet = new Promise<string>((resolve) => {
      resolveSet = () => resolve("saved");
    });
    const slowKv = {
      ...mockKV(),
      set: vi.fn(() => pendingSet),
    };
    const persistence = new IndexPersistence(slowKv as never, bm25, null);

    persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(5000);
    expect(slowKv.set).toHaveBeenCalledTimes(1);

    persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(60000);
    expect(slowKv.set).toHaveBeenCalledTimes(1);

    resolveSet?.();
    await Promise.resolve();
    expect(slowKv.set).toHaveBeenCalledTimes(1);
  });

  it("backs off deferred retries after a failed save", async () => {
    const bm25 = new SearchIndex();
    const retryingKv = {
      ...mockKV(),
      set: vi
        .fn()
        .mockRejectedValueOnce(new Error("state unavailable"))
        .mockResolvedValue("saved"),
    };
    const persistence = new IndexPersistence(retryingKv as never, bm25, null);

    persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(5000);
    expect(retryingKv.set).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(retryingKv.set).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(retryingKv.set).toHaveBeenCalledTimes(2);
  });

  it("defers scheduled saves while the runtime is unhealthy", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const recordingKv = {
      ...kv,
      set: vi.fn(kv.set),
    };
    const shouldDeferSave = vi
      .fn<() => boolean | string | null>()
      .mockReturnValueOnce("kv_unhealthy")
      .mockReturnValue(false);
    const persistence = new IndexPersistence(
      recordingKv as never,
      bm25,
      null,
      KV.bm25Index,
      { shouldDeferSave },
    );

    persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(5000);

    expect(recordingKv.set).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Index persistence deferred while health is unhealthy",
      { scope: KV.bm25Index, reason: "kv_unhealthy" },
    );
    expect(persistence.getStatus()).toMatchObject({
      pendingSave: true,
      deferredCount: 1,
      deferReason: "kv_unhealthy",
    });

    await vi.advanceTimersByTimeAsync(14999);
    expect(recordingKv.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(recordingKv.set).toHaveBeenCalledWith(
      KV.bm25Index,
      "data",
      expect.any(String),
    );
  });

  it("saves sharded indexes as bounded StateKV writes", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    for (let i = 0; i < 40; i++) {
      bm25.addDocument(
        `doc_${i}`,
        "session_1",
        `auth middleware token validation ${i} `.repeat(20),
      );
    }
    for (let i = 0; i < 12; i++) {
      vector.add(
        `doc_${i}`,
        "session_1",
        new Float32Array([i + 0.1, i + 0.2, i + 0.3, i + 0.4]),
      );
    }

    const baseKv = mockKV();
    const writes: Array<{ scope: string; key: string; data: unknown }> = [];
    const recordingKv = {
      ...baseKv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        writes.push({ scope, key, data });
        return baseKv.set(scope, key, data);
      }),
    };
    const persistence = new IndexPersistence(
      recordingKv as never,
      bm25,
      vector,
      KV.retrievalBlockIndex,
      {
        mode: "sharded",
        shardSizeBytes: 300,
        now: () => "2026-04-24T12:00:00.000Z",
      },
    );

    await persistence.save();

    const manifest = await baseKv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );
    expect(manifest.bm25.shards.length).toBeGreaterThan(1);
    expect(manifest.vector.shards.length).toBeGreaterThan(1);
    expect(manifest.schemaVersion).toBe(2);
    const shardWrites = writes.filter((write) => write.scope.includes(":shard:"));
    expect(shardWrites.length).toBeGreaterThan(1);
    expect(
      shardWrites.every(
        (write) =>
          write.scope !== KV.retrievalBlockIndex &&
          write.key === "data" &&
          typeof write.data === "string" &&
          Buffer.byteLength(write.data, "utf8") <= 300,
      ),
    ).toBe(true);
    expect(manifest.bm25.shards[0]).toMatchObject({
      scope: expect.stringContaining(`${KV.retrievalBlockIndex}:shard:bm25:`),
      key: "data",
      kind: "bm25",
    });
    expect(await baseKv.get(manifest.bm25.shards[0].scope, "data")).not.toBeNull();
    expect(baseKv.keys(KV.indexManifest(KV.retrievalBlockIndex))).toEqual([
      "manifest",
    ]);
    expect(baseKv.keys(KV.retrievalBlockIndex)).toEqual([]);
    expect(await baseKv.get(KV.retrievalBlockIndex, "data")).toBeNull();
    expect(persistence.getStatus()).toMatchObject({
      status: "ok",
      manifest: {
        manifestVersion: 2,
        physicalScopeMode: "physical-scope",
        legacyPayloadPresent: false,
        legacySameScopeShardCount: 0,
        documentCount: 40,
        vectorCount: 12,
      },
    });
  });

  it("saves observation indexes in sharded mode without legacy blobs", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    for (let i = 0; i < 30; i++) {
      bm25.add(makeObs({
        id: `obs_${i}`,
        title: `Observation index timeout regression ${i}`,
        narrative: "StateKV write amplification must stay bounded ".repeat(12),
      }));
    }
    vector.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));

    const persistence = new IndexPersistence(
      kv as never,
      bm25,
      vector,
      KV.bm25Index,
      { mode: "sharded", shardSizeBytes: 250 },
    );

    await persistence.save();

    const manifest = await kv.get<any>(KV.indexManifest(KV.bm25Index), "manifest");
    expect(manifest.mode).toBe("sharded");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.bm25.shards.length).toBeGreaterThan(1);
    expect(manifest.vector.shards.length).toBeGreaterThan(0);
    expect(
      manifest.bm25.shards.every((shard: { scope: string; key: string }) =>
        shard.scope.startsWith(`${KV.bm25Index}:shard:bm25:`) &&
        shard.key === "data",
      ),
    ).toBe(true);
    expect(kv.keys(KV.indexManifest(KV.bm25Index))).toEqual(["manifest"]);
    expect(kv.keys(KV.bm25Index)).toEqual([]);
    expect(await kv.get(KV.bm25Index, "data")).toBeNull();
    expect(await kv.get(KV.bm25Index, "vectors")).toBeNull();
    expect(persistence.getStatus()).toMatchObject({
      scope: KV.bm25Index,
      mode: "sharded",
      status: "ok",
      manifest: {
        manifestVersion: 2,
        physicalScopeMode: "physical-scope",
        documentCount: 30,
        vectorCount: 1,
      },
    });
  });

  it("loads sharded indexes from a complete manifest", async () => {
    const bm25 = new SearchIndex();
    bm25.addDocument("doc_1", "session_1", "auth middleware token validation");
    const vector = new VectorIndex();
    vector.add("doc_1", "session_1", new Float32Array([0.1, 0.2, 0.3]));

    const persistence = new IndexPersistence(
      kv as never,
      bm25,
      vector,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await persistence.save();

    const loader = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      new VectorIndex(),
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    const loaded = await loader.load();

    expect(loaded.bm25?.size).toBe(1);
    expect(loaded.bm25?.searchDocuments("auth")).toHaveLength(1);
    expect(loaded.vector?.size).toBe(1);
    expect(loader.getStatus()).toMatchObject({
      status: "ok",
      manifestScope: KV.indexManifest(KV.retrievalBlockIndex),
      manifestSource: "manifest-scope",
      manifest: {
        documentCount: 1,
        vectorCount: 1,
      },
    });
  });

  it("loads current manifests without reading the parent index scope", async () => {
    const bm25 = new SearchIndex();
    bm25.addDocument("doc_1", "session_1", "auth middleware token validation");
    const persistence = new IndexPersistence(
      kv as never,
      bm25,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await persistence.save();

    const guardKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === KV.retrievalBlockIndex) {
          throw new Error("parent scope should not be read");
        }
        return kv.get<T>(scope, key);
      }),
    };
    const loader = new IndexPersistence(
      guardKv as never,
      new SearchIndex(),
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );

    const loaded = await loader.load();

    expect(loaded.bm25?.size).toBe(1);
    expect(guardKv.get).not.toHaveBeenCalledWith(
      KV.retrievalBlockIndex,
      expect.any(String),
    );
    expect(loader.getStatus()).toMatchObject({
      status: "ok",
      manifestSource: "manifest-scope",
      manifest: { legacyPayloadPresent: false },
    });
  });

  it("loads v1 same-scope manifests and migrates the next save to physical scopes", async () => {
    const source = new SearchIndex();
    source.addDocument("doc_1", "session_1", "auth middleware token validation");
    const serialized = source.serialize();
    const shardKey = "bm25:shard:legacy:00000";
    await kv.set(KV.retrievalBlockIndex, shardKey, serialized);
    await kv.set(KV.retrievalBlockIndex, "manifest", {
      schemaVersion: 1,
      mode: "sharded",
      savedAt: "2026-04-24T12:00:00.000Z",
      bm25: {
        kind: "bm25",
        byteLength: byteLength(serialized),
        count: 1,
        sha256: sha256(serialized),
        shards: [
          {
            key: shardKey,
            byteLength: byteLength(serialized),
            sha256: sha256(serialized),
          },
        ],
      },
      vector: null,
    });

    const target = new SearchIndex();
    const persistence = new IndexPersistence(
      kv as never,
      target,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    const loaded = await persistence.load();
    target.restoreFrom(loaded.bm25!);

    expect(loaded.bm25?.searchDocuments("auth")).toHaveLength(1);
    expect(persistence.getStatus()).toMatchObject({
      status: "ok",
      manifest: {
        manifestVersion: 1,
        physicalScopeMode: "same-scope",
        legacySameScopeShardCount: 1,
        physicalShardScopeCount: 0,
      },
    });

    await persistence.save();

    const manifest = await kv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.bm25.shards[0]).toMatchObject({
      scope: expect.stringContaining(`${KV.retrievalBlockIndex}:shard:bm25:`),
      key: "data",
      kind: "bm25",
    });
    expect(await kv.get(KV.retrievalBlockIndex, shardKey)).not.toBeNull();
    expect(kv.keys(KV.indexManifest(KV.retrievalBlockIndex))).toEqual([
      "manifest",
    ]);
    expect(kv.keys(KV.retrievalBlockIndex)).toEqual([shardKey, "manifest"]);
  });

  it("preserves a larger complete vector manifest over a partial in-memory vector index", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    for (let i = 0; i < 4; i++) {
      bm25.addDocument("doc_" + i, "session_1", "retrieval block " + i);
      vector.add("doc_" + i, "session_1", new Float32Array([i, i + 1, i + 2]));
    }
    const persistence = new IndexPersistence(
      kv as never,
      bm25,
      vector,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await persistence.save();
    const firstManifest = await kv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );

    const partialVector = new VectorIndex();
    partialVector.add("doc_0", "session_1", new Float32Array([0, 1, 2]));
    const updater = new IndexPersistence(
      kv as never,
      bm25,
      partialVector,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await updater.load();
    await updater.save();

    const nextManifest = await kv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );
    expect(nextManifest.vector.count).toBe(4);
    expect(nextManifest.vector.shards).toEqual(firstManifest.vector.shards);

    const loader = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      new VectorIndex(),
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    const loaded = await loader.load();
    expect(loaded.vector?.size).toBe(4);
  });

  it("preserves a larger stored BM25 manifest over a partial in-memory index", async () => {
    const fullBm25 = new SearchIndex();
    for (let i = 0; i < 4; i++) {
      fullBm25.addDocument("doc_" + i, "session_1", "retrieval block " + i);
    }
    const firstPersistence = new IndexPersistence(
      kv as never,
      fullBm25,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await firstPersistence.save();
    const firstManifest = await kv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );

    const partialBm25 = new SearchIndex();
    partialBm25.addDocument("doc_0", "session_1", "retrieval block 0");
    const startupPersistence = new IndexPersistence(
      kv as never,
      partialBm25,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await startupPersistence.save();

    const nextManifest = await kv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );
    expect(nextManifest.bm25.count).toBe(4);
    expect(nextManifest.bm25.shards).toEqual(firstManifest.bm25.shards);

    const loader = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    const loaded = await loader.load();
    expect(loaded.bm25?.size).toBe(4);
  });

  it("marks sharded loads incomplete when a shard is missing", async () => {
    const bm25 = new SearchIndex();
    bm25.addDocument(
      "doc_1",
      "session_1",
      "auth middleware token validation ".repeat(20),
    );
    const persistence = new IndexPersistence(
      kv as never,
      bm25,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await persistence.save();
    const manifest = await kv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );
    await kv.delete(manifest.bm25.shards[0].scope, manifest.bm25.shards[0].key);

    const loader = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    const loaded = await loader.load();

    expect(loaded.bm25).toBeNull();
    expect(loader.getStatus()).toMatchObject({
      status: "incomplete",
      error: "persisted index shards are missing or stale",
      manifest: { incomplete: true },
    });
  });

  it("does not corrupt the last complete manifest when a shard save fails", async () => {
    const bm25 = new SearchIndex();
    bm25.addDocument("doc_1", "session_1", "auth middleware token validation");
    let failShardWrites = false;
    const baseKv = mockKV();
    const failingKv = {
      ...baseKv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (failShardWrites && scope.includes(":shard:")) {
          throw new Error("state unavailable");
        }
        return baseKv.set(scope, key, data);
      }),
    };
    const persistence = new IndexPersistence(
      failingKv as never,
      bm25,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await persistence.save();
    const firstManifest = await baseKv.get<any>(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
    );

    bm25.addDocument(
      "doc_2",
      "session_1",
      "new auth middleware token validation ".repeat(10),
    );
    failShardWrites = true;

    await expect(persistence.save()).rejects.toThrow("state unavailable");
    expect(
      await baseKv.get(KV.indexManifest(KV.retrievalBlockIndex), "manifest"),
    ).toEqual(firstManifest);

    const loader = new IndexPersistence(
      baseKv as never,
      new SearchIndex(),
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    const loaded = await loader.load();
    expect(loaded.bm25?.size).toBe(1);
    expect(persistence.getStatus()).toMatchObject({
      status: "error",
      error: "state unavailable",
    });
  });

  it("skips unchanged shard writes when a previous complete manifest is available", async () => {
    const bm25 = new SearchIndex();
    bm25.addDocument(
      "doc_1",
      "session_1",
      "auth middleware token validation ".repeat(20),
    );
    const baseKv = mockKV();
    const recordingKv = {
      ...baseKv,
      set: vi.fn(baseKv.set),
    };
    const persistence = new IndexPersistence(
      recordingKv as never,
      bm25,
      null,
      KV.retrievalBlockIndex,
      { mode: "sharded", shardSizeBytes: 80 },
    );
    await persistence.save();
    vi.mocked(recordingKv.set).mockClear();

    await persistence.save();

    const shardWrites = vi
      .mocked(recordingKv.set)
      .mock.calls.filter(([scope]) => scope.includes(":shard:"));
    expect(shardWrites).toHaveLength(0);
    expect(recordingKv.set).toHaveBeenCalledWith(
      KV.indexManifest(KV.retrievalBlockIndex),
      "manifest",
      expect.any(Object),
    );
  });
});
