// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerCodexIntegrationProofFunction } from "../src/functions/codex-integration-proof.js";
import { registerContextFunction } from "../src/functions/context.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import type {
  BranchOverlay,
  DecisionMemory,
  GuardrailMemory,
  HandoffPacket,
  Session,
  SessionSummary,
} from "../src/types.js";

describe("Codex payload compatibility", () => {
  it("accepts Codex-style lifecycle payloads and returns the completed turn immediately", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerContextFunction(sdk as never, kv as never, 900);

    await kv.set(KV.sessions, "session-codex", {
      id: "session-codex",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T12:00:00.000Z",
      status: "active",
      observationCount: 0,
    });

    await sdk.trigger("mem::observe", {
      hookType: "prompt_submit",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-prompt-1",
      persistenceClass: "persistent",
      capabilities: ["query_aware_context", "event_identity"],
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        prompt: "Audit current Codex memory integration",
      },
    });

    await sdk.trigger("mem::observe", {
      hookType: "post_tool_use",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:01.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-post-tool-1",
      persistenceClass: "persistent",
      capabilities: ["structured_post_tool_payload", "event_identity"],
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "toolu_123",
        tool_input: {
          file_path: "/project/src/agentmemory.ts",
          query: "agentmemory integration",
        },
        tool_output: {
          status: "ok",
        },
      },
    });

    await sdk.trigger("mem::observe", {
      hookType: "assistant_result",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:02.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-assistant-1",
      persistenceClass: "persistent",
      capabilities: ["event_identity"],
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        assistant_text: "Codex integration is active and session-backed.",
        is_final: true,
      },
    });

    await sdk.trigger("mem::observe", {
      hookType: "stop",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:03.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-stop-1",
      persistenceClass: "ephemeral",
      capabilities: ["event_identity"],
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        last_assistant_message:
          "Codex integration is active and session-backed.",
      },
    });

    const capsule = await kv.get<any>(
      KV.turnCapsules,
      "session-codex:turn-codex-1",
    );
    expect(capsule.userPrompt).toBe("Audit current Codex memory integration");
    expect(capsule.assistantConclusion).toBe(
      "Codex integration is active and session-backed.",
    );
    expect(capsule.files).toContain("/project/src/agentmemory.ts");
    expect(capsule.concepts).toContain("agentmemory integration");

    const workingSet = await kv.get<any>(KV.workingSets, "session-codex");
    expect(workingSet.latestCompletedTurnId).toBe("turn-codex-1");
    expect(workingSet.latestCompletedCapsule.turnId).toBe("turn-codex-1");
    expect(workingSet.latestCompletedCapsule.files).toBeUndefined();
    expect(workingSet.latestCompletedCapsule.concepts).toBeUndefined();
    expect(workingSet.latestCompletedCapsule.sourceObservationIds).toBeUndefined();
    expect(workingSet.latestCompletedCapsule.importantObservationIds).toBeUndefined();

    const result = (await sdk.trigger("mem::context", {
      sessionId: "session-codex",
      project: "/project",
      budget: 900,
    })) as { context: string };

    expect(result.context).toContain("Audit current Codex memory integration");
    expect(result.context).toContain(
      "Codex integration is active and session-backed.",
    );
    expect(result.items[0]?.why).toBeTruthy();
    expect(result.items[0]?.freshness).toBeTruthy();
  });

  it("returns a bootstrap payload for session start with latest handoff and coordination signals for the current session", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);
    registerApiTriggers(sdk as never, kv as never);

    const previousSession: Session = {
      id: "session-codex-prev",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T11:00:00.000Z",
      status: "completed",
      observationCount: 3,
      latestHandoffPacketId: "hdf-prev",
    };
    const previousSummary: SessionSummary = {
      sessionId: previousSession.id,
      project: "/project",
      createdAt: "2026-03-29T11:05:00.000Z",
      title: "Previous session summary",
      narrative: "Deployment coordination still needs approval.",
      keyDecisions: ["Keep approval as a checkpoint"],
      filesModified: ["/project/src/triggers/api.ts"],
      concepts: ["deployment"],
      observationCount: 3,
    };
    const handoff: HandoffPacket = {
      id: "hdf-prev",
      createdAt: "2026-03-29T11:05:00.000Z",
      updatedAt: "2026-03-29T11:06:00.000Z",
      project: "/project",
      scopeType: "session",
      scopeId: previousSession.id,
      summary: "Resume the deploy handoff from the previous session.",
      recentChanges: ["API wiring is done."],
      knownFacts: ["Approval is pending."],
      relevantFiles: ["/project/src/triggers/api.ts"],
      relevantConcepts: ["deployment", "approval"],
      blockers: ["Checkpoint pending: Production approval"],
      openQuestions: ["Who approves production?"],
      recommendedNextStep: "Resolve production approval.",
      confidence: 0.81,
      sourceObservationIds: [],
      sourceActionIds: [],
      sourceBeliefIds: [],
    };
    const guardrail: GuardrailMemory = {
      id: "grd-bootstrap",
      createdAt: "2026-03-29T11:01:00.000Z",
      updatedAt: "2026-03-29T11:02:00.000Z",
      project: "/project",
      scopeType: "project",
      scopeId: "/project",
      triggerConditions: ["deploy to production"],
      riskLevel: "high",
      explanation: "Production deploy requires explicit approval.",
      evidence: [],
      relatedFiles: ["/project/src/triggers/api.ts"],
      relatedConcepts: ["deployment"],
      status: "active",
      supersedes: [],
      sourceObservationIds: [],
      sourceActionIds: [],
    };
    const decision: DecisionMemory = {
      id: "dec-bootstrap",
      createdAt: "2026-03-29T11:01:00.000Z",
      updatedAt: "2026-03-29T11:03:00.000Z",
      title: "Use approval checkpoints",
      decision: "Keep production approval external.",
      rationale: "Avoid accidental deploys.",
      alternatives: ["Auto-approve deploys"],
      reconsiderWhen: ["Approval latency becomes a blocker"],
      status: "active",
      project: "/project",
      relatedFiles: ["/project/src/triggers/api.ts"],
      relatedConcepts: ["deployment"],
      sourceObservationIds: [],
      sourceActionIds: [],
      supersedes: [],
    };
    const overlay: BranchOverlay = {
      id: "brx-bootstrap",
      createdAt: "2026-03-29T11:01:00.000Z",
      updatedAt: "2026-03-29T11:04:00.000Z",
      project: "/project",
      branch: "main",
      targetType: "handoff",
      targetId: handoff.id,
      summary: "Main branch deploy overlay is still active.",
      blockers: ["Approval missing"],
      notes: [],
      status: "active",
    };

    await kv.set(KV.sessions, previousSession.id, previousSession);
    await kv.set(KV.summaries, previousSummary.sessionId, previousSummary);
    await kv.set(KV.handoffPackets, handoff.id, handoff);
    await kv.set(KV.guardrails, guardrail.id, guardrail);
    await kv.set(KV.decisions, decision.id, decision);
    await kv.set(KV.branchOverlays, overlay.id, overlay);

    sdk.registerFunction("mem::next", async () => ({
      success: true,
      suggestion: {
        actionId: "act-1",
        title: "Resolve production approval",
        priority: 9,
        score: 92,
      },
    }));

    const response = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: previousSession.id,
        project: "/project",
        cwd: "/project",
      },
      headers: {},
    })) as {
      status_code: number;
      body: {
        context: string;
        bootstrap: {
          latestHandoff: HandoffPacket | null;
          nextAction: { title?: string } | null;
          guardrails: GuardrailMemory[];
          activeDecisions: DecisionMemory[];
          branchOverlaySummary?: string | null;
        };
      };
    };

    expect(response.status_code).toBe(200);
    expect(typeof response.body.context).toBe("string");
    expect(response.body.bootstrap.latestHandoff?.id).toBe(handoff.id);
    expect(response.body.bootstrap.nextAction?.title).toBe("Resolve production approval");
    expect(response.body.bootstrap.guardrails[0]?.id).toBe(guardrail.id);
    expect(response.body.bootstrap.activeDecisions[0]?.id).toBe(decision.id);
    expect(response.body.bootstrap.branchOverlaySummary).toContain("deploy overlay");
    expect(response.body.bootstrap.warnings).toContain(
      "session_start_context_deferred",
    );
  });

  it("defers context retrieval during session start by default", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    let contextCalled = false;
    sdk.registerFunction("mem::context", async () => {
      contextCalled = true;
      return { context: "should not be returned", items: [] };
    });
    sdk.registerFunction("mem::next", async () => ({
      success: true,
      suggestion: null,
    }));

    const response = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "session-context-deferred",
        project: "/project",
        cwd: "/project",
        branch: "main",
      },
      headers: {},
    })) as {
      status_code: number;
      body: {
        context: string;
        bootstrap: {
          partial?: boolean;
          omitted?: string[];
          warnings?: string[];
        };
      };
    };

    expect(response.status_code).toBe(200);
    expect(contextCalled).toBe(false);
    expect(response.body.context).toBe("");
    expect(response.body.bootstrap.partial).toBe(true);
    expect(response.body.bootstrap.omitted).toContain("context");
    expect(response.body.bootstrap.warnings).toContain(
      "session_start_context_deferred",
    );
  });

  it("fails open when session start bootstrap stalls", async () => {
    const previousTimeout = process.env.AGENTMEMORY_SESSION_START_BOOTSTRAP_TIMEOUT_MS;
    process.env.AGENTMEMORY_SESSION_START_BOOTSTRAP_TIMEOUT_MS = "5";
    try {
      const sdk = mockSdk();
      const kv = mockKV();
      registerApiTriggers(sdk as never, kv as never);

      sdk.registerFunction("mem::context", async () => new Promise(() => {}));
      sdk.registerFunction("mem::next", async () => new Promise(() => {}));

      const startedAt = Date.now();
      const response = (await sdk.trigger("api::session::start", {
        body: {
          sessionId: "session-bootstrap-timeout",
          project: "/project",
          cwd: "/project",
          branch: "main",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          context: string;
          bootstrap: {
            partial?: boolean;
            omitted?: string[];
            warnings?: string[];
          };
        };
      };

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(response.status_code).toBe(200);
      expect(response.body.context).toBe("");
      expect(response.body.bootstrap.partial).toBe(true);
      expect(response.body.bootstrap.omitted).toContain("bootstrap");
      expect(response.body.bootstrap.warnings).toContain(
        "session_start_bootstrap_timeout",
      );
      const session = await kv.get<Session>(KV.sessions, "session-bootstrap-timeout");
      expect(session?.status).toBe("active");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AGENTMEMORY_SESSION_START_BOOTSTRAP_TIMEOUT_MS;
      } else {
        process.env.AGENTMEMORY_SESSION_START_BOOTSTRAP_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("fails open when session persistence stalls", async () => {
    const previousTimeout = process.env.AGENTMEMORY_SESSION_START_PERSIST_TIMEOUT_MS;
    process.env.AGENTMEMORY_SESSION_START_PERSIST_TIMEOUT_MS = "5";
    try {
      const sdk = mockSdk();
      const kv = mockKV();
      const slowKv = {
        ...kv,
        set: async <T>(scope: string, key: string, data: T): Promise<T> => {
          if (scope === KV.sessions) {
            return new Promise(() => {});
          }
          return kv.set(scope, key, data);
        },
      };
      registerApiTriggers(sdk as never, slowKv as never);

      const response = (await sdk.trigger("api::session::start", {
        body: {
          sessionId: "session-persistence-timeout",
          project: "/project",
          cwd: "/project",
          branch: "main",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          context: string;
          bootstrap: {
            partial?: boolean;
            warnings?: string[];
          };
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.context).toBe("");
      expect(response.body.bootstrap.partial).toBe(true);
      expect(response.body.bootstrap.warnings).toContain(
        "session_start_persistence_timeout",
      );
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AGENTMEMORY_SESSION_START_PERSIST_TIMEOUT_MS;
      } else {
        process.env.AGENTMEMORY_SESSION_START_PERSIST_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("supports bounded idempotent closeout for Codex sessions", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const session: Session = {
      id: "session-codex-closeout",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T12:00:00.000Z",
      status: "active",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);

    sdk.registerFunction("mem::summarize", async ({ sessionId }: { sessionId: string }) => {
      const summary: SessionSummary = {
        sessionId,
        project: "/project",
        createdAt: "2026-03-29T12:10:00.000Z",
        title: "Closeout summary",
        narrative: "Session closeout completed.",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 2,
      };
      await kv.set(KV.summaries, sessionId, summary);
      return { success: true, summary };
    });
    sdk.registerFunction("mem::auto-crystallize", async () => ({
      success: true,
      groupCount: 0,
      crystalIds: [],
    }));
    sdk.registerFunction("mem::consolidate-pipeline", async () => ({
      success: true,
    }));

    const first = (await sdk.trigger("api::session::closeout", {
      body: { sessionId: session.id },
      headers: {},
    })) as {
      status_code: number;
      body: {
        success: boolean;
        steps: Record<string, string>;
      };
    };
    expect(first.status_code).toBe(200);
    expect(first.body.success).toBe(true);
    expect(first.body.steps).toMatchObject({
      summarize: "ok",
      endSession: "ok",
      crystallize: "ok",
      consolidate: "ok",
    });

    const storedSession = await kv.get<Session>(KV.sessions, session.id);
    expect(storedSession?.status).toBe("completed");
    expect(storedSession?.endedAt).toBeDefined();

    const second = (await sdk.trigger("api::session::closeout", {
      body: { sessionId: session.id },
      headers: {},
    })) as {
      status_code: number;
      body: {
        success: boolean;
        steps: Record<string, string>;
      };
    };
    expect(second.status_code).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.steps.summarize).toBe("skipped");
    expect(second.body.steps.endSession).toBe("skipped");
  });

  it("returns a Codex integration proof bundle with separate contract, quality, and latency signals", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    sdk.registerFunction("mem::context", async () => ({
      context: "Codex startup context includes the latest handoff.",
      items: [{ id: "ctx-1", why: "recent handoff", freshness: "recent" }],
      blocks: 1,
      tokens: 8,
      trace: { lanes: [] },
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      results: [{ id: "result-1", title: "Codex integration" }],
      mode: "hybrid",
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: {
        status: "healthy",
        queuedCount: 0,
        blockingQueuedCount: 0,
      },
    }));

    const response = (await sdk.trigger("api::codex-integration-proof", {
      body: {
        sessionId: "session-codex-proof",
        project: "/home/ericjuta/.openclaw/workspace/repos/codex",
        cwd: "/home/ericjuta/.openclaw/workspace/repos/codex",
        query: "Codex integration proof",
        latencyTargetsMs: {
          sessionStart: 60_000,
          context: 60_000,
          smartSearch: 60_000,
        },
      },
      headers: {},
    })) as {
      status_code: number;
      body: {
        pass: boolean;
        contractPass: boolean;
        qualityPass: boolean;
        latencyWarnings: string[];
        steps: Record<
          string,
          {
            status: string;
            details: Record<string, unknown>;
          }
        >;
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.pass).toBe(true);
    expect(response.body.contractPass).toBe(true);
    expect(response.body.qualityPass).toBe(true);
    expect(response.body.latencyWarnings).toEqual([]);
    expect(response.body.steps.sessionStart.status).toBe("pass");
    expect(response.body.steps.sessionStart.details.envelope).toEqual([
      "session",
      "context",
      "bootstrap",
    ]);
    expect(response.body.steps.context.details).toMatchObject({
      chars: 50,
      tokens: 8,
      blocks: 1,
      tracePresent: true,
    });
    expect(response.body.steps.smartSearch.details).toMatchObject({
      results: 1,
      mode: "hybrid",
    });
    expect(response.body.steps.retrievalProof.details).toMatchObject({
      pass: true,
      maintenanceStatus: "healthy",
      queuedCount: 0,
      blockingQueuedCount: 0,
    });
  });
});
