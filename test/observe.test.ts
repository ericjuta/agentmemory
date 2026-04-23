// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

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

  it("feeds synthetic compression signals back into the current turn capsule", async () => {
    const previousAutoCompress = process.env["AGENTMEMORY_AUTO_COMPRESS"];
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";

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
      const synthetic = stored.find((observation) => observation.type === "file_edit");
      expect(synthetic?.files).toContain("/project/src/auth.ts");
      expect(synthetic?.concepts).toContain("auth");
      expect(synthetic?.facts.some((fact: string) => fact.includes("status"))).toBe(true);

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
    }
  });
});
