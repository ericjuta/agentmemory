import { describe, expect, it } from "vitest";
import { loadFixtures, markdownSummary, runMockEval, type CodexSessionEvalFixture } from "../benchmark/codex-session-eval.js";

function fixtureById(fixtures: CodexSessionEvalFixture[], id: string): CodexSessionEvalFixture {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  expect(fixture).toBeDefined();
  return fixture!;
}

function sourceRecallWarningFixture(): CodexSessionEvalFixture {
  return {
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
}

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

  it("keeps the requested Codex failure modes represented structurally", () => {
    const fixtures = loadFixtures();

    const multiRepo = fixtureById(fixtures, "multi-repo-project-identity");
    const multiRepoEvents = [...multiRepo.priorSessions.flatMap((session) => session.events), ...multiRepo.currentSession.events];
    const nestedApiCwd = multiRepoEvents.find((event) => event.hook === "SessionStart")?.payload.cwd;
    const neighborCwd = multiRepoEvents.find((event) => event.observationId === "multirepo_neighbor")?.payload.cwd;
    expect(multiRepo.project).toBe("/tmp/agentmemory-codex-eval/mono/packages/api");
    expect(nestedApiCwd).toBe("/tmp/agentmemory-codex-eval/mono/packages/api/src/routes");
    expect(String(nestedApiCwd)).toContain(multiRepo.project + "/");
    expect(neighborCwd).toBe("/tmp/agentmemory-codex-eval/mono/packages/web");
    expect(multiRepo.currentSession.events.some((event) => (
      event.hook === "SessionStart"
      && typeof event.payload.cwd === "string"
      && event.payload.cwd.startsWith(multiRepo.project + "/")
    ))).toBe(true);

    const longSession = fixtureById(fixtures, "long-session-selective-survival");
    const longEvents = longSession.priorSessions.flatMap((session) => session.events);
    expect(longEvents).toHaveLength(21);
    expect([...longEvents, ...longSession.currentSession.events]).toHaveLength(22);
    expect(longEvents.filter((event) => event.hook === "PostToolUse")).toHaveLength(21);

    const handoff = fixtureById(fixtures, "fresh-session-handoff");
    expect(handoff.priorSessions.flatMap((session) => session.events).some((event) => event.hook === "SessionEnd")).toBe(true);
    expect(handoff.currentSession.events.map((event) => event.hook)).toEqual(["SessionStart", "UserPromptSubmit"]);

    const worktree = fixtureById(fixtures, "branch-worktree-isolation");
    const worktreeNeighbor = worktree.priorSessions.flatMap((session) => session.events).find((event) => event.observationId === "worktree_neighbor");
    expect(worktreeNeighbor?.payload.cwd).toBe("/tmp/agentmemory-codex-eval/worktrees/feature-b");
    expect(worktree.gold.forbiddenFacts).toContain("feature-b switches src/payments/gateway.ts to sandbox card gateway");

    const promptOnly = fixtureById(fixtures, "prompt-only-user-decision");
    expect(promptOnly.priorSessions.flatMap((session) => session.events).every((event) => event.hook === "UserPromptSubmit")).toBe(true);
    expect(promptOnly.gold.requiredFacts[0]).toContain("User decision:");

    const failedTool = fixtureById(fixtures, "failed-tool-correction");
    const failedToolIds = failedTool.priorSessions.flatMap((session) => session.events).map((event) => event.observationId);
    expect(failedToolIds).toEqual(["failed_tool_initial", "failed_tool_fixed"]);
    expect(failedTool.gold.requiredFacts[0]).toContain("now passes");
    expect(failedTool.gold.forbiddenFacts[0]).toContain("still failing");
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
    for (const fixtureId of [
      "multi-repo-project-identity",
      "long-session-selective-survival",
      "fresh-session-handoff",
      "branch-worktree-isolation",
      "prompt-only-user-decision",
      "failed-tool-correction",
    ]) {
      const result = results.fixtures.find((fixture) => fixture.fixtureId === fixtureId);
      expect(result?.goldObservationRecallAtK).toBe(1);
      expect(result?.leakedForbiddenFacts).toEqual([]);
    }
  }, 30000);

  it("uses gold labels only for grading, not mock candidate selection", async () => {
    const fixture = sourceRecallWarningFixture();

    const results = await runMockEval([fixture]);
    const [result] = results.fixtures;
    expect(result.selectedObservationIds).toContain("relevant_by_query");
    expect(result.selectedObservationIds).not.toContain("labeled_only");
    expect(result.candidateSelectionTrace.map((candidate) => candidate.id)).toContain("labeled_only");
    expect(result.leakedForbiddenFacts).toEqual([]);
    expect(results.passed).toBe(true);
    expect(results.warnings).toHaveLength(1);
    expect(results.warnings[0]).toMatchObject({
      fixtureId: "label-isolation",
      factRecall: 1,
      sourceRecall: 0,
      threshold: 0.85,
      goldObservationIds: ["labeled_only"],
    });
    expect(results.warnings[0].selectedObservationIds).toContain("relevant_by_query");
    expect(results.warnings[0].selectedObservationIds).not.toContain("labeled_only");
    expect(markdownSummary(results)).toContain(
      "- label-isolation: fact_recall_from_context is 1.000 but source_recall is 0.000 below 0.85",
    );
  }, 30000);

  it("can make source-recall warnings fatal through an explicit policy", async () => {
    const results = await runMockEval([sourceRecallWarningFixture()], "mock", undefined, true, {
      maxSourceRecallWarnings: 0,
      minAverageGoldObservationRecallAtK: 0.5,
    });

    expect(results.passed).toBe(false);
    expect(results.warningPolicy.passed).toBe(false);
    expect(results.gates.sourceRecallWarningCount).toBe(false);
    expect(results.gates.goldObservationRecallAtK).toBe(false);
    expect(results.warningPolicy.failures).toEqual([
      "source_recall_warning_count 1 exceeds max 0",
      "gold_observation_recall@k 0.000 is below min 0.500",
    ]);
    expect(markdownSummary(results)).toContain("- source_recall_warning_count 1 exceeds max 0");
  }, 30000);
});
