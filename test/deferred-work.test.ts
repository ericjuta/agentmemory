import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearDeferredWorkStatusCache,
  getDeferredWorkStatus,
} from "../src/functions/deferred-work.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

afterEach(() => {
  clearDeferredWorkStatusCache();
  delete process.env.AGENTMEMORY_DEFERRED_WORK_CACHE_MS;
});

describe("getDeferredWorkStatus", () => {
  it("shares concurrent StateKV scans", async () => {
    const kv = mockKV();
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    const list = vi.spyOn(kv, "list");

    const [first, second] = await Promise.all([
      getDeferredWorkStatus(kv as never),
      getDeferredWorkStatus(kv as never),
    ]);

    expect(first.totalQueued).toBe(1);
    expect(second).toBe(first);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("refreshes after the cache ttl expires", async () => {
    vi.useFakeTimers();
    process.env.AGENTMEMORY_DEFERRED_WORK_CACHE_MS = "1000";
    const kv = mockKV();
    const list = vi.spyOn(kv, "list");

    await getDeferredWorkStatus(kv as never);
    await getDeferredWorkStatus(kv as never);
    expect(list).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1001);
    await getDeferredWorkStatus(kv as never);
    expect(list).toHaveBeenCalledTimes(6);

    vi.useRealTimers();
  });

  it("uses lane state without listing retry queues for lightweight status", async () => {
    const kv = mockKV();
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      lastQueued: 12,
      queuedDeltaSinceLastWake: -5,
      drainRatePerHour: 300,
      estimatedDrainEtaMs: 120000,
    });
    const list = vi.spyOn(kv, "list");

    const status = await getDeferredWorkStatus(kv as never, {
      lightweight: true,
    });

    expect(status).toMatchObject({
      compression: {
        queued: 12,
        queuedDeltaSinceLastWake: -5,
        drainRatePerHour: 300,
        estimatedDrainEtaMs: 120000,
      },
      retrievalBlocks: { queued: 0 },
      graphExtraction: { queued: 0 },
      totalQueued: 12,
    });
    expect(list).not.toHaveBeenCalled();
  });
});
