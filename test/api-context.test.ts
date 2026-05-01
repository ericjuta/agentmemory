import { describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Session } from "../src/types.js";
import { registerContextFunction } from "../src/functions/context.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("api::context", () => {
  it("forwards an optional query to mem::context", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);
    registerApiTriggers(sdk as never, kv as never);

    const session: Session = {
      id: "session-api-context",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T13:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    const observation: CompressedObservation = {
      id: "obs-api-context",
      sessionId: session.id,
      turnId: "turn-1",
      timestamp: "2026-03-29T13:00:01.000Z",
      type: "discovery",
      title: "Context query forwarding",
      facts: [],
      narrative: "The context endpoint should preserve retrieval trace queries.",
      concepts: ["retrieval trace", "api context"],
      files: ["/project/src/triggers/api.ts"],
      importance: 7,
    };

    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), observation.id, observation);

    const response = (await sdk.trigger("api::context", {
      body: {
        sessionId: session.id,
        project: session.project,
        query: "retrieval trace",
      },
      headers: {},
    })) as {
      status_code: number;
      body: { trace: { query?: string; queryTerms: string[] } };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.trace.query).toBe("retrieval trace");
    expect(response.body.trace.queryTerms).toContain("retrieval");
  });

  it("accepts unified retrieval intent and file/context focus fields", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);
    registerApiTriggers(sdk as never, kv as never);

    const session: Session = {
      id: "session-api-context-intent",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T13:10:00.000Z",
      status: "active",
      observationCount: 0,
    };
    await kv.set(KV.sessions, session.id, session);

    const response = (await sdk.trigger("api::context", {
      body: {
        sessionId: session.id,
        intent: "file_enrich",
        files: ["/project/src/triggers/api.ts"],
        terms: ["retrieval trace"],
      },
      headers: {},
    })) as {
      status_code: number;
      body: { trace: { queryTerms: string[] } };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.trace.queryTerms).toContain("retrieval");
  });

  it("keeps short context refresh queries instead of dropping them", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);
    registerApiTriggers(sdk as never, kv as never);

    const session: Session = {
      id: "session-api-context-refresh",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T13:15:00.000Z",
      status: "active",
      observationCount: 0,
    };
    await kv.set(KV.sessions, session.id, session);

    const response = (await sdk.trigger("api::context-refresh", {
      body: {
        sessionId: session.id,
        project: session.project,
        query: "3113",
      },
      headers: {},
    })) as {
      status_code: number;
      body: { trace: { query?: string; queryTerms: string[] } };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.trace.query).toBe("3113");
    expect(response.body.trace.queryTerms).toContain("3113");
  });

  it("applies a bounded default budget to context refresh requests", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let contextPayload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::context", async (payload: unknown) => {
      contextPayload = payload as Record<string, unknown>;
      return { context: "", items: [], blocks: 0, trace: {} };
    });
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::context-refresh", {
      body: {
        sessionId: "session-api-context-refresh-budget",
        project: "/project",
        query: "budget proof",
      },
      headers: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    expect(contextPayload).toMatchObject({
      sessionId: "session-api-context-refresh-budget",
      budget: 1500,
    });
  });

  it("returns bounded fallback context when the API context call stalls", async () => {
    const previousTimeout = process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS;
    process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS = "5";
    const sdk = mockSdk();
    const kv = mockKV();
    try {
      sdk.registerFunction("mem::context", async () => new Promise(() => {}));
      registerApiTriggers(sdk as never, kv as never);
      const session: Session = {
        id: "session-api-context-timeout",
        project: "/project",
        cwd: "/project",
        startedAt: "2026-04-30T10:00:00.000Z",
        status: "active",
        observationCount: 1,
      };
      await kv.set(KV.sessions, session.id, session);
      await kv.set(KV.observations(session.id), "obs-api-context-timeout", {
        id: "obs-api-context-timeout",
        sessionId: session.id,
        timestamp: "2026-04-30T10:00:01.000Z",
        type: "conversation",
        title: "Context timeout fallback",
        facts: ["context deferred timeout still returns scoped evidence"],
        narrative: "The API fallback should avoid an empty degraded payload.",
        concepts: ["retrieval trace"],
        files: ["/project/src/triggers/api.ts"],
        importance: 7,
      } satisfies CompressedObservation);

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: session.id,
          project: session.project,
          query: "retrieval trace",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          context: string;
          degraded?: boolean;
          skipped?: boolean;
          fallback?: string;
          reason?: string;
          trace?: { pressureFallback?: { skippedExpensiveLanes?: string[] } };
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.context).toContain("context deferred timeout");
      expect(response.body.degraded).toBe(true);
      expect(response.body.fallback).toBe("current-session-observations");
      expect(response.body.skipped).toBeUndefined();
      expect(response.body.reason).toBe("context_deferred_timeout");
      expect(response.body.trace?.pressureFallback?.skippedExpensiveLanes).toContain(
        "full_retrieval_block_scan",
      );
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS;
      } else {
        process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("returns bounded fallback context when the API context call times out with eligible evidence", async () => {
    const previousTimeout = process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS;
    process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS = "5";
    const sdk = mockSdk();
    const kv = mockKV();
    try {
      const session: Session = {
        id: "session-api-context-timeout-fallback",
        project: "/project",
        cwd: "/project",
        startedAt: "2026-04-30T13:00:00.000Z",
        status: "active",
        observationCount: 1,
      };
      await kv.set(KV.sessions, session.id, session);
      await kv.set(KV.observations(session.id), "obs-timeout-fallback", {
        id: "obs-timeout-fallback",
        sessionId: session.id,
        timestamp: "2026-04-30T13:00:01.000Z",
        type: "conversation",
        title: "Context timeout fallback marker",
        facts: ["bounded fallback evidence exists"],
        narrative: "The API timeout path should still return scoped evidence.",
        concepts: ["context timeout"],
        files: [],
        importance: 8,
      } satisfies CompressedObservation);
      const list = vi.spyOn(kv, "list");
      sdk.registerFunction("mem::context", async () => new Promise(() => {}));
      registerApiTriggers(sdk as never, kv as never);

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: session.id,
          project: session.project,
          query: "bounded fallback evidence",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          context: string;
          degraded?: boolean;
          fallback?: string;
          reason?: string;
          skipped?: boolean;
          trace?: { pressureFallback?: { skippedExpensiveLanes?: string[] } };
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.context).toContain("bounded fallback evidence exists");
      expect(response.body.degraded).toBe(true);
      expect(response.body.fallback).toBe("current-session-observations");
      expect(response.body.reason).toBe("context_deferred_timeout");
      expect(response.body.skipped).toBeUndefined();
      expect(response.body.trace?.pressureFallback?.skippedExpensiveLanes).toContain(
        "full_retrieval_block_scan",
      );
      expect(list).not.toHaveBeenCalledWith(KV.retrievalBlocks);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS;
      } else {
        process.env.AGENTMEMORY_CONTEXT_API_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("keeps context available for normal deferred backlog by default", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
    delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerContextFunction(sdk as never, kv as never, 900);
      registerApiTriggers(sdk as never, kv as never);
      for (let i = 0; i < 120; i++) {
        await kv.set(KV.compressRetry, `queued-compress-${i}`, {
          obsId: `queued-compress-${i}`,
        });
      }

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: "session-api-context-normal-backlog",
          project: "/project",
          query: "retrieval trace",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          skipped?: boolean;
          reason?: string;
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.skipped).toBeUndefined();
      expect(response.body.reason).toBeUndefined();
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
    }
  });

  it("does not let compression retry backlog silence context reads", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
    const previousIncludeCompression =
      process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_INCLUDE_COMPRESSION"];
    process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] = "1";
    delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_INCLUDE_COMPRESSION"];

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerContextFunction(sdk as never, kv as never, 900);
      registerApiTriggers(sdk as never, kv as never);
      for (let i = 0; i < 50; i++) {
        await kv.set(KV.compressRetry, `queued-compress-${i}`, {
          obsId: `queued-compress-${i}`,
        });
      }

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: "session-api-context-compression-backlog",
          project: "/project",
          query: "retrieval trace",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          skipped?: boolean;
          reason?: string;
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.skipped).toBeUndefined();
      expect(response.body.reason).toBeUndefined();
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
      if (previousIncludeCompression === undefined) {
        delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_INCLUDE_COMPRESSION"];
      } else {
        process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_INCLUDE_COMPRESSION"] =
          previousIncludeCompression;
      }
    }
  });

  it("defers explicit manual recall during deferred queue pressure", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
    process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] = "1";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerContextFunction(sdk as never, kv as never, 900);
      registerApiTriggers(sdk as never, kv as never);
      await kv.set(KV.maintenanceLaneState, "retrieval", {
        lane: "retrieval",
        lastQueued: 1,
        updatedAt: "2026-04-30T00:00:00.000Z",
      });

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: "session-api-context-manual-recall",
          project: "/project",
          query: "retrieval trace",
          intent: "manual_recall",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          context?: string;
          skipped?: boolean;
          reason?: string;
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.context).toBe("");
      expect(response.body.skipped).toBe(true);
      expect(response.body.reason).toBe("hot_path_backpressure");
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
    }
  });

  it("returns an empty skipped context payload under hot-path pressure", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
    process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] = "1";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerContextFunction(sdk as never, kv as never, 900);
      registerApiTriggers(sdk as never, kv as never);
      await kv.set(KV.maintenanceLaneState, "retrieval", {
        lane: "retrieval",
        lastQueued: 1,
        updatedAt: "2026-04-30T00:00:00.000Z",
      });

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: "session-api-context-pressure",
          project: "/project",
          query: "retrieval trace",
        },
        headers: {},
      })) as {
        status_code: number;
        body: {
          context: string;
          skipped?: boolean;
          reason?: string;
          pressure?: { reason?: string };
        };
      };

      expect(response.status_code).toBe(200);
      expect(response.body).toMatchObject({
        context: "",
        skipped: true,
        reason: "hot_path_backpressure",
      });
      expect(response.body.pressure?.reason).toBe("deferred_queue_1_gte_1");
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
    }
  });

  it("does not use Codex fallback for file enrich pressure", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
    const previousPressureCache =
      process.env["AGENTMEMORY_HOT_PATH_PRESSURE_CACHE_MS"];
    const previousCodexBackpressure =
      process.env["AGENTMEMORY_CODEX_CONTEXT_QUEUE_BACKPRESSURE"];
    process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] = "1";
    process.env["AGENTMEMORY_HOT_PATH_PRESSURE_CACHE_MS"] = "0";
    process.env["AGENTMEMORY_CODEX_CONTEXT_QUEUE_BACKPRESSURE"] = "true";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerContextFunction(sdk as never, kv as never, 900);
      registerApiTriggers(sdk as never, kv as never);
      await kv.set(KV.maintenanceLaneState, "retrieval", {
        lane: "retrieval",
        lastQueued: 1,
        updatedAt: "2026-04-30T00:00:00.000Z",
      });

      const response = (await sdk.trigger("api::context", {
        body: {
          sessionId: "session-codex-file-enrich-pressure",
          project: "/home/ericjuta/.openclaw/workspace/repos/codex",
          query: "codex fallback",
          intent: "file_enrich",
          files: ["/home/ericjuta/.openclaw/workspace/repos/codex/src/main.rs"],
        },
        headers: {},
      })) as {
        status_code: number;
        body: { context: string; degraded?: boolean; fallback?: string };
      };

      expect(response.status_code).toBe(200);
      expect(response.body.context).toBe("");
      expect(response.body.degraded).toBe(true);
      expect(response.body.fallback).toBe("empty");
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
      if (previousPressureCache === undefined) {
        delete process.env["AGENTMEMORY_HOT_PATH_PRESSURE_CACHE_MS"];
      } else {
        process.env["AGENTMEMORY_HOT_PATH_PRESSURE_CACHE_MS"] =
          previousPressureCache;
      }
      if (previousCodexBackpressure === undefined) {
        delete process.env["AGENTMEMORY_CODEX_CONTEXT_QUEUE_BACKPRESSURE"];
      } else {
        process.env["AGENTMEMORY_CODEX_CONTEXT_QUEUE_BACKPRESSURE"] =
          previousCodexBackpressure;
      }
    }
  });
});
