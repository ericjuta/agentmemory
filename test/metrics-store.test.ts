import { describe, expect, it, vi } from "vitest";
import { MetricsStore } from "../src/eval/metrics-store.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

describe("MetricsStore recent windows", () => {
  it("keeps lifetime counters while exposing only recent failures in the rolling window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
    const kv = mockKV();
    const store = new MetricsStore(kv as never);

    await store.record("mem::summarize", 100, false, undefined, "timeout");
    vi.setSystemTime(new Date("2026-05-08T00:16:00.000Z"));
    await store.record("mem::summarize", 50, true, 90);

    const metric = await store.get("mem::summarize");
    expect(metric?.totalCalls).toBe(2);
    expect(metric?.failureCount).toBe(1);
    expect(metric?.recentCalls).toBe(1);
    expect(metric?.recentFailureCount).toBe(0);
    expect(metric?.recentFailureRate).toBe(0);
    expect(metric?.lastFailureAt).toBe("2026-05-08T00:00:00.000Z");
    expect(metric).not.toHaveProperty("recentEvents");

    vi.useRealTimers();
  });

  it("rehydrates persisted recent events and prunes stale ones on read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:20:00.000Z"));
    const kv = mockKV();
    await kv.set(KV.metrics, "mem::compress", {
      functionId: "mem::compress",
      totalCalls: 3,
      successCount: 1,
      failureCount: 2,
      failureReasons: { timeout: 2 },
      avgLatencyMs: 100,
      avgQualityScore: 0,
      recentEvents: [
        {
          timestamp: new Date("2026-05-08T00:01:00.000Z").getTime(),
          success: false,
          latencyMs: 100,
          failureReason: "timeout",
        },
        {
          timestamp: new Date("2026-05-08T00:19:00.000Z").getTime(),
          success: false,
          latencyMs: 80,
          failureReason: "timeout",
        },
      ],
    });

    const store = new MetricsStore(kv as never);
    const metric = await store.get("mem::compress");
    expect(metric?.recentCalls).toBe(1);
    expect(metric?.recentFailureCount).toBe(1);
    expect(metric?.recentFailureReasons).toEqual({ timeout: 1 });
    expect(metric).not.toHaveProperty("recentEvents");

    vi.useRealTimers();
  });
});
