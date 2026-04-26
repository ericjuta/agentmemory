import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("api::smart-search", () => {
  it("whitelists scope fields before forwarding to mem::smart-search", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let captured: unknown;
    sdk.registerFunction("mem::smart-search", async (payload: unknown) => {
      captured = payload;
      return { mode: "compact", results: [] };
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::smart-search", {
      body: {
        query: " scoped search ",
        cwd: " /repo ",
        branch: " feature/smart ",
        limit: 5,
        scope_required: true,
        ignored: "drop",
      },
      headers: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    expect(captured).toEqual({
      query: "scoped search",
      cwd: "/repo",
      branch: "feature/smart",
      limit: 5,
      scope_required: true,
    });
  });

  it("accepts camel-case scopeRequired with explicit global scope", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let captured: unknown;
    sdk.registerFunction("mem::smart-search", async (payload: unknown) => {
      captured = payload;
      return { mode: "compact", results: [] };
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::smart-search", {
      body: {
        query: "global memory",
        global: true,
        scopeRequired: true,
      },
      headers: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    expect(captured).toEqual({
      query: "global memory",
      global: true,
      scopeRequired: true,
    });
  });

  it("fails closed before dispatch when required scope is missing", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let calls = 0;
    sdk.registerFunction("mem::smart-search", async () => {
      calls += 1;
      return { mode: "compact", results: [] };
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::smart-search", {
      body: {
        query: "auth",
        scopeRequired: true,
      },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toBe("scope is required: provide project, cwd, or global");
    expect(calls).toBe(0);
  });

  it("rejects invalid scope field types", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("mem::smart-search", async () => ({ mode: "compact", results: [] }));
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::smart-search", {
      body: {
        query: "auth",
        cwd: 123,
      },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toBe("cwd must be a non-empty string");
  });
});
