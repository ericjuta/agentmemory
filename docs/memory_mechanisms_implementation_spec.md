<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Memory + Mechanisms Implementation Spec

## Purpose

Turn the broad roadmap in
[`memory_mechanisms_expansion_spec.md`](./memory_mechanisms_expansion_spec.md)
into an actionable implementation plan.

This document is the execution map for the full expansion proposal:

- what gets built first
- how the tracks depend on each other
- where each track should land in the codebase
- what can wait
- and what counts as done per phase

It is intentionally implementation-oriented, not product-theory oriented.

## Status

Planning spec only.

No code in this document is implemented yet unless another spec explicitly says
otherwise.

## Executive Decision

The full expansion proposal should not be implemented as one monolithic push.

It should be built in three phases:

1. truth projection
2. coordination state
3. learned execution structure

Those phases map to the highest-leverage tracks like this:

- Phase 1
  - belief graph / current-truth projection
  - retrieval trace / influence feedback
- Phase 2
  - mission layer
  - handoff packets
  - branch / PR memory
  - negative memory / guardrails
- Phase 3
  - component dossiers
  - decision memory
  - routine compiler

This order matters because later phases should consume primitives from earlier
phases instead of re-implementing them ad hoc.

## Architecture Principles

All implementation should preserve the current repo’s strongest constraints:

1. do not bypass iii-engine
2. keep state explicit in KV scopes
3. favor additive state models over mutation-heavy hidden logic
4. keep retrieval explainable
5. keep historical evidence instead of deleting ambiguity

Additional implementation rules for this roadmap:

1. every new state object must have a stable identity and timestamps
2. every state-changing operation must write audit entries
3. retrieval should prefer projected current truth, but never destroy
   historical evidence
4. mission and handoff state must compose with existing actions / leases /
   checkpoints rather than replace them immediately
5. branch-scoped state must not silently contaminate project-global state

## Phase Plan

## Phase 1

Goal:

- make memory answer “what is currently true?”
- make retrieval explainable enough to debug

Tracks:

- belief graph / current-truth projection
- retrieval trace / influence feedback

Primary deliverables:

- [`belief_graph_spec.md`](./belief_graph_spec.md)
- retrieval trace additions to `context.ts`

Required new primitives:

- `Belief`
- `BeliefEvidence`
- `BeliefProjection`
- `RetrievalTrace`

Why first:

- later mission, dossier, and handoff layers need a way to distinguish current
  truth from stale memory
- without this, every later state layer risks becoming another store of
  conflicting facts

## Phase 2

Goal:

- make coordination state durable across turns, sessions, and agents

Tracks:

- mission layer
- handoff packets
- branch / PR memory
- negative memory / guardrails

Primary deliverables:

- [`mission_layer_spec.md`](./mission_layer_spec.md)
- [`handoff_packets_spec.md`](./handoff_packets_spec.md)
- branch-local overlays
- guardrail retrieval lane

Required new primitives:

- `Mission`
- `MissionRun`
- `HandoffPacket`
- `GuardrailMemory`

Why second:

- missions should consume beliefs, not raw memory alone
- handoffs should summarize current truth plus coordination state

## Phase 3

Goal:

- make the system codebase-native and self-improving

Tracks:

- component dossiers
- decision memory
- routine compiler

Required new primitives:

- `ComponentDossier`
- `DecisionRecord`
- `RoutineCandidate`

Why third:

- these layers are powerful but easiest to get wrong if built before truth and
  mission state are stable

## Track-by-Track Implementation Notes

### Track 1: Belief Graph

Spec owner:

- [`belief_graph_spec.md`](./belief_graph_spec.md)

Implementation shape:

- add new KV scope for beliefs
- derive beliefs from `Memory`, `MemoryRelation`, and verification evidence
- support `supersedes` and `contradicts` first
- expose retrieval projection before adding auto-promotion logic

Must not do in v1:

- no autonomous belief writing from every observation
- no probabilistic graph inference engine

### Track 2: Mission Layer

Spec owner:

- [`mission_layer_spec.md`](./mission_layer_spec.md)

Implementation shape:

- add mission container above actions
- attach leases, checkpoints, sentinels, and routines by mission id
- compute mission status from linked mechanism state

Must not do in v1:

- no replacement of `Action`
- no automatic migration of all existing action flows into missions

### Track 3: Handoff Packets

Spec owner:

- [`handoff_packets_spec.md`](./handoff_packets_spec.md)

Implementation shape:

- build generated packet from working set + turn capsules + frontier + beliefs
- support packet generation for mission and action scopes
- store and retrieve packets explicitly

Must not do in v1:

- no LLM-required handoff generation for every session
- no hidden automatic delivery semantics

### Track 4: Component Dossiers

Implementation shape:

- start with file-level dossiers only
- derive from observations, failures, lessons, and branch-aware context

Must not do in v1:

- no symbol-level dossiers yet
- no background dossier generation for every file in the project

### Track 5: Decision Memory

Implementation shape:

- attach explicit alternatives / rejection reasons / reconsideration conditions
- build from manual save paths or reflection output first

Must not do in v1:

- no attempt to infer every decision automatically from generic prose

### Track 6: Routine Compiler

Implementation shape:

- mine repeated successful action chains
- output proposed routine candidates only

Must not do in v1:

- no automatic enabling of compiled routines

### Track 7: Retrieval Trace and Influence Feedback

Implementation shape:

- add trace output to context assembly
- track selected vs skipped candidates
- attach downstream usefulness later

Must not do in v1:

- no automatic strength mutation from weak heuristics

### Track 8: Branch / PR Memory

Implementation shape:

- add branch-local overlays for beliefs, dossiers, and blockers
- merge-time promotion must be explicit

Must not do in v1:

- no silent branch-to-main promotion

### Track 9: Negative Memory / Guardrails

Implementation shape:

- add explicit guardrail objects with scope and expiry
- retrieval should surface guardrails alongside positive context

Must not do in v1:

- no hard blocking enforcement in v1 without operator confirmation

## Codebase Placement

Expected new files:

- `src/functions/beliefs.ts`
- `src/functions/missions.ts`
- `src/functions/handoffs.ts`
- `src/functions/component-dossiers.ts`
- `src/functions/decisions.ts`
- `src/functions/guardrails.ts`
- `src/functions/routine-compiler.ts`

Expected touched files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/context.ts`
- `src/functions/verify.ts`
- `src/functions/actions.ts`
- `src/functions/frontier.ts`
- `src/functions/branch-aware.ts`
- `src/triggers/api.ts`
- `src/mcp/tools-registry.ts`
- `src/mcp/server.ts`
- `src/index.ts`

Viewer follow-up targets:

- `src/viewer/server.ts`
- `src/viewer/index.html`

## API Rollout Strategy

New externally visible functionality should follow this order:

1. internal function
2. REST endpoint
3. MCP tool
4. viewer rendering
5. docs and examples

Do not expose a tool before the underlying state model and REST path are stable.

## Testing Strategy

Per phase:

1. unit tests for object construction and state transitions
2. function tests for writes / reads / audit behavior
3. context retrieval tests for projection order
4. export/import coverage for any new persisted objects

Required invariant tests:

- superseded beliefs remain historically accessible
- contradictory beliefs do not overwrite one another
- missions can be incomplete even when some actions are complete
- handoff packets are reproducible from the same input state
- branch-local state does not leak into global retrieval by default

## Export / Import Expectations

Every new durable state object introduced by this roadmap should eventually be
included in export/import, but not necessarily in the very first patch that
creates the object.

Required rule:

- once a primitive becomes user-visible and durable, export/import support
  becomes mandatory in the next stabilization pass

## Recommended Immediate Sequence

1. implement belief graph
2. add retrieval trace
3. implement mission layer
4. implement handoff packets
5. add branch-local overlays
6. add guardrail memory
7. add component dossiers
8. add decision memory
9. add routine compiler

## Standard Of Done

This implementation program is complete when:

- current-truth projection exists and is retrievable
- mission state can own and summarize mechanism state
- handoff packets make resume quality materially better
- branch-local state can be stored without polluting global truth
- guardrails and decisions are retrievable as explicit state
- dossiers and routines become additive leverage rather than parallel shadow
  systems

## Related Docs

- [`memory_mechanisms_expansion_spec.md`](./memory_mechanisms_expansion_spec.md)
- [`belief_graph_spec.md`](./belief_graph_spec.md)
- [`mission_layer_spec.md`](./mission_layer_spec.md)
- [`handoff_packets_spec.md`](./handoff_packets_spec.md)
