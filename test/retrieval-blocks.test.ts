import { describe, expect, it } from "vitest";

import {
  buildMemoryRetrievalBlock,
  refreshRetrievalBlocksFromState,
} from "../src/functions/retrieval-blocks.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";

function createMemory(index: number): Memory {
  const timestamp = `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`;
  return {
    id: `mem_${index}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: "architecture",
    title: `Memory ${index}`,
    content: `Memory content ${index}`,
    concepts: [`concept_${index}`],
    files: [`src/file-${index}.ts`],
    sessionIds: [`session_${index}`],
    strength: 0.8,
    version: 1,
    isLatest: true,
  };
}

function createMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  let activeSets = 0;
  let maxConcurrentSets = 0;
  let setCalls = 0;

  const ensureScope = (scope: string) => {
    let bucket = store.get(scope);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      store.set(scope, bucket);
    }
    return bucket;
  };

  return {
    seed: (scope: string, key: string, value: unknown) => {
      ensureScope(scope).set(key, value);
    },
    stats: () => ({ maxConcurrentSets, setCalls }),
    kv: {
      list: async <T>(scope: string): Promise<T[]> => {
        return Array.from(ensureScope(scope).values()) as T[];
      },
      set: async <T>(scope: string, key: string, value: T): Promise<T> => {
        setCalls += 1;
        activeSets += 1;
        maxConcurrentSets = Math.max(maxConcurrentSets, activeSets);
        try {
          await Promise.resolve();
          ensureScope(scope).set(key, value);
          return value;
        } finally {
          activeSets -= 1;
        }
      },
      delete: async (scope: string, key: string): Promise<void> => {
        ensureScope(scope).delete(key);
      },
    },
  };
}

describe("refreshRetrievalBlocksFromState", () => {
  it("writes retrieval blocks sequentially", async () => {
    const mock = createMockKV();
    const memories = Array.from({ length: 40 }, (_, index) => createMemory(index + 1));
    for (const memory of memories) {
      mock.seed(KV.memories, memory.id, memory);
    }

    const count = await refreshRetrievalBlocksFromState(mock.kv as never);
    const stats = mock.stats();
    const stored = await mock.kv.list(KV.retrievalBlocks);

    expect(count).toBe(40);
    expect(stored).toHaveLength(40);
    expect(stats.setCalls).toBe(40);
    expect(stats.maxConcurrentSets).toBe(1);
  });

  it("skips unchanged retrieval blocks", async () => {
    const mock = createMockKV();
    const memory = createMemory(1);
    const block = buildMemoryRetrievalBlock(memory);

    mock.seed(KV.memories, memory.id, memory);
    mock.seed(KV.retrievalBlocks, block.id, block);

    const count = await refreshRetrievalBlocksFromState(mock.kv as never);
    const stats = mock.stats();
    const stored = await mock.kv.list(KV.retrievalBlocks);

    expect(count).toBe(1);
    expect(stored).toEqual([block]);
    expect(stats.setCalls).toBe(0);
  });
});
