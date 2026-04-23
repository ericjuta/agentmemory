import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterGhostWorkers,
  registerHealthMonitor,
  getLatestHealth,
} from "../src/health/monitor.js";
import { KV } from "../src/state/schema.js";

describe("registerHealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips snapshot persistence when the kv probe already failed", async () => {
    const kv = {
      set: vi.fn(async <T>(scope: string, key: string, value: T): Promise<T> => {
        if (scope === KV.health && key === "_probe") {
          throw new Error("probe failed");
        }
        return value;
      }),
      get: vi.fn(async () => null),
    };
    const sdk = {
      trigger: vi.fn(async () => ({ workers: [] })),
      on: vi.fn(),
    };

    const monitor = registerHealthMonitor(sdk as never, kv as never);
    await vi.advanceTimersByTimeAsync(5001);
    await Promise.resolve();

    expect(kv.set).toHaveBeenCalledTimes(1);
    expect(kv.set).toHaveBeenCalledWith(
      KV.health,
      "_probe",
      expect.objectContaining({ ts: expect.any(Number) }),
    );

    const health = await getLatestHealth(kv as never);
    expect(health?.kvConnectivity?.status).toBe("error");
    expect(health?.snapshotPersistence?.error).toContain(
      "skipped_due_kv_probe_error:probe failed",
    );

    monitor.stop();
  });

  it("filters the duplicate anonymous zero-function ghost worker", () => {
    const workers = filterGhostWorkers([
      {
        id: "real",
        name: "agentmemory",
        status: "connected",
        function_count: 289,
        connected_at_ms: 1001,
        ip_address: "172.18.0.3",
        runtime: "node",
        version: "0.11.0",
      },
      {
        id: "ghost",
        name: null,
        status: "connected",
        function_count: 0,
        connected_at_ms: 1000,
        ip_address: "172.18.0.3",
        runtime: null,
        version: null,
      },
    ]);

    expect(workers).toHaveLength(1);
    expect(workers[0]?.id).toBe("real");
  });
});
