import { describe, expect, it } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Codex payload compatibility", () => {
  it("accepts Codex-style lifecycle payloads and returns the completed turn immediately", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerContextFunction(sdk as never, kv as never, 900);

    await kv.set(KV.sessions, "session-codex", {
      id: "session-codex",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T12:00:00.000Z",
      status: "active",
      observationCount: 0,
    });

    await sdk.trigger("mem::observe", {
      hookType: "prompt_submit",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:00.000Z",
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        prompt: "Audit current Codex memory integration",
      },
    });

    await sdk.trigger("mem::observe", {
      hookType: "post_tool_use",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:01.000Z",
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        tool_name: "Bash",
        tool_use_id: "toolu_123",
        tool_input: {
          file_path: "/project/src/agentmemory.ts",
          query: "agentmemory integration",
        },
        tool_output: {
          status: "ok",
        },
      },
    });

    await sdk.trigger("mem::observe", {
      hookType: "assistant_result",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:02.000Z",
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        assistant_text: "Codex integration is active and session-backed.",
        is_final: true,
      },
    });

    await sdk.trigger("mem::observe", {
      hookType: "stop",
      sessionId: "session-codex",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-03-29T12:00:03.000Z",
      data: {
        session_id: "session-codex",
        turn_id: "turn-codex-1",
        cwd: "/project",
        model: "gpt-5.4",
        last_assistant_message:
          "Codex integration is active and session-backed.",
      },
    });

    const capsule = await kv.get<any>(
      KV.turnCapsules,
      "session-codex:turn-codex-1",
    );
    expect(capsule.userPrompt).toBe("Audit current Codex memory integration");
    expect(capsule.assistantConclusion).toBe(
      "Codex integration is active and session-backed.",
    );
    expect(capsule.files).toContain("/project/src/agentmemory.ts");
    expect(capsule.concepts).toContain("agentmemory integration");

    const workingSet = await kv.get<any>(KV.workingSets, "session-codex");
    expect(workingSet.latestCompletedTurnId).toBe("turn-codex-1");
    expect(workingSet.latestCompletedCapsule.turnId).toBe("turn-codex-1");

    const result = (await sdk.trigger("mem::context", {
      sessionId: "session-codex",
      project: "/project",
      budget: 900,
    })) as { context: string };

    expect(result.context).toContain("Audit current Codex memory integration");
    expect(result.context).toContain(
      "Codex integration is active and session-backed.",
    );
  });
});
