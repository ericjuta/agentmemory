import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompressFunction } from "../src/functions/compress.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { RawObservation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const compressionXml = [
  "<type>file_read</type>",
  "<title>Read auth file</title>",
  "<facts><fact>Read src/auth.ts</fact></facts>",
  "<narrative>Read the auth file.</narrative>",
  "<concepts><concept>auth</concept></concepts>",
  "<files><file>src/auth.ts</file></files>",
  "<importance>7</importance>",
].join("\n");

function rawObservation(id: string): RawObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: "2026-04-25T00:00:00.000Z",
    hookType: "post_tool_use",
    persistenceClass: "persistent",
    toolName: "Read",
    toolInput: { file_path: "src/auth.ts" },
    toolOutput: "auth contents",
    raw: {},
  };
}

describe("compression retry catch-up", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("discovers unqueued raw observations and compresses them after recovery", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(async () => compressionXml),
      summarize: vi.fn(),
    };
    const session: Session = {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    const raw = rawObservation("obs_1");
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), raw.id, raw);
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::compress-retry", {
      scanLimit: 5,
    })) as { queued: number; retried: number; removed: number; succeeded: number };

    expect(result.queued).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(provider.compress).toHaveBeenCalledTimes(1);
    const stored = await kv.get<{ title?: string }>(
      KV.observations(session.id),
      raw.id,
    );
    expect(stored?.title).toBe("Read auth file");
    expect(await kv.get(KV.compressRetry, raw.id)).toBeNull();
  });

  it("does not raw-scan when auto compression is disabled", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(async () => compressionXml),
      summarize: vi.fn(),
    };
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);
    await kv.set(KV.observations("ses_1"), "obs_1", rawObservation("obs_1"));
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::compress-retry", {})) as {
      queued: number;
      scanned: number;
    };

    expect(result).toMatchObject({ queued: 0, scanned: 0 });
    expect(provider.compress).not.toHaveBeenCalled();
  });

  it("synthetically compresses queued raw observations when auto compression is disabled", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(async () => compressionXml),
      summarize: vi.fn(),
    };
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);
    const raw = rawObservation("obs_synthetic_retry");
    await kv.set(KV.observations("ses_1"), raw.id, raw);
    await kv.set(KV.compressRetry, raw.id, {
      obsId: raw.id,
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::compress-retry", {
      batchSize: 1,
      scanRaw: false,
    })) as { succeeded: number; processed: number };

    expect(result).toMatchObject({ succeeded: 1, processed: 1 });
    expect(provider.compress).not.toHaveBeenCalled();
    const stored = await kv.get<{ title?: string; narrative?: string }>(
      KV.observations("ses_1"),
      raw.id,
    );
    expect(stored?.title).toBe("Read");
    expect(stored?.narrative).toContain("auth contents");
    expect(await kv.get(KV.compressRetry, raw.id)).toBeNull();
  });

  it("processes no more than the configured retry batch cap", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(async () => compressionXml),
      summarize: vi.fn(),
    };
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 3,
    } satisfies Session);
    for (let i = 0; i < 3; i++) {
      const raw = rawObservation(`obs_cap_${i}`);
      await kv.set(KV.observations("ses_1"), raw.id, raw);
      await kv.set(KV.compressRetry, raw.id, {
        obsId: raw.id,
        sessionId: "ses_1",
        retries: 0,
        failedAt: "2026-04-25T00:00:00.000Z",
      });
    }
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const result = await sdk.trigger("mem::compress-retry", {
      batchSize: 2,
      scanRaw: false,
    });

    expect(result).toMatchObject({
      succeeded: 2,
      deferred: 1,
      processed: 2,
      queued: 0,
    });
    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(await kv.list(KV.compressRetry)).toHaveLength(1);
  });

  it("retries oldest compression entries first and records attempt time", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(async () => "not xml"),
      summarize: vi.fn(),
    };
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 2,
    } satisfies Session);
    for (const id of ["obs_old", "obs_new"]) {
      await kv.set(KV.observations("ses_1"), id, rawObservation(id));
    }
    await kv.set(KV.compressRetry, "obs_new", {
      obsId: "obs_new",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-26T00:00:00.000Z",
    });
    await kv.set(KV.compressRetry, "obs_old", {
      obsId: "obs_old",
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const result = await sdk.trigger("mem::compress-retry", {
      batchSize: 1,
      scanRaw: false,
    });

    expect(result).toMatchObject({ retried: 1, processed: 1, deferred: 1 });
    const oldEntry = await kv.get<{ retries: number; lastAttemptAt?: string }>(
      KV.compressRetry,
      "obs_old",
    );
    const newEntry = await kv.get<{ retries: number; lastAttemptAt?: string }>(
      KV.compressRetry,
      "obs_new",
    );
    expect(oldEntry?.retries).toBe(1);
    expect(oldEntry?.lastAttemptAt).toEqual(expect.any(String));
    expect(newEntry?.retries).toBe(0);
    expect(newEntry?.lastAttemptAt).toBeUndefined();
  });

  it("keeps compression retry single-flight", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(compressionXml), 50);
          }),
      ),
      summarize: vi.fn(),
    };
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);
    const raw = rawObservation("obs_single_flight");
    await kv.set(KV.observations("ses_1"), raw.id, raw);
    await kv.set(KV.compressRetry, raw.id, {
      obsId: raw.id,
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const [first, second] = await Promise.all([
      sdk.trigger("mem::compress-retry", { batchSize: 1, scanRaw: false }),
      sdk.trigger("mem::compress-retry", { batchSize: 1, scanRaw: false }),
    ]);

    expect([first, second]).toContainEqual(
      expect.objectContaining({
        skipped: true,
        reason: "compress_retry_in_flight",
      }),
    );
    expect(provider.compress).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded deferred result when retry work exceeds the time budget", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test",
      compress: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(compressionXml), 1000);
          }),
      ),
      summarize: vi.fn(),
    };
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-04-25T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    } satisfies Session);
    const raw = rawObservation("obs_time_budget");
    await kv.set(KV.observations("ses_1"), raw.id, raw);
    await kv.set(KV.compressRetry, raw.id, {
      obsId: raw.id,
      sessionId: "ses_1",
      retries: 0,
      failedAt: "2026-04-25T00:00:00.000Z",
    });
    registerCompressFunction(sdk as never, kv as never, provider as never);

    const startedAt = Date.now();
    const result = await sdk.trigger("mem::compress-retry", {
      batchSize: 1,
      scanRaw: false,
      timeBudgetMs: 500,
    });

    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(result).toMatchObject({
      succeeded: 0,
      deferred: 1,
      processed: 1,
      timedOut: true,
      timeBudgetMs: 500,
    });
    expect(provider.compress).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards compression retry REST options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let forwarded: unknown;
    sdk.registerFunction("mem::compress-retry", async (payload: unknown) => {
      forwarded = payload;
      return { succeeded: 1 };
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::compress-retry", {
      body: {
        batchSize: "3",
        scanLimit: 7,
        timeBudgetMs: "1000",
        scanRaw: false,
        ignored: "drop",
      },
      headers: {},
    })) as { status_code: number; body: { succeeded: number } };

    expect(response.status_code).toBe(200);
    expect(response.body.succeeded).toBe(1);
    expect(forwarded).toEqual({
      batchSize: 3,
      scanLimit: 7,
      timeBudgetMs: 1000,
      scanRaw: false,
    });
  });

  it("rejects invalid compression retry REST options", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::compress-retry", {
      body: { batchSize: 0, scanRaw: "yes" },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("batchSize");
  });
});
