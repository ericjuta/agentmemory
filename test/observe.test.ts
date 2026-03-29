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
      data: {
        turn_id: "turn-2",
        last_assistant_message:
          "The latest turn capsule is now retrieved immediately.",
      },
    })) as { observationId: string };

    const observations = await kv.list<any>(KV.observations("session-1"));
    expect(observations).toHaveLength(2);
    expect(observations[1].turnId).toBe("turn-2");
    expect(observations[1].assistantResponse).toBe(
      "The latest turn capsule is now retrieved immediately.",
    );

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
});
