import { describe, expect, it } from "vitest";
import {
  type BurninConfig,
  type BurninSample,
  activeInvocationCount,
  parseBurninArgs,
  summarizeBurnin,
} from "../scripts/agentmemory-runtime-burnin.js";

function config(overrides: Partial<BurninConfig> = {}): BurninConfig {
  return {
    url: "http://127.0.0.1:3111",
    samples: 2,
    intervalMs: 0,
    warnRssGrowthMb: 32,
    failRssGrowthMb: 64,
    warnKvLatencyMs: 100,
    failKvLatencyMs: 500,
    failHookErrors: 0,
    failFunctionErrors: 0,
    json: false,
    ...overrides,
  };
}

function sample(overrides: Partial<BurninSample> = {}): BurninSample {
  return {
    index: 1,
    timestamp: "2026-05-06T00:00:00.000Z",
    healthStatus: "healthy",
    healthHttpMs: 10,
    diagnosticsHttpMs: 8,
    rssMb: 200,
    heapUsedMb: 40,
    eventLoopLagMs: 1,
    cpuPercent: 2,
    kvStatus: "ok",
    kvLatencyMs: 3,
    activeInvocations: 0,
    workerCount: 1,
    functionMetricCalls: 10,
    compressCalls: 10,
    compressFailures: 0,
    summarizeCalls: 5,
    summarizeFailures: 0,
    hookAttempts: 100,
    hookFailures: 0,
    hookTimeouts: 0,
    hookMaxLatencyMs: 20,
    alerts: [],
    notes: [],
    ...overrides,
  };
}

describe("agentmemory runtime burn-in summary", () => {
  it("passes steady samples and reports resource deltas", () => {
    const summary = summarizeBurnin([
      sample({ index: 1, rssMb: 200, kvLatencyMs: 4, activeInvocations: 1 }),
      sample({ index: 2, rssMb: 205, kvLatencyMs: 8, activeInvocations: 3 }),
    ], config());

    expect(summary.passed).toBe(true);
    expect(summary.rssGrowthMb).toBe(5);
    expect(summary.maxKvLatencyMs).toBe(8);
    expect(summary.maxActiveInvocations).toBe(3);
    expect(summary.compressCallDelta).toBe(0);
    expect(summary.summarizeFailureDelta).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  it("keeps RSS growth warnings non-fatal below the fail threshold", () => {
    const summary = summarizeBurnin([
      sample({ index: 1, rssMb: 200 }),
      sample({ index: 2, rssMb: 240 }),
    ], config());

    expect(summary.passed).toBe(true);
    expect(summary.warnings.some((warning) => warning.includes("rss_growth_mb"))).toBe(true);
    expect(summary.failures).toEqual([]);
  });

  it("fails on hook error deltas and critical health", () => {
    const summary = summarizeBurnin([
      sample({ index: 1, hookFailures: 2 }),
      sample({ index: 2, healthStatus: "critical", hookFailures: 3 }),
    ], config());

    expect(summary.passed).toBe(false);
    expect(summary.failures.some((failure) => failure.includes("health status critical"))).toBe(true);
    expect(summary.failures.some((failure) => failure.includes("hook_error_delta 1"))).toBe(true);
  });

  it("fails on compress and summarize failure deltas", () => {
    const summary = summarizeBurnin([
      sample({ index: 1, compressCalls: 10, compressFailures: 1, summarizeCalls: 5, summarizeFailures: 2 }),
      sample({ index: 2, compressCalls: 12, compressFailures: 2, summarizeCalls: 6, summarizeFailures: 3 }),
    ], config());

    expect(summary.passed).toBe(false);
    expect(summary.compressCallDelta).toBe(2);
    expect(summary.compressFailureDelta).toBe(1);
    expect(summary.summarizeCallDelta).toBe(1);
    expect(summary.summarizeFailureDelta).toBe(1);
    expect(summary.failures.some((failure) => failure.includes("function_error_delta 2"))).toBe(true);
  });

  it("warns and clamps hook deltas when diagnostics counters reset", () => {
    const summary = summarizeBurnin([
      sample({ index: 1, hookFailures: 3, hookTimeouts: 2 }),
      sample({ index: 2, hookFailures: 1, hookTimeouts: 1 }),
    ], config());

    expect(summary.passed).toBe(true);
    expect(summary.hookFailureDelta).toBe(0);
    expect(summary.hookTimeoutDelta).toBe(0);
    expect(summary.warnings.some((warning) => warning.includes("counters decreased"))).toBe(true);
  });

  it("prefers iii active_invocations over status inference", () => {
    expect(activeInvocationCount([
      { status: "connected", active_invocations: 4 },
      { status: "busy" },
      { status: "connected", active_invocations: 0 },
    ])).toBe(5);
  });

  it("parses explicit threshold and output options", () => {
    const parsed = parseBurninArgs([
      "--url", "http://localhost:3999",
      "--samples", "3",
      "--interval-ms", "10",
      "--warn-rss-growth-mb", "10",
      "--fail-rss-growth-mb", "20",
      "--warn-kv-latency-ms", "30",
      "--fail-kv-latency-ms", "40",
      "--fail-hook-errors", "2",
      "--fail-function-errors", "3",
      "--json",
    ], {});

    expect(parsed).toMatchObject({
      url: "http://localhost:3999",
      samples: 3,
      intervalMs: 10,
      warnRssGrowthMb: 10,
      failRssGrowthMb: 20,
      warnKvLatencyMs: 30,
      failKvLatencyMs: 40,
      failHookErrors: 2,
      failFunctionErrors: 3,
      json: true,
    });
  });

});
