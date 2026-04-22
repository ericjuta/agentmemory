import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerHealthMonitor, getLatestHealth } from "../src/health/monitor.js";
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
});
