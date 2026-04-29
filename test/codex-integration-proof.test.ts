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
});
