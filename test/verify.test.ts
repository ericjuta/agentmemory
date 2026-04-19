import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerBeliefsFunctions } from "../src/functions/beliefs.js";
import { registerVerifyFunction } from "../src/functions/verify.js";
import type { Memory, CompressedObservation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Verify Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerBeliefsFunctions(sdk as never, kv as never);
    registerVerifyFunction(sdk as never, kv as never);
  });

  it("returns error when id is missing", async () => {
    const result = (await sdk.trigger("mem::verify", {})) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("id is required");
  });

  it("returns not found for unknown id", async () => {
    const result = (await sdk.trigger("mem::verify", {
      id: "unknown_123",
    })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe("not found");
  });

  it("verifies a memory with citation chain", async () => {
    const session: Session = {
      id: "ses_1",
      project: "/test/project",
      cwd: "/test",
      startedAt: "2026-03-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const obs: CompressedObservation = {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: "2026-03-01T00:01:00Z",
      type: "decision",
      title: "Chose React over Vue",
      facts: ["React chosen for ecosystem"],
      narrative: "Team decided on React",
      concepts: ["react", "frontend"],
      files: ["src/App.tsx"],
      importance: 8,
      confidence: 0.85,
    };
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const memory: Memory = {
      id: "mem_1",
      createdAt: "2026-03-01T00:02:00Z",
      updatedAt: "2026-03-01T00:02:00Z",
      type: "architecture",
      title: "Using React for frontend",
      content: "The team uses React for the frontend framework",
      concepts: ["react", "frontend"],
      files: ["src/App.tsx"],
      sessionIds: ["ses_1"],
      strength: 8,
      version: 1,
      isLatest: true,
      sourceObservationIds: ["obs_1"],
    };
    await kv.set("mem:memories", "mem_1", memory);

    const result = (await sdk.trigger("mem::verify", { id: "mem_1" })) as {
      success: boolean;
      type: string;
      citations: Array<{
        observationId: string;
        confidence: number;
        sessionProject: string;
      }>;
      citationCount: number;
    };

    expect(result.success).toBe(true);
    expect(result.type).toBe("memory");
    expect(result.citationCount).toBe(1);
    expect(result.citations[0].observationId).toBe("obs_1");
    expect(result.citations[0].confidence).toBe(0.85);
    expect(result.citations[0].sessionProject).toBe("/test/project");
  });

  it("verifies a memory with no source observations", async () => {
    const memory: Memory = {
      id: "mem_2",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "API uses REST",
      content: "The API follows REST conventions",
      concepts: ["api", "rest"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_2", memory);

    const result = (await sdk.trigger("mem::verify", { id: "mem_2" })) as {
      success: boolean;
      type: string;
      citationCount: number;
      citations: unknown[];
    };

    expect(result.success).toBe(true);
    expect(result.type).toBe("memory");
    expect(result.citationCount).toBe(0);
    expect(result.citations).toEqual([]);
  });

  it("verifies an observation directly", async () => {
    const session: Session = {
      id: "ses_2",
      project: "/my/project",
      cwd: "/my",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_2", session);

    const obs: CompressedObservation = {
      id: "obs_direct",
      sessionId: "ses_2",
      timestamp: "2026-03-01T00:01:00Z",
      type: "file_write",
      title: "Created index.ts",
      facts: ["Created file"],
      narrative: "Agent created the index file",
      concepts: ["typescript"],
      files: ["index.ts"],
      importance: 6,
      confidence: 0.72,
    };
    await kv.set("mem:obs:ses_2", "obs_direct", obs);

    const result = (await sdk.trigger("mem::verify", {
      id: "obs_direct",
    })) as {
      success: boolean;
      type: string;
      observation: { id: string; confidence: number };
      session: { project: string };
    };

    expect(result.success).toBe(true);
    expect(result.type).toBe("observation");
    expect(result.observation.id).toBe("obs_direct");
    expect(result.observation.confidence).toBe(0.72);
    expect(result.session.project).toBe("/my/project");
  });

  it("returns memory info with supersede chain", async () => {
    const memory: Memory = {
      id: "mem_v2",
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
      type: "pattern",
      title: "Updated pattern",
      content: "Updated pattern content",
      concepts: ["testing"],
      files: [],
      sessionIds: [],
      strength: 9,
      version: 2,
      parentId: "mem_v1",
      supersedes: ["mem_v1"],
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_v2", memory);

    const result = (await sdk.trigger("mem::verify", { id: "mem_v2" })) as {
      success: boolean;
      memory: {
        id: string;
        version: number;
        parentId: string;
        supersedes: string[];
      };
    };

    expect(result.success).toBe(true);
    expect(result.memory.version).toBe(2);
    expect(result.memory.parentId).toBe("mem_v1");
    expect(result.memory.supersedes).toEqual(["mem_v1"]);
  });

  it("verifies a belief with support and contradiction evidence", async () => {
    const session: Session = {
      id: "ses-belief",
      project: "/test/project",
      cwd: "/test/project",
      startedAt: "2026-03-02T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    const supportObservation: CompressedObservation = {
      id: "obs-support",
      sessionId: session.id,
      timestamp: "2026-03-02T00:01:00Z",
      type: "decision",
      title: "REST chosen",
      facts: ["REST chosen"],
      narrative: "The team chose REST for the control plane.",
      concepts: ["rest"],
      files: ["/test/project/src/api.ts"],
      importance: 8,
      confidence: 0.9,
    };
    const contradictionObservation: CompressedObservation = {
      id: "obs-contradict",
      sessionId: session.id,
      timestamp: "2026-03-02T00:02:00Z",
      type: "decision",
      title: "GraphQL proposed",
      facts: ["GraphQL proposed"],
      narrative: "A conflicting GraphQL proposal was recorded.",
      concepts: ["graphql"],
      files: ["/test/project/src/api.ts"],
      importance: 7,
      confidence: 0.8,
    };
    const supportMemory: Memory = {
      id: "mem-rest",
      createdAt: "2026-03-02T00:03:00Z",
      updatedAt: "2026-03-02T00:03:00Z",
      type: "architecture",
      title: "REST transport",
      content: "Use REST for the control plane API.",
      concepts: ["rest", "api"],
      files: ["/test/project/src/api.ts"],
      sessionIds: [session.id],
      strength: 8,
      version: 1,
      isLatest: true,
      sourceObservationIds: ["obs-support"],
    };
    const contradictionMemory: Memory = {
      id: "mem-graphql",
      createdAt: "2026-03-02T00:04:00Z",
      updatedAt: "2026-03-02T00:04:00Z",
      type: "architecture",
      title: "GraphQL transport",
      content: "Use GraphQL for the control plane API.",
      concepts: ["graphql", "api"],
      files: ["/test/project/src/api.ts"],
      sessionIds: [session.id],
      strength: 7,
      version: 1,
      isLatest: true,
      sourceObservationIds: ["obs-contradict"],
    };

    await kv.set("mem:sessions", session.id, session);
    await kv.set("mem:obs:ses-belief", "obs-support", supportObservation);
    await kv.set("mem:obs:ses-belief", "obs-contradict", contradictionObservation);
    await kv.set("mem:memories", supportMemory.id, supportMemory);
    await kv.set("mem:memories", contradictionMemory.id, contradictionMemory);
    await kv.set("mem:relations", "rel-belief", {
      type: "contradicts",
      sourceId: supportMemory.id,
      targetId: contradictionMemory.id,
      createdAt: "2026-03-02T00:05:00Z",
      confidence: 0.9,
    });
    await sdk.trigger("mem::belief-project", { project: "/test/project" });

    const beliefs = await kv.list<{ id: string; claim: string }>("mem:beliefs");
    const restBelief = beliefs.find((belief) => belief.claim.includes("REST"));
    const result = (await sdk.trigger("mem::verify", {
      id: restBelief!.id,
    })) as {
      success: boolean;
      type: string;
      explanation: { status: string; reason: string };
      supportingMemories: Array<{ id: string }>;
      contradictingMemories: Array<{ id: string }>;
      citationCount: number;
    };

    expect(result.success).toBe(true);
    expect(result.type).toBe("belief");
    expect(result.explanation.status).toBe("uncertain");
    expect(result.explanation.reason).toContain("mixed evidence");
    expect(result.supportingMemories.map((memory) => memory.id)).toEqual(["mem-rest"]);
    expect(result.contradictingMemories.map((memory) => memory.id)).toEqual(["mem-graphql"]);
    expect(result.citationCount).toBe(2);
  });
});
