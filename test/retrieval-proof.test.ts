import { describe, expect, it } from "vitest";

import { registerRetrievalProofFunction } from "../src/functions/retrieval-proof.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("mem::retrieval-proof", () => {
  it("builds a lightweight proof bundle from diagnostics without search", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    sdk.registerFunction("mem::retrieval-blocks-diagnostics", async (payload) => {
      forwarded = payload;
      return {
        success: true,
        quality: {
          vectorCoverage: 1,
          lastEvalLeakageCount: 0,
          deferredFreshnessLag: { queuedCount: 0 },
        },
      };
    });
    registerRetrievalProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-proof", {
      project: "/project",
      branch: "main",
      query: "retrieval health",
      includeSearch: false,
    })) as {
      success: boolean;
      project: string;
      branch: string;
      diagnostics: { quality: { vectorCoverage: number } };
      search: { skipped: boolean; reason: string };
    };

    expect(forwarded).toEqual({
      project: "/project",
      branch: "main",
      sampleLimit: 0,
    });
    expect(result).toMatchObject({
      success: true,
      project: "/project",
      branch: "main",
      diagnostics: {
        quality: {
          vectorCoverage: 1,
        },
      },
      search: {
        skipped: true,
        reason: "includeSearch=false",
      },
    });
  });

  it("fails closed instead of searching without a project scope", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("mem::retrieval-blocks-diagnostics", async () => ({
      success: true,
      quality: {
        vectorCoverage: 1,
        lastEvalLeakageCount: 0,
        deferredFreshnessLag: { queuedCount: 0 },
      },
    }));
    registerRetrievalProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-proof", {
      query: "retrieval health",
      includeSearch: true,
    })) as { search: { skipped: boolean; reason: string } };

    expect(result.search).toEqual({
      skipped: true,
      reason: "scope_required",
    });
  });

  it("does not fail proof for non-blocking maintenance backlog", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("mem::retrieval-blocks-diagnostics", async () => ({
      success: true,
      quality: {
        vectorCoverage: 1,
        lastEvalLeakageCount: 0,
        deferredFreshnessLag: {
          queuedCount: 4,
          blockingQueuedCount: 0,
          diagnosticQueuedCount: 1,
          byLane: { hot: 0, warm: 0, cold: 4 },
        },
      },
    }));
    registerRetrievalProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-proof", {
      project: "/project",
      includeSearch: false,
    })) as {
      pass: boolean;
      maintenance: { status: string; queuedCount: number; blockingQueuedCount: number };
    };

    expect(result.pass).toBe(true);
    expect(result.maintenance).toMatchObject({
      status: "retrieval_freshness_draining",
      queuedCount: 4,
      blockingQueuedCount: 0,
    });
  });

  it("passes with explicit compression backlog status when retrieval freshness is clear", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.maintenanceLaneState, "compression", {
      lane: "compression",
      lastQueued: 7,
      lastWorkDone: 2,
      queuedDeltaSinceLastWake: -2,
      drainRatePerHour: 120,
      estimatedDrainEtaMs: 210000,
      currentBatchSize: 2,
      currentIntervalMs: 60000,
      successStreak: 1,
      pressureStreak: 0,
      updatedAt: "2026-04-30T16:00:00.000Z",
    });
    sdk.registerFunction("mem::retrieval-blocks-diagnostics", async () => ({
      success: true,
      quality: {
        vectorCoverage: 1,
        lastEvalLeakageCount: 0,
        deferredFreshnessLag: {
          queuedCount: 0,
          blockingQueuedCount: 0,
          diagnosticQueuedCount: 0,
          byLane: { hot: 0, warm: 0, cold: 0 },
        },
      },
    }));
    registerRetrievalProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-proof", {
      project: "/project",
      includeSearch: false,
    })) as {
      pass: boolean;
      maintenance: {
        status: string;
        compressionBacklog: {
          status: string;
          queuedCount: number;
          drainRatePerHour: number;
        };
      };
    };

    expect(result.pass).toBe(true);
    expect(result.maintenance.status).toBe("compression_backlog_draining");
    expect(result.maintenance.compressionBacklog).toMatchObject({
      status: "draining",
      queuedCount: 7,
      drainRatePerHour: 120,
    });
  });

  it("fails when hot or warm retrieval freshness is blocking", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("mem::retrieval-blocks-diagnostics", async () => ({
      success: true,
      quality: {
        vectorCoverage: 1,
        lastEvalLeakageCount: 0,
        deferredFreshnessLag: {
          queuedCount: 2,
          blockingQueuedCount: 2,
          byLane: { hot: 1, warm: 1, cold: 0 },
          oldestQueuedAt: "2026-04-30T09:00:00.000Z",
          oldestAgeMs: 60000,
        },
      },
    }));
    registerRetrievalProofFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-proof", {
      project: "/project",
      includeSearch: false,
    })) as {
      pass: boolean;
      maintenance: {
        status: string;
        retrievalFreshness: { status: string; oldestAgeMs: number };
      };
    };

    expect(result.pass).toBe(false);
    expect(result.maintenance).toMatchObject({
      status: "retrieval_freshness_blocked",
      retrievalFreshness: {
        status: "blocked",
        oldestAgeMs: 60000,
      },
    });
  });
});
