<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Retrieval Freshness Spec

## Goal

Improve follow-up recall so Agentmemory can answer "what just happened?" without
waiting for the background consolidation pipeline to finish.

The current system is good at returning durable project memory and older session
summaries, but it is weak at surfacing newly observed work within the same
session or shortly after a session ends.

## Problem

Fresh observations enter the system immediately through `/agentmemory/observe`,
but retrieval is still overly dependent on:

- session summaries that only exist after summarization
- consolidated semantic/procedural memory that arrives later
- project profile blocks that are useful but not freshness-oriented

This creates a gap:

- ingestion is near real-time
- retrieval freshness is delayed

## Design Principles

1. Retrieval freshness should not depend on consolidation.
2. Freshness should be represented at the turn level, not as isolated raw
   observations.
3. Durable memory and fresh context should coexist, not compete for the entire
   token budget.
4. The knowledge graph should help expand and connect relevant context, but it
   should not be the primary source of "what just happened?"

## Retrieval Model

### Three-Lane Retrieval

The context builder should assemble results from three lanes:

- Hot lane
  - current session
  - very recent same-project turn capsules
  - optimized for immediate follow-up recall
- Warm lane
  - recent high-signal compressed observations not already covered by capsules
  - used as supplemental evidence and detail
- Cold lane
  - durable semantic / procedural / summary / profile memory
  - used for stable long-term context

### Lane Budgeting

Default budget split for `mem::context`:

- 40% hot lane / 30% warm lane / 30% cold lane (no query)
- 20% hot lane / 40% warm lane / 40% cold lane (query present)

Rules:

- no single lane should consume the full token budget by default
- unused budget from one lane may be reallocated to another lane
- same-session hot-lane results should receive the highest default priority
- when a query is present, budget shifts toward warm/cold lanes to prioritize
  relevant content over recent-but-irrelevant capsules

## Turn Capsules

### Rationale

Raw observations are too granular and noisy, while consolidated memory is too
slow for freshness. The correct freshness unit is a turn capsule.

### Capsule Contents

Each capsule should summarize one turn and answer:

- what the user asked
- what the agent tried
- what succeeded or failed
- which files or concepts mattered
- what conclusion mattered

Minimum fields:

- `id`
- `sessionId`
- `turnId`
- `project`
- `cwd`
- `createdAt`
- `updatedAt`
- `userPrompt`
- `assistantConclusion`
- `importantObservations[]`
- `files[]`
- `concepts[]`
- `hadFailure`
- `hadDecision`
- `sourceObservationIds[]`

### Construction

Capsules should be updated incrementally as observations arrive.

Primary inputs:

- `prompt_submit`
- `assistant_result`
- high-signal `post_tool_use`
- `post_tool_failure`
- `stop`

Low-signal events such as routine `pre_tool_use` should not dominate capsule
content.

### Completion

When `assistant_result.is_final=true` or `stop` is observed, the current turn
capsule should be considered complete enough for retrieval.

## Context Retrieval Strategy

### Hot Lane

Retrieve:

- current-session recent capsules
- recent same-project capsules from other sessions

Scoring signals:

- same session boost
- exact `turnId` / session continuity boost
- file overlap boost
- concept overlap boost
- assistant conclusion boost
- failure / decision boost
- recency boost

### Warm Lane

Retrieve recent compressed observations only when they add information not
already covered by hot-lane capsules.

Inclusion policy:

- recent
- high-signal
- query-relevant
- not redundant with selected capsules

Examples:

- a specific file read/edit result
- an important failure
- a search result that names a relevant file or term

### Cold Lane

Retrieve durable memory:

- project profile
- semantic memory
- procedural memory
- session summaries

This lane answers:

- what is generally true
- what has been learned over time
- which reusable workflows matter

## Deduplication

Deduplicate across lanes before final context assembly.

Examples of duplicates to collapse:

- a turn capsule and a recent observation describing the same failure
- a durable semantic memory and a fresh capsule making the same conclusion
- multiple observations touching the same file with the same outcome

Preferred retention order:

1. hot-lane capsule
2. warm-lane observation
3. cold-lane durable memory

Exception:

- retain the durable memory if it adds stable policy/procedure that the capsule
  does not contain

## Graph Role

The knowledge graph should support freshness retrieval, not replace it.

Use the graph for:

- entity expansion
- connected-file discovery
- related-concept expansion
- query refinement

Do not use the graph as the primary answer to freshness questions.

Default graph role:

- expand candidate retrieval sets
- add supporting context
- improve ranking via entity overlap

## Immediate Working Set

To reduce freshness latency further, maintain a session-local working set for:

- latest completed turn capsule
- latest final assistant conclusion
- latest high-signal failure / decision / file touch set

This working set should be queryable immediately, even before background
indexing or consolidation work finishes.

## Retrieval Ranking Signals

Recommended ranking features:

- same session
- same project
- recency
- file overlap
- concept overlap
- graph entity overlap
- assistant conclusion present
- final assistant result present
- failure present
- decision present
- prompt similarity

Recommended demotions:

- routine `pre_tool_use`
- low-importance notifications
- shell churn without a meaningful outcome

## API / Storage Changes

### New Storage

Add a turn-capsule store:

- `mem:turn-capsules`

Optionally support:

- `mem:turn-capsules:{sessionId}`

### New or Extended Types

Add:

- `TurnCapsule`

Extend freshness-relevant observation handling to include:

- `assistant_result`
- `turn_id` extraction from hook payload data

### Context Function

`mem::context` should:

- retrieve lane candidates
- rank within each lane
- deduplicate across lanes
- enforce lane budgets
- emit a structured context response that preserves freshness and durable memory

## Acceptance Criteria

1. A same-session follow-up can retrieve the latest turn capsule without waiting
   for consolidation.
2. Recent project activity from the last 30 to 120 minutes appears in context
   even when no durable memory has been produced yet.
3. Durable semantic/procedural memory still appears in context and is not
   crowded out by recent noise.
4. Low-signal raw activity no longer dominates fresh retrieval.
5. The graph improves ranking/expansion when graph data exists, but the system
   still performs well when graph data is sparse or empty.

## Implementation Order

1. Add turn-capsule storage and type definitions.
2. Extract `turnId`, prompt text, assistant conclusion, and high-signal tool
   outcomes into capsules.
3. Add hot/warm/cold lane retrieval to `mem::context`.
4. Add cross-lane deduplication and budget enforcement.
5. Use graph expansion as a ranking/support feature.
6. Add regression tests for same-session freshness and recent cross-session
   freshness.

## Standard Of Done

This work is done when:

- `mem::context` returns fresh turn-centric context in the same session
- recent follow-up recall no longer depends on consolidation timing
- durable memory remains present and useful
- regression coverage exists for freshness, lane budgeting, and deduplication

Status:

- the current implementation now satisfies this standard of done

## Current Status

### Implemented

- turn-capsule storage exists in `mem:turn-capsules`
- `TurnCapsule` is defined and used by retrieval
- raw observations update capsules immediately during `mem::observe`
- shipped prompt/tool/failure/stop hooks now propagate `turn_id` when the
  host provides it
- a shipped `assistant-result` hook entrypoint now exists for runtimes that
  expose a dedicated final assistant-result event
- compressed observations enrich capsules with files, concepts, failure/decision
  signals, and importance
- the `stop` path now persists a final observation before summarization
- Claude Code currently uses the `stop` path with `last_assistant_message`
  as the supported final-turn completion signal
- a dedicated session-local working set is maintained for the active session and
  injected into the hot lane
- `mem::context` now assembles hot / warm / cold lanes
- default lane budgeting is implemented as 40% hot, 30% warm, 30% cold
- cross-lane deduplication is implemented
- graph expansion is now used as supplemental warm-lane evidence instead of the
  primary freshness source
- durable profile / semantic / procedural memory remains present beside fresh
  context
- regression coverage exists for:
  - same-session capsule preference
  - recent same-project capsule retrieval
  - warm-lane deduplication against capsules
  - durable memory coexisting with fresh context
  - immediate working-set retrieval
  - stop-driven capsule completion
  - graph-assisted warm-lane expansion

### Partially Implemented

- end-to-end `assistant_result` capture now has a shipped hook entrypoint, but
  host/runtime support still depends on whether the upstream agent exposes that
  event; Claude Code does not currently appear to expose a dedicated
  `assistant_result` hook and instead relies on `stop`
- `turn_id` propagation now exists in the shipped hooks that matter for
  freshness, but turn stitching still depends on the upstream host actually
  providing `turn_id`

### Implemented (Query-Aware Ranking)

- `mem::context` now accepts an optional `query` parameter
- `prompt_submit` hook triggers context refresh with the user's prompt as query
- REST endpoint `POST /agentmemory/context/refresh` exposes query-aware context
- query scoring filters noise words (<4 chars), normalizes as fraction of
  meaningful terms matched
- blocks matching any query term always rank above blocks matching none
- lane budgets shift to 20/40/40 (hot/warm/cold) when query is present
- consolidated memories (KV.memories) are now included in the cold lane
- memory usefulness feedback loop tracks injected memories and adjusts strength
  on session end based on session quality

### Not Yet Implemented

- file overlap boost (beyond term matching)
- concept overlap boost (beyond term matching)
- prompt similarity (embedding-based)
- graph entity overlap boost

## Autonomous Maintenance

### Goal

All memory lifecycle operations should run autonomously without manual triggers.

### Requirements

- `mem::consolidate` (concept-grouped memory creation) must run automatically,
  not just `mem::consolidate-pipeline`
- retention eviction (`mem::retention-evict`) must run on a timer to prune
  low-retention memories
- graph pruning must clean up stale nodes/edges when source observations are
  evicted
- search/vector index integrity must self-heal if indices drift from KV state

### Implementation — Complete

- `mem::consolidate` runs after each `mem::consolidate-pipeline` tick
- `mem::retention-evict` + `mem::evict` run on adaptive timer (base 4hr,
  min 1hr, max 12hr), with `mem::retention-score` preceding eviction
- graph pruning fires on every observation eviction via `onEvict` callback,
  marking nodes/edges `stale: true` when all source observations are gone
- index verification runs on adaptive timer (base 2hr, min 30min, max 8hr),
  triggers `rebuildIndex` when BM25/KV drift exceeds 10% and 50 observations

## Next Steps

1. Validate host/runtime support for a real `assistant_result` event wherever
   available outside Claude Code.
2. Extend regression coverage for hook-provided `turn_id` stitching with
   runtime-shaped payloads.
3. Add embedding-based prompt similarity for richer query-aware ranking.
4. Add concept/file-specific overlap boosts beyond raw term matching.
