import { describe, expect, it, vi } from "vitest";
import { MetricsStore } from "../src/eval/metrics-store.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function healthSnapshot() {
  return {
    connectionState: "connected",
    workers: [],
    memory: { heapUsed: 0, heapTotal: 1, rss: 0, external: 0 },
    cpu: { userMicros: 0, systemMicros: 0, percent: 0 },
    eventLoopLagMs: 0,
    uptimeSeconds: 1,
    kvConnectivity: { status: "ok", latencyMs: 1 },
    status: "healthy",
    alerts: [],
  };
}

describe("api::health function metrics", () => {
  it("stays healthy when summarize has only stale lifetime failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
    const sdk = mockSdk();
    const kv = mockKV();
    const metricsStore = new MetricsStore(kv as never);
    registerApiTriggers(sdk as never, kv as never, undefined, metricsStore);
    await kv.set(KV.health, "latest", healthSnapshot());
    await metricsStore.record("mem::summarize", 100, false, undefined, "timeout");

    vi.setSystemTime(new Date("2026-05-08T00:20:00.000Z"));
    const response = (await sdk.trigger({
      function_id: "api::health",
      payload: {},
    })) as { status_code: number; body: { status: string; health: { alerts: string[] } } };

    expect(response.status_code).toBe(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.health.alerts).toEqual([]);
    vi.useRealTimers();
  });

  it("degrades when summarize is failing in the recent window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
    const sdk = mockSdk();
    const kv = mockKV();
    const metricsStore = new MetricsStore(kv as never);
    registerApiTriggers(sdk as never, kv as never, undefined, metricsStore);
    await kv.set(KV.health, "latest", healthSnapshot());

    await metricsStore.record("mem::summarize", 100, false, undefined, "timeout");
    await metricsStore.record("mem::summarize", 100, false, undefined, "timeout");
    await metricsStore.record("mem::summarize", 100, true, 90);

    const response = (await sdk.trigger({
      function_id: "api::health",
      payload: {},
    })) as { status_code: number; body: { status: string; health: { alerts: string[] } } };

    expect(response.status_code).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.health.alerts[0]).toContain(
      "function_failures_warn_mem::summarize_67%_2of3",
    );
    vi.useRealTimers();
  });

  it("goes critical when compress has a severe recent failure rate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
    const sdk = mockSdk();
    const kv = mockKV();
    const metricsStore = new MetricsStore(kv as never);
    registerApiTriggers(sdk as never, kv as never, undefined, metricsStore);
    await kv.set(KV.health, "latest", healthSnapshot());

    for (let i = 0; i < 5; i += 1) {
      await metricsStore.record("mem::compress", 100, false, undefined, "timeout");
    }

    const response = (await sdk.trigger({
      function_id: "api::health",
      payload: {},
    })) as { status_code: number; body: { status: string; health: { alerts: string[] } } };

    expect(response.status_code).toBe(503);
    expect(response.body.status).toBe("critical");
    expect(response.body.health.alerts[0]).toContain(
      "function_failures_critical_mem::compress_100%_5of5",
    );
    vi.useRealTimers();
  });
});
