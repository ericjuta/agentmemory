import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompressFunction } from "../src/functions/compress.js";
import { KV } from "../src/state/schema.js";
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
});
