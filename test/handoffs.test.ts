import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { registerCheckpointsFunction } from "../src/functions/checkpoints.js";
import { registerHandoffsFunction } from "../src/functions/handoffs.js";
import { registerMissionsFunction } from "../src/functions/missions.js";
import { registerSignalsFunction } from "../src/functions/signals.js";
import { KV } from "../src/state/schema.js";
import type {
  Checkpoint,
  HandoffPacket,
  Session,
  SessionSummary,
  SessionWorkingSet,
  TurnCapsule,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("handoffs", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerActionsFunction(sdk as never, kv as never);
    registerCheckpointsFunction(sdk as never, kv as never);
    registerMissionsFunction(sdk as never, kv as never);
    registerSignalsFunction(sdk as never, kv as never);
    registerHandoffsFunction(sdk as never, kv as never);
  });

  it("generates a session-scoped handoff packet from the working set", async () => {
    const session: Session = {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-20T00:00:00Z",
      status: "active",
      observationCount: 3,
    };
    const capsule: TurnCapsule = {
      id: "capsule_1",
      sessionId: "ses_1",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-04-20T00:00:01Z",
      updatedAt: "2026-04-20T00:00:02Z",
      userPrompt: "Resume the work",
      assistantConclusion: "The retrieval trace core is implemented.",
      files: ["/project/src/functions/context.ts"],
      concepts: ["retrieval trace"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs_1"],
      importantObservationIds: ["obs_1"],
      maxImportance: 8,
    };
    const workingSet: SessionWorkingSet = {
      sessionId: "ses_1",
      project: "/project",
      cwd: "/project",
      updatedAt: "2026-04-20T00:00:03Z",
      latestTurnId: "turn-1",
      latestCompletedTurnId: "turn-1",
      latestCompletedCapsule: capsule,
      latestAssistantConclusion: "The retrieval trace core is implemented.",
      latestImportantFiles: ["/project/src/functions/context.ts"],
      latestImportantConcepts: ["retrieval trace"],
      latestImportantObservationIds: ["obs_1"],
      latestHadFailure: false,
      latestHadDecision: true,
    };
    const summary: SessionSummary = {
      sessionId: "ses_1",
      project: "/project",
      createdAt: "2026-04-20T00:00:04Z",
      title: "Retrieval work",
      narrative: "Implemented retrieval explainability.",
      keyDecisions: ["Expose selected and skipped candidates"],
      filesModified: ["/project/src/functions/context.ts"],
      concepts: ["retrieval trace"],
      observationCount: 3,
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.workingSets, session.id, workingSet);
    await kv.set(KV.summaries, session.id, summary);

    sdk.registerFunction("mem::next", async () => ({
      success: true,
      suggestion: { title: "Implement mission state" },
    }));

    const result = (await sdk.trigger("mem::handoff-generate", {
      scopeType: "session",
      scopeId: session.id,
    })) as {
      success: boolean;
      handoffPacket: HandoffPacket;
    };

    expect(result.success).toBe(true);
    expect(result.handoffPacket.scopeType).toBe("session");
    expect(result.handoffPacket.scopeId).toBe("ses_1");
    expect(result.handoffPacket.summary).toContain("retrieval trace core");
    expect(result.handoffPacket.recommendedNextStep).toBe("Implement mission state");
    expect(result.handoffPacket.relevantFiles).toContain("/project/src/functions/context.ts");
  });

  it("generates an action-scoped handoff packet with blockers and optional delivery signal", async () => {
    const actionCreate = (await sdk.trigger("mem::action-create", {
      title: "Ship deploy handoff",
      createdBy: "agent-1",
      project: "/project",
      sourceObservationIds: ["obs_2"],
    })) as {
      action: { id: string };
    };

    await sdk.trigger("mem::checkpoint-create", {
      name: "Approval gate",
      type: "approval",
      linkedActionIds: [actionCreate.action.id],
    });

    sdk.registerFunction("mem::next", async () => ({
      success: true,
      suggestion: { title: "Review the next available action" },
    }));

    const result = (await sdk.trigger("mem::handoff-generate", {
      scopeType: "action",
      scopeId: actionCreate.action.id,
      project: "/project",
      from: "agent-1",
      deliverTo: "agent-2",
    })) as {
      success: boolean;
      handoffPacket: HandoffPacket;
      signal: { id: string; type: string; metadata?: Record<string, unknown> } | null;
    };

    expect(result.success).toBe(true);
    expect(result.handoffPacket.scopeType).toBe("action");
    expect(result.handoffPacket.sourceActionIds).toEqual([actionCreate.action.id]);
    expect(
      result.handoffPacket.blockers.some((blocker) =>
        blocker.includes("Checkpoint pending"),
      ),
    ).toBe(true);
    expect(result.signal).not.toBeNull();
    expect(result.signal?.type).toBe("handoff");
    expect(result.signal?.metadata?.handoffPacketId).toBe(result.handoffPacket.id);
  });

  it("lists and gets generated handoff packets", async () => {
    const session: Session = {
      id: "ses_2",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-20T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    await kv.set(KV.sessions, session.id, session);

    const checkpoint: Checkpoint = {
      id: "ckpt_manual",
      name: "Manual gate",
      description: "",
      status: "pending",
      type: "external",
      createdAt: "2026-04-20T00:00:00Z",
      linkedActionIds: [],
    };
    await kv.set(KV.checkpoints, checkpoint.id, checkpoint);

    sdk.registerFunction("mem::next", async () => ({
      success: true,
      suggestion: { title: "Pick the next action" },
    }));

    const created = (await sdk.trigger("mem::handoff-generate", {
      scopeType: "session",
      scopeId: session.id,
    })) as { handoffPacket: HandoffPacket };

    const listed = (await sdk.trigger("mem::handoff-list", {
      scopeType: "session",
      scopeId: session.id,
    })) as {
      success: boolean;
      handoffPackets: HandoffPacket[];
    };
    expect(listed.success).toBe(true);
    expect(listed.handoffPackets).toHaveLength(1);
    expect(listed.handoffPackets[0].id).toBe(created.handoffPacket.id);

    const fetched = (await sdk.trigger("mem::handoff-get", {
      handoffPacketId: created.handoffPacket.id,
    })) as {
      success: boolean;
      handoffPacket: HandoffPacket;
    };
    expect(fetched.success).toBe(true);
    expect(fetched.handoffPacket).toEqual(created.handoffPacket);
  });

  it("generates a mission-scoped handoff packet and updates the mission pointer", async () => {
    const mission = (await sdk.trigger("mem::mission-create", {
      goal: "Finish mission handoff support",
      project: "/project",
      owner: "agent-3",
    })) as { mission: { id: string } };
    await sdk.trigger("mem::action-create", {
      title: "Ship mission packet",
      createdBy: "agent-3",
      project: "/project",
      missionId: mission.mission.id,
    });

    const result = (await sdk.trigger("mem::handoff-generate", {
      scopeType: "mission",
      scopeId: mission.mission.id,
    })) as {
      success: boolean;
      handoffPacket: HandoffPacket;
    };

    expect(result.success).toBe(true);
    expect(result.handoffPacket.scopeType).toBe("mission");
    expect(result.handoffPacket.scopeId).toBe(mission.mission.id);

    const storedMission = await kv.get<{
      latestHandoffPacketId?: string;
    }>(KV.missions, mission.mission.id);
    expect(storedMission?.latestHandoffPacketId).toBe(result.handoffPacket.id);
  });
});
