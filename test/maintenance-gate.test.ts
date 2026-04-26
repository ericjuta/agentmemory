import { describe, expect, it } from "vitest";

import {
  getMaintenancePauseReason,
  shouldPauseMaintenance,
} from "../src/health/maintenance-gate.js";
import { getWriteGatePauseReason } from "../src/health/write-gate.js";
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

describe("maintenance gate", () => {
  it("allows maintenance when health is healthy", () => {
    expect(shouldPauseMaintenance(makeSnapshot())).toBe(false);
  });

  it("pauses maintenance when health is degraded", () => {
    expect(
      shouldPauseMaintenance(
        makeSnapshot({
          status: "degraded",
          alerts: ["kv_probe_error_streak_1"],
        }),
      ),
    ).toBe(true);
  });

  it("pauses maintenance when kv connectivity is failing", () => {
    const snapshot = makeSnapshot({
      kvConnectivity: {
        status: "error",
        error: "Invocation timeout after 30000ms: state::set",
        consecutiveFailures: 1,
      },
    });

    expect(shouldPauseMaintenance(snapshot)).toBe(true);
    expect(getMaintenancePauseReason(snapshot)).toContain("state::set");
  });

  it("uses narrower gates for derived writes and index persistence", () => {
    const degradedCpu = makeSnapshot({
      status: "degraded",
      alerts: ["cpu_warn_85%"],
    });
    expect(getWriteGatePauseReason(degradedCpu, "llm_work")).toBe("cpu_warn_85%");
    expect(getWriteGatePauseReason(degradedCpu, "graph_extraction")).toBe(
      "cpu_warn_85%",
    );
    expect(getWriteGatePauseReason(degradedCpu, "derived_kv_write")).toBeNull();
    expect(getWriteGatePauseReason(degradedCpu, "index_persistence")).toBe(
      "cpu_warn_85%",
    );
  });

  it("pauses all write gates when kv connectivity is failing", () => {
    const snapshot = makeSnapshot({
      kvConnectivity: {
        status: "error",
        error: "StateKV state::set timed out after 5000ms",
      },
    });

    expect(getWriteGatePauseReason(snapshot, "llm_work")).toContain("StateKV");
    expect(getWriteGatePauseReason(snapshot, "derived_kv_write")).toContain(
      "StateKV",
    );
    expect(getWriteGatePauseReason(snapshot, "index_persistence")).toContain(
      "StateKV",
    );
  });
});
