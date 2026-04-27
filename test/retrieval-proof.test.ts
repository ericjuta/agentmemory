import { describe, expect, it } from "vitest";

import { registerRetrievalProofFunction } from "../src/functions/retrieval-proof.js";
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
      status: "non_blocking_backlog",
      queuedCount: 4,
      blockingQueuedCount: 0,
    });
  });
});
