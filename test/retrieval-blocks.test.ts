import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/health/write-gate.js", () => ({
  getDerivedKvWritePauseReason: vi.fn(async () => null),
}));

import {
  buildMemoryRetrievalBlock,
  buildObservationRetrievalBlock,
  reconcileRetrievalBlocksFromState,
  refreshRetrievalBlocksFromState,
  upsertMemoryRetrievalBlock,
} from "../src/functions/retrieval-blocks.js";
import { getDerivedKvWritePauseReason } from "../src/health/write-gate.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

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

function createSession(id: string, startedAt: string): Session {
  return {
    id,
    project: "/project",
    cwd: "/project",
    startedAt,
    status: "active",
    observationCount: 1,
  };
}

function createObservation(
  id: string,
  sessionId: string,
  timestamp: string,
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp,
    type: "file_edit",
    title: `Observation ${id}`,
    facts: ["Edited auth handler"],
    narrative: "Edited auth handler.",
    concepts: ["auth"],
    files: ["/project/src/auth.ts"],
    importance: 4,
  };
}

function createMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  let activeSets = 0;
  let maxConcurrentSets = 0;
  let setCalls = 0;
  const listScopes: string[] = [];

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
    stats: () => ({ maxConcurrentSets, setCalls, listScopes }),
    kv: {
      get: async <T>(scope: string, key: string): Promise<T | null> => {
        return (ensureScope(scope).get(key) as T) ?? null;
      },
      list: async <T>(scope: string): Promise<T[]> => {
        listScopes.push(scope);
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
  beforeEach(() => {
    vi.mocked(getDerivedKvWritePauseReason).mockResolvedValue(null);
  });

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
    expect(stats.setCalls).toBeGreaterThanOrEqual(40);
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

  it("bounds partial reconciliation and keeps unrelated stored blocks", async () => {
    const mock = createMockKV();
    const staleMemory = createMemory(99);
    const staleBlock = buildMemoryRetrievalBlock(staleMemory);
    const memory = createMemory(1);
    const newestSession = createSession("session-new", "2026-02-03T00:00:00Z");
    const olderSession = createSession("session-old", "2026-02-01T00:00:00Z");
    const newestObservation = createObservation(
      "obs-new",
      newestSession.id,
      "2026-02-03T00:01:00Z",
    );
    const olderObservation = createObservation(
      "obs-old",
      olderSession.id,
      "2026-02-01T00:01:00Z",
    );

    mock.seed(KV.retrievalBlocks, staleBlock.id, staleBlock);
    mock.seed(KV.memories, memory.id, memory);
    mock.seed(KV.sessions, newestSession.id, newestSession);
    mock.seed(KV.sessions, olderSession.id, olderSession);
    mock.seed(KV.observations(newestSession.id), newestObservation.id, newestObservation);
    mock.seed(KV.observations(olderSession.id), olderObservation.id, olderObservation);

    const report = await reconcileRetrievalBlocksFromState(mock.kv as never, {
      partial: true,
      sessionLimit: 1,
    });
    const stored = await mock.kv.list(KV.retrievalBlocks);
    const observationListScopes = mock
      .stats()
      .listScopes.filter((scope) => scope.startsWith(KV.observations("")));

    expect(report.stale).toBe(0);
    expect(report.limited).toBe(false);
    expect(report.changed).toBeGreaterThanOrEqual(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        staleBlock,
        buildMemoryRetrievalBlock(memory),
        buildObservationRetrievalBlock(newestObservation, newestSession.project),
      ]),
    );
    expect(stored).not.toContainEqual(
      buildObservationRetrievalBlock(olderObservation, olderSession.project),
    );
    expect(observationListScopes).toEqual([KV.observations(newestSession.id)]);
  });

  it("defers derived retrieval block writes while health is unhealthy", async () => {
    vi.mocked(getDerivedKvWritePauseReason).mockResolvedValueOnce(
      "StateKV state::set timed out after 5000ms",
    );
    const mock = createMockKV();
    const memory = createMemory(1);
    const expectedBlock = buildMemoryRetrievalBlock(memory);

    const block = await upsertMemoryRetrievalBlock(mock.kv as never, memory);

    expect(block).toEqual(expectedBlock);
    expect(await mock.kv.list(KV.retrievalBlocks)).toHaveLength(0);
    expect(await mock.kv.list(KV.retrievalBlockRetry)).toEqual([
      expect.objectContaining({
        blockId: expectedBlock.id,
        operation: "upsert",
      }),
    ]);
    expect((await mock.kv.get<any>(KV.retrievalBlockRetry, expectedBlock.id))?.block).toBeUndefined();
    expect(mock.stats().setCalls).toBe(1);
  });
});
