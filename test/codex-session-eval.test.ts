import { describe, expect, it } from "vitest";
import { loadFixtures, runMockEval } from "../benchmark/codex-session-eval.js";

describe("Codex session replay eval", () => {
  it("loads the seven required fixture categories", () => {
    const fixtures = loadFixtures();
    expect(fixtures).toHaveLength(7);
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "same-repo-continuation",
      "stale-decision-replacement",
      "cross-session-implementation-trail",
      "stop-then-resume",
      "noisy-tool-stream",
      "negative-recall",
      "budget-pressure",
    ]);
  });

  it("passes mock mode without a live service", async () => {
    const results = await runMockEval();
    expect(results.passed).toBe(true);
    expect(results.metrics.fixtureCount).toBe(7);
    expect(results.metrics.requiredFactRecallAtContext).toBeGreaterThanOrEqual(0.85);
    expect(results.metrics.forbiddenFactLeakRate).toBeLessThanOrEqual(0.05);
    expect(results.metrics.sessionStateCorrectness).toBe(1);
    expect(results.metrics.hookContractCorrectness).toBe(1);
    expect(results.metrics.disabledInjectionNoOutput).toBe(true);
  }, 30000);
});
