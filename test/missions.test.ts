import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { registerCheckpointsFunction } from "../src/functions/checkpoints.js";
import { registerMissionsFunction } from "../src/functions/missions.js";
import { KV } from "../src/state/schema.js";
import type { MissionRun } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("missions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerActionsFunction(sdk as never, kv as never);
    registerCheckpointsFunction(sdk as never, kv as never);
    registerMissionsFunction(sdk as never, kv as never);
  });

  it("creates, updates, lists, and gets a mission with linked actions", async () => {
    const created = (await sdk.trigger("mem::mission-create", {
      goal: "Ship retrieval explainability",
      project: "/project",
      owner: "agent-1",
      successCriteria: ["trace visible", "tests passing"],
    })) as {
      success: boolean;
      mission: { id: string; status: string; phase: string; owner: string };
    };

    expect(created.success).toBe(true);
    expect(created.mission.status).toBe("active");

    const missionId = created.mission.id;
    const actionCreate = (await sdk.trigger("mem::action-create", {
      title: "Wire mission action",
      createdBy: "agent-1",
      project: "/project",
      missionId,
    })) as {
      success: boolean;
      action: { id: string };
    };

    expect(actionCreate.success).toBe(true);

    const updated = (await sdk.trigger("mem::mission-update", {
      missionId,
      phase: "implementation",
      summary: "Mission is underway",
      risk: "medium",
      confidence: 0.8,
    })) as {
      success: boolean;
      mission: { phase: string; summary: string; status: string; actionIds: string[] };
    };

    expect(updated.success).toBe(true);
    expect(updated.mission.phase).toBe("implementation");
    expect(updated.mission.summary).toBe("Mission is underway");
    expect(updated.mission.actionIds).toContain(actionCreate.action.id);

    const fetched = (await sdk.trigger("mem::mission-get", {
      missionId,
    })) as {
      success: boolean;
      mission: { id: string; phase: string; actionIds: string[] };
      actions: Array<{ id: string }>;
      statusSummary: { status: string };
    };

    expect(fetched.success).toBe(true);
    expect(fetched.mission.id).toBe(missionId);
    expect(fetched.actions).toHaveLength(1);
    expect(fetched.statusSummary.status).toBe("active");

    const listed = (await sdk.trigger("mem::mission-list", {
      project: "/project",
      status: "active",
    })) as {
      success: boolean;
      missions: Array<{ mission: { id: string } }>;
    };

    expect(listed.success).toBe(true);
    expect(listed.missions).toHaveLength(1);
    expect(listed.missions[0].mission.id).toBe(missionId);

    const runs = await kv.list<MissionRun>(KV.missionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      missionId,
      status: "active",
      actor: "agent-1",
    });
  });

  it("marks a mission blocked when a linked checkpoint is pending", async () => {
    const mission = (await sdk.trigger("mem::mission-create", {
      goal: "Ship guarded deploy",
      project: "/project",
      owner: "agent-1",
    })) as { mission: { id: string } };
    const action = (await sdk.trigger("mem::action-create", {
      title: "Prepare deploy",
      createdBy: "agent-1",
      project: "/project",
      missionId: mission.mission.id,
    })) as { action: { id: string } };

    await sdk.trigger("mem::checkpoint-create", {
      name: "Production approval",
      missionId: mission.mission.id,
      linkedActionIds: [action.action.id],
      type: "approval",
    });

    const fetched = (await sdk.trigger("mem::mission-get", {
      missionId: mission.mission.id,
    })) as {
      mission: { status: string };
      statusSummary: { status: string; blockers: string[] };
      actions: Array<{ status: string }>;
      checkpoints: Array<{ status: string }>;
    };

    expect(fetched.mission.status).toBe("blocked");
    expect(fetched.statusSummary.status).toBe("blocked");
    expect(
      fetched.statusSummary.blockers.some((blocker) =>
        blocker.includes("Checkpoint pending"),
      ),
    ).toBe(true);
    expect(fetched.actions[0].status).toBe("blocked");
    expect(fetched.checkpoints[0].status).toBe("pending");
  });

  it("marks a mission completed when linked actions are done", async () => {
    const mission = (await sdk.trigger("mem::mission-create", {
      goal: "Close implementation slice",
      project: "/project",
      owner: "agent-2",
    })) as { mission: { id: string } };
    const action = (await sdk.trigger("mem::action-create", {
      title: "Finish the slice",
      createdBy: "agent-2",
      project: "/project",
      missionId: mission.mission.id,
    })) as { action: { id: string } };

    await sdk.trigger("mem::action-update", {
      actionId: action.action.id,
      status: "done",
      result: "implemented",
    });

    const fetched = (await sdk.trigger("mem::mission-get", {
      missionId: mission.mission.id,
    })) as {
      mission: { status: string };
      statusSummary: {
        status: string;
        actionCounts: Record<string, number>;
      };
    };

    expect(fetched.mission.status).toBe("completed");
    expect(fetched.statusSummary.status).toBe("completed");
    expect(fetched.statusSummary.actionCounts.done).toBe(1);
  });

  it("keeps mission-get and mission-list read-only", async () => {
    const setSpy = vi.spyOn(kv, "set");
    const mission = (await sdk.trigger("mem::mission-create", {
      goal: "Read-only projection",
      project: "/project",
      owner: "agent-3",
    })) as { mission: { id: string } };

    const missionSetCallsBefore = setSpy.mock.calls.filter(
      ([scope]) => scope === KV.missions,
    ).length;

    await sdk.trigger("mem::mission-get", {
      missionId: mission.mission.id,
    });
    await sdk.trigger("mem::mission-list", {
      project: "/project",
    });

    const missionSetCallsAfter = setSpy.mock.calls.filter(
      ([scope]) => scope === KV.missions,
    ).length;

    expect(missionSetCallsAfter).toBe(missionSetCallsBefore);
  });

  it("lists missions even when stored arrays are malformed", async () => {
    await kv.set(
      KV.missions,
      "legacy-mission",
      {
        id: "legacy-mission",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        project: "/project",
        goal: "Legacy mission",
        successCriteria: undefined,
        status: "active",
        phase: "planned",
        owner: "legacy-agent",
        summary: "",
        risk: "",
        confidence: 0.5,
        actionIds: undefined,
        checkpointIds: undefined,
        sentinelIds: undefined,
        leaseIds: undefined,
        routineIds: undefined,
      } as never,
    );

    await kv.set(
      KV.checkpoints,
      "legacy-checkpoint",
      {
        id: "legacy-checkpoint",
        name: "Legacy checkpoint",
        description: "",
        status: "pending",
        type: "approval",
        createdAt: "2026-04-20T00:00:00.000Z",
        linkedActionIds: undefined,
        missionId: "legacy-mission",
      } as never,
    );

    const listed = (await sdk.trigger("mem::mission-list", {
      project: "/project",
    })) as {
      success: boolean;
      partialFailures?: number;
      missions: Array<{ mission: { id: string } }>;
    };

    expect(listed.success).toBe(true);
    expect(listed.partialFailures).toBe(0);
    expect(listed.missions.map((entry) => entry.mission.id)).toContain(
      "legacy-mission",
    );
  });
});
