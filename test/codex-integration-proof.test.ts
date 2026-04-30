import { describe, expect, it } from "vitest";

import { registerCodexIntegrationProofFunction } from "../src/functions/codex-integration-proof.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("mem::codex-integration-proof", () => {
  it("separates contract, quality, and latency warnings", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("api::session::start", async () => ({
      status_code: 200,
      body: {
        session: { id: "session-1", project: "/project" },
        context: "",
        bootstrap: { latestHandoff: null, warnings: [] },
      },
    }));
    sdk.registerFunction("mem::context", async () => ({
      context: "Relevant Codex memory context",
      tokens: 120,
      blocks: [{ id: "block-1" }],
      trace: { selected: 1 },
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      mode: "hybrid",
      results: [{ id: "result-1" }],
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: {
        status: "non_blocking_backlog",
        queuedCount: 5,
        blockingQueuedCount: 0,
      },
    }));
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-integration-proof", {
      project: "/project",
      sessionId: "session-1",
      latencyTargetsMs: { sessionStart: 1, context: 1, smartSearch: 1 },
    })) as {
      pass: boolean;
      contractPass: boolean;
      qualityPass: boolean;
      latencyWarnings: string[];
      steps: {
        sessionStart: { status: string; details: { envelope: string[] } };
        context: { status: string; details: { chars: number; tokens: number } };
        smartSearch: { status: string; details: { results: number } };
        retrievalProof: { status: string; details: { maintenanceStatus: string } };
      };
    };

    expect(result.pass).toBe(true);
    expect(result.contractPass).toBe(true);
    expect(result.qualityPass).toBe(true);
    expect(result.steps.sessionStart.details.envelope.sort()).toEqual([
      "bootstrap",
      "context",
      "session",
    ]);
    expect(result.steps.context.details).toMatchObject({ chars: 29, tokens: 120 });
    expect(result.steps.smartSearch.details.results).toBe(1);
    expect(result.steps.retrievalProof.details.maintenanceStatus).toBe(
      "non_blocking_backlog",
    );
    expect(result.latencyWarnings.length).toBeGreaterThanOrEqual(0);
  });

  it("fails the contract when session start does not return the Codex envelope", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("api::session::start", async () => ({
      status_code: 200,
      body: { ok: true },
    }));
    sdk.registerFunction("mem::context", async () => ({
      context: "Relevant Codex memory context",
      blocks: [{ id: "block-1" }],
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      results: [{ id: "result-1" }],
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: { status: "caught_up" },
    }));
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-integration-proof", {
      project: "/project",
    })) as {
      pass: boolean;
      contractPass: boolean;
      qualityPass: boolean;
      steps: { sessionStart: { status: string } };
    };

    expect(result.pass).toBe(false);
    expect(result.contractPass).toBe(false);
    expect(result.qualityPass).toBe(true);
    expect(result.steps.sessionStart.status).toBe("fail");
  });

  it("treats degraded non-empty pressure fallback context as a warning", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:health", "latest", {
      status: "critical",
      alerts: ["cpu_critical_152%"],
      eventLoopLagMs: 59,
      kvConnectivity: { status: "ok", latencyMs: 90 },
      observeCapture: { status: "shedding" },
    });
    sdk.registerFunction("api::session::start", async () => ({
      status_code: 200,
      body: {
        session: { id: "session-1", project: "/project" },
        context: "",
        bootstrap: { latestHandoff: null, warnings: [] },
      },
    }));
    sdk.registerFunction("mem::context", async () => ({
      context: "Relevant Codex fallback context",
      tokens: 120,
      blocks: 1,
      trace: { selected: 1 },
      degraded: true,
      fallback: "last-known-good",
      ageMs: 42,
      pressure: { reason: "critical", runtimeStatus: "critical" },
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      mode: "hybrid",
      results: [{ id: "result-1" }],
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: { status: "caught_up" },
    }));
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-integration-proof", {
      project: "/project",
      sessionId: "session-1",
    })) as {
      pass: boolean;
      qualityPass: boolean;
      warnings: string[];
      health: { status: string; observeCaptureStatus: string };
      steps: { context: { status: string; details: Record<string, unknown> } };
    };

    expect(result.pass).toBe(true);
    expect(result.qualityPass).toBe(true);
    expect(result.warnings).toContain("latency_context");
    expect(result.health).toMatchObject({
      status: "critical",
      observeCaptureStatus: "shedding",
    });
    expect(result.steps.context.status).toBe("warn");
    expect(result.steps.context.details).toMatchObject({
      contextStatus: "degraded",
      fallback: "last-known-good",
      degraded: true,
      pressureReason: "critical",
      runtimeStatus: "critical",
      observeCaptureStatus: "shedding",
      ageMs: 42,
    });
  });

  it("keeps cold-session project fallback context as a warning", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:health", "latest", {
      status: "critical",
      alerts: ["cpu_critical_152%"],
      eventLoopLagMs: 59,
      kvConnectivity: { status: "ok", latencyMs: 90 },
      observeCapture: { status: "shedding" },
    });
    sdk.registerFunction("api::session::start", async () => ({
      status_code: 200,
      body: {
        session: { id: "cold-session-1", project: "/project" },
        context: "",
        bootstrap: { latestHandoff: null, warnings: [] },
      },
    }));
    sdk.registerFunction("mem::context", async () => ({
      context: "Project-level Codex fallback context",
      tokens: 120,
      blocks: 1,
      trace: { selected: 1 },
      degraded: true,
      fallback: "last-known-good",
      ageMs: 42,
      pressure: {
        reason: "critical",
        runtimeStatus: "critical",
        fallbackScope: "project",
      },
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      mode: "hybrid",
      results: [{ id: "result-1" }],
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: { status: "caught_up" },
    }));
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-integration-proof", {
      project: "/project",
      sessionId: "cold-session-1",
    })) as {
      pass: boolean;
      qualityPass: boolean;
      warnings: string[];
      steps: { context: { status: string; details: Record<string, unknown> } };
    };

    expect(result.pass).toBe(true);
    expect(result.qualityPass).toBe(true);
    expect(result.warnings).toContain("context_degraded");
    expect(result.steps.context.status).toBe("warn");
    expect(result.steps.context.details).toMatchObject({
      contextStatus: "degraded",
      fallback: "last-known-good",
      pressureReason: "critical",
      runtimeStatus: "critical",
      pressure: { fallbackScope: "project" },
    });
  });

  it("keeps empty pressure context as a quality failure", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("api::session::start", async () => ({
      status_code: 200,
      body: {
        session: { id: "session-1", project: "/project" },
        context: "",
        bootstrap: { latestHandoff: null, warnings: [] },
      },
    }));
    sdk.registerFunction("mem::context", async () => ({
      context: "",
      tokens: 0,
      blocks: 0,
      trace: {},
      degraded: true,
      fallback: "empty",
      pressure: { reason: "critical" },
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      mode: "hybrid",
      results: [{ id: "result-1" }],
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: { status: "caught_up" },
    }));
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-integration-proof", {
      project: "/project",
      sessionId: "session-1",
    })) as {
      pass: boolean;
      qualityPass: boolean;
      steps: { context: { status: string; details: Record<string, unknown> } };
    };

    expect(result.pass).toBe(false);
    expect(result.qualityPass).toBe(false);
    expect(result.steps.context.status).toBe("fail");
    expect(result.steps.context.details).toMatchObject({
      contextStatus: "empty",
      fallback: "empty",
      pressureReason: "critical",
    });
  });

  it("keeps empty fallback with zero token metadata as a quality failure", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("api::session::start", async () => ({
      status_code: 200,
      body: {
        session: { id: "session-1", project: "/project" },
        context: "",
        bootstrap: { latestHandoff: null, warnings: [] },
      },
    }));
    sdk.registerFunction("mem::context", async () => ({
      context: "",
      tokens: 0,
      trace: {},
      degraded: true,
      fallback: "empty",
      pressure: { reason: "critical" },
    }));
    sdk.registerFunction("mem::smart-search", async () => ({
      mode: "hybrid",
      results: [{ id: "result-1" }],
    }));
    sdk.registerFunction("mem::retrieval-proof", async () => ({
      pass: true,
      maintenance: { status: "caught_up" },
    }));
    registerCodexIntegrationProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::codex-integration-proof", {
      project: "/project",
      sessionId: "session-1",
    })) as {
      pass: boolean;
      qualityPass: boolean;
      steps: { context: { status: string; details: Record<string, unknown> } };
    };

    expect(result.pass).toBe(false);
    expect(result.qualityPass).toBe(false);
    expect(result.steps.context.status).toBe("fail");
    expect(result.steps.context.details).toMatchObject({
      contextStatus: "empty",
      fallback: "empty",
      pressureReason: "critical",
    });
  });
});
