import { describe, expect, it } from "vitest";

import {
  evaluateCodexLiveRetrievalCase,
  evaluateCodexLiveRetrievalRuns,
  summarizeCodexLiveRetrievalSuite,
} from "../src/eval/codex-live-retrieval.js";

const okHttp = (body: unknown, latencyMs = 20) => ({
  ok: true,
  status: 200,
  latencyMs,
  body,
});

describe("Codex live retrieval eval", () => {
  it("scores relevance, freshness, leakage, latency, and non-empty context", () => {
    const result = evaluateCodexLiveRetrievalCase(
      {
        id: "recent-proof",
        project: "/repo/agentmemory",
        query: "retrieval proof status",
        requiredEvidenceIds: ["obs-proof"],
        requiredSubstrings: ["vector coverage"],
        freshnessSubstrings: ["current state"],
        staleSubstrings: ["old marker-smoke-only success"],
        forbiddenSubstrings: ["pmOrderUsd"],
        maxContextLatencyMs: 100,
        maxSmartSearchLatencyMs: 50,
      },
      {
        context: okHttp(
          {
            context:
              "Current state includes vector coverage and retrieval proof obs-proof.",
            items: [{ id: "obs-proof" }],
            trace: { fallback: "hot-warm-retrieval-blocks" },
          },
          80,
        ),
        smartSearch: okHttp(
          {
            results: [
              {
                id: "obs-proof",
                text: "retrieval proof current state vector coverage",
              },
            ],
            trace: { route: "smart-search" },
          },
          40,
        ),
      },
    );

    expect(result.passed).toBe(true);
    expect(result.relevancePass).toBe(true);
    expect(result.freshnessPass).toBe(true);
    expect(result.leakagePass).toBe(true);
    expect(result.latencyPass).toBe(true);
    expect(result.contextNonEmptyPass).toBe(true);
    expect(result.trace.context).toEqual({
      fallback: "hot-warm-retrieval-blocks",
    });
  });

  it("fails known-evidence cases that return empty context", () => {
    const result = evaluateCodexLiveRetrievalCase(
      {
        id: "empty-context",
        project: "/repo/agentmemory",
        query: "known evidence",
        requiredSubstrings: ["known evidence"],
      },
      {
        context: okHttp({ context: "", items: [] }),
        smartSearch: okHttp({
          results: [{ text: "known evidence from smart search" }],
        }),
      },
    );

    expect(result.contextNonEmptyPass).toBe(false);
    expect(result.failures).toContain("context_empty_for_known_evidence");
  });

  it("keeps latency as a warning unless explicitly required", () => {
    const caseResult = evaluateCodexLiveRetrievalCase(
      {
        id: "slow-but-relevant",
        project: "/repo/agentmemory",
        query: "retrieval proof",
        requiredSubstrings: ["retrieval proof"],
        maxContextLatencyMs: 10,
        maxSmartSearchLatencyMs: 10,
      },
      {
        context: okHttp({ context: "retrieval proof", items: [{}] }, 25),
        smartSearch: okHttp({ results: [{ text: "retrieval proof" }] }, 30),
      },
    );

    const advisory = summarizeCodexLiveRetrievalSuite([caseResult]);
    const enforced = summarizeCodexLiveRetrievalSuite([caseResult], {
      requireLatency: true,
    });

    expect(caseResult.latencyPass).toBe(false);
    expect(advisory.passed).toBe(true);
    expect(advisory.failures).toEqual([]);
    expect(enforced.passed).toBe(false);
    expect(enforced.failures).toEqual(["slow-but-relevant:latency"]);
  });

  it("supports the legacy run evaluator shape used by smoke tooling", () => {
    const result = evaluateCodexLiveRetrievalRuns([
      {
        evalCase: {
          id: "legacy",
          project: "/repo/agentmemory",
          query: "current retrieval quality",
          requiredSubstrings: ["retrieval quality"],
          freshnessRequiredSubstrings: ["current state"],
          forbiddenStaleSubstrings: ["stale branch"],
          forbiddenProjectSubstrings: ["BTC 5m"],
        },
        context: okHttp({
          context: "current state retrieval quality",
          items: [{ id: "obs-current" }],
        }),
        smartSearch: okHttp({
          results: [{ id: "obs-current", text: "retrieval quality current state" }],
        }),
      },
    ]);

    expect(result.pass).toBe(true);
    expect(result.relevance.requiredHits).toBe(1);
    expect(result.relevance.nonEmptyContextKnownEvidenceCases).toBe(1);
    expect(result.freshness.requiredHits).toBe(1);
    expect(result.leakage.forbiddenHits).toBe(0);
  });
});
