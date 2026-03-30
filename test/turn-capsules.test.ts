// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";
import type { CompressedObservation, RawObservation } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import {
  upsertTurnCapsuleFromCompressed,
  upsertTurnCapsuleFromRaw,
} from "../src/functions/turn-capsules.js";

describe("turn capsules", () => {
  it("captures prompt and final assistant conclusion from raw observations", async () => {
    const kv = mockKV();

    const prompt: RawObservation = {
      id: "obs-1",
      sessionId: "session-1",
      timestamp: "2026-03-28T00:00:00.000Z",
      hookType: "prompt_submit",
      turnId: "turn-1",
      userPrompt: "Fix retrieval freshness",
      raw: { turn_id: "turn-1" },
    };
    await upsertTurnCapsuleFromRaw(
      kv as never,
      "session-1",
      "/project",
      "/project",
      prompt,
    );

    const assistant: RawObservation = {
      id: "obs-2",
      sessionId: "session-1",
      timestamp: "2026-03-28T00:00:01.000Z",
      hookType: "assistant_result",
      turnId: "turn-1",
      assistantResponse: "Fresh recall now uses turn capsules.",
      raw: { turn_id: "turn-1", assistant_text: "Fresh recall now uses turn capsules." },
    };
    await upsertTurnCapsuleFromRaw(
      kv as never,
      "session-1",
      "/project",
      "/project",
      assistant,
    );

    const capsule = await kv.get<any>(KV.turnCapsules, "session-1:turn-1");
    expect(capsule.userPrompt).toBe("Fix retrieval freshness");
    expect(capsule.assistantConclusion).toBe(
      "Fresh recall now uses turn capsules.",
    );
    expect(capsule.sourceObservationIds).toEqual(["obs-1", "obs-2"]);
    expect(capsule.importantObservationIds).toEqual(["obs-2"]);
  });

  it("merges files, concepts, and signal flags from compressed observations", async () => {
    const kv = mockKV();

    const prompt: RawObservation = {
      id: "obs-1",
      sessionId: "session-1",
      timestamp: "2026-03-28T00:00:00.000Z",
      hookType: "prompt_submit",
      turnId: "turn-1",
      userPrompt: "Investigate failures",
      raw: { turn_id: "turn-1" },
    };
    await upsertTurnCapsuleFromRaw(
      kv as never,
      "session-1",
      "/project",
      "/project",
      prompt,
    );

    const compressed: CompressedObservation = {
      id: "obs-2",
      sessionId: "session-1",
      timestamp: "2026-03-28T00:00:01.000Z",
      turnId: "turn-1",
      type: "error",
      title: "Graph build failed",
      facts: [],
      narrative: "The graph build timed out.",
      concepts: ["graph build"],
      files: ["/project/src/triggers/api.ts"],
      importance: 8,
    };
    await upsertTurnCapsuleFromCompressed(kv as never, compressed);

    const capsule = await kv.get<any>(KV.turnCapsules, "session-1:turn-1");
    expect(capsule.files).toEqual(["/project/src/triggers/api.ts"]);
    expect(capsule.concepts).toEqual(["graph build"]);
    expect(capsule.hadFailure).toBe(true);
    expect(capsule.maxImportance).toBe(8);
    expect(capsule.importantObservationIds).toEqual(["obs-2"]);
  });
});
