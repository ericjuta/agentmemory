import { describe, expect, it } from "vitest";

import { registerActiveScopeDiagnosticsFunction } from "../src/functions/active-scope-diagnostics.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("mem::active-scope-diagnostics", () => {
  it("summarizes turn capsule and working set active scope age", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    await kv.set(KV.turnCapsules, "session-old:turn-1", {
      id: "session-old:turn-1",
      sessionId: "session-old",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: old,
      updatedAt: old,
      files: ["a.ts"],
      concepts: ["memory"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs-1"],
      importantObservationIds: ["obs-1"],
      maxImportance: 8,
    });
    await kv.set(KV.turnCapsules, "session-new:turn-1", {
      id: "session-new:turn-1",
      sessionId: "session-new",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: recent,
      updatedAt: recent,
      files: [],
      concepts: [],
      hadFailure: false,
      hadDecision: false,
      sourceObservationIds: [],
      importantObservationIds: [],
      maxImportance: 0,
    });
    await kv.set(KV.workingSets, "session-old", {
      sessionId: "session-old",
      project: "/project",
      cwd: "/project",
      updatedAt: old,
      latestTurnId: "turn-1",
      latestCompletedTurnId: "turn-1",
      latestImportantFiles: ["a.ts"],
      latestImportantConcepts: ["memory"],
      latestImportantObservationIds: ["obs-1"],
      latestHadFailure: false,
      latestHadDecision: true,
    });
    registerActiveScopeDiagnosticsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::active-scope-diagnostics", {
      staleAfterDays: 30,
      sampleLimit: 1,
    })) as {
      totalItems: number;
      totalStaleCandidates: number;
      scopes: {
        turnCapsules: {
          count: number;
          estimatedBytes: number;
          staleCandidates: number;
          ageBuckets: Record<string, number>;
          projects: Array<{ project: string; count: number; estimatedBytes: number }>;
          sessions: Array<{ sessionId: string; count: number; estimatedBytes: number }>;
          samples: Array<{ id: string }>;
        };
        workingSets: { count: number; staleCandidates: number };
      };
      totalEstimatedBytes: number;
    };

    expect(result.totalItems).toBe(3);
    expect(result.totalEstimatedBytes).toBeGreaterThan(0);
    expect(result.totalStaleCandidates).toBe(2);
    expect(result.scopes.turnCapsules).toMatchObject({
      count: 2,
      estimatedBytes: expect.any(Number),
      staleCandidates: 1,
      ageBuckets: { d30to90: 1, lt7d: 1 },
      projects: [{ project: "/project", count: 2, estimatedBytes: expect.any(Number) }],
    });
    expect(result.scopes.turnCapsules.sessions[0]).toMatchObject({
      sessionId: expect.any(String),
      count: 1,
      estimatedBytes: expect.any(Number),
    });
    expect(result.scopes.turnCapsules.samples).toHaveLength(1);
    expect(result.scopes.turnCapsules.samples[0].id).toBe("session-old:turn-1");
    expect(result.scopes.workingSets).toMatchObject({
      count: 1,
      staleCandidates: 1,
    });
  });
});
