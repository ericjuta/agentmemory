import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerBranchAwareFunction } from "../src/functions/branch-aware.js";
import { registerComponentDossiersFunction } from "../src/functions/component-dossiers.js";
import { registerDecisionsFunction } from "../src/functions/decisions.js";
import { registerGuardrailsFunction } from "../src/functions/guardrails.js";
import { registerRoutineCompilerFunction } from "../src/functions/routine-compiler.js";
import { KV } from "../src/state/schema.js";
import type {
  Action,
  BranchOverlay,
  ComponentDossier,
  Crystal,
  GuardrailMemory,
  Insight,
  Lesson,
  Mission,
  Session,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("deferred memory primitives", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerBranchAwareFunction(sdk as never, kv as never);
    registerGuardrailsFunction(sdk as never, kv as never);
    registerDecisionsFunction(sdk as never, kv as never);
    registerComponentDossiersFunction(sdk as never, kv as never);
    registerRoutineCompilerFunction(sdk as never, kv as never);
  });

  it("saves, lists, and promotes mission branch overlays", async () => {
    const mission: Mission = {
      id: "msn_1",
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-20T00:00:00Z",
      project: "/repo",
      branch: "feature/guardrails",
      goal: "Ship deferred memory lane",
      successCriteria: ["backend live"],
      status: "active",
      phase: "implementation",
      owner: "agent-1",
      summary: "Mission underway",
      risk: "medium",
      confidence: 0.6,
      actionIds: [],
      checkpointIds: [],
      sentinelIds: [],
      leaseIds: [],
      routineIds: [],
    };
    await kv.set(KV.missions, mission.id, mission);

    const created = (await sdk.trigger("mem::branch-overlay-save", {
      project: "/repo",
      branch: "feature/guardrails",
      targetType: "mission",
      targetId: mission.id,
      summary: "Branch-local blocker around endpoint count drift",
      blockers: ["README and index counts are now coupled"],
      notes: ["Promote only once the count is verified"],
    })) as {
      success: boolean;
      overlay: BranchOverlay;
    };

    expect(created.success).toBe(true);
    expect(created.overlay.branch).toBe("feature/guardrails");

    const listed = (await sdk.trigger("mem::branch-overlays", {
      project: "/repo",
      branch: "feature/guardrails",
    })) as { success: boolean; overlays: BranchOverlay[] };
    expect(listed.success).toBe(true);
    expect(listed.overlays).toHaveLength(1);

    const promoted = (await sdk.trigger("mem::branch-overlay-promote", {
      overlayId: created.overlay.id,
      actor: "agent-1",
    })) as {
      success: boolean;
      overlay: BranchOverlay;
      promotedTarget: Mission;
    };
    expect(promoted.success).toBe(true);
    expect(promoted.overlay.status).toBe("promoted");
    expect(promoted.promotedTarget.status).toBe("blocked");
    expect(promoted.promotedTarget.summary).toContain("Branch-local blocker");
  });

  it("supports guardrail supersession and blocker-overlay promotion into guardrails", async () => {
    const first = (await sdk.trigger("mem::guardrail-save", {
      project: "/repo",
      branch: "feature/guardrails",
      scopeType: "file",
      scopeId: "src/index.ts",
      triggerConditions: ["when editing endpoint counts"],
      riskLevel: "high",
      explanation: "Update endpoint counts everywhere together",
      evidence: ["count drift caused breakage"],
      relatedFiles: ["src/index.ts", "README.md"],
    })) as {
      success: boolean;
      guardrail: GuardrailMemory;
    };
    expect(first.success).toBe(true);

    const second = (await sdk.trigger("mem::guardrail-save", {
      project: "/repo",
      scopeType: "file",
      scopeId: "src/index.ts",
      triggerConditions: ["when editing endpoint counts or docs"],
      riskLevel: "high",
      explanation: "Keep API counts, docs, and log lines aligned",
      supersedes: [first.guardrail.id],
      relatedFiles: ["src/index.ts", "README.md"],
    })) as {
      success: boolean;
      guardrail: GuardrailMemory;
    };
    expect(second.success).toBe(true);

    const firstStored = await kv.get<GuardrailMemory>(KV.guardrails, first.guardrail.id);
    expect(firstStored?.status).toBe("superseded");
    expect(firstStored?.supersededBy).toBe(second.guardrail.id);

    const blockerOverlay = (await sdk.trigger("mem::branch-overlay-save", {
      project: "/repo",
      branch: "feature/guardrails",
      targetType: "blocker",
      targetId: "endpoint-counts",
      summary: "Promote the count-drift blocker into global negative memory",
      blockers: ["Docs and runtime counts drift together"],
      notes: ["Verify README and startup log before merge"],
    })) as { overlay: BranchOverlay };

    const promoted = (await sdk.trigger("mem::branch-overlay-promote", {
      overlayId: blockerOverlay.overlay.id,
    })) as {
      success: boolean;
      promotedTarget: GuardrailMemory;
    };
    expect(promoted.success).toBe(true);
    expect(promoted.promotedTarget.scopeType).toBe("project");

    const searched = (await sdk.trigger("mem::guardrail-search", {
      project: "/repo",
      query: "endpoint counts docs",
    })) as { success: boolean; guardrails: Array<GuardrailMemory & { score: number }> };
    expect(searched.success).toBe(true);
    expect(searched.guardrails.length).toBeGreaterThan(0);
  });

  it("saves decisions and builds dossiers from observations, guardrails, and decisions", async () => {
    const session: Session = {
      id: "ses_1",
      project: "/repo",
      cwd: "/repo",
      branch: "feature/context",
      startedAt: "2026-04-20T00:00:00Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs_1", {
      id: "obs_1",
      sessionId: session.id,
      timestamp: "2026-04-20T00:00:01Z",
      type: "file_edit",
      title: "Context selection changed",
      facts: ["added guardrail lane"],
      narrative: "Context retrieval now surfaces negative memory before stale summaries.",
      concepts: ["guardrail memory", "retrieval context"],
      files: ["src/functions/context.ts"],
      importance: 8,
    });
    const lesson: Lesson = {
      id: "lsn_1",
      content: "Keep endpoint counts aligned when adding routes.",
      context: "src/functions/context.ts interacts with retrieval budget reporting.",
      confidence: 0.8,
      reinforcements: 1,
      source: "manual",
      sourceIds: [],
      project: "/repo",
      tags: ["context"],
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-20T00:00:00Z",
      decayRate: 0.05,
    };
    const insight: Insight = {
      id: "ins_1",
      title: "Context retrieval should carry negative memory",
      content: "Guardrails and decisions belong in the same retrieval lane as positive context.",
      confidence: 0.7,
      reinforcements: 1,
      sourceConceptCluster: ["context"],
      sourceMemoryIds: [],
      sourceLessonIds: [lesson.id],
      sourceCrystalIds: [],
      project: "/repo",
      tags: ["context"],
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-20T00:00:00Z",
      decayRate: 0.05,
    };
    await kv.set(KV.lessons, lesson.id, lesson);
    await kv.set(KV.insights, insight.id, insight);

    const decision = (await sdk.trigger("mem::decision-save", {
      title: "Prefer durable negative memory in context",
      decision: "Inject guardrails into mem::context",
      rationale: "Repeated failure patterns should be visible at retrieval time.",
      reconsiderWhen: ["guardrails become too noisy"],
      project: "/repo",
      branch: "feature/context",
      relatedFiles: ["src/functions/context.ts"],
      relatedConcepts: ["guardrail memory"],
    })) as {
      success: boolean;
      decisionRecord: { id: string };
    };
    expect(decision.success).toBe(true);

    await sdk.trigger("mem::guardrail-save", {
      project: "/repo",
      branch: "feature/context",
      scopeType: "file",
      scopeId: "src/functions/context.ts",
      triggerConditions: ["when changing retrieval lane order"],
      riskLevel: "medium",
      explanation: "Keep negative memory visible without drowning hot working set context",
      relatedFiles: ["src/functions/context.ts"],
      relatedConcepts: ["guardrail memory"],
    });

    const dossier = (await sdk.trigger("mem::dossier-refresh", {
      project: "/repo",
      branch: "feature/context",
      filePath: "src/functions/context.ts",
    })) as {
      success: boolean;
      dossier: ComponentDossier;
    };

    expect(dossier.success).toBe(true);
    expect(dossier.dossier.relatedDecisionIds).toContain(decision.decisionRecord.id);
    expect(dossier.dossier.relatedInsightIds).toContain(insight.id);
    expect(dossier.dossier.summary).toContain("Context retrieval");
    expect(dossier.dossier.activeRisks.some((risk) => risk.includes("negative memory"))).toBe(
      true,
    );
  });

  it("compiles repeated crystal action chains into routine candidates", async () => {
    const actions: Action[] = [
      {
        id: "act_1",
        title: "Refresh viewer",
        description: "",
        status: "done",
        priority: 1,
        createdAt: "2026-04-20T00:00:00Z",
        updatedAt: "2026-04-20T00:00:00Z",
        createdBy: "agent-1",
        project: "/repo",
        tags: ["viewer"],
        sourceObservationIds: [],
        sourceMemoryIds: [],
      },
      {
        id: "act_2",
        title: "Verify health endpoint",
        description: "",
        status: "done",
        priority: 1,
        createdAt: "2026-04-20T00:00:00Z",
        updatedAt: "2026-04-20T00:00:00Z",
        createdBy: "agent-1",
        project: "/repo",
        tags: ["viewer"],
        sourceObservationIds: [],
        sourceMemoryIds: [],
      },
      {
        id: "act_3",
        title: "Refresh viewer",
        description: "",
        status: "done",
        priority: 1,
        createdAt: "2026-04-20T00:00:00Z",
        updatedAt: "2026-04-20T00:00:00Z",
        createdBy: "agent-2",
        project: "/repo",
        tags: ["viewer"],
        sourceObservationIds: [],
        sourceMemoryIds: [],
      },
      {
        id: "act_4",
        title: "Verify health endpoint",
        description: "",
        status: "done",
        priority: 1,
        createdAt: "2026-04-20T00:00:00Z",
        updatedAt: "2026-04-20T00:00:00Z",
        createdBy: "agent-2",
        project: "/repo",
        tags: ["viewer"],
        sourceObservationIds: [],
        sourceMemoryIds: [],
      },
    ];
    for (const action of actions) {
      await kv.set(KV.actions, action.id, action);
    }

    const crystals: Crystal[] = [
      {
        id: "cry_1",
        narrative: "Viewer refresh sequence",
        keyOutcomes: [],
        filesAffected: [],
        lessons: [],
        sourceActionIds: ["act_1", "act_2"],
        project: "/repo",
        createdAt: "2026-04-20T00:00:00Z",
      },
      {
        id: "cry_2",
        narrative: "Viewer refresh sequence repeated",
        keyOutcomes: [],
        filesAffected: [],
        lessons: [],
        sourceActionIds: ["act_3", "act_4"],
        project: "/repo",
        createdAt: "2026-04-20T00:01:00Z",
      },
    ];
    for (const crystal of crystals) {
      await kv.set(KV.crystals, crystal.id, crystal);
    }

    const result = (await sdk.trigger("mem::routine-compile", {
      project: "/repo",
      minActionCount: 2,
      minEvidenceCount: 2,
    })) as {
      success: boolean;
      routineCandidates: Array<{ stepTitles: string[]; evidenceCount: number }>;
    };

    expect(result.success).toBe(true);
    expect(result.routineCandidates).toHaveLength(1);
    expect(result.routineCandidates[0].stepTitles).toEqual([
      "Refresh viewer",
      "Verify health endpoint",
    ]);
    expect(result.routineCandidates[0].evidenceCount).toBe(2);
  });
});
