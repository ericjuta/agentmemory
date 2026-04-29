import { describe, expect, it, vi, afterEach } from "vitest";

import { registerCodexPruneFunction } from "../src/functions/codex-prune.js";
import { retrievalBlockId } from "../src/functions/retrieval-blocks.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-04-20T00:00:00.000Z";
const CODEX = "/home/ericjuta/.openclaw/workspace/repos/codex";
const OLD_PROJECT = "/tmp/old-client";

afterEach(() => {
  vi.useRealTimers();
});

function turnCapsule(id: string, project: string, updatedAt: string) {
  return {
    id,
    sessionId: id.split(":")[0],
    turnId: "turn-1",
    project,
    cwd: project,
    createdAt: updatedAt,
    updatedAt,
    files: [],
    concepts: [],
    hadFailure: false,
    hadDecision: false,
    sourceObservationIds: [],
    importantObservationIds: [],
    maxImportance: 0,
  };
}

function workingSet(sessionId: string, project: string, updatedAt: string) {
  return {
    sessionId,
    project,
    cwd: project,
    updatedAt,
    latestTurnId: "turn-1",
    latestImportantFiles: [],
    latestImportantConcepts: [],
    latestImportantObservationIds: [],
    latestHadFailure: false,
    latestHadDecision: false,
  };
}

function observation(id: string, sessionId: string, timestamp: string) {
  return {
    id,
    sessionId,
    timestamp,
    type: "conversation",
    title: "Old observation",
    facts: [],
    narrative: "old",
    concepts: [],
    files: [],
    importance: 1,
  };
}

describe("mem::codex-prune", () => {
  it("reports non-allowlisted stale rows without mutating on dry run", async () => {
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.turnCapsules, "ses-old:turn-1", turnCapsule("ses-old:turn-1", OLD_PROJECT, OLD));
    await kv.set(KV.turnCapsules, "ses-codex:turn-1", turnCapsule("ses-codex:turn-1", CODEX, OLD));
    await kv.set(KV.workingSets, "ses-other", workingSet("ses-other", OLD_PROJECT, OLD));
    await kv.set(KV.sessions, "ses-other", {
      id: "ses-other",
      project: OLD_PROJECT,
      cwd: OLD_PROJECT,
      startedAt: OLD,
      status: "completed",
      observationCount: 1,
    });
    await kv.set(KV.observations("ses-other"), "obs-old", observation("obs-old", "ses-other", OLD));
    registerCodexPruneFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-prune", {
      dryRun: true,
      staleAfterDays: 14,
      includeSamples: true,
    })) as {
      dryRun: boolean;
      candidates: number;
      estimatedBytes: number;
      scopes: Record<string, { candidates: number }>;
      projects: Array<{ project: string; candidates: number }>;
      samples: Array<{ project: string }>;
    };

    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBe(3);
    expect(result.estimatedBytes).toBeGreaterThan(0);
    expect(result.scopes.turnCapsules.candidates).toBe(1);
    expect(result.scopes.workingSets.candidates).toBe(1);
    expect(result.scopes.observations.candidates).toBe(1);
    expect(result.projects[0]).toMatchObject({ project: OLD_PROJECT, candidates: 3 });
    expect(result.samples.some((sample) => sample.project === OLD_PROJECT)).toBe(true);
    expect(await kv.list(KV.turnCapsules)).toHaveLength(2);
    expect(await kv.list(KV.workingSets)).toHaveLength(1);
    expect(await kv.list(KV.observations("ses-other"))).toHaveLength(1);
  });

  it("requires force before deleting and archives before deletion", async () => {
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    const sdk = mockSdk();
    const kv = mockKV();
    const capsule = turnCapsule("ses-old:turn-1", OLD_PROJECT, OLD);
    await kv.set(KV.turnCapsules, capsule.id, capsule);
    await kv.set(KV.retrievalBlocks, retrievalBlockId("turn_capsule", capsule.id), {
      id: retrievalBlockId("turn_capsule", capsule.id),
      sourceType: "turn_capsule",
      sourceId: capsule.id,
    });
    registerCodexPruneFunction(sdk as never, kv as never);

    const denied = (await sdk.trigger("mem::codex-prune", {
      dryRun: false,
      staleAfterDays: 14,
    })) as { success: boolean; error: string };
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("force");
    expect(await kv.list(KV.turnCapsules)).toHaveLength(1);

    const result = (await sdk.trigger("mem::codex-prune", {
      dryRun: false,
      force: true,
      staleAfterDays: 14,
      batchSize: 10,
    })) as { success: boolean; deleted: number; deletedBytes: number };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(result.deletedBytes).toBeGreaterThan(0);
    expect(await kv.list(KV.turnCapsules)).toHaveLength(0);
    expect(await kv.list(KV.retrievalBlocks)).toHaveLength(0);
    expect(await kv.list("mem:codex-prune-archive")).toHaveLength(1);
    expect(await kv.list(KV.audit)).toHaveLength(1);
  });

  it("counts all candidates while bounding selected rows to the batch size", async () => {
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    const sdk = mockSdk();
    const kv = mockKV();
    for (let index = 0; index < 12; index += 1) {
      const id = "ses-old:turn-" + index;
      await kv.set(KV.turnCapsules, id, turnCapsule(id, OLD_PROJECT, OLD));
    }
    registerCodexPruneFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-prune", {
      dryRun: true,
      staleAfterDays: 14,
      batchSize: 5,
      includeSamples: true,
    })) as {
      candidates: number;
      selected: number;
      remainingAfterBatch: number;
      samples: unknown[];
      projects: Array<{ project: string; candidates: number }>;
    };

    expect(result.candidates).toBe(12);
    expect(result.selected).toBe(5);
    expect(result.remainingAfterBatch).toBe(7);
    expect(result.samples).toHaveLength(5);
    expect(result.projects[0]).toMatchObject({ project: OLD_PROJECT, candidates: 12 });
  });
});

describe("api::codex-prune", () => {
  it("forwards only whitelisted prune options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::codex-prune", async (payload) => {
      forwarded = payload;
      return { success: true };
    });

    const response = (await sdk.trigger("api::codex-prune", {
      body: {
        dryRun: false,
        force: true,
        archive: true,
        includeSamples: true,
        staleAfterDays: "45",
        batchSize: 25,
        timeBudgetMs: "1000",
        allowProjects: ["/tmp/keep"],
        includeScopes: ["turnCapsules"],
        ignored: true,
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      dryRun: false,
      force: true,
      archive: true,
      includeSamples: true,
      staleAfterDays: 45,
      batchSize: 25,
      timeBudgetMs: 1000,
      allowProjects: ["/tmp/keep"],
      includeScopes: ["turnCapsules"],
    });
  });

  it("validates prune options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::codex-prune", {
      body: {
        dryRun: "no",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("dryRun");
  });
});
