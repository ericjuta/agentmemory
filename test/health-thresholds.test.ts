// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";

import { evaluateHealth } from "../src/health/thresholds.js";
import type { HealthSnapshot } from "../src/types.js";

function makeSnapshot(
  overrides: Partial<HealthSnapshot> = {},
): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory: {
      heapUsed: 10,
      heapTotal: 100,
      heapLimit: 1000,
      rss: 20,
      external: 5,
    },
    cpu: { userMicros: 1, systemMicros: 1, percent: 5 },
    eventLoopLagMs: 1,
    uptimeSeconds: 30,
    status: "healthy",
    alerts: [],
    ...overrides,
  };
}

describe("evaluateHealth", () => {
  it("degrades on a transient kv probe failure", () => {
    const result = evaluateHealth(
      makeSnapshot({
        kvConnectivity: {
          status: "error",
          error: "timeout",
          consecutiveFailures: 1,
        },
      }),
    );

    expect(result.status).toBe("degraded");
    expect(result.alerts).toContain("kv_probe_error_streak_1");
  });

  it("becomes critical after repeated kv probe failures", () => {
    const result = evaluateHealth(
      makeSnapshot({
        kvConnectivity: {
          status: "error",
          error: "timeout",
          consecutiveFailures: 3,
        },
      }),
    );

    expect(result.status).toBe("critical");
    expect(result.alerts).toContain("kv_probe_error_streak_3");
  });

  it("degrades on health snapshot persist failures", () => {
    const result = evaluateHealth(
      makeSnapshot({
        snapshotPersistence: {
          status: "error",
          consecutiveFailures: 1,
          error: "Invocation timeout after 30000ms: state::set",
        },
      }),
    );

    expect(result.status).toBe("degraded");
    expect(result.alerts).toContain(
      "health_snapshot_persist_error_streak_1",
    );
  });

  it("uses heapLimit when available instead of transient heapTotal", () => {
    const result = evaluateHealth(
      makeSnapshot({
        memory: {
          heapUsed: 95,
          heapTotal: 100,
          heapLimit: 1000,
          rss: 120,
          external: 5,
        },
      }),
    );

    expect(result.status).toBe("healthy");
    expect(result.alerts).toEqual([]);
  });

  it("can require sustained cpu pressure before degrading runtime health", () => {
    const firstSample = evaluateHealth(
      makeSnapshot({
        cpu: {
          userMicros: 1,
          systemMicros: 1,
          percent: 97,
          consecutiveHighSamples: 1,
        },
      }),
      { cpuWarnConsecutiveSamples: 2, cpuCriticalConsecutiveSamples: 2 },
    );
    const secondSample = evaluateHealth(
      makeSnapshot({
        cpu: {
          userMicros: 1,
          systemMicros: 1,
          percent: 97,
          consecutiveHighSamples: 2,
        },
      }),
      { cpuWarnConsecutiveSamples: 2, cpuCriticalConsecutiveSamples: 2 },
    );

    expect(firstSample.status).toBe("healthy");
    expect(firstSample.alerts).toEqual([]);
    expect(secondSample.status).toBe("critical");
    expect(secondSample.alerts).toContain("cpu_critical_97%");
  });
});
