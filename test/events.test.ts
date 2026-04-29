import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>(
    "../src/config.js",
  );
  return {
    ...actual,
    isGraphExtractionEnabled: vi.fn(() => false),
  };
});

vi.mock("../src/functions/branch-utils.js", () => ({
  detectWorktreeInfo: vi.fn(async () => ({ branch: "main" })),
}));

import { isGraphExtractionEnabled } from "../src/config.js";

describe("event triggers", () => {
  beforeEach(() => {
    vi.mocked(isGraphExtractionEnabled).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fires graph extraction at session stop when enabled", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    vi.mocked(isGraphExtractionEnabled).mockReturnValue(true);
    await kv.set(KV.observations("session_1"), "obs_1", {
      id: "obs_1",
      sessionId: "session_1",
      title: "Implemented auth",
    });

    await sdk.trigger("event::session::stopped", { sessionId: "session_1" });

    expect(sdk.triggerVoid).toHaveBeenCalledWith("mem::graph-extract", {
      observations: [
        expect.objectContaining({
          id: "obs_1",
          title: "Implemented auth",
        }),
      ],
    });
  });

  it("skips graph extraction at session stop when disabled", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerEventTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::summarize", async () => ({ success: true }));
    await kv.set(KV.observations("session_1"), "obs_1", {
      id: "obs_1",
      sessionId: "session_1",
      title: "Implemented auth",
    });

    await sdk.trigger("event::session::stopped", { sessionId: "session_1" });

    expect(sdk.triggerVoid).not.toHaveBeenCalled();
  });
});
