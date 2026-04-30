// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";

import { createAdaptiveTimer } from "../src/state/adaptive-timer.js";

describe("createAdaptiveTimer", () => {
  it("honors explicit interval from pressure-aware maintenance results", async () => {
    const handle = createAdaptiveTimer(
      async () => ({ workDone: 5, nextIntervalMs: 120_000 }),
      {
        baseMs: 60_000,
        minMs: 30_000,
        maxMs: 300_000,
        label: "test maintenance",
      },
    );

    await handle.tickForTest?.();
    handle.stop();

    expect(handle.currentInterval()).toBe(120_000);
  });
});
