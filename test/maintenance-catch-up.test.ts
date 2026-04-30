import { describe, expect, it } from "vitest";

import { registerMaintenanceCatchUpFunction } from "../src/functions/maintenance-catch-up.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

async function setHealth(
  kv: ReturnType<typeof mockKV>,
  status: "healthy" | "degraded" | "critical",
  cpuPercent: number,
  consecutiveHighSamples = 0,
) {
  await kv.set(KV.health, "latest", {
    status,
    alerts: status === "healthy" ? [] : ["cpu_warn_" + Math.round(cpuPercent) + "%"],
    connectionState: "connected",
    kvConnectivity: { status: "ok", consecutiveFailures: 0 },
    snapshotPersistence: { status: "ok", consecutiveFailures: 0 },
    eventLoopLagMs: 0,
    cpu: { percent: cpuPercent, consecutiveHighSamples, userMicros: 0, systemMicros: 0 },
    memory: { heapUsed: 0, heapTotal: 1, heapLimit: 1, external: 0, rss: 0 },
    pipeline: { compressActive: 0, compressPending: 0, totalInflight: 0 },
    workers: [],
    uptimeSeconds: 1,
  });
}

describe("mem::maintenance-catch-up", () => {
  it("uses health headroom to run bounded retrieval catch-up", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-block-retry", async (payload) => {
      forwarded = payload;
      return { succeeded: 10, diagnosticsRemoved: 1 };
    });

    await setHealth(kv, "healthy", 20);
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-27T00:00:00.000Z",
      lastFailedAt: "2026-04-27T00:00:00.000Z",
      lastError: "timeout",
    });

    const result = (await sdk.trigger("mem::maintenance-catch-up", {
      lane: "retrieval",
    })) as { lane: string; workDone: number; batchSize: number };

    expect(result).toMatchObject({
      lane: "retrieval",
      workDone: 11,
      batchSize: 40,
    });
    expect(forwarded).toEqual({
      batchSize: 40,
      timeBudgetMs: 8000,
      ignoreBackoff: true,
      refreshFromState: false,
    });
  });

  it("auto-selects retrieval before compression when both backlogs exist", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-block-retry", async () => ({ succeeded: 1 }));
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("compression should not run for auto-selected retrieval");
    });

    await setHealth(kv, "healthy", 20);
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-27T00:00:00.000Z",
      lastFailedAt: "2026-04-27T00:00:00.000Z",
      lastError: "timeout",
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {});

    expect(result).toMatchObject({
      lane: "retrieval",
      workDone: 1,
    });
  });

  it("honors explicit compression lane while retrieval retry is pending", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async (payload) => {
      forwarded = payload;
      return { succeeded: 2 };
    });

    await setHealth(kv, "healthy", 10);
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-27T00:00:00.000Z",
      lastFailedAt: "2026-04-27T00:00:00.000Z",
      lastError: "timeout",
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      lane: "compression",
      workDone: 2,
    });
    expect(forwarded).toMatchObject({
      scanRaw: false,
    });
  });

  it("auto-selects graph before compression when graph catch-up is enabled", async () => {
    const previousGraphCatchUp = process.env["GRAPH_CATCH_UP_ENABLED"];
    process.env["GRAPH_CATCH_UP_ENABLED"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerMaintenanceCatchUpFunction(sdk as never, kv as never);
      sdk.registerFunction("mem::graph-catch-up", async () => ({ extracted: 1 }));
      sdk.registerFunction("mem::compress-retry", async () => {
        throw new Error("compression should not run for auto-selected graph");
      });

      await setHealth(kv, "healthy", 20);
      await kv.set(KV.graphExtractionRetry, "obs_graph", {
        observationId: "obs_graph",
        sessionId: "ses_1",
        retries: 0,
        firstDeferredAt: "2026-04-27T00:00:00.000Z",
        lastDeferredAt: "2026-04-27T00:00:00.000Z",
        lastError: "timeout",
      });
      await kv.set(KV.compressRetry, "obs_1", {
        obsId: "obs_1",
        sessionId: "ses_1",
        retries: 0,
        failedAt: "2026-04-27T00:00:00.000Z",
      });

      const result = await sdk.trigger("mem::maintenance-catch-up", {});

      expect(result).toMatchObject({
        lane: "graph",
        workDone: 1,
      });
    } finally {
      if (previousGraphCatchUp === undefined) {
        delete process.env["GRAPH_CATCH_UP_ENABLED"];
      } else {
        process.env["GRAPH_CATCH_UP_ENABLED"] = previousGraphCatchUp;
      }
    }
  });

  it("lets compression drain when graph catch-up is disabled", async () => {
    const previousGraphCatchUp = process.env["GRAPH_CATCH_UP_ENABLED"];
    process.env["GRAPH_CATCH_UP_ENABLED"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    try {
      registerMaintenanceCatchUpFunction(sdk as never, kv as never);
      sdk.registerFunction("mem::compress-retry", async (payload) => {
        forwarded = payload;
        return { succeeded: 3 };
      });

      await setHealth(kv, "healthy", 10);
      await kv.set(KV.graphExtractionRetry, "obs_graph", {
        observationId: "obs_graph",
        sessionId: "ses_1",
        retries: 0,
        firstDeferredAt: "2026-04-27T00:00:00.000Z",
        lastDeferredAt: "2026-04-27T00:00:00.000Z",
        lastError: "timeout",
      });
      await kv.set(KV.compressRetry, "obs_1", {
        obsId: "obs_1",
        sessionId: "ses_1",
        retries: 0,
        failedAt: "2026-04-27T00:00:00.000Z",
      });

      const result = await sdk.trigger("mem::maintenance-catch-up", {
        lane: "compression",
      });

      expect(result).toMatchObject({
        lane: "compression",
        workDone: 3,
      });
      expect(forwarded).toMatchObject({
        scanRaw: false,
      });
    } finally {
      if (previousGraphCatchUp === undefined) {
        delete process.env["GRAPH_CATCH_UP_ENABLED"];
      } else {
        process.env["GRAPH_CATCH_UP_ENABLED"] = previousGraphCatchUp;
      }
    }
  });

  it("pauses compression for a single non-idle CPU sample", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("compression should not run without idle headroom");
    });

    await setHealth(kv, "healthy", 30);
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      skipped: true,
      lane: "compression",
      reason: "idle_required_cpu_30_gte_20",
      workDone: 0,
    });
    const laneState = await kv.get(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      lane: "compression",
      lastWorkDone: 0,
      lastQueued: 1,
      lastSkippedReason: "idle_required_cpu_30_gte_20",
      currentIntervalMs: 60_000,
    });
    expect(result).toMatchObject({
      result: {
        laneState: {
          currentIntervalMs: 60_000,
        },
      },
    });
  });

  it("pauses compression when CPU pressure persists", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => ({ succeeded: 1 }));

    await setHealth(kv, "healthy", 30, 2);
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      skipped: true,
      lane: "compression",
      reason: "idle_required_cpu_30_gte_20",
      workDone: 0,
    });
  });

  it("pauses compression while the worker has active invocations", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("compression should not run while the worker is busy");
    });

    await setHealth(kv, "healthy", 5);
    const health = await kv.get<Record<string, unknown>>(KV.health, "latest");
    await kv.set(KV.health, "latest", {
      ...health,
      workers: [{ id: "worker_1", active_invocations: 2 }],
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      skipped: true,
      lane: "compression",
      reason: "idle_required_active_invocations_2_gt_0",
      workDone: 0,
    });
  });

  it("pauses compression while compression work is already inflight", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("compression should not run while pipeline work is inflight");
    });

    await setHealth(kv, "healthy", 5);
    const health = await kv.get<Record<string, unknown>>(KV.health, "latest");
    await kv.set(KV.health, "latest", {
      ...health,
      pipeline: { compressActive: 1, compressPending: 0, totalInflight: 1 },
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      skipped: true,
      lane: "compression",
      reason: "idle_required_pipeline_inflight_1_gt_0",
      workDone: 0,
    });
  });

  it("forwards adaptive compression batch size under healthy idle headroom", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async (payload) => {
      forwarded = payload;
      return { succeeded: 5 };
    });

    await setHealth(kv, "healthy", 10);
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = (await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
      maxBatchSize: 20,
      timeBudgetMs: 7000,
    })) as { lane: string; workDone: number; batchSize: number; timeBudgetMs: number };

    expect(result).toMatchObject({
      lane: "compression",
      workDone: 5,
      batchSize: 2,
      timeBudgetMs: 2000,
    });
    expect(forwarded).toEqual({
      batchSize: 2,
      timeBudgetMs: 2000,
      scanRaw: false,
    });
    const laneState = await kv.get(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      lane: "compression",
      lastWorkDone: 5,
      successStreak: 1,
      pressureStreak: 0,
      queuedDeltaSinceLastWake: 0,
    });
  });

  it("records compression drain trend after a successful wake", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      await kv.delete(KV.compressRetry, "obs_1");
      await kv.delete(KV.compressRetry, "obs_2");
      return { succeeded: 2 };
    });

    await setHealth(kv, "healthy", 10);
    for (const obsId of ["obs_1", "obs_2", "obs_3"]) {
      await kv.set(KV.compressRetry, obsId, {
        obsId,
        sessionId: "ses_1",
        retries: 0,
        failedAt: "2026-04-27T00:00:00.000Z",
      });
    }

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      lane: "compression",
      workDone: 2,
    });
    const laneState = await kv.get<{
      queuedDeltaSinceLastWake: number;
      drainRatePerHour: number;
      estimatedDrainEtaMs: number;
      lastQueued: number;
    }>(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      queuedDeltaSinceLastWake: -2,
      lastQueued: 1,
    });
    expect(laneState?.drainRatePerHour).toBeGreaterThan(0);
    expect(laneState?.estimatedDrainEtaMs).toBeGreaterThan(0);
  });

  it("backs off compression after a StateKV timeout", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("StateKV state::set timed out after 5000ms");
    });

    await setHealth(kv, "healthy", 10);
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      currentBatchSize: 4,
      currentIntervalMs: 60_000,
      successStreak: 2,
      pressureStreak: 0,
      updatedAt: "2026-04-27T00:00:00.000Z",
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    await expect(
      sdk.trigger("mem::maintenance-catch-up", { lane: "compression" }),
    ).rejects.toThrow("StateKV state::set timed out");
    const laneState = await kv.get(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      lane: "compression",
      lastErrorReason: "StateKV state::set timed out after 5000ms",
      currentBatchSize: 1,
      smoothingBatchSize: 1,
      currentIntervalMs: 120_000,
      successStreak: 0,
      pressureStreak: 1,
    });
  });

  it("doubles compression lane interval after StateKV pressure", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("StateKV temporarily unavailable for state::set");
    });

    await setHealth(kv, "healthy", 10);
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      currentBatchSize: 4,
      currentIntervalMs: 120_000,
      successStreak: 1,
      pressureStreak: 1,
      updatedAt: "2026-04-27T00:00:00.000Z",
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    await expect(
      sdk.trigger("mem::maintenance-catch-up", {
        lane: "compression",
        maxBatchSize: 20,
        timeBudgetMs: 7000,
      }),
    ).rejects.toThrow("StateKV temporarily unavailable");
    const laneState = await kv.get(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      currentBatchSize: 1,
      currentIntervalMs: 240_000,
      pressureStreak: 2,
    });
  });

  it("smooths compression batch down when backlog grows", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      await kv.set(KV.compressRetry, "obs_2", {
        obsId: "obs_2",
        sessionId: "ses_1",
        retries: 0,
        failedAt: "2026-04-27T00:01:00.000Z",
      });
      return { succeeded: 1 };
    });

    await setHealth(kv, "healthy", 5);
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      currentBatchSize: 3,
      smoothingBatchSize: 3,
      currentIntervalMs: 60_000,
      successStreak: 2,
      pressureStreak: 0,
      updatedAt: "2026-04-27T00:00:00.000Z",
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
      maxBatchSize: 20,
    });

    expect(result).toMatchObject({
      lane: "compression",
      workDone: 1,
      batchSize: 3,
    });
    const laneState = await kv.get(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      currentBatchSize: 2,
      smoothingBatchSize: 2,
      queuedDeltaSinceLastWake: 1,
      lastQueued: 2,
    });
  });

  it("returns compression lane interval state after pressure backoff", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => {
      throw new Error("StateKV temporarily unavailable for state::set");
    });

    await setHealth(kv, "healthy", 10);
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      currentBatchSize: 4,
      currentIntervalMs: 60_000,
      successStreak: 2,
      pressureStreak: 0,
      updatedAt: "2026-04-27T00:00:00.000Z",
    });
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-27T00:00:00.000Z",
    });

    await expect(
      sdk.trigger("mem::maintenance-catch-up", { lane: "compression" }),
    ).rejects.toThrow("StateKV temporarily unavailable");
    const laneState = await kv.get(KV.maintenanceLaneState, "compression");
    expect(laneState).toMatchObject({
      currentIntervalMs: 120_000,
      currentBatchSize: 1,
      smoothingBatchSize: 1,
      pressureStreak: 1,
    });
  });

  it("pauses maintenance while health is degraded", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-block-retry", async () => ({ succeeded: 1 }));

    await setHealth(kv, "degraded", 82);
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-27T00:00:00.000Z",
      lastFailedAt: "2026-04-27T00:00:00.000Z",
      lastError: "timeout",
    });

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "retrieval",
    });

    expect(result).toMatchObject({
      skipped: true,
      reason: "degraded",
      workDone: 0,
    });
  });
});
