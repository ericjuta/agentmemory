import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { CompressedObservation } from "../src/types.js";

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
  let indexDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    kv = mockKV();
    indexDir = await mkdtemp(join(tmpdir(), "agentmemory-index-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(indexDir, { recursive: true, force: true });
  });

  it("saves and loads BM25 index round-trip", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));

    const persistence = new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    });
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

    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      cacheDir: indexDir,
    });
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("shards large vector snapshots and loads them back", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    for (let i = 0; i < 1001; i++) {
      vector.add(`obs_${i}`, "ses_1", new Float32Array([i, 0, 1]));
    }

    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      cacheDir: indexDir,
    });
    await persistence.save();

    const meta = await kv.get<{
      vector: { files?: string[]; entries: number; bytes: number };
    }>("mem:index:bm25", "metadata");
    expect(meta?.vector.files?.length).toBe(2);
    expect(meta?.vector.entries).toBe(1001);
    await expect(access(join(indexDir, "vectors-0000.json"))).resolves.toBeUndefined();
    await expect(access(join(indexDir, "vectors-0001.json"))).resolves.toBeUndefined();

    const loaded = await persistence.load();
    expect(loaded.vector?.size).toBe(1001);
  });

  it("keeps loading usable vector snapshots when BM25 snapshot is corrupt", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const vector = new VectorIndex();
    vector.add("obs_1", "ses_1", new Float32Array([1, 0, 0]));

    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      cacheDir: indexDir,
    });
    await persistence.save();
    await writeFile(join(indexDir, "bm25.json"), "corrupt", "utf-8");

    const loaded = await persistence.load();

    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
    expect(loaded.vector!.search(new Float32Array([1, 0, 0]))[0]?.obsId).toBe("obs_1");
  });

  it("loads legacy single-file vector snapshots", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    vector.add("obs_legacy_vec", "ses_1", new Float32Array([1, 0, 0]));
    const contents = vector.serialize();
    await writeFile(join(indexDir, "vectors.json"), contents, "utf-8");
    await writeFile(join(indexDir, "bm25.json"), bm25.serialize(), "utf-8");
    const { createHash } = await import("node:crypto");
    await kv.set("mem:index:bm25", "metadata", {
      version: 1,
      savedAt: new Date().toISOString(),
      bm25: {
        file: "bm25.json",
        bytes: Buffer.byteLength(bm25.serialize()),
        sha256: createHash("sha256").update(bm25.serialize()).digest("hex"),
        entries: 0,
      },
      vector: {
        file: "vectors.json",
        bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
        entries: 1,
      },
    });
    await writeFile(
      join(indexDir, "manifest.json"),
      JSON.stringify(await kv.get("mem:index:bm25", "metadata")),
      "utf-8",
    );

    const loaded = await new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    }).load();
    expect(loaded.vector?.size).toBe(1);
  });

  it("removes stale vector snapshot files when vectors are no longer present", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const vector = new VectorIndex();
    vector.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));

    const withVector = new IndexPersistence(kv as never, bm25, vector, {
      cacheDir: indexDir,
    });
    await withVector.save();
    await expect(access(join(indexDir, "vectors.json"))).resolves.toBeUndefined();

    const withoutVector = new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    });
    await withoutVector.save();

    await expect(access(join(indexDir, "vectors.json"))).rejects.toThrow();
    const meta = await kv.get<{ vector: unknown }>("mem:index:bm25", "metadata");
    expect(meta?.vector).toBeNull();
  });

  it("scheduleSave debounces multiple calls", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    });

    persistence.scheduleSave();
    persistence.scheduleSave();
    persistence.scheduleSave();

    await expect(kv.get("mem:index:bm25", "metadata")).resolves.toBeNull();

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const saved = await kv.get<string>("mem:index:bm25", "metadata");
    expect(saved).not.toBeNull();
  });

  it("stop clears the pending timer", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    });

    persistence.scheduleSave();
    persistence.stop();

    vi.advanceTimersByTime(10000);
    const saved = await kv.get<string>("mem:index:bm25", "metadata");
    expect(saved).toBeNull();
  });

  it("returns null indexes when nothing has been saved", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    });

    const loaded = await persistence.load();
    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });

  it("scheduled save swallows kv.set rejection without unhandledRejection (#204)", async () => {
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        const err = new Error(
          "TIMEOUT: invocation timed out after 30000ms",
        ) as Error & { code?: string; function_id?: string };
        err.code = "TIMEOUT";
        err.function_id = "state::set";
        throw err;
      }),
    };
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(
      failingKv as never,
      bm25,
      null,
      { cacheDir: indexDir },
    );

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      persistence.scheduleSave();
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // give microtasks a chance to flush
      await Promise.resolve();
      expect(failingKv.set).toHaveBeenCalled();
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("save() does not throw when kv.set rejects (#204)", async () => {
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        throw new Error("TIMEOUT");
      }),
    };
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(
      failingKv as never,
      bm25,
      null,
      { cacheDir: indexDir },
    );

    await expect(persistence.save()).resolves.toBeUndefined();
  });

  it("writes file-backed snapshots instead of storing large index payloads in KV", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));

    const persistence = new IndexPersistence(kv as never, bm25, null, {
      cacheDir: indexDir,
    });
    await persistence.save();

    await expect(kv.get("mem:index:bm25", "data")).resolves.toBeNull();
    const meta = await kv.get<{
      bm25: { file: string; entries: number; bytes: number };
      vector: null;
    }>("mem:index:bm25", "metadata");
    expect(meta?.bm25.entries).toBe(1);
    expect(meta?.bm25.bytes).toBeGreaterThan(0);
    expect(meta?.vector).toBeNull();

    const fileData = await readFile(join(indexDir, "bm25.json"), "utf-8");
    expect(fileData).toContain("obs_1");
  });

  it("falls back to legacy KV snapshots when index files are unavailable", async () => {
    const legacy = new SearchIndex();
    legacy.add(makeObs({ id: "obs_legacy", title: "legacy auth handler" }));
    await kv.set("mem:index:bm25", "data", legacy.serialize());
    await kv.set("mem:index:bm25", "metadata", {
      version: 1,
      savedAt: new Date().toISOString(),
      bm25: { file: "missing-bm25.json", bytes: 1, sha256: "missing", entries: 1 },
      vector: null,
    });

    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      { cacheDir: indexDir },
    );
    const loaded = await persistence.load();

    expect(loaded.bm25?.search("legacy")[0]?.obsId).toBe("obs_legacy");
  });

  it("returns null indexes when file snapshot is empty so callers can rebuild live", async () => {
    await writeFile(join(indexDir, "bm25.json"), "not json", "utf-8");

    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      { cacheDir: indexDir },
    );
    const loaded = await persistence.load();

    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });
});
