import { describe, expect, it } from "vitest";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("api::observe native contract", () => {
  it("maps native snake_case metadata into mem::observe", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::observe", {
      body: {
        hookType: "post_tool_use",
        sessionId: "session-1",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:00:01.000Z",
        source: "codex-native",
        payload_version: "1",
        event_id: "evt-post-tool-1",
        source_timestamp: "2026-03-29T12:00:00.500Z",
        capabilities: ["structured_post_tool_payload", "event_identity"],
        persistence_class: "persistent",
        data: {
          session_id: "session-1",
          turn_id: "turn-1",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Read",
          tool_use_id: "toolu_1",
          tool_input: { file_path: "/project/src/index.ts" },
          tool_output: { output: "ok" },
        },
      },
      headers: {},
    })) as { status_code: number; body: { observationId: string } };

    expect(response.status_code).toBe(201);

    const observations = await kv.list<any>(KV.observations("session-1"));
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe("codex-native");
    expect(observations[0].payloadVersion).toBe("1");
    expect(observations[0].eventId).toBe("evt-post-tool-1");
    expect(observations[0].persistenceClass).toBe("persistent");
    expect(observations[0].sourceTimestamp).toBe("2026-03-29T12:00:00.500Z");
  });

  it("returns 400 for unsupported native payload versions", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::observe", {
      body: {
        hookType: "post_tool_use",
        sessionId: "session-1",
        project: "/project",
        cwd: "/project",
        timestamp: "2026-03-29T12:00:01.000Z",
        source: "codex-native",
        payload_version: "99",
        event_id: "evt-post-tool-2",
        persistence_class: "persistent",
        data: {
          session_id: "session-1",
          turn_id: "turn-1",
          cwd: "/project",
          model: "gpt-5.4",
          tool_name: "Read",
          tool_use_id: "toolu_2",
          tool_input: { file_path: "/project/src/index.ts" },
          tool_output: { output: "ok" },
        },
      },
      headers: {},
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("Unsupported codex-native payloadVersion");
  });
});
