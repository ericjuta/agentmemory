import { describe, expect, it, vi } from "vitest";
import { indexObservationVector, populateVectorIndex } from "../src/state/vector-indexing.js";
import { VectorIndex } from "../src/state/vector-index.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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

function obs(id: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: "2026-01-01T00:00:00Z",
    type: "decision",
    title: "Vector " + id,
    facts: ["vector fact"],
    narrative: "Vector indexing narrative",
    concepts: ["vector"],
    files: [],
    importance: 5,
  };
}

function provider(): EmbeddingProvider {
  return {
    name: "test",
    dimensions: 3,
    embed: vi.fn(async () => new Float32Array([1, 0, 0])),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0])),
    ),
  };
}

describe("vector indexing", () => {
  it("restores stored embeddings into the vector index without provider calls", async () => {
    const kv = mockKV();
    const p = provider();
    await kv.set("mem:emb:obs_1", "data", {
      dimensions: 3,
      embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer).toString("base64"),
    });
    const vector = new VectorIndex();

    const result = await indexObservationVector(obs("obs_1"), vector, p, kv as never);

    expect(result).toBe("stored");
    expect(vector.size).toBe(1);
    expect(p.embed).not.toHaveBeenCalled();
    expect(vector.search(new Float32Array([0, 1, 0]))[0]?.obsId).toBe("obs_1");
  });

  it("generates and persists missing embeddings when enabled", async () => {
    const kv = mockKV();
    const p = provider();
    const vector = new VectorIndex();

    const result = await indexObservationVector(obs("obs_2"), vector, p, kv as never, {
      generateMissing: true,
    });

    expect(result).toBe("generated");
    expect(vector.size).toBe(1);
    expect(p.embed).toHaveBeenCalled();
    await expect(kv.get("mem:emb:obs_2", "data")).resolves.toMatchObject({
      dimensions: 3,
      provider: "test",
    });
  });

  it("populates existing stored vectors and respects generated limit", async () => {
    const kv = mockKV();
    const p = provider();
    await kv.set("mem:emb:obs_1", "data", {
      dimensions: 3,
      embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer).toString("base64"),
    });
    const vector = new VectorIndex();

    const result = await populateVectorIndex(
      [obs("obs_1"), obs("obs_2"), obs("obs_3")],
      vector,
      p,
      kv as never,
      { generateMissing: true, maxGenerate: 1 },
    );

    expect(result).toEqual({ stored: 1, generated: 1, skipped: 1, failed: 0 });
    expect(vector.size).toBe(2);
  });

  it("keeps the previous vector index when refresh generation fails smaller", async () => {
    const kv = mockKV();
    const p = provider();
    vi.mocked(p.embedBatch).mockRejectedValueOnce(new Error("provider down"));
    const vector = new VectorIndex();
    vector.add("obs_existing", "ses_1", new Float32Array([0, 1, 0]));

    const result = await populateVectorIndex([obs("obs_2")], vector, p, kv as never, {
      generateMissing: true,
    });

    expect(result).toEqual({ stored: 0, generated: 0, skipped: 0, failed: 1 });
    expect(vector.size).toBe(1);
    expect(vector.search(new Float32Array([0, 1, 0]))[0]?.obsId).toBe("obs_existing");
  });
});
