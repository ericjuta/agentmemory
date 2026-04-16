<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Codex Follow-Ups Spec

## Goal

Lock in the currently working Codex-to-agentmemory integration with explicit
compatibility coverage, clearer documentation, and an optional path for
query-aware context ranking.

This work is not about proving that Codex can talk to agentmemory in principle.
That is already true in the current environment. This work is about reducing
future drift and making the integration legible and testable.

## Scope

Three follow-up tracks:

1. Codex payload compatibility test coverage
2. Codex-native integration documentation
3. Optional query-aware ranking in `mem::context`

## Current Situation

Observed reality:

- the current forked Codex session is configured to use `agentmemory`
- Codex session identity and lifecycle payloads are reaching the live
  `agentmemory` service
- current-session turns are retrievable immediately through the freshness path
- the fork's adapter emits Codex-shaped lifecycle events that are translated to
  `agentmemory` observation payloads

Current gap:

- this compatibility is proven by runtime evidence, but it is not pinned by an
  explicit repo-side contract test
- repo docs do not clearly distinguish generic Codex MCP/REST usage from a
  fork that posts native lifecycle events directly into `agentmemory`
- `mem::context` is freshness-oriented, but does not currently use an
  optional retrieval query even when an upstream adapter can provide one

## Track 1: Codex Payload Compatibility Test

### Goal

Add one focused test that proves `agentmemory` correctly handles the payload
shape emitted by the current Codex fork.

### Test Surface

The test should simulate a realistic Codex lifecycle using the existing
`agentmemory` API or registered functions.

Minimum sequence:

1. start a session
2. submit a user prompt with `turn_id`
3. capture at least one tool event with `turn_id`
4. capture an `assistant_result` event with `assistant_text`
5. capture a `stop` event with `last_assistant_message`
6. request `mem::context`

### Required Assertions

- the turn capsule is created for the supplied `turn_id`
- the capsule contains the user prompt
- the capsule contains the final assistant conclusion
- the session working set is updated to the latest completed turn
- `mem::context` returns the completed turn immediately
- `assistant_result` and `stop` are both accepted without breaking capsule
  completion semantics

### Payload Contract To Cover

Representative Codex-style fields to preserve:

- `session_id`
- `turn_id`
- `cwd`
- `model`
- `tool_name`
- `tool_use_id`
- `command` or structured tool input
- `tool_response`
- `assistant_text`
- `last_assistant_message`
- `is_final`

### Non-Goals

- do not build a full integration harness against the external Codex repo
- do not duplicate all freshness tests under a Codex-specific name
- do not introduce Codex-specific business logic into `agentmemory`

## Track 2: Codex-Native Documentation

### Goal

Document the difference between:

- Claude Code native hook/plugin integration
- Codex forks that post lifecycle events directly to `agentmemory`
- generic MCP/REST-only agent integrations

### Required Documentation Outcome

Docs should make it obvious that these are different integration levels.

Recommended framing:

- `Claude Code`
  - native hook/plugin path shipped in this repo
- `Codex forks`
  - native adapter path if the fork emits compatible lifecycle events into
    `/agentmemory/observe` and uses `/agentmemory/context`
- `Generic Codex / MCP clients`
  - MCP or REST path only

### Required Clarifications

- `agentmemory` accepts native lifecycle payloads from a compatible Codex
  adapter
- this is distinct from the standalone MCP server path
- the standalone MCP server should not be described as equivalent to native
  session capture
- Codex-native lifecycle capture depends on the host fork, not on a plugin
  shipped by this repo

### Suggested File Targets

- [README.md](/Users/ericjuta/Projects/agentmemory/README.md)
- optionally a small dedicated section under `docs/` if README becomes noisy

## Track 3: Optional Query-Aware Ranking

### Goal

Allow `mem::context` to use an optional query signal when an upstream adapter
provides one, without regressing the default freshness-oriented behavior.

### Motivation

The Codex adapter already has a natural place to supply retrieval intent during
mid-session recall. Today `mem::context` mostly ranks by session continuity,
recency, and freshness signals. That works, but it ignores useful retrieval
intent when it is available.

### API Shape

Extend `mem::context` input to accept:

- `query?: string`

The HTTP surface may continue to accept the same optional field.

### Ranking Expectations

When `query` is present:

- hot, warm, and cold lane candidates may receive lightweight ranking boosts
  from overlap with the query
- file overlap, concept overlap, prompt similarity, and graph entity overlap
  may contribute to ranking
- freshness still dominates over old durable memory for immediate follow-ups

When `query` is absent:

- behavior should remain materially unchanged from current retrieval freshness

### Guardrails

- do not make the query mandatory
- do not let cold durable memory swamp current-turn freshness
- do not turn `mem::context` into a second copy of `mem::search`
- keep graph as a supporting signal, not the primary source of freshness

### Suggested Validation

- a query mentioning a file or concept should reorder otherwise similar recent
  candidates in a predictable way
- same-session latest-turn context should still appear even when the query is
  weak or noisy
- behavior without a query should match current tests closely

## Implementation Order

1. Add the Codex payload compatibility test
2. Update Codex-native integration docs
3. Add optional query-aware ranking to `mem::context`

## Standard Of Done

This follow-up lane is done when:

- a dedicated test proves compatibility with the current Codex payload shape
- docs clearly distinguish native Codex adapter usage from generic MCP/REST
- `mem::context` optionally accepts a query without regressing freshness
- default retrieval behavior remains stable when no query is supplied

## Current Status

### Track 1: Codex Payload Compatibility Test

- implemented

### Track 2: Codex-Native Documentation

- implemented

### Track 3: Query-Aware Ranking

- implemented
- `mem::context` accepts optional `query` parameter
- `prompt_submit` hook fires context refresh with user prompt as query
- `POST /agentmemory/context/refresh` endpoint added
- query scoring normalizes term overlap, skips noise words, hard-partitions
  matched vs unmatched blocks
- lane budgets shift from 40/30/30 to 20/40/40 when query is present
- consolidated memories (KV.memories) now included in cold lane
- memory usefulness feedback loop adjusts strength on session end
