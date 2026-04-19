import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerBeliefsFunctions } from "../src/functions/beliefs.js";
import { KV } from "../src/state/schema.js";
import type { Memory, MemoryRelation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("belief projection", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerBeliefsFunctions(sdk as never, kv as never);
  });

  it("seeds an active belief from a latest memory", async () => {
    const session: Session = {
      id: "session-1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-19T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    const memory: Memory = {
      id: "mem-1",
      createdAt: "2026-04-19T00:01:00.000Z",
      updatedAt: "2026-04-19T00:01:00.000Z",
      type: "fact",
      title: "Parser choice",
      content: "Use parser Y for ingest.",
      concepts: ["parser", "ingest"],
      files: ["/project/src/parser.ts"],
      sessionIds: [session.id],
      strength: 8,
      version: 1,
      isLatest: true,
      sourceObservationIds: [],
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.memories, memory.id, memory);

    const result = (await sdk.trigger("mem::belief-project", {
      project: "/project",
    })) as { success: boolean; beliefCount: number };
    const beliefs = await kv.list<{
      id: string;
      claim: string;
      status: string;
      supportingMemoryIds: string[];
    }>(KV.beliefs);
    const evidence = await kv.list<{
      beliefId: string;
      memoryId: string;
      relationType: string;
    }>(KV.beliefEvidence);

    expect(result.success).toBe(true);
    expect(result.beliefCount).toBe(1);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({
      claim: "Use parser Y for ingest.",
      status: "active",
      supportingMemoryIds: ["mem-1"],
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      beliefId: beliefs[0].id,
      memoryId: "mem-1",
      relationType: "supports",
    });
  });

  it("keeps superseded claims inspectable while default list stays current", async () => {
    const session: Session = {
      id: "session-2",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-19T00:00:00.000Z",
      status: "completed",
      observationCount: 2,
    };
    const oldMemory: Memory = {
      id: "mem-old",
      createdAt: "2026-04-19T00:01:00.000Z",
      updatedAt: "2026-04-19T00:01:00.000Z",
      type: "fact",
      title: "Old parser",
      content: "Use parser X for ingest.",
      concepts: ["parser"],
      files: ["/project/src/parser.ts"],
      sessionIds: [session.id],
      strength: 7,
      version: 1,
      isLatest: false,
      sourceObservationIds: [],
    };
    const newMemory: Memory = {
      id: "mem-new",
      createdAt: "2026-04-19T00:02:00.000Z",
      updatedAt: "2026-04-19T00:02:00.000Z",
      type: "fact",
      title: "New parser",
      content: "Use parser Y for ingest.",
      concepts: ["parser"],
      files: ["/project/src/parser.ts"],
      sessionIds: [session.id],
      strength: 8,
      version: 2,
      parentId: "mem-old",
      supersedes: ["mem-old"],
      isLatest: true,
      sourceObservationIds: [],
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.memories, oldMemory.id, oldMemory);
    await kv.set(KV.memories, newMemory.id, newMemory);
    await sdk.trigger("mem::belief-project", { project: "/project" });

    const activeList = (await sdk.trigger("mem::belief-list", {
      project: "/project",
    })) as { beliefs: Array<{ claim: string; status: string }> };
    const supersededList = (await sdk.trigger("mem::belief-list", {
      project: "/project",
      status: "superseded",
    })) as { beliefs: Array<{ claim: string; status: string }> };

    expect(activeList.beliefs).toHaveLength(1);
    expect(activeList.beliefs[0]).toMatchObject({
      claim: "Use parser Y for ingest.",
      status: "active",
    });
    expect(supersededList.beliefs).toHaveLength(1);
    expect(supersededList.beliefs[0]).toMatchObject({
      claim: "Use parser X for ingest.",
      status: "superseded",
    });
  });

  it("keeps contradictory beliefs and lowers confidence", async () => {
    const session: Session = {
      id: "session-3",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-19T00:00:00.000Z",
      status: "completed",
      observationCount: 2,
    };
    const restMemory: Memory = {
      id: "mem-rest",
      createdAt: "2026-04-19T00:01:00.000Z",
      updatedAt: "2026-04-19T00:01:00.000Z",
      type: "architecture",
      title: "REST transport",
      content: "Use REST for the control plane API.",
      concepts: ["rest", "api"],
      files: ["/project/src/api.ts"],
      sessionIds: [session.id],
      strength: 8,
      version: 1,
      isLatest: true,
      sourceObservationIds: [],
    };
    const graphqlMemory: Memory = {
      id: "mem-graphql",
      createdAt: "2026-04-19T00:02:00.000Z",
      updatedAt: "2026-04-19T00:02:00.000Z",
      type: "architecture",
      title: "GraphQL transport",
      content: "Use GraphQL for the control plane API.",
      concepts: ["graphql", "api"],
      files: ["/project/src/api.ts"],
      sessionIds: [session.id],
      strength: 8,
      version: 1,
      isLatest: true,
      sourceObservationIds: [],
    };
    const relation: MemoryRelation = {
      type: "contradicts",
      sourceId: "mem-rest",
      targetId: "mem-graphql",
      createdAt: "2026-04-19T00:03:00.000Z",
      confidence: 0.9,
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.memories, restMemory.id, restMemory);
    await kv.set(KV.memories, graphqlMemory.id, graphqlMemory);
    await kv.set(KV.relations, "rel-1", relation);
    await sdk.trigger("mem::belief-project", { project: "/project" });

    const beliefs = (await sdk.trigger("mem::belief-list", {
      project: "/project",
      status: "uncertain",
      limit: 10,
    })) as { beliefs: Array<{ claim: string; confidence: number; contradictingMemoryIds: string[] }> };

    expect(beliefs.beliefs).toHaveLength(2);
    for (const belief of beliefs.beliefs) {
      expect(belief.confidence).toBeLessThan(0.75);
      expect(belief.contradictingMemoryIds).toHaveLength(1);
    }

    const storedBeliefs = await kv.list<{ id: string; claim: string }>(KV.beliefs);
    const restBelief = storedBeliefs.find((belief) =>
      belief.claim.includes("REST"),
    );
    const detail = (await sdk.trigger("mem::belief-get", {
      beliefId: restBelief!.id,
    })) as {
      success: boolean;
      contradictingMemories: Array<{ id: string }>;
    };

    expect(detail.success).toBe(true);
    expect(detail.contradictingMemories[0].id).toBe("mem-graphql");
  });
});
