import { describe, it, expect, beforeEach } from "vitest";

import { registerHookDiagnosticsFunctions } from "../src/functions/hook-diagnostics.js";
import { KV } from "../src/state/schema.js";
import type { HookDiagnostics } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("hook diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerHookDiagnosticsFunctions(sdk as any, kv as any);
  });

  it("records hook attempts and aggregates report counters", async () => {
    await sdk.trigger({
      function_id: "mem::hook-diagnostics-record",
      payload: {
        hookName: "PostToolUse",
        source: "codex-env-wrapper",
        status: "success",
        latencyMs: 12.4,
        exitCode: 0,
        timestamp: "2026-05-04T00:00:00.000Z",
      },
    });

    await sdk.trigger({
      function_id: "mem::hook-diagnostics-record",
      payload: {
        hookName: "PostToolUse",
        source: "codex-env-wrapper",
        status: "timeout",
        latencyMs: 750,
        signal: "SIGTERM",
        timestamp: "2026-05-04T00:01:00.000Z",
      },
    });

    const diagnostic = await kv.get<HookDiagnostics>(KV.hookDiagnostics, "PostToolUse");
    expect(diagnostic).toMatchObject({
      hookName: "PostToolUse",
      source: "codex-env-wrapper",
      attempts: 2,
      successes: 1,
      failures: 0,
      timeouts: 1,
      lastLatencyMs: 750,
      totalLatencyMs: 762,
      maxLatencyMs: 750,
      lastSignal: "SIGTERM",
      lastError: "hook command timed out",
    });

    const report = await sdk.trigger({
      function_id: "mem::hook-diagnostics-list",
      payload: {},
    }) as { summary: { attempts: number; successes: number; failures: number; timeouts: number }; hooks: HookDiagnostics[] };

    expect(report.summary).toEqual({
      attempts: 2,
      successes: 1,
      failures: 0,
      timeouts: 1,
    });
    expect(report.hooks).toHaveLength(1);
  });

  it("filters diagnostics by hook name", async () => {
    await sdk.trigger({
      function_id: "mem::hook-diagnostics-record",
      payload: { hookName: "Stop", status: "success" },
    });
    await sdk.trigger({
      function_id: "mem::hook-diagnostics-record",
      payload: { hookName: "SessionStart", status: "failure", error: "boom" },
    });

    const report = await sdk.trigger({
      function_id: "mem::hook-diagnostics-list",
      payload: { hookName: "SessionStart" },
    }) as { hooks: HookDiagnostics[] };

    expect(report.hooks.map((hook) => hook.hookName)).toEqual(["SessionStart"]);
    expect(report.hooks[0].lastError).toBe("boom");
  });
});
