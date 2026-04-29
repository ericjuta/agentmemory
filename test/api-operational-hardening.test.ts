import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";
import { getDeferredWorkStatus } from "../src/functions/deferred-work.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("operational hardening APIs", () => {
  it("exposes lightweight deferred work and write gates on health", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      lastQueued: 1,
      lastWorkDone: 1,
      currentBatchSize: 1,
      currentIntervalMs: 60_000,
      updatedAt: "2026-04-25T00:00:00.000Z",
    });
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-25T00:00:00.000Z",
      lastFailedAt: "2026-04-25T00:00:00.000Z",
      lastError: "timeout",
    });
    await kv.set(KV.graphExtractionRetry, "obs_2", {
      observationId: "obs_2",
      sessionId: "ses_1",
      retries: 0,
      firstDeferredAt: "2026-04-25T00:00:00.000Z",
      lastDeferredAt: "2026-04-25T00:00:00.000Z",
      lastError: "health_unhealthy",
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::health", {
      headers: {},
    })) as {
      status_code: number;
      body: {
        deferredWork: {
          compression: { queued: number; oldestFailedAt?: string; oldestAgeMs?: number };
          retrievalBlocks: { queued: number };
          graphExtraction: { queued: number };
          observeCapture: { status: string; captureSkipped: boolean };
          totalQueued: number;
        };
        writeGates: Record<string, null>;
        maintenance: { status: string; totalQueued: number; paused: boolean };
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.deferredWork).toMatchObject({
      compression: {
        queued: 1,
      },
      retrievalBlocks: { queued: 0 },
      graphExtraction: { queued: 0 },
      observeCapture: { status: "capturing", captureSkipped: false },
      totalQueued: 1,
    });
    expect(response.body.maintenance).toEqual({
      status: "behind",
      totalQueued: 1,
      paused: false,
    });
    expect(response.body.writeGates).toMatchObject({
      llmWork: null,
      derivedKvWrites: null,
      graphExtraction: null,
      indexPersistence: null,
    });
  });

  it("keeps full deferred work counts available outside health", async () => {
    const kv = mockKV();
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-25T00:00:00.000Z",
      lastFailedAt: "2026-04-25T00:00:00.000Z",
      lastError: "timeout",
    });
    await kv.set(KV.graphExtractionRetry, "obs_2", {
      observationId: "obs_2",
      sessionId: "ses_1",
      retries: 0,
      firstDeferredAt: "2026-04-25T00:00:00.000Z",
      lastDeferredAt: "2026-04-25T00:00:00.000Z",
      lastError: "health_unhealthy",
    });

    const status = await getDeferredWorkStatus(kv as never, { refresh: true });

    expect(status).toMatchObject({
      compression: {
        queued: 1,
        oldestFailedAt: "2026-04-25T00:00:00.000Z",
        oldestAgeMs: expect.any(Number),
      },
      retrievalBlocks: { queued: 1 },
      graphExtraction: { queued: 1 },
      totalQueued: 3,
    });
  });

  it("runs one bounded compression drain wake through maintenance", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    await kv.set(KV.compressRetry, "obs_1", {
      obsId: "obs_1",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    sdk.registerFunction("mem::maintenance-catch-up", async (payload) => {
      forwarded = payload;
      await kv.delete(KV.compressRetry, "obs_1");
      return { success: true, lane: "compression", workDone: 1 };
    });
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::compression-drain", {
      body: {
        batchSize: "2",
        timeBudgetMs: 1000,
        ignored: "drop",
      },
      headers: { authorization: "Bearer secret" },
    })) as {
      status_code: number;
      body: {
        result: { workDone: number };
        remainingCompressionQueued: number;
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.result.workDone).toBe(1);
    expect(response.body.remainingCompressionQueued).toBe(0);
    expect(forwarded).toEqual({
      lane: "compression",
      maxBatchSize: 2,
      timeBudgetMs: 1000,
    });
  });

  it("validates compression drain options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::compression-drain", {
      body: { maxBatchSize: 0 },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("maxBatchSize");
  });

  it("forwards whitelisted retrieval block shard migration options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::retrieval-blocks-migrate-shards", async (payload) => {
      forwarded = payload;
      return { success: true, migrated: 2 };
    });

    const response = (await sdk.trigger("api::retrieval-blocks-migrate-shards", {
      body: {
        batchSize: 2,
        timeBudgetMs: "1000",
        dryRun: true,
        deleteLegacy: false,
        ignored: "drop",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean; migrated: number } };

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({ success: true, migrated: 2 });
    expect(forwarded).toEqual({
      batchSize: 2,
      timeBudgetMs: 1000,
      dryRun: true,
      deleteLegacy: false,
    });
  });

  it("keeps serving health separate from CPU-paused maintenance", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.health, "latest", {
      status: "critical",
      alerts: ["cpu_critical_95%"],
      connectionState: "connected",
      kvConnectivity: { status: "ok", consecutiveFailures: 0 },
      snapshotPersistence: { status: "ok", consecutiveFailures: 0 },
      eventLoopLagMs: 0,
      cpu: { percent: 95, userMicros: 0, systemMicros: 0 },
      memory: { heapUsed: 0, heapTotal: 1, heapLimit: 1, external: 0, rss: 0 },
      pipeline: { compressActive: 0, compressPending: 0, totalInflight: 0 },
      workers: [],
      uptimeSeconds: 1,
    });
    await kv.set(KV.retrievalBlockRetry, "rblk_1", {
      blockId: "rblk_1",
      sourceType: "memory",
      retries: 0,
      firstFailedAt: "2026-04-25T00:00:00.000Z",
      lastFailedAt: "2026-04-25T00:00:00.000Z",
      lastError: "timeout",
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::health", {
      headers: {},
    })) as {
      status_code: number;
      body: {
        status: string;
        runtimeStatus: string;
        servingStatus: string;
        maintenanceStatus: string;
        writeGates: Record<string, string | null>;
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.servingStatus).toBe("healthy");
    expect(response.body.runtimeStatus).toBe("critical");
    expect(response.body.maintenanceStatus).toBe("paused");
    expect(response.body.writeGates.llmWork).toBe("cpu_critical_95%");
  });

  it("does not list deferred queues during health under pressure", async () => {
    vi.useFakeTimers();
    const sdk = mockSdk();
    const kv = mockKV();
    kv.list = vi.fn(async (scope: string) => {
      if (scope === KV.compressRetry) throw new Error("full compression list should not run");
      return [];
    });
    registerApiTriggers(sdk as never, kv as never);

    const pending = sdk.trigger("api::health", { headers: {} }) as Promise<{
      status_code: number;
      body: { deferredWork: { error: string }; healthTimeouts: unknown };
    }>;
    await vi.advanceTimersByTimeAsync(1600);
    const response = await pending;

    expect(response.status_code).toBe(200);
    expect(response.body.deferredWork).toMatchObject({
      compression: { queued: 0 },
      retrievalBlocks: { queued: 0 },
      graphExtraction: { queued: 0 },
      totalQueued: 0,
    });
    expect(response.body.healthTimeouts).toMatchObject({
      componentTimeoutMs: 1500,
    });
  });

  it("uses lightweight deferred work for health under pressure", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const listedScopes: string[] = [];
    const originalList = kv.list;
    kv.list = vi.fn(async (scope: string) => {
      listedScopes.push(scope);
      return originalList(scope);
    });
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      lastQueued: 42,
      lastWorkDone: 5,
      currentBatchSize: 6,
      currentIntervalMs: 60_000,
      updatedAt: "2026-04-29T00:00:00.000Z",
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::health", {
      headers: {},
    })) as {
      status_code: number;
      body: {
        deferredWork: {
          compression: { queued: number };
          totalQueued: number;
        };
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.deferredWork.compression.queued).toBe(42);
    expect(response.body.deferredWork.totalQueued).toBe(42);
    expect(listedScopes).not.toContain(KV.compressRetry);
    expect(listedScopes).not.toContain(KV.retrievalBlockRetry);
    expect(listedScopes).not.toContain(KV.graphExtractionRetry);
  });

  it("reports observe capture emergency disabled from health", async () => {
    const previous = process.env["AGENTMEMORY_INGEST_ENABLED"];
    process.env["AGENTMEMORY_INGEST_ENABLED"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerApiTriggers(sdk as never, kv as never);

      const response = (await sdk.trigger("api::health", {
        headers: {},
      })) as {
        status_code: number;
        body: { observeCapture: { status: string; captureSkipped: boolean; lastShedReason: string } };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.observeCapture).toMatchObject({
        status: "emergency_disabled",
        captureSkipped: true,
        lastShedReason: "ingest_disabled",
      });
    } finally {
      if (previous === undefined) {
        delete process.env["AGENTMEMORY_INGEST_ENABLED"];
      } else {
        process.env["AGENTMEMORY_INGEST_ENABLED"] = previous;
      }
    }
  });

  it("reports active observe cooldown from health", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
    await kv.set(KV.observePressureState, "latest", {
      status: "degraded",
      timeoutStreak: 1,
      degradedObserveCount: 1,
      acceptedObserveCount: 0,
      cooldownUntil,
      lastShedReason: "StateKV state::set timed out after 5000ms",
      lastTransitionAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::health", {
      headers: {},
    })) as {
      status_code: number;
      body: { observeCapture: { status: string; captureSkipped: boolean; cooldownUntil: string } };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.observeCapture).toMatchObject({
      status: "degraded",
      captureSkipped: true,
      cooldownUntil,
    });
  });

  it("forwards whitelisted retrieval block diagnostic options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::retrieval-blocks-diagnostics", async (payload) => {
      forwarded = payload;
      return { success: true };
    });

    const response = (await sdk.trigger("api::retrieval-blocks-diagnostics", {
      body: {
        project: "/project",
        sessionId: "ses_1",
        branch: "main",
        sampleLimit: 5,
        largeScanThreshold: 100,
        ignored: true,
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      project: "/project",
      sessionId: "ses_1",
      branch: "main",
      sampleLimit: 5,
      largeScanThreshold: 100,
    });
  });

  it("forwards whitelisted active scope diagnostic options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::active-scope-diagnostics", async (payload) => {
      forwarded = payload;
      return { success: true };
    });

    const response = (await sdk.trigger("api::active-scope-diagnostics", {
      body: {
        staleAfterDays: "45",
        sampleLimit: 5,
        ignored: true,
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      staleAfterDays: 45,
      sampleLimit: 5,
    });
  });

  it("validates active scope diagnostic API options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::active-scope-diagnostics", {
      body: { staleAfterDays: 0 },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("staleAfterDays");
  });

  it("forwards whitelisted Codex prune options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::codex-prune", async (payload) => {
      forwarded = payload;
      return { success: true, dryRun: true };
    });

    const response = (await sdk.trigger("api::codex-prune", {
      body: {
        allowProjects: ["/keep"],
        includeScopes: ["turnCapsules"],
        dryRun: false,
        force: true,
        archive: true,
        includeSamples: true,
        staleAfterDays: 45,
        batchSize: 25,
        timeBudgetMs: 1000,
        ignored: true,
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      allowProjects: ["/keep"],
      includeScopes: ["turnCapsules"],
      dryRun: false,
      force: true,
      archive: true,
      includeSamples: true,
      staleAfterDays: 45,
      batchSize: 25,
      timeBudgetMs: 1000,
    });
  });

  it("validates Codex prune API options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::codex-prune", {
      body: { dryRun: "false" },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("dryRun");
  });

  it("forwards whitelisted retrieval proof options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::retrieval-proof", async (payload) => {
      forwarded = payload;
      return { success: true, pass: true };
    });

    const response = (await sdk.trigger("api::retrieval-proof", {
      body: {
        project: "/project",
        cwd: "/cwd",
        branch: "main",
        query: "retrieval health",
        limit: 4,
        coverageTarget: 0.99,
        includeSearch: true,
        ignored: "drop",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean; pass: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body).toEqual({ success: true, pass: true });
    expect(forwarded).toEqual({
      project: "/project",
      cwd: "/cwd",
      branch: "main",
      query: "retrieval health",
      limit: 4,
      coverageTarget: 0.99,
      includeSearch: true,
    });
  });

  it("forwards whitelisted Codex integration proof options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::codex-integration-proof", async (payload) => {
      forwarded = payload;
      return { success: true, pass: true };
    });

    const response = (await sdk.trigger("api::codex-integration-proof", {
      body: {
        project: "/project",
        cwd: "/cwd",
        branch: "main",
        query: "codex proof",
        sessionId: "session-1",
        contextBudget: 6000,
        searchLimit: 5,
        latencyTargetsMs: {
          sessionStart: 1000,
          context: 2000,
          smartSearch: 1500,
        },
        ignored: "drop",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean; pass: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body).toEqual({ success: true, pass: true });
    expect(forwarded).toEqual({
      project: "/project",
      cwd: "/cwd",
      branch: "main",
      query: "codex proof",
      sessionId: "session-1",
      contextBudget: 6000,
      searchLimit: 5,
      latencyTargetsMs: {
        sessionStart: 1000,
        context: 2000,
        smartSearch: 1500,
      },
    });
  });

  it("forwards whitelisted insight decay sweep options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::insight-decay-sweep", async (payload) => {
      forwarded = payload;
      return { success: true, dryRun: true };
    });

    const response = (await sdk.trigger("api::insight-decay-sweep", {
      body: {
        dryRun: true,
        pruneDeletedAfterDays: 30,
        pruneBatchSize: "25",
        ignored: "drop",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      dryRun: true,
      pruneDeletedAfterDays: 30,
      pruneBatchSize: 25,
    });
  });

  it("validates insight decay sweep API options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::insight-decay-sweep", {
      body: { dryRun: "yes" },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("dryRun");
  });

  it("validates retrieval proof API options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::retrieval-proof", {
      body: { coverageTarget: 1.1, includeSearch: "yes" },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("coverageTarget");
  });

  it("validates consolidated memory backfill API options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::consolidated-memory-backfill", {
      body: { kinds: ["semantic", "other"] },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("kinds");
  });

  it("forwards whitelisted consolidated memory backfill options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    registerApiTriggers(sdk as never, kv as never, "secret");
    sdk.registerFunction("mem::consolidated-memory-backfill", async (payload) => {
      forwarded = payload;
      return { success: true };
    });

    const response = (await sdk.trigger("api::consolidated-memory-backfill", {
      body: {
        dryRun: true,
        reindex: false,
        includeItems: true,
        limit: 25,
        kinds: ["semantic"],
        ignored: "field",
      },
      headers: { authorization: "Bearer secret" },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(forwarded).toEqual({
      dryRun: true,
      reindex: false,
      includeItems: true,
      limit: 25,
      kinds: ["semantic"],
    });
  });
});
