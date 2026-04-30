import { describe, expect, it } from "vitest";

import { registerObserveDerivedDrainFunction } from "../src/functions/observe-derived-drain.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import type { ObserveDerivedRetryEntry } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function health(status: "healthy" | "critical" = "healthy") {
  return {
    status,
    alerts: status === "healthy" ? [] : ["memory_critical_99%"],
    connectionState: "connected",
    kvConnectivity: { status: "ok", consecutiveFailures: 0 },
    snapshotPersistence: { status: "ok", consecutiveFailures: 0 },
    eventLoopLagMs: 0,
    cpu: {
      percent: 10,
      consecutiveHighSamples: 0,
      userMicros: 0,
      systemMicros: 0,
    },
    memory: { heapUsed: 0, heapTotal: 1, heapLimit: 1, external: 0, rss: 0 },
    pipeline: { compressActive: 0, compressPending: 0, totalInflight: 0 },
    workers: [],
    uptimeSeconds: 1,
  };
}

function observation(id: string, sessionId = "session-1", turnId = "turn-1") {
  return {
    id,
    sessionId,
    timestamp: "2026-04-30T00:00:00.000Z",
    type: "file_read",
    title: "Edit auth file",
    narrative: "Edited /project/src/auth.ts and found token validation.",
    facts: ["token validation"],
    concepts: ["auth"],
    files: ["/project/src/auth.ts"],
    importance: 7,
    turnId,
  };
}

function retry(id: string, sessionId = "session-1"): ObserveDerivedRetryEntry {
  return {
    observationId: id,
    sessionId,
    project: "/project",
    cwd: "/project",
    hookType: "assistant_result",
    raw: {
      id,
      sessionId,
      timestamp: "2026-04-30T00:00:00.000Z",
      hookType: "assistant_result",
      turnId: "turn-1",
      toolName: "Edit",
      toolInput: { file_path: "/project/src/auth.ts" },
      toolOutput: { output: "token validation" },
      raw: {
        turn_id: "turn-1",
        assistant_text: "Edited auth validation.",
        is_final: true,
      },
    },
    retries: 0,
    firstDeferredAt: "2026-04-30T00:00:00.000Z",
    lastDeferredAt: "2026-04-30T00:00:00.000Z",
    lastError: "observe_derived_inline_disabled",
  };
}

describe("observe-derived drain", () => {
  it("observe enqueues derived work without inline retrieval or capsule updates", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "assistant_result",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-04-30T00:00:00.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-derived-1",
      persistenceClass: "persistent",
      capabilities: ["structured_post_tool_payload", "event_identity"],
      data: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/project",
        model: "gpt-5.5",
        assistant_text: "Edited auth validation.",
        is_final: true,
      },
    })) as { observationId: string };

    expect(await kv.list(KV.observeDerivedRetry)).toHaveLength(1);
    expect(await kv.list(KV.retrievalBlocks)).toHaveLength(2);
    expect(await kv.get(KV.turnCapsules, "session-1:turn-1")).not.toBeNull();
    const queued = await kv.get<ObserveDerivedRetryEntry>(
      KV.observeDerivedRetry,
      result.observationId,
    );
    expect(queued).toMatchObject({
      observationId: result.observationId,
      sessionId: "session-1",
      project: "/project",
      hookType: "assistant_result",
      lastError: "observe_derived_inline_disabled",
    });
  });

  it("processes only a bounded batch", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveDerivedDrainFunction(sdk as never, kv as never);
    await kv.set(KV.health, "latest", health());
    for (const id of ["obs-1", "obs-2", "obs-3"]) {
      await kv.set(KV.observations("session-1"), id, observation(id));
      await kv.set(KV.observeDerivedRetry, id, retry(id));
    }

    const result = (await sdk.trigger("mem::observe-derived-drain", {
      batchSize: 2,
      timeBudgetMs: 1000,
    })) as { processed: number; deferred: number; indexedObservations: number };

    expect(result.processed).toBe(2);
    expect(result.indexedObservations).toBe(2);
    expect(result.deferred).toBe(1);
    expect(await kv.list(KV.observeDerivedRetry)).toHaveLength(1);
    expect(await kv.list(KV.retrievalBlocks)).toHaveLength(4);
    expect(await kv.get(KV.turnCapsules, "session-1:turn-1")).not.toBeNull();
  });

  it("respects health and write pressure", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveDerivedDrainFunction(sdk as never, kv as never);
    await kv.set(KV.health, "latest", health("critical"));
    await kv.set(KV.observations("session-1"), "obs-1", observation("obs-1"));
    await kv.set(KV.observeDerivedRetry, "obs-1", retry("obs-1"));

    const result = (await sdk.trigger("mem::observe-derived-drain", {
      batchSize: 1,
    })) as { skipped?: boolean; reason?: string; processed: number };

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("critical");
    expect(result.processed).toBe(0);
    expect(await kv.list(KV.observeDerivedRetry)).toHaveLength(1);
    expect(await kv.list(KV.retrievalBlocks)).toHaveLength(0);
  });

  it("is idempotent across repeated drains", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveDerivedDrainFunction(sdk as never, kv as never);
    await kv.set(KV.health, "latest", health());
    await kv.set(KV.observations("session-1"), "obs-1", observation("obs-1"));
    await kv.set(KV.observeDerivedRetry, "obs-1", retry("obs-1"));

    const first = (await sdk.trigger("mem::observe-derived-drain", {
      batchSize: 5,
    })) as { processed: number };
    const second = (await sdk.trigger("mem::observe-derived-drain", {
      batchSize: 5,
    })) as { processed: number };

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(await kv.list(KV.observeDerivedRetry)).toHaveLength(0);
    expect(await kv.list(KV.retrievalBlocks)).toHaveLength(3);
  });
});
