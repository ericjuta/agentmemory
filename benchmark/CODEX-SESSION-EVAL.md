# Codex Session Integration Eval Spec

## Current Status

Codex session integration is reliable at the transport and lifecycle-contract layer, but eval quality is still only medium. The repo proves that hooks do not break Codex, that payloads reach the expected REST endpoints, and that closeout avoids the recent stop/reactivation failure mode. It does not yet prove that injected memory context is the right context for realistic Codex work.

Live status captured on 2026-05-04:

- agentmemory service: healthy on `/agentmemory/health`
- context injection: enabled by `/agentmemory/config/flags`
- hook diagnostics: 2,219 successful Codex wrapper attempts, 0 failures, 0 timeouts
- focused regression tests: 44/44 passing across context injection, closeout, hook diagnostics, and eval schema/quality tests
- live function metrics still show summarization failures historically: `mem::summarize` 1,886 successes / 2,369 total calls

Current relevant coverage:

- `test/context-injection.test.ts`: Codex hook subprocess behavior, disabled/no-output safety, enabled `additionalContext`, env-file loading, live env precedence, prompt capture, post-tool payload shape, stop semantics, and session-end summarize behavior.
- `test/session-closeout.test.ts`: manual closeout, idle-after-stop sweep, and post-stop activity reactivation.
- `test/hook-diagnostics.test.ts`: hook attempt aggregation, timeout/failure counters, and filtering.
- `test/eval.test.ts`: schema validation and heuristic scoring primitives.
- `test/integration.test.ts`: basic live API health, session lifecycle, observation capture, search, context, viewer, dashboard endpoints, and auth.
- `benchmark/longmemeval-bench.ts`: retrieval-only benchmark for long-term memory recall, not Codex lifecycle integration.

## Problem

The current test suite answers:

- Does Codex call the right scripts?
- Do scripts swallow backend errors?
- Does context injection emit valid Codex hook JSON when enabled?
- Do observations and stop/closeout semantics preserve session state?

It does not answer:

- Did the injected context contain the right prior decisions, files, commands, and pitfalls for a real Codex task?
- Did stale or unrelated memories stay out of the injected context?
- Did stop, fresh prompt, and post-stop activity preserve one logical session correctly?
- Did retrieval quality hold when observations are noisy, compressed, summarized, or split across several turns?
- Did latency and context size stay inside operational budgets while hooks ran under real subprocess conditions?

## Goal

Add a Codex-specific replay eval that grades end-to-end session memory behavior from hook event stream to injected context. The eval should run locally without touching the live user database by default, seed an isolated iii/state workspace, replay deterministic Codex-like events, and score both contract correctness and memory usefulness.

This should complement LongMemEval. LongMemEval measures generic long-term retrieval recall. This eval measures whether Codex session integration captures, recalls, and injects the right coding-agent context at the right lifecycle point.

## Non-Goals

- Do not replace unit tests for hook scripts or session-closeout internals.
- Do not require live user memory data for default CI/local runs.
- Do not add a second state implementation outside iii-engine/StateModule.
- Do not judge final assistant answer quality in the first version; grade the memory context provided to Codex.
- Do not make context injection default-on for users as part of this spec.

## Proposed Harness

Add a replay benchmark under `benchmark/codex-session-eval.ts` with fixture data under `benchmark/data/codex-session-eval/`.

Each fixture defines:

- prior sessions: ordered Codex hook events and expected durable facts
- current session: startup prompt, prompt-submit turns, tool events, stop events, and optional continuation after stop
- queries: expected context requests at `SessionStart` and `UserPromptSubmit`
- gold labels: relevant observation IDs, required phrases/facts, forbidden stale facts, expected session status transitions, and max budgets

Run modes:

- `mock`: in-memory mocked sdk/kv for fast deterministic CI-style checks
- `local-service`: isolated temporary data dir and iii-engine/agentmemory process for real REST/hook subprocess checks
- `live-readonly`: optional diagnostic mode against the current service that records scores without mutating state

The first implementation can start with `mock` plus hook subprocess calls, then add `local-service` once the fixture schema is stable.

## Fixture Categories

1. Same-repo continuation

   Prior session edits a specific file, makes a decision, runs a command, and hits a blocker. New prompt asks to continue. Expected context includes the file, decision, command result, and blocker.

2. Stale decision replacement

   Earlier session chooses approach A; later session explicitly replaces it with approach B. Expected context prefers B and either omits A or marks it stale.

3. Cross-session implementation trail

   Three sessions each touch part of a feature. New prompt asks for current state. Expected context recalls the latest status across all three without overloading unrelated details.

4. Stop then resume

   A Stop event arrives, then a later prompt/tool event arrives before idle closeout eligibility. Expected result: session remains active, closeout metadata is cleared or skipped, and context sees the continuation.

5. Noisy tool stream

   Many searches, file reads, and failed commands surround one important decision. Expected context recalls the decision and important file, not the noise.

6. Negative recall

   Similar project names or neighboring repos contain tempting but wrong facts. Expected context excludes unrelated repo/session facts.

7. Budget pressure

   Large prior session with many observations. Expected context fits the configured budget and retains top required facts.

## Metrics

Primary metrics:

- `required_fact_recall@context`: fraction of gold required facts present in injected context.
- `forbidden_fact_leak_rate`: fraction of forbidden stale/unrelated facts present.
- `gold_observation_recall@k`: whether gold observations appear in the retrieval set before rendering.
- `context_precision_proxy`: required fact count divided by total extracted factual claims from context, using deterministic labels where possible.
- `session_state_correctness`: pass/fail for active/completed/closeout status transitions.
- `hook_contract_correctness`: pass/fail for exit code, stdout shape, endpoint sequence, and no-output safety when injection is disabled.

Operational metrics:

- hook wall time p50/p95/max
- context bytes and estimated tokens
- observations captured per fixture
- summarization/compression failures
- backend health before and after run

Recommended first gates:

- 100% hook contract correctness
- 100% session state correctness
- >= 0.85 required fact recall across fixtures
- <= 0.05 forbidden fact leak rate
- p95 hook subprocess wall time <= 1,500 ms in mock mode
- generated context <= requested budget plus a small renderer overhead allowance

## Fixture Schema

```json
{
  "id": "same-repo-continuation",
  "project": "/tmp/agentmemory-fixture",
  "priorSessions": [
    {
      "sessionId": "fixture_prior_1",
      "events": [
        {
          "hook": "UserPromptSubmit",
          "timestamp": "2026-05-04T00:00:00.000Z",
          "payload": { "prompt": "fix auth timeout" }
        },
        {
          "hook": "PostToolUse",
          "timestamp": "2026-05-04T00:01:00.000Z",
          "payload": {
            "tool_name": "Edit",
            "tool_input": { "file_path": "src/auth.ts" },
            "tool_response": { "output": "added AbortSignal.timeout" }
          }
        }
      ]
    }
  ],
  "currentSession": {
    "sessionId": "fixture_current_1",
    "events": [
      {
        "hook": "SessionStart",
        "timestamp": "2026-05-04T01:00:00.000Z",
        "payload": { "cwd": "/tmp/agentmemory-fixture" }
      }
    ]
  },
  "gold": {
    "requiredFacts": [
      "src/auth.ts uses AbortSignal.timeout for auth timeout handling"
    ],
    "forbiddenFacts": [
      "auth timeout was left unfixed"
    ],
    "goldObservationIds": [],
    "expectedSessionStatus": "active"
  },
  "budgets": {
    "contextTokens": 1200,
    "hookP95Ms": 1500
  }
}
```

The real fixture files should avoid secrets and raw private user content. Use synthetic but coding-realistic events.

## Implementation Plan

1. Add fixture loader and JSON schema validation.

   Keep fixture parsing independent from live state. Fail fast on malformed fixtures, missing gold labels, or ambiguous timestamps.

2. Add mock-mode runner.

   Reuse existing hook scripts where possible by spawning `plugin/scripts/codex-env-wrapper.mjs` against a local HTTP test server. Use existing function registrations and mocked kv/sdk for direct state assertions.

3. Add context grader.

   Start with deterministic string/regex labels for required and forbidden facts. Do not introduce an LLM judge until deterministic labels are insufficient.

4. Add retrieval tap.

   Expose or instrument the observation IDs selected before context rendering so `gold_observation_recall@k` can be measured separately from renderer phrasing.

5. Add local-service mode.

   Start an isolated agentmemory process with a temporary data dir, replay events through REST/hook subprocesses, query health and diagnostics, then shut it down.

6. Add package script and result artifact.

   Recommended scripts:

   - `npm run eval:codex-session` for mock mode
   - `npm run eval:codex-session:service` for local-service mode

   Write JSON results to `benchmark/data/codex_session_eval_results.json` and a markdown summary to `benchmark/CODEX-SESSION-EVAL-RESULTS.md`.

7. Wire into release confidence.

   Treat mock-mode pass as required before changing Codex hooks, session lifecycle, context rendering, or retrieval ranking. Treat local-service mode as required before claiming live integration quality improved.

## Acceptance Criteria

The first useful version is done when:

- at least 7 fixture categories above are represented
- mock mode runs without a live service
- results include contract, state, relevance, leakage, budget, and latency metrics
- a failing fixture prints the missing required facts and leaked forbidden facts
- the focused existing tests still pass
- the benchmark docs state clearly that this is Codex integration/context quality, not generic LongMemEval QA

## Current Risk Readout

Current risk is low for hook transport and session state regression, medium for context relevance, and medium-high for stale/noisy recall under long real Codex sessions. The next improvement should be measurement, not more lifecycle code, because live diagnostics already show the wrapper path is stable while the unmeasured surface is memory usefulness.

## Post-Implementation Future Work

Status after the first release-quality implementation:

- mock mode no longer uses gold labels during candidate selection.
- local-service mode starts an isolated iii-engine plus agentmemory worker, replays real hook subprocesses, checks auth/health readiness, tolerates host CPU-only health alerts during startup, waits for replayed observations, and grades context from REST output.
- The expanded 20-fixture set passes in both modes with 100% required fact recall and 0% forbidden fact leakage.
- Markdown output now warns when context fact recall is perfect but source recall is low, so summary/rendering wins do not hide retrieval drift.

What is left is mostly operational polish, not a blocker for the current Codex-session gate. The next hardening step should turn the current warning signals into explicit release policy.

### 1. Expand Fixture Breadth

Completed coverage now includes:

- multi-repo monorepo tasks where cwd, package root, and sibling package identity differ
- long sessions with 20+ tool events where only a few observations should survive budget pressure
- fresh-session handoff where a closed prior thread should still produce useful summary context
- branch/worktree-specific decisions that should not leak across sibling worktrees
- prompt-only memory where no tool output exists but the user decision matters
- failed-tool correction sequences where the final successful command supersedes earlier errors
- secret-redaction boundaries, subagent ownership, runtime-vs-repo boundaries, user corrections, test diagnosis, generated handoff artifacts, and no-op `NO_REPLY` contracts

Acceptance: at least 20 fixtures, with every new fixture proving one distinct failure mode instead of only adding volume.

### 2. Stabilize Cold-Start Runtime Gates

The live service can take longer than the current reload script expects to expose the worker-manager socket, even though it becomes healthy shortly after. The eval harness now warms hook subprocesses, but the live reload path should also distinguish slow startup from failed startup.

Status: `npm run agentmemory:reload` now delegates to `scripts/agentmemory-reload.mjs`, which waits for `/agentmemory/livez`, authenticated `/agentmemory/health` when `AGENTMEMORY_SECRET` is configured, and the reported worker-manager `connectionState === "connected"` before printing a success marker. On timeout it prints the recent startup log tail instead of leaving the early ECONNREFUSED as the only visible state.

Acceptance:

- npm run agentmemory:reload waits on /agentmemory/health and connected worker state, not only early /livez.
- startup logs do not leave alarming transient ECONNREFUSED 49134 lines as the final visible state without a later connected marker.
- reload does not expose a false negative when iii takes 30-60 seconds to finish worker-manager startup.

### 3. Add Live-Readonly Diagnostic Mode

A live-readonly mode remains useful, but it should not be a release gate. It should score current live retrieval/context health without mutating user memory.

Acceptance:

- no session creation, observation writes, compression, summaries, or access tracking side effects
- reads /agentmemory/health, context-like debug surfaces, and existing diagnostics only
- reports current recall/leak signals against sampled synthetic queries or explicitly supplied session IDs

### 4. Track Retrieval Drift Separately From Rendering

gold_observation_recall@k is now measurable, but context rendering can still pass if adjacent summaries contain the same phrase while the intended observation was not selected. That is useful but should be visible.

Current local-service result: 20 fixtures pass with 100% fact recall and 0% forbidden leakage, while `stop-then-resume` and `budget-pressure` warn because fact recall is perfect but source recall is 0.000 for those fixtures. This is acceptable for the current release gate because the warnings are visible, but it should not remain policy-free.

Acceptance:

- result output separates fact_recall_from_context from source_recall
- service mode maps fixture observation IDs to actual generated IDs deterministically
- any fixture with perfect fact recall but low source recall is marked as a warning in the markdown summary
- define an explicit source-recall warning budget, such as max warning count or minimum average `gold_observation_recall@k`, before wiring this into CI enforcement
- keep source-recall warnings non-fatal until the intended attribution behavior for summarized/closed sessions is fixed

Next implementation notes:

- add a machine-readable `warnings` array to the JSON result, not only markdown text
- include per-warning fields for fixture id, fact recall, source recall, threshold, selected observation IDs, and gold observation IDs
- add a CLI threshold option so CI can fail on warning count or source recall without changing local exploratory runs

### 5. Add CI Profiles

The benchmark should have two CI levels:

- fast PR gate: schema tests, mock eval, and focused Codex eval tests
- release gate: local-service eval with isolated iii-engine
- optional warning-policy gate: local-service eval plus the source-recall warning budget once the policy is chosen

Acceptance:

- CI commands are documented in this file and package.json
- local-service failures print startup logs, fixture diagnostics, selected IDs, and missing/leaked facts
- release gate does not depend on live ~/.agentmemory data or user environment keys
- release gate artifacts include the markdown and JSON result files so source-recall warning changes are reviewable

### 6. Watch Runtime Memory/RSS Under Compression

The current live stack is healthy, but LLM compression, graph extraction, vector indexes, and consolidation are all enabled. RSS should be watched as part of operational confidence, separate from benchmark correctness.

Acceptance:

- add a lightweight burn-in probe that records RSS, active invocations, KV latency, and hook diagnostics over time
- define warning and fail thresholds for sustained RSS growth
- keep this out of the Codex-session recall score so retrieval quality and runtime resource health do not blur together

## Current Recommendation

Keep the current benchmark as the release-confidence gate for Codex session integration. The next best investment is source-recall warning policy plus CI profiles, then live-readonly diagnostics. Runtime RSS burn-in remains useful, but it should stay separate from Codex-session recall scoring so retrieval quality and resource health do not blur together.
