import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerContextFunction } from "../src/functions/context.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("context debug trace", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    vi.useRealTimers();
    sdk = mockSdk();
    kv = mockKV();
    registerContextFunction(sdk as any, kv as any, 100);
    registerApiTriggers(sdk as any, kv as any);
    await kv.set(KV.sessions, "prior_trace", {
      id: "prior_trace",
      project: "/tmp/trace-project",
      cwd: "/tmp/trace-project",
      startedAt: "2026-05-04T00:00:00.000Z",
      status: "active",
      observationCount: 2,
    });
    await kv.set(KV.sessions, "older_trace", {
      id: "older_trace",
      project: "/tmp/trace-project",
      cwd: "/tmp/trace-project",
      startedAt: "2026-05-03T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    });
    await kv.set(KV.observations("prior_trace"), "obs_trace_selected", {
      id: "obs_trace_selected",
      sessionId: "prior_trace",
      timestamp: "2026-05-04T00:00:01.000Z",
      type: "decision",
      title: "Selected trace decision",
      facts: ["selected trace fact"],
      narrative: "selected trace fact",
      concepts: [],
      files: [],
      importance: 9,
    });
    await kv.set(KV.observations("older_trace"), "obs_trace_skipped", {
      id: "obs_trace_skipped",
      sessionId: "older_trace",
      timestamp: "2026-05-03T00:00:01.000Z",
      type: "decision",
      title: "Skipped trace decision",
      facts: ["skipped trace fact"],
      narrative: "skipped trace fact ".repeat(80),
      concepts: [],
      files: [],
      importance: 9,
    });
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_CONTEXT_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_SESSION_START_CONTEXT_TIMEOUT_MS"];
    vi.useRealTimers();
  });

  it("keeps debug trace and source ids absent by default", async () => {
    const result = await sdk.trigger({
      function_id: "api::context",
      payload: {
        body: {
          sessionId: "current_trace",
          project: "/tmp/trace-project",
          budget: 100,
        },
      },
    }) as { body: Record<string, unknown> };

    expect(result.body.context).toEqual(expect.stringContaining("<agentmemory-context"));
    expect(result.body).not.toHaveProperty("debugTrace");
    expect(result.body).not.toHaveProperty("selectedObservationIds");
  });

  it("returns selected and budget-skipped block trace only when requested", async () => {
    const result = await sdk.trigger({
      function_id: "api::context",
      payload: {
        body: {
          sessionId: "current_trace",
          project: "/tmp/trace-project",
          budget: 100,
          includeRetrievalIds: true,
          debugTrace: true,
        },
      },
    }) as { body: Record<string, unknown> };

    expect(result.body.selectedObservationIds).toContain("obs_trace_selected");
    const debugTrace = result.body.debugTrace as {
      degraded: boolean;
      blocks: Array<{
        type: string;
        sourceObservationIds: string[];
        sessionIds: string[];
        tokens: number;
        status: string;
        skipReason?: string;
      }>;
    };
    expect(debugTrace.degraded).toBe(false);
    expect(debugTrace.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "observation",
        sourceObservationIds: ["obs_trace_selected"],
        sessionIds: ["prior_trace"],
        status: "selected",
      }),
      expect.objectContaining({
        type: "observation",
        sourceObservationIds: ["obs_trace_skipped"],
        sessionIds: ["older_trace"],
        status: "skipped",
        skipReason: "budget_exceeded",
      }),
    ]));
    expect(debugTrace.blocks.every((block) => typeof block.tokens === "number")).toBe(true);
  });

  it("returns a debug fallback trace when API context generation times out", async () => {
    process.env["AGENTMEMORY_CONTEXT_TIMEOUT_MS"] = "1";
    sdk.registerFunction("mem::context", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { context: "late", blocks: 1, tokens: 1 };
    });

    const result = await sdk.trigger({
      function_id: "api::context",
      payload: {
        body: {
          sessionId: "current_trace",
          project: "/tmp/trace-project",
          debugTrace: true,
        },
      },
    }) as { body: Record<string, unknown> };

    expect(result.body).toMatchObject({
      context: "",
      blocks: 0,
      tokens: 0,
      debugTrace: {
        requested: true,
        degraded: true,
        fallbackReason: "context_timeout",
      },
    });
  });

  it("returns a degraded session-start marker when startup context times out", async () => {
    process.env["AGENTMEMORY_SESSION_START_CONTEXT_TIMEOUT_MS"] = "1";
    sdk.registerFunction("mem::context", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { context: "late startup context" };
    });

    const result = await sdk.trigger({
      function_id: "api::session::start",
      payload: {
        body: {
          sessionId: "startup_timeout",
          project: "/tmp/trace-project",
          cwd: "/tmp/trace-project",
        },
      },
    }) as { body: Record<string, unknown> };

    expect(result.body).toMatchObject({
      context: "",
      degraded: true,
      fallbackReason: "context_timeout",
      session: {
        id: "startup_timeout",
        status: "active",
      },
    });
  });
});
