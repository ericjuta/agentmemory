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
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("refreshes after the cache ttl expires", async () => {
    vi.useFakeTimers();
    process.env.AGENTMEMORY_DEFERRED_WORK_CACHE_MS = "1000";
    const kv = mockKV();
    const list = vi.spyOn(kv, "list");

    await getDeferredWorkStatus(kv as never);
    await getDeferredWorkStatus(kv as never);
    expect(list).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(1001);
    await getDeferredWorkStatus(kv as never);
    expect(list).toHaveBeenCalledTimes(8);

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
      observeCapture: {
        status: "capturing",
        pressure: null,
        derivedWorkDeferred: false,
        captureSkipped: false,
      },
      totalQueued: 12,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("reports observe capture shedding from lightweight deferred status", async () => {
    const previousQueueCritical =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
    const previousIncludeCompression =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"];
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] = "1";
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"] =
      "true";
    const kv = mockKV();
    try {
      await kv.set(KV.maintenanceLaneState, "compression", {
        lane: "compression",
        lastQueued: 1,
        successStreak: 0,
        pressureStreak: 1,
        updatedAt: "2026-04-29T00:00:00.000Z",
      });

      const status = await getDeferredWorkStatus(kv as never, {
        lightweight: true,
      });

      expect(status.observeCapture).toMatchObject({
        status: "shedding",
        derivedWorkDeferred: true,
        captureSkipped: true,
        pressure: {
          reason: "deferred_queue_1_gte_1",
          mode: "shed",
        },
      });
    } finally {
      if (previousQueueCritical === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] =
          previousQueueCritical;
      }
      if (previousIncludeCompression === undefined) {
        delete process.env[
          "AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"
        ];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"] =
          previousIncludeCompression;
      }
    }
  });
});
