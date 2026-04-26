import { describe, expect, it } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("operational hardening APIs", () => {
  it("exposes deferred work and write gates on health", async () => {
    const sdk = mockSdk();
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
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::health", {
      headers: {},
    })) as {
      status_code: number;
      body: {
        deferredWork: {
          compression: { queued: number };
          retrievalBlocks: { queued: number };
          graphExtraction: { queued: number };
        };
        writeGates: Record<string, null>;
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.deferredWork).toMatchObject({
      compression: { queued: 1 },
      retrievalBlocks: { queued: 1 },
      graphExtraction: { queued: 1 },
    });
    expect(response.body.writeGates).toMatchObject({
      llmWork: null,
      derivedKvWrites: null,
      graphExtraction: null,
      indexPersistence: null,
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
