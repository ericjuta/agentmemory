import { describe, expect, it } from "vitest";

import { registerRetrievalVectorRepairWorkerFunction } from "../src/functions/retrieval-vector-repair-worker.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

async function setHealth(
  kv: ReturnType<typeof mockKV>,
  status: "healthy" | "degraded" | "critical",
  cpuPercent: number,
) {
  await kv.set(KV.health, "latest", {
    status,
    alerts: status === "healthy" ? [] : ["cpu_critical_" + Math.round(cpuPercent) + "%"],
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

describe("mem::retrieval-vector-repair-worker", () => {
  it("runs a leased adaptive vector backfill and records progress", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerRetrievalVectorRepairWorkerFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-vector-backfill", async (payload) => {
      forwarded = payload;
      return {
        success: true,
        source: "retrieval-bm25-index",
        eligibleCount: 10,
        vectorPresentBefore: 4,
        vectorCoverageRatioBefore: 0.4,
        attempted: 6,
        backfilled: 6,
        failed: 0,
        vectorPresentAfter: 10,
        vectorMissingAfter: 0,
        vectorCoverageRatioAfter: 1,
        complete: true,
      };
    });
    await setHealth(kv, "healthy", 20);

    const result = (await sdk.trigger("mem::retrieval-vector-repair-worker", {
      workerId: "test-worker",
      maxBatchSize: 64,
      requireIdle: false,
    })) as {
      workDone: number;
      progress?: { status?: string; runs?: number; vectorCoverageRatioAfter?: number };
    };

    expect(result.workDone).toBe(6);
    expect(forwarded).toMatchObject({
      batchSize: 64,
      candidateScanLimit: 2500,
      timeBudgetMs: 6000,
      concurrency: 1,
      coverageTarget: 0.98,
      scheduleSave: true,
      resetCursor: false,
      dryRun: false,
    });
    expect(result.progress).toMatchObject({
      status: "completed",
      runs: 1,
      vectorCoverageRatioAfter: 1,
    });
    expect(await kv.get(KV.config, "retrieval-vector-repair-worker-lease")).toBeNull();
    expect(await kv.get(KV.config, "retrieval-vector-repair-worker-progress")).toMatchObject({
      status: "completed",
      workerId: "test-worker",
      backfilled: 6,
    });
  });

  it("skips when another worker holds the repair lease", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalVectorRepairWorkerFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-vector-backfill", async () => {
      throw new Error("backfill should not run while leased");
    });
    await setHealth(kv, "healthy", 20);
    await kv.set(KV.config, "retrieval-vector-repair-worker-lease", {
      workerId: "other-worker",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await sdk.trigger("mem::retrieval-vector-repair-worker", {
      workerId: "test-worker",
    });

    expect(result).toMatchObject({
      skipped: true,
      reason: "repair_worker_lease_held",
      workDone: 0,
    });
  });

  it("pauses under runtime pressure and records the pause reason", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalVectorRepairWorkerFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-vector-backfill", async () => {
      throw new Error("backfill should not run while paused");
    });
    await setHealth(kv, "critical", 99);

    const result = (await sdk.trigger("mem::retrieval-vector-repair-worker", {
      workerId: "test-worker",
    })) as {
      skipped?: boolean;
      reason?: string;
      progress?: { status?: string; lastPauseReason?: string };
    };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("cpu_critical_99%");
    expect(result.progress).toMatchObject({
      status: "paused",
      lastPauseReason: "cpu_critical_99%",
    });
  });

  it("waits for idle headroom by default before vector repair work", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalVectorRepairWorkerFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::retrieval-vector-backfill", async () => {
      throw new Error("backfill should not run until idle");
    });
    await setHealth(kv, "healthy", 50);

    const result = (await sdk.trigger("mem::retrieval-vector-repair-worker", {
      workerId: "test-worker",
    })) as {
      skipped?: boolean;
      reason?: string;
      progress?: { status?: string; lastPauseReason?: string };
    };

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("idle_required_cpu_50_gte_35");
    expect(result.progress).toMatchObject({
      status: "paused",
      lastPauseReason: "idle_required_cpu_50_gte_35",
    });
  });
});
