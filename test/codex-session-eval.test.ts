import { describe, expect, it } from "vitest";
import { loadFixtures, markdownSummary, runMockEval, type CodexSessionEvalFixture } from "../benchmark/codex-session-eval.js";

describe("Codex session replay eval", () => {
  it("loads the expanded fixture categories", () => {
    const fixtures = loadFixtures();
    expect(fixtures).toHaveLength(20);
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "same-repo-continuation",
      "stale-decision-replacement",
      "cross-session-implementation-trail",
      "stop-then-resume",
      "noisy-tool-stream",
      "negative-recall",
      "budget-pressure",
      "multi-repo-project-identity",
      "long-session-selective-survival",
      "fresh-session-handoff",
      "branch-worktree-isolation",
      "prompt-only-user-decision",
      "failed-tool-correction",
      "secret-redaction-boundary",
      "subagent-ownership",
      "runtime-vs-repo-boundary",
      "user-correction-over-agent-assumption",
      "test-diagnosis-regression",
      "generated-artifact-handoff",
      "no-op-no-reply-contract",
    ]);
    expect(new Set(fixtures.map((fixture) => fixture.category)).size).toBe(20);
  });

  it("passes mock mode without a live service", async () => {
    const results = await runMockEval();
    expect(results.passed).toBe(true);
    expect(results.metrics.fixtureCount).toBe(20);
    expect(results.metrics.requiredFactRecallAtContext).toBeGreaterThanOrEqual(0.85);
    expect(results.metrics.forbiddenFactLeakRate).toBeLessThanOrEqual(0.05);
    expect(results.metrics.sessionStateCorrectness).toBe(1);
    expect(results.metrics.hookContractCorrectness).toBe(1);
    expect(results.metrics.disabledInjectionNoOutput).toBe(true);
  }, 30000);

  it("uses gold labels only for grading, not mock candidate selection", async () => {
    const fixture: CodexSessionEvalFixture = {
      id: "label-isolation",
      category: "Label isolation",
      project: "/tmp/agentmemory-codex-eval/label-isolation",
      priorSessions: [{
        sessionId: "prior_label_isolation",
        events: [
          {
            hook: "PostToolUse",
            timestamp: "2026-01-01T00:00:00.000Z",
            observationId: "labeled_only",
            payload: {
              tool_name: "Edit",
              tool_input: { file_path: "docs/noise.md" },
              tool_response: { output: "query target stale forbidden distractor" },
            },
          },
          {
            hook: "PostToolUse",
            timestamp: "2026-01-01T00:00:01.000Z",
            observationId: "relevant_by_query",
            payload: {
              tool_name: "Edit",
              tool_input: { file_path: "src/target.ts" },
              tool_response: { output: "query target required fact" },
            },
          },
        ],
      }],
      currentSession: {
        sessionId: "current_label_isolation",
        events: [{
          hook: "UserPromptSubmit",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: { prompt: "query target required src/target.ts" },
        }],
      },
      gold: {
        requiredFacts: ["query target required fact"],
        forbiddenFacts: ["query target stale forbidden distractor"],
        goldObservationIds: ["labeled_only"],
        expectedSessionStatus: "active",
      },
      budgets: {
        contextTokens: 80,
        hookP95Ms: 1500,
      },
    };

    const results = await runMockEval([fixture]);
    const [result] = results.fixtures;
    expect(result.selectedObservationIds).toContain("relevant_by_query");
    expect(result.selectedObservationIds).not.toContain("labeled_only");
    expect(result.candidateSelectionTrace.map((candidate) => candidate.id)).toContain("labeled_only");
    expect(result.leakedForbiddenFacts).toEqual([]);
    expect(markdownSummary(results)).toContain(
      "- label-isolation: fact_recall_from_context is 1.000 but source_recall is 0.000 below 0.85",
    );
  }, 30000);
});
