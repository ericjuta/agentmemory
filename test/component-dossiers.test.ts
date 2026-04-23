import { describe, expect, it } from "vitest";
import { registerComponentDossiersFunction } from "../src/functions/component-dossiers.js";
import { upsertObservationRetrievalBlock } from "../src/functions/retrieval-blocks.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  DecisionMemory,
  GuardrailMemory,
  Insight,
  Session,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("component dossiers", () => {
  it("uses file-matched retrieval state and ignores unrelated project insights", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerComponentDossiersFunction(sdk as never, kv as never);

    const session: Session = {
      id: "session-auth",
      project: "/project",
      cwd: "/project",
      branch: "main",
      startedAt: "2026-03-29T12:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    const observation: CompressedObservation = {
      id: "obs-auth",
      sessionId: session.id,
      turnId: "turn-auth",
      timestamp: "2026-03-29T12:00:01.000Z",
      type: "file_edit",
      title: "Auth middleware updated",
      facts: ["status: ok"],
      narrative: "Adjusted the auth middleware write path.",
      concepts: ["auth", "middleware"],
      files: ["src/auth.ts"],
      importance: 7,
      confidence: 0.8,
    };
    const guardrail: GuardrailMemory = {
      id: "grd-auth",
      createdAt: "2026-03-29T12:00:02.000Z",
      updatedAt: "2026-03-29T12:00:03.000Z",
      project: "/project",
      branch: "main",
      scopeType: "project",
      scopeId: "/project",
      triggerConditions: ["edit auth write path"],
      riskLevel: "high",
      explanation: "Auth writes require explicit approval.",
      evidence: [],
      relatedFiles: ["src/auth.ts"],
      relatedConcepts: ["auth"],
      status: "active",
      supersedes: [],
      sourceObservationIds: [],
      sourceActionIds: [],
    };
    const decision: DecisionMemory = {
      id: "dec-auth",
      createdAt: "2026-03-29T12:00:02.000Z",
      updatedAt: "2026-03-29T12:00:04.000Z",
      title: "Keep auth approval gate",
      decision: "Keep approval before production auth writes.",
      rationale: "Auth writes are high-risk.",
      alternatives: [],
      reconsiderWhen: ["Auth workflow changes materially"],
      status: "active",
      project: "/project",
      branch: "main",
      relatedFiles: ["src/auth.ts"],
      relatedConcepts: ["auth"],
      sourceObservationIds: [],
      sourceActionIds: [],
      supersedes: [],
    };
    const unrelatedInsight: Insight = {
      id: "ins-unrelated",
      createdAt: "2026-03-29T12:00:05.000Z",
      updatedAt: "2026-03-29T12:00:05.000Z",
      project: "/project",
      title: "Worker health",
      content: "The worker health probe is noisy but unrelated.",
      confidence: 0.8,
      reinforcements: 1,
      sourceConceptCluster: ["health"],
      sourceMemoryIds: [],
      sourceLessonIds: [],
      sourceCrystalIds: [],
      tags: ["health"],
      decayRate: 0,
      deleted: false,
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), observation.id, observation);
    await upsertObservationRetrievalBlock(kv as never, observation, session.project);
    await kv.set(KV.guardrails, guardrail.id, guardrail);
    await kv.set(KV.decisions, decision.id, decision);
    await kv.set(KV.insights, unrelatedInsight.id, unrelatedInsight);

    const result = (await sdk.trigger("mem::dossier-refresh", {
      project: "/project",
      filePath: "/project/src/auth.ts",
      branch: "main",
    })) as { success: boolean; dossier: { summary: string; relatedGuardrailIds: string[]; relatedDecisionIds: string[]; sourceObservationIds: string[] } };

    expect(result.success).toBe(true);
    expect(result.dossier.summary).toContain("Adjusted the auth middleware write path.");
    expect(result.dossier.summary).not.toContain("worker health probe");
    expect(result.dossier.relatedGuardrailIds).toContain("grd-auth");
    expect(result.dossier.relatedDecisionIds).toContain("dec-auth");
    expect(result.dossier.sourceObservationIds).toEqual(["obs-auth"]);
  });

  it("tolerates raw observations and legacy insights without array fields", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerComponentDossiersFunction(sdk as never, kv as never);

    const session: Session = {
      id: "session-legacy",
      project: "/project",
      cwd: "/project",
      branch: "main",
      startedAt: "2026-03-29T12:00:00.000Z",
      status: "active",
      observationCount: 2,
    };
    const compressed: CompressedObservation = {
      id: "obs-compressed",
      sessionId: session.id,
      timestamp: "2026-03-29T12:00:01.000Z",
      type: "file_edit",
      title: "Context file updated",
      facts: [],
      narrative: "Updated the context file.",
      concepts: ["context"],
      files: ["src/functions/context.ts"],
      importance: 6,
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs-raw", {
      id: "obs-raw",
      sessionId: session.id,
      timestamp: "2026-03-29T12:00:00.500Z",
      hookType: "post_tool_use",
      raw: { file_path: "src/functions/context.ts" },
    });
    await kv.set(KV.observations(session.id), compressed.id, compressed);
    await kv.set(KV.insights, "ins-legacy", {
      id: "ins-legacy",
      title: "Legacy context insight",
      content: "Context files should stay small.",
      createdAt: "2026-03-29T12:00:02.000Z",
      updatedAt: "2026-03-29T12:00:02.000Z",
      project: "/project",
      confidence: 0.7,
      reinforcements: 1,
      decayRate: 0.05,
      deleted: false,
    });

    const result = (await sdk.trigger("mem::dossier-refresh", {
      project: "/project",
      filePath: "src/functions/context.ts",
      branch: "main",
    })) as {
      success: boolean;
      dossier: { summary: string; sourceObservationIds: string[]; relatedInsightIds: string[] };
    };

    expect(result.success).toBe(true);
    expect(result.dossier.summary).toContain("Updated the context file.");
    expect(result.dossier.sourceObservationIds).toEqual(["obs-compressed"]);
    expect(result.dossier.relatedInsightIds).toContain("ins-legacy");
  });
});
