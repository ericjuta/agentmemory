import { describe, expect, it } from "vitest";

import { registerMaintenanceCatchUpFunction } from "../src/functions/maintenance-catch-up.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

async function setHealth(
  kv: ReturnType<typeof mockKV>,
  status: "healthy" | "degraded" | "critical",
  cpuPercent: number,
) {
  await kv.set(KV.health, "latest", {
    status,
    alerts: status === "healthy" ? [] : ["cpu_warn_" + Math.round(cpuPercent) + "%"],
    connectionState: "connected",
    kvConnectivity: { status: "ok", consecutiveFailures: 0 },
    snapshotPersistence: { status: "ok", consecutiveFailures: 0 },
    eventLoopLagMs: 0,
    cpu: { percent: cpuPercent, userMicros: 0, systemMicros: 0 },
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

  it("keeps compression idle-only while retrieval backlog exists", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => ({ succeeded: 1 }));

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

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      skipped: true,
      lane: "compression",
      reason: "retrieval_backlog_priority",
      workDone: 0,
    });
  });

  it("keeps compression idle-only while graph backlog exists", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerMaintenanceCatchUpFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::compress-retry", async () => ({ succeeded: 1 }));

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

    const result = await sdk.trigger("mem::maintenance-catch-up", {
      lane: "compression",
    });

    expect(result).toMatchObject({
      skipped: true,
      lane: "compression",
      reason: "graph_backlog_priority",
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
      batchSize: 5,
      timeBudgetMs: 5000,
    });
    expect(forwarded).toEqual({
      batchSize: 5,
      timeBudgetMs: 5000,
      scanRaw: false,
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
