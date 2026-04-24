import { describe, expect, it } from "vitest";

import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("operational hardening APIs", () => {
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
