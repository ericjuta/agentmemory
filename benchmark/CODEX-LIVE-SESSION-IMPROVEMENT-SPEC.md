# Codex Live Session Improvement Spec

## Current Baseline

The Codex session eval is now a 20-fixture gate with clean local-service results:

- `required_fact_recall@context`: 1.000
- `forbidden_fact_leak_rate`: 0.000
- `gold_observation_recall@k`: 1.000
- source-recall warnings: 0

The current hook integration contract does not need a wire change for source attribution. Codex hooks still receive `hookSpecificOutput.additionalContext` as a string. Retrieval IDs are an opt-in debug/eval surface through `/agentmemory/context` via `includeRetrievalIds: true` or `AGENTMEMORY_CONTEXT_DEBUG_IDS=true`.

## Problem

The fixture eval proves deterministic replay quality, but it does not yet prove that live Codex sessions on this host remain good under real runtime conditions:

- startup context may degrade or delay when the backend is under pressure
- hook stdout may be correct in tests but drift in host config
- injected context can be useful without leaving enough trace for diagnosis
- release gates still allow nonzero source-recall warnings even though the current code reaches zero

## Goal

Add live-session confidence around the existing backend and hook path without changing the normal Codex hook contract.

The desired end state is:

- one command proves a real native Codex hook flow from session start through prompt context refresh
- debug mode can explain where each injected context block came from
- release/profile CI can require zero source-recall warnings
- slow or unhealthy backend paths return fast degraded context instead of making Codex feel hung

## Non-Goals

- Do not make normal hooks emit source IDs to Codex stdout.
- Do not require live `~/.agentmemory` data for default CI.
- Do not add a second persistence path outside iii-engine/StateModule.
- Do not change `hookSpecificOutput.additionalContext` shape.
- Do not turn on verbose traces by default for normal users.

## Work Items

### 1. Live Codex Session Smoke Test

Add a host-safe smoke test script that runs against a temporary HOME/cwd/state by default and can optionally point at the live service in read-only/debug mode.

It should prove:

- `SessionStart` emits Codex-shaped JSON when injection is enabled.
- `UserPromptSubmit` records the prompt and can inject refreshed context.
- `PostToolUse` captures native Codex `tool_response` payloads.
- `Stop` marks stop state without incorrectly closing a resumed session.
- `/agentmemory/context` returns selected source IDs when debug IDs are requested.

Recommended commands:

- `npm run codex:smoke`
- `npm run codex:smoke:live-readonly`

The default command must not mutate live `~/.agentmemory`.

### 2. Context Debug Trace

Add an opt-in trace object to `/agentmemory/context` when debug mode is requested.

The trace should include:

- block type: `summary`, `observation`, `memory`, or fallback
- source observation IDs
- session IDs where known
- token estimate per block
- selected/skipped status
- skip reason when budget excludes a block
- degraded/fallback reason when applicable

The normal response remains unchanged unless debug is requested.

### 3. Strict Source-Recall Release Gate

Keep warnings non-fatal for default developer runs, but add a stricter release/profile script that requires zero warnings and perfect average source recall for the Codex session eval.

Recommended script:

- `npm run eval:codex-session:ci:strict-warning-policy`

Expected command body:

- `npm run eval:codex-session:service -- --max-source-recall-warnings 0 --min-average-gold-observation-recall 1`

This is now feasible because the local-service eval reaches:

- warnings: 0
- `gold_observation_recall@k`: 1.000

### 4. Startup Pressure UX

Audit and harden the startup/context path so Codex does not feel stuck when agentmemory is under load.

Desired behavior:

- `/agentmemory/session/start` returns quickly with context or an explicit degraded marker.
- `/agentmemory/context` has bounded work for hook calls.
- last-known-good or deferred context paths are visible in debug trace.
- hook scripts still swallow backend failures and avoid raw stderr/stdout noise.

Proof should use direct endpoint timing and hook subprocess timing, not only health `200`.

### 5. Host Hook Config Audit

After the backend smoke test exists, add a read-only host audit command for native Codex hook configuration.

It should verify:

- `~/.codex/hooks.json` uses native Codex event names only.
- enabled hook commands point at current repo scripts or built plugin scripts.
- `SessionStart` and `UserPromptSubmit` stdout shape remains valid Codex JSON.
- `PostToolUse` handles native `tool_response`.

This is an audit/proof surface, not a new integration contract.

## Acceptance Criteria

- `npm run eval:codex-session:service` remains green with 20 fixtures.
- strict source-warning policy passes with zero warnings.
- smoke test proves session start, prompt submit, post-tool capture, stop/resume, and debug selected IDs.
- normal hook stdout remains limited to Codex-compatible context JSON.
- default smoke/eval commands use isolated temp state and do not mutate live `~/.agentmemory`.
- live-readonly diagnostics clearly label live state and avoid writes.

## Suggested Sequence

1. Add strict warning-policy script.
2. Add the isolated live-session smoke test.
3. Add opt-in context debug trace.
4. Harden startup pressure behavior where the smoke test exposes delay.
5. Add host hook config audit after the runtime proof is stable.

