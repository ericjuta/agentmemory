// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function preserveEnv(name: string): () => void {
  const previous = process.env[name];
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

describe("observe freshness plumbing", () => {
  it("parses assistant_result payloads into raw observations and capsules", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "assistant_result",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      data: {
        turn_id: "turn-1",
        assistant_text: "Freshness now prefers the current turn capsule.",
        is_final: true,
      },
    })) as { observationId: string };

    const observations = await kv.list<any>(KV.observations("session-1"));
    expect(observations).toHaveLength(1);
    expect(observations[0].turnId).toBe("turn-1");
    expect(observations[0].assistantResponse).toBe(
      "Freshness now prefers the current turn capsule.",
    );

    const capsule = await kv.get<any>(KV.turnCapsules, "session-1:turn-1");
    expect(capsule.assistantConclusion).toBe(
      "Freshness now prefers the current turn capsule.",
    );
    expect(capsule.importantObservationIds).toEqual([result.observationId]);

    const workingSet = await kv.get<any>(KV.workingSets, "session-1");
    expect(workingSet.latestCompletedTurnId).toBe("turn-1");
    expect(workingSet.latestAssistantConclusion).toBe(
      "Freshness now prefers the current turn capsule.",
    );
  });

  it("parses stop payloads into final assistant conclusions for the current turn", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      hookType: "prompt_submit",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      data: {
        turn_id: "turn-2",
        prompt: "What changed most recently?",
      },
    });

    const result = (await sdk.trigger("mem::observe", {
      hookType: "stop",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:05.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-stop-turn-2",
      persistenceClass: "ephemeral",
      capabilities: ["event_identity"],
      data: {
        session_id: "session-1",
        turn_id: "turn-2",
        cwd: "/project",
        model: "gpt-5.4",
        last_assistant_message:
          "The latest turn capsule is now retrieved immediately.",
      },
    })) as { observationId: string; persisted: boolean };

    const observations = await kv.list<any>(KV.observations("session-1"));
    expect(result.persisted).toBe(false);
    expect(observations).toHaveLength(1);

    const capsule = await kv.get<any>(KV.turnCapsules, "session-1:turn-2");
    expect(capsule.userPrompt).toBe("What changed most recently?");
    expect(capsule.assistantConclusion).toBe(
      "The latest turn capsule is now retrieved immediately.",
    );
    expect(capsule.importantObservationIds).toContain(result.observationId);

    const workingSet = await kv.get<any>(KV.workingSets, "session-1");
    expect(workingSet.latestCompletedTurnId).toBe("turn-2");
    expect(workingSet.latestCompletedCapsule.turnId).toBe("turn-2");
  });

  it("acks ephemeral pre-tool events without hot-path writes", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "pre_tool_use",
      sessionId: "session-ephemeral-pre-tool",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:01.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-pre-tool",
      persistenceClass: "ephemeral",
      capabilities: ["event_identity"],
      data: {
        session_id: "session-ephemeral-pre-tool",
        turn_id: "turn-pre-tool",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "toolu-pre",
        tool_input: { command: "true" },
      },
    })) as { persisted: boolean; skipped?: boolean; reason?: string };

    expect(result).toMatchObject({
      persisted: false,
      skipped: true,
      reason: "ephemeral_pre_tool_use",
    });
    expect(
      await kv.list<any>(KV.observations("session-ephemeral-pre-tool")),
    ).toHaveLength(0);
    expect(
      await kv.list<any>(KV.observeReceipts("session-ephemeral-pre-tool")),
    ).toHaveLength(0);
    expect(await kv.get<any>(KV.observePressure, "latest")).toBeNull();
  });

  it("bounds per-turn capsule signal arrays under repeated observe fanout", async () => {
    const previousLimit = process.env["AGENTMEMORY_TURN_CAPSULE_SIGNAL_LIMIT"];
    const restorePersistDerived = preserveEnv(
      "AGENTMEMORY_OBSERVE_PERSIST_DERIVED",
    );
    process.env["AGENTMEMORY_TURN_CAPSULE_SIGNAL_LIMIT"] = "3";
    process.env["AGENTMEMORY_OBSERVE_PERSIST_DERIVED"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerObserveFunction(sdk as never, kv as never);

      for (let index = 0; index < 8; index += 1) {
        await sdk.trigger("mem::observe", {
          hookType: "post_tool_use",
          sessionId: "session-1",
          project: "/project",
          cwd: "/project",
          timestamp: `2026-04-30T00:00:0${index}.000Z`,
          source: "codex-native",
          payloadVersion: "1",
          eventId: `evt-${index}`,
          persistenceClass: "persistent",
          capabilities: ["structured_post_tool_payload", "event_identity"],
          data: {
            session_id: "session-1",
            turn_id: "turn-oom",
            cwd: "/project",
            model: "gpt-5.4",
            tool_name: "Read",
            tool_use_id: `toolu-${index}`,
            tool_input: { file_path: `/project/src/file-${index}.ts` },
            tool_output: { output: `concept-${index} result` },
          },
        });
      }

      const capsule = await kv.get<any>(KV.turnCapsules, "session-1:turn-oom");

      expect(capsule.files.length).toBeLessThanOrEqual(3);
      expect(capsule.concepts.length).toBeLessThanOrEqual(3);
      expect(capsule.sourceObservationIds.length).toBeLessThanOrEqual(3);
    } finally {
      if (previousLimit === undefined) {
        delete process.env["AGENTMEMORY_TURN_CAPSULE_SIGNAL_LIMIT"];
      } else {
        process.env["AGENTMEMORY_TURN_CAPSULE_SIGNAL_LIMIT"] = previousLimit;
      }
      restorePersistDerived();
    }
  });

  it("rejects unknown hook families instead of storing them", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "unknown_hook",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      data: {},
    })) as { success: false; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported hookType");
    expect(await kv.list<any>(KV.observations("session-1"))).toHaveLength(0);
  });

  it("rejects unsupported native payload versions cleanly", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "post_tool_use",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      source: "codex-native",
      payloadVersion: "99",
      eventId: "evt-1",
      persistenceClass: "persistent",
      capabilities: ["structured_post_tool_payload"],
      data: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Read",
        tool_use_id: "toolu_1",
        tool_input: { file_path: "/project/src/observe.ts" },
        tool_output: { output: "ok" },
      },
    })) as { success: false; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported codex-native payloadVersion");
    expect(await kv.list<any>(KV.observations("session-1"))).toHaveLength(0);
  });

  it("uses native event ids for idempotent observe retries", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const payload = {
      hookType: "post_tool_use" as const,
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-2",
      persistenceClass: "persistent" as const,
      capabilities: ["structured_post_tool_payload", "event_identity"],
      data: {
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Read",
        tool_use_id: "toolu_2",
        tool_input: { file_path: "/project/src/observe.ts" },
        tool_output: { output: "ok" },
      },
    };

    const first = (await sdk.trigger("mem::observe", payload)) as {
      observationId: string;
    };
    const second = (await sdk.trigger("mem::observe", payload)) as {
      deduplicated: boolean;
      observationId: string;
    };

    const observations = await kv.list<any>(KV.observations("session-1"));
    expect(first.observationId).toBe(second.observationId);
    expect(second.deduplicated).toBe(true);
    expect(observations).toHaveLength(1);
    expect(observations[0].eventId).toBe("evt-2");
  });

  it("keeps diagnostics-only shutdown markers out of recall storage", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "stop",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:05.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-stop",
      persistenceClass: "diagnostics_only",
      capabilities: ["event_identity"],
      data: {
        session_id: "session-1",
        cwd: "/project",
      },
    })) as { observationId: string; persisted: boolean };

    expect(result.persisted).toBe(false);
    expect(await kv.list<any>(KV.observations("session-1"))).toHaveLength(0);
    expect(await kv.get<any>(KV.turnCapsules, "session-1:turn-1")).toBeNull();
    expect(
      await kv.get<any>(KV.observeReceipts("session-1"), "evt-stop"),
    ).toMatchObject({
      eventId: "evt-stop",
      observationId: result.observationId,
      persistenceClass: "diagnostics_only",
    });
  });

  it("keeps operator proof commands out of hot recall even when marked persistent", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "post_tool_use",
      sessionId: "session-1",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:06.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-proof",
      persistenceClass: "persistent",
      capabilities: ["structured_post_tool_payload", "event_identity"],
      data: {
        session_id: "session-1",
        turn_id: "turn-proof",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "toolu_proof",
        tool_input: {
          command: "curl -sS http://127.0.0.1:3113/agentmemory/retrieval-proof",
        },
        tool_output: { status: "ok" },
      },
    })) as {
      persisted: boolean;
      persistenceClass: string;
      observationId: string;
    };

    expect(result).toMatchObject({
      persisted: false,
      persistenceClass: "diagnostics_only",
    });
    expect(await kv.list<any>(KV.observations("session-1"))).toHaveLength(0);
    expect(await kv.list<any>(KV.retrievalBlocks)).toHaveLength(0);
    expect(await kv.list<any>(KV.retrievalBlockRetry)).toHaveLength(0);
    expect(
      await kv.get<any>(KV.observeReceipts("session-1"), "evt-proof"),
    ).toMatchObject({
      eventId: "evt-proof",
      observationId: result.observationId,
      persistenceClass: "diagnostics_only",
    });
  });

  it("stores normal persistent tool results without inline derived indexing by default", async () => {
    const previousAutoCompress = process.env["AGENTMEMORY_AUTO_COMPRESS"];
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerObserveFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-1",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:00:07.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-edit",
        persistenceClass: "persistent",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        data: {
          session_id: "session-1",
          turn_id: "turn-edit",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Edit",
          tool_use_id: "toolu_edit",
          tool_input: { file_path: "/project/src/app.ts" },
          tool_output: { changed_files: ["/project/src/app.ts"] },
        },
      })) as { persisted: boolean; persistenceClass: string };

      expect(result).toMatchObject({
        persisted: true,
        persistenceClass: "persistent",
      });
      expect(await kv.list<any>(KV.observations("session-1"))).toHaveLength(1);
      expect(await kv.list<any>(KV.retrievalBlocks)).toHaveLength(2);
    } finally {
      if (previousAutoCompress === undefined) {
        delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
      } else {
        process.env["AGENTMEMORY_AUTO_COMPRESS"] = previousAutoCompress;
      }
    }
  });

  it("stores compact synthetic observations by default for large observe payloads", async () => {
    const restoreStringLimit = preserveEnv(
      "AGENTMEMORY_OBSERVE_RAW_STRING_LIMIT",
    );
    const restoreArrayLimit = preserveEnv(
      "AGENTMEMORY_OBSERVE_RAW_ARRAY_LIMIT",
    );
    const restoreObjectLimit = preserveEnv(
      "AGENTMEMORY_OBSERVE_RAW_OBJECT_KEYS_LIMIT",
    );
    const restoreAutoCompress = preserveEnv("AGENTMEMORY_AUTO_COMPRESS");
    const restoreInlineCompress = preserveEnv(
      "AGENTMEMORY_OBSERVE_INLINE_COMPRESS",
    );
    const restorePersistRaw = preserveEnv("AGENTMEMORY_OBSERVE_PERSIST_RAW");
    process.env["AGENTMEMORY_OBSERVE_RAW_STRING_LIMIT"] = "64";
    process.env["AGENTMEMORY_OBSERVE_RAW_ARRAY_LIMIT"] = "3";
    process.env["AGENTMEMORY_OBSERVE_RAW_OBJECT_KEYS_LIMIT"] = "10";
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    process.env["AGENTMEMORY_OBSERVE_INLINE_COMPRESS"] = "false";
    delete process.env["AGENTMEMORY_OBSERVE_PERSIST_RAW"];

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerObserveFunction(sdk as never, kv as never);

      await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-large-raw",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:00:08.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-large-raw",
        persistenceClass: "persistent",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        data: {
          session_id: "session-large-raw",
          turn_id: "turn-large",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Bash",
          tool_use_id: "toolu_large",
          tool_input: { command: "npm test" },
          tool_output: {
            stdout: "x".repeat(500),
            changed_files: [
              "/project/src/a.ts",
              "/project/src/b.ts",
              "/project/src/c.ts",
              "/project/src/d.ts",
            ],
            status: "ok",
          },
        },
      });

      const observations = await kv.list<any>(
        KV.observations("session-large-raw"),
      );
      expect(observations).toHaveLength(1);
      expect(observations[0].raw).toBeUndefined();
      expect(observations[0].type).toBe("command_run");
      expect(observations[0].facts).toContain("status: ok");
      expect(observations[0].files).toContain("/project/src/a.ts");
      expect(observations[0].narrative.length).toBeLessThanOrEqual(400);
    } finally {
      restoreStringLimit();
      restoreArrayLimit();
      restoreObjectLimit();
      restoreAutoCompress();
      restoreInlineCompress();
      restorePersistRaw();
    }
  });

  it("stores synthetic derived observe work when retry queues are hot", async () => {
    const previousAutoCompress = process.env["AGENTMEMORY_AUTO_COMPRESS"];
    const previousQueueHigh =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"];
    const previousQueueCritical =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"] = "1";
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] = "99";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      await kv.set(KV.retrievalBlockRetry, "queued-block", {
        id: "queued-block",
      });
      registerObserveFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-pressure",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:01:00.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-pressure-edit",
        persistenceClass: "persistent",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        data: {
          session_id: "session-pressure",
          turn_id: "turn-pressure",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Edit",
          tool_use_id: "toolu_pressure",
          tool_input: { file_path: "/project/src/app.ts" },
          tool_output: { changed_files: ["/project/src/app.ts"] },
        },
      })) as {
        persisted: boolean;
        deferred?: boolean;
        reason?: string;
      };

      expect(result).toMatchObject({
        persisted: true,
        deferred: true,
        reason: "hot_path_backpressure",
      });
      const observations = await kv.list<any>(
        KV.observations("session-pressure"),
      );
      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe("file_edit");
      expect(observations[0].title).toBeTruthy();
      expect(await kv.list<any>(KV.retrievalBlocks)).toHaveLength(2);
      expect(await kv.list<any>(KV.compressRetry)).toHaveLength(0);
    } finally {
      if (previousAutoCompress === undefined) {
        delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
      } else {
        process.env["AGENTMEMORY_AUTO_COMPRESS"] = previousAutoCompress;
      }
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
      if (previousQueueCritical === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] =
          previousQueueCritical;
      }
    }
  });

  it("does not shed observations because of compression retry backlog alone", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"];
    const previousQueueCritical =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
    const previousIncludeCompression =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"];
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"] = "1";
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] = "1";
    delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"];

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      await kv.set(KV.compressRetry, "queued-compress", {
        obsId: "queued-compress",
      });
      registerObserveFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-compression-backlog",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:01:30.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-compression-backlog-stop",
        persistenceClass: "persistent",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        data: {
          session_id: "session-compression-backlog",
          turn_id: "turn-pressure",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Edit",
          tool_use_id: "toolu_compression_backlog",
          tool_input: { file_path: "/project/src/app.ts" },
          tool_output: { changed_files: ["/project/src/app.ts"] },
        },
      })) as {
        skipped?: boolean;
        persisted: boolean;
        reason?: string;
      };

      expect(result.skipped).toBeUndefined();
      expect(result.reason).toBeUndefined();
      expect(result.persisted).toBe(true);
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
      if (previousQueueCritical === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] =
          previousQueueCritical;
      }
      if (previousIncludeCompression === undefined) {
        delete process.env[
          "AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"
        ];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"] =
          previousIncludeCompression;
      }
    }
  });

  it("defers derived indexing for persistent observations under critical health", async () => {
    const previousAutoCompress = process.env["AGENTMEMORY_AUTO_COMPRESS"];
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      await kv.set(KV.health, "latest", {
        status: "critical",
        alerts: ["critical"],
      });
      registerObserveFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-critical-health",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:01:45.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-critical-health-edit",
        persistenceClass: "persistent",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        data: {
          session_id: "session-critical-health",
          turn_id: "turn-pressure",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Edit",
          tool_use_id: "toolu_critical_health",
          tool_input: { file_path: "/project/src/app.ts" },
          tool_output: { changed_files: ["/project/src/app.ts"] },
        },
      })) as {
        persisted: boolean;
        deferred?: boolean;
        reason?: string;
      };

      expect(result).toMatchObject({
        persisted: true,
        deferred: true,
        reason: "hot_path_backpressure",
      });
      expect(
        await kv.list<any>(KV.observations("session-critical-health")),
      ).toHaveLength(1);
      expect(await kv.list<any>(KV.retrievalBlockRetry)).toHaveLength(2);
      expect(await kv.list<any>(KV.retrievalBlocks)).toHaveLength(0);
    } finally {
      if (previousAutoCompress === undefined) {
        delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
      } else {
        process.env["AGENTMEMORY_AUTO_COMPRESS"] = previousAutoCompress;
      }
    }
  });

  it("sheds non-persistent observations under critical backpressure", async () => {
    const previousQueueHigh =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"];
    const previousQueueCritical =
      process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"] = "1";
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] = "1";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      await kv.set(KV.retrievalBlockRetry, "queued-block", {
        id: "queued-block",
      });
      registerObserveFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::observe", {
        hookType: "stop",
        sessionId: "session-pressure-shed",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:02:00.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-pressure-stop",
        persistenceClass: "ephemeral",
        capabilities: ["event_identity"],
        data: {
          session_id: "session-pressure-shed",
          turn_id: "turn-pressure",
          cwd: "/project",
          model: "gpt-5.4",
          last_assistant_message: "done",
        },
      })) as {
        skipped?: boolean;
        persisted: boolean;
        reason?: string;
      };

      expect(result).toMatchObject({
        skipped: true,
        persisted: false,
        reason: "hot_path_backpressure",
      });
      expect(
        await kv.list<any>(KV.observations("session-pressure-shed")),
      ).toHaveLength(0);
      expect(
        await kv.get<any>(
          KV.observeReceipts("session-pressure-shed"),
          "evt-pressure-stop",
        ),
      ).toMatchObject({
        eventId: "evt-pressure-stop",
        persistenceClass: "ephemeral",
      });
    } finally {
      if (previousQueueHigh === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH"] =
          previousQueueHigh;
      }
      if (previousQueueCritical === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL"] =
          previousQueueCritical;
      }
    }
  });

  it("skips observe immediately while cooldown is active", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.observePressureState, "latest", {
      status: "degraded",
      timeoutStreak: 2,
      degradedObserveCount: 2,
      acceptedObserveCount: 0,
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      lastShedReason: "StateKV state::set timed out after 5000ms",
      lastTransitionAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      hookType: "post_tool_use",
      sessionId: "session-cooldown",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-04-29T15:31:00.000Z",
      source: "codex-native",
      payloadVersion: "1",
      eventId: "evt-cooldown",
      persistenceClass: "persistent",
      capabilities: ["structured_post_tool_payload", "event_identity"],
      data: {
        session_id: "session-cooldown",
        turn_id: "turn-cooldown",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Edit",
        tool_use_id: "toolu_cooldown",
        tool_input: { file_path: "/project/src/app.ts" },
        tool_output: { changed_files: ["/project/src/app.ts"] },
      },
    })) as { persisted: boolean; skipped: boolean; reason: string };

    expect(result).toMatchObject({
      persisted: false,
      skipped: true,
      reason: "observe_pressure",
    });
    expect(
      await kv.list<any>(KV.observations("session-cooldown")),
    ).toHaveLength(0);
  });

  it("feeds synthetic compression signals back into the current turn capsule", async () => {
    const previousAutoCompress = process.env["AGENTMEMORY_AUTO_COMPRESS"];
    const previousInlineDerived =
      process.env["AGENTMEMORY_OBSERVE_INLINE_DERIVED"];
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    process.env["AGENTMEMORY_OBSERVE_INLINE_DERIVED"] = "true";

    const sdk = mockSdk();
    const kv = mockKV();
    try {
      registerObserveFunction(sdk as never, kv as never);

      await sdk.trigger("mem::observe", {
        hookType: "prompt_submit",
        sessionId: "session-1",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:00:00.000Z",
        data: {
          turn_id: "turn-3",
          prompt: "Tighten auth write path",
        },
      });

      await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-1",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:00:02.000Z",
        data: {
          turn_id: "turn-3",
          tool_name: "Edit",
          tool_input: {
            file_path: "/project/src/observe.ts",
            query: "auth write path",
          },
          tool_output: {
            changed_files: ["/project/src/auth.ts"],
            status: "ok",
          },
        },
      });

      const stored = await kv.list<any>(KV.observations("session-1"));
      const synthetic = stored.find(
        (observation) => observation.type === "file_edit",
      );
      expect(synthetic?.files).toContain("/project/src/auth.ts");
      expect(synthetic?.concepts).toContain("auth");
      expect(
        synthetic?.facts.some((fact: string) => fact.includes("status")),
      ).toBe(true);

      const capsule = await kv.get<any>(KV.turnCapsules, "session-1:turn-3");
      expect(capsule.files).toContain("/project/src/auth.ts");
      expect(capsule.concepts).toContain("auth");
      expect(capsule.maxImportance).toBeGreaterThanOrEqual(6);

      const workingSet = await kv.get<any>(KV.workingSets, "session-1");
      expect(workingSet.latestImportantFiles).toContain("/project/src/auth.ts");
    } finally {
      if (previousAutoCompress === undefined) {
        delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
      } else {
        process.env["AGENTMEMORY_AUTO_COMPRESS"] = previousAutoCompress;
      }
      if (previousInlineDerived === undefined) {
        delete process.env["AGENTMEMORY_OBSERVE_INLINE_DERIVED"];
      } else {
        process.env["AGENTMEMORY_OBSERVE_INLINE_DERIVED"] =
          previousInlineDerived;
      }
    }
  });

  it("fails fast when the required compact observe write exceeds the write budget", async () => {
    const restoreBudget = preserveEnv("AGENTMEMORY_OBSERVE_WRITE_BUDGET_MS");
    const restoreAutoCompress = preserveEnv("AGENTMEMORY_AUTO_COMPRESS");
    const restoreCooldown = preserveEnv("AGENTMEMORY_OBSERVE_COOLDOWN_MS");
    process.env["AGENTMEMORY_OBSERVE_WRITE_BUDGET_MS"] = "5";
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    process.env["AGENTMEMORY_OBSERVE_COOLDOWN_MS"] = "1";

    const sdk = mockSdk();
    const baseKv = mockKV();
    const kv = {
      ...baseKv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === KV.observations("session-slow")) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return baseKv.set(scope, key, data);
      },
    };
    try {
      registerObserveFunction(sdk as never, kv as never);

      const startedAt = Date.now();
      const result = (await sdk.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId: "session-slow",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:03:00.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-slow-write",
        persistenceClass: "persistent",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        data: {
          session_id: "session-slow",
          turn_id: "turn-slow",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Edit",
          tool_use_id: "toolu_slow",
          tool_input: { file_path: "/project/src/app.ts" },
          tool_output: { changed_files: ["/project/src/app.ts"] },
        },
      })) as {
        persisted: boolean;
        deferred?: boolean;
        reason?: string;
        pressure?: { reason?: string };
      };

      expect(Date.now() - startedAt).toBeLessThan(40);
      expect(result).toMatchObject({
        persisted: false,
        deferred: true,
        reason: "observe_pressure",
      });
      expect(result.pressure?.reason).toContain("synthetic_observation");
      expect(
        await baseKv.list<any>(KV.observations("session-slow")),
      ).toHaveLength(0);
      await baseKv.delete(KV.observePressureState, "latest");
    } finally {
      restoreBudget();
      restoreAutoCompress();
      restoreCooldown();
    }
  });

  it("returns write-pressure metadata when optional derived observe work times out", async () => {
    const restoreBudget = preserveEnv("AGENTMEMORY_OBSERVE_WRITE_BUDGET_MS");
    const restoreAutoCompress = preserveEnv("AGENTMEMORY_AUTO_COMPRESS");
    process.env["AGENTMEMORY_OBSERVE_WRITE_BUDGET_MS"] = "5";
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";

    const sdk = mockSdk();
    const baseKv = mockKV();
    const kv = {
      ...baseKv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === KV.turnCapsules) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return baseKv.set(scope, key, data);
      },
    };
    try {
      registerObserveFunction(sdk as never, kv as never);

      const result = (await sdk.trigger("mem::observe", {
        hookType: "assistant_result",
        sessionId: "session-derived-slow",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:03:30.000Z",
        source: "codex-native",
        payloadVersion: "1",
        eventId: "evt-derived-slow",
        persistenceClass: "persistent",
        capabilities: ["event_identity"],
        data: {
          session_id: "session-derived-slow",
          turn_id: "turn-derived-slow",
          cwd: "/project",
          model: "gpt-5.4",
          assistant_text: "done",
          is_final: true,
        },
      })) as {
        persisted: boolean;
        deferred?: boolean;
        reason?: string;
        pressure?: { reason?: string };
      };

      expect(result).toMatchObject({
        persisted: true,
      });
      expect(result.deferred).toBe(true);
      expect(result.reason).toBe("observe_write_pressure");
      expect(
        await baseKv.list<any>(KV.observations("session-derived-slow")),
      ).toHaveLength(1);
    } finally {
      restoreBudget();
      restoreAutoCompress();
    }
  });
});
