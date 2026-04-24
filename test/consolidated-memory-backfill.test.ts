import { describe, expect, it } from "vitest";

import { registerConsolidatedMemoryBackfillFunction } from "../src/functions/consolidated-memory-backfill.js";
import { retrievalBlockId } from "../src/functions/retrieval-blocks.js";
import { KV } from "../src/state/schema.js";
import type { Memory, ProceduralMemory, RetrievalBlock, SemanticMemory, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeSession(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: project,
    startedAt: "2026-04-24T12:00:00.000Z",
    status: "completed",
    observationCount: 1,
  };
}

function makeSemantic(id: string, sourceSessionIds: string[]): SemanticMemory {
  return {
    id,
    fact: `Legacy fact ${id}`,
    confidence: 0.8,
    sourceSessionIds,
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: "2026-04-24T12:00:00.000Z",
    strength: 0.8,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
  };
}

function makeMemory(id: string, project: string): Memory {
  return {
    id,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    type: "pattern",
    title: `Pattern ${id}`,
    content: "Reusable workflow",
    concepts: ["workflow"],
    files: [],
    project,
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

function makeProcedural(id: string, sourceMemoryIds: string[]): ProceduralMemory {
  return {
    id,
    name: `Legacy procedure ${id}`,
    steps: ["Inspect state", "Run tests"],
    triggerCondition: "when resuming old work",
    frequency: 1,
    sourceSessionIds: [],
    sourceMemoryIds,
    strength: 0.7,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
  };
}

describe("mem::consolidated-memory-backfill", () => {
  it("backfills a single-project semantic memory and reindexes it", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerConsolidatedMemoryBackfillFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, "ses_1", makeSession("ses_1", "/project-a"));
    await kv.set(KV.semantic, "sem_1", makeSemantic("sem_1", ["ses_1"]));

    const result = (await sdk.trigger("mem::consolidated-memory-backfill", {
      kinds: ["semantic"],
      includeItems: true,
    })) as { counts: { updated: number }; items: Array<{ status: string }> };

    expect(result.counts.updated).toBe(1);
    expect(result.items[0].status).toBe("updated");
    const stored = await kv.get<SemanticMemory>(KV.semantic, "sem_1");
    expect(stored).toMatchObject({
      project: "/project-a",
      sourceScope: "project",
      sourceProjects: ["/project-a"],
    });
    const block = await kv.get<RetrievalBlock>(
      KV.retrievalBlocks,
      retrievalBlockId("semantic_memory", "sem_1"),
    );
    expect(block).toMatchObject({
      project: "/project-a",
      scope: "project",
      sourceId: "sem_1",
    });
  });

  it("leaves multi-project semantic memory global with source project evidence", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerConsolidatedMemoryBackfillFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, "ses_a", makeSession("ses_a", "/project-a"));
    await kv.set(KV.sessions, "ses_b", makeSession("ses_b", "/project-b"));
    await kv.set(KV.semantic, "sem_multi", makeSemantic("sem_multi", ["ses_a", "ses_b"]));

    const result = (await sdk.trigger("mem::consolidated-memory-backfill", {
      kinds: ["semantic"],
    })) as { counts: { markedGlobal: number } };

    expect(result.counts.markedGlobal).toBe(1);
    const stored = await kv.get<SemanticMemory>(KV.semantic, "sem_multi");
    expect(stored).toMatchObject({
      project: undefined,
      sourceScope: "global",
      sourceProjects: ["/project-a", "/project-b"],
    });
  });

  it("infers procedural memory project from source memories and reruns as a no-op", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerConsolidatedMemoryBackfillFunction(sdk as never, kv as never);
    await kv.set(KV.memories, "mem_1", makeMemory("mem_1", "/project-a"));
    await kv.set(KV.procedural, "proc_1", makeProcedural("proc_1", ["mem_1"]));

    const first = (await sdk.trigger("mem::consolidated-memory-backfill", {
      kinds: ["procedural"],
    })) as { counts: { updated: number } };
    const second = (await sdk.trigger("mem::consolidated-memory-backfill", {
      kinds: ["procedural"],
    })) as { counts: { unchanged: number; updated: number } };

    expect(first.counts.updated).toBe(1);
    expect(second.counts.updated).toBe(0);
    expect(second.counts.unchanged).toBe(1);
    const stored = await kv.get<ProceduralMemory>(KV.procedural, "proc_1");
    expect(stored).toMatchObject({
      project: "/project-a",
      sourceScope: "project",
      sourceProjects: ["/project-a"],
    });
  });
});
