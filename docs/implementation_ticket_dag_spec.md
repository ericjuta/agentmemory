<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Implementation Ticket DAG Spec

## Purpose

Turn the current memory-mechanisms roadmap into an implementation ticket graph
grounded in the live repository state as of April 20, 2026.

This document is not another theory-level roadmap. It is the execution
companion to:

- [`memory_mechanisms_implementation_spec.md`](./memory_mechanisms_implementation_spec.md)
- [`belief_graph_spec.md`](./belief_graph_spec.md)
- [`mission_layer_spec.md`](./mission_layer_spec.md)
- [`handoff_packets_spec.md`](./handoff_packets_spec.md)

## Status

Core ticket DAG implemented as of April 20, 2026.

This document exists because the implementation baseline has already moved past
parts of the earlier plan.

Most importantly:

- belief projection is already implemented
- retrieval trace is implemented
- coordination export/import now includes the existing durable coordination
  state that was previously missing
- mission and handoff state now exist in the live backend
- the narrowed core implementation set in this DAG has been completed

## Live Baseline

Current state in the repo:

- belief graph is already shipped in
  - `src/functions/beliefs.ts`
  - `src/functions/context.ts`
  - `src/functions/verify.ts`
  - `src/triggers/api.ts`
  - `test/beliefs.test.ts`
- retrieval usefulness plumbing now includes explicit retrieval trace in
  `mem::context`
  - `src/functions/access-tracker.ts`
  - `src/functions/context.ts`
  - `src/functions/summarize.ts`
- mission and handoff durable state now exist
  - `src/functions/missions.ts`
  - `src/functions/handoffs.ts`
  - `Mission`, `MissionRun`, and `HandoffPacket` types in `src/types.ts`
- branch awareness exists only as worktree/session lookup
  - `src/functions/branch-aware.ts`
- the existing MCP `session_handoff` prompt is now packet-backed
  - `src/mcp/server.ts`
- export/import now includes the coordination state added across this lane
  - `Lease`
  - `RoutineRun`
  - `Mission`
  - `MissionRun`
  - `HandoffPacket`

## Planning Rules

Use these rules when turning this DAG into actual PRs:

1. treat belief projection as baseline, not backlog
2. finish retrieval explainability before adding more coordination state
3. do not add MCP tools for mission or handoff v1
4. add viewer support only after function and REST layers stabilize
5. once a new primitive is both durable and user-visible, export/import support
   becomes mandatory in that same ticket or the next stabilization ticket
6. every REST-surface ticket must also update:
   - `src/index.ts`
   - `README.md`
   - endpoint-count assertions or docs that depend on the count
7. branch overlays, guardrails, viewer expansion, dossiers, decision memory,
   and routine compilation are explicitly deferred until the mission/handoff
   lane proves its value

## Core Ticket DAG

```text
IT-01 -> IT-03
IT-01 -> IT-05
IT-02 -> IT-03
IT-02 -> IT-05
IT-03 -> IT-04
IT-04 -> IT-05
IT-05 -> IT-06
```

Interpretation:

- the critical path is retrieval trace -> mission core -> mission linkage ->
  handoff packets
- this is the recommended implementation bar, not a maximal backlog

## Ticket Specs

### IT-01: Retrieval Trace Core

Status:

- implemented

Goal:

- make `mem::context` explainable enough to debug ranking and selection

Primary files:

- `src/functions/context.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `test/context.test.ts`

Required output:

- explicit selected vs skipped candidate trace
- lane, score, and selection reason visibility
- linkage to the existing usefulness loop instead of creating a second feedback
  path

Notes:

- do not add MCP tools
- prefer augmenting `mem::context` output and optionally persisting the latest
  trace for debugging

### IT-02: Coordination Export/Import Hardening

Status:

- implemented

Goal:

- close existing portability gaps before adding more durable coordination state

Primary files:

- `src/functions/export-import.ts`
- `src/types.ts`
- `src/version.ts`
- `test/export-import.test.ts`

Required output:

- export/import support for existing coordination objects that are already
  durable but not fully covered
- at minimum:
  - `Lease`
  - `RoutineRun`

Notes:

- this is a prep ticket
- mission and handoff tickets should not deepen export/import drift

### IT-03: Mission State Core

Status:

- implemented

Blocked by:

- `IT-01`
- `IT-02`

Goal:

- add first-class mission containers above the current mechanism primitives

Primary files:

- `src/functions/missions.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `src/index.ts`
- `src/triggers/api.ts`
- `test/missions.test.ts`

Required output:

- `Mission`
- `MissionRun`
- create, update, get, and list functions
- REST endpoints from `mission_layer_spec.md`
- export/import support for the new durable mission objects

Notes:

- do not replace `Action`
- do not add viewer work yet
- do not add MCP tools in v1

### IT-04: Mission Linkage And Status Projection

Status:

- implemented

Blocked by:

- `IT-03`

Goal:

- let missions own existing mechanism state without forcing a full migration

Primary files:

- `src/functions/actions.ts`
- `src/functions/checkpoints.ts`
- `src/functions/sentinels.ts`
- `src/functions/leases.ts`
- `src/functions/routines.ts`
- `src/functions/missions.ts`
- `src/types.ts`
- `test/missions.test.ts`

Required output:

- optional `missionId` support on existing primitives
- conservative mission status projection
- durable mission summary derived from linked primitives

Notes:

- this is the ticket that makes mission state actually useful
- mission status should remain explainable and additive

### IT-05: Handoff Packet Core

Status:

- implemented

Blocked by:

- `IT-01`
- `IT-02`
- `IT-04`

Goal:

- create durable, deterministic handoff packets from structured state

Primary files:

- `src/functions/handoffs.ts`
- `src/functions/context.ts`
- `src/functions/missions.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `src/index.ts`
- `src/triggers/api.ts`
- `src/functions/export-import.ts`
- `test/handoffs.test.ts`

Required output:

- `HandoffPacket`
- generate, get, and list functions
- REST endpoints from `handoff_packets_spec.md`
- deterministic packet generation from:
  - working set
  - turn capsules
  - frontier / next
  - checkpoints / sentinels
  - beliefs

Notes:

- support `session`, `action`, and `mission` scope in one model
- do not auto-inject handoff packets into context yet

### IT-06: Handoff Delivery And Prompt Upgrade

Status:

- implemented

Blocked by:

- `IT-05`

Goal:

- route existing handoff seams through durable packet state

Primary files:

- `src/functions/signals.ts`
- `src/mcp/server.ts`
- `src/types.ts`
- `README.md`
- tests covering the prompt or signal behavior

Required output:

- `Signal.type = "handoff"` can reference packet state
- existing `session_handoff` prompt returns packet-backed output instead of a
  thin session + summary dump

Notes:

- this is the migration ticket for existing handoff seams
- no new MCP tools are required

## Deferred Tickets

The following items may still be good ideas, but they are not part of the
current implementation bar.

They should not block the core mission/handoff lane.

### DT-01: Branch Overlay Foundation

Status:

- implemented

Blocked by:

- core mission and handoff stabilization

Goal:

- add branch-scoped durable overlays without contaminating project-global state

Primary files:

- `src/functions/branch-aware.ts`
- mission, handoff, and later belief-linked state files
- `src/types.ts`
- `src/state/schema.ts`
- new tests for branch-local isolation

Required output:

- branch-local overlay model for durable coordination state
- explicit promotion rules instead of silent merge into global truth

Notes:

- start with mission, handoff, and blocker-oriented state
- do not attempt automatic merge-time promotion in v1

### DT-02: Guardrail Memory

Status:

- implemented

Blocked by:

- branch-local durable state or another proven retrieval gap

Goal:

- add explicit negative-memory objects with scope and expiry

Primary files:

- `src/functions/guardrails.ts`
- `src/functions/context.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `src/index.ts`
- `src/triggers/api.ts`
- tests for retrieval and expiry behavior

Required output:

- durable guardrail objects
- retrieval lane that surfaces guardrails alongside positive context
- expiry and supersession behavior

Notes:

- do not hard-block execution in v1
- surface guidance first, enforcement later if ever needed

### DT-03: Mission And Handoff Viewer Cards

Status:

- implemented

Blocked by:

- backend stabilization of mission and handoff state

Goal:

- expose the new durable coordination state in the viewer

Primary files:

- `src/viewer/index.html`
- `src/viewer/server.ts`
- any viewer-facing REST fetch wiring

Required output:

- mission card:
  - goal
  - status
  - phase
  - owner
  - blockers
  - linked action count
- handoff card or panel with current packet summary

Notes:

- keep this out of the first mission/handoff backend PRs

### DT-04: Component Dossiers

Status:

- implemented

Blocked by:

- branch/guardrail maturity and a proven need for file-level long-lived views

Goal:

- add file-level dossiers that synthesize stable component context

Primary files:

- `src/functions/component-dossiers.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `src/index.ts`
- `src/triggers/api.ts`
- dossier tests

Required output:

- file-level dossiers only in v1
- inputs from observations, failures, lessons, and branch-aware context

Notes:

- do not attempt symbol-level dossiers yet

### DT-05: Decision Memory

Status:

- implemented

Blocked by:

- clear evidence that lessons/insights/crystals are insufficient

Goal:

- persist explicit decisions with alternatives and reconsideration conditions

Primary files:

- `src/functions/decisions.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `src/index.ts`
- `src/triggers/api.ts`
- decision tests

Required output:

- durable decision records
- retrieval surface for active decisions and reversibility conditions

Notes:

- start from manual-save and reflection-driven paths
- do not try to infer every decision from generic prose

### DT-06: Routine Compiler

Status:

- implemented

Blocked by:

- evidence of repeated successful action-chain patterns worth formalizing

Goal:

- mine repeated successful execution structure into proposed routine candidates

Primary files:

- `src/functions/routine-compiler.ts`
- `src/functions/routines.ts`
- `src/types.ts`
- `src/state/schema.ts`
- `src/index.ts`
- `src/triggers/api.ts`
- routine-compiler tests

Required output:

- routine candidates derived from repeated successful action chains
- proposal-only mode in v1

Notes:

- do not auto-enable compiled routines

## Recommended Merge Slices

Use these slices unless there is a strong reason to split more finely:

1. slice A
   - `IT-01`
   - `IT-02`
2. slice B
   - `IT-03`
   - `IT-04`
3. slice C
   - `IT-05`
   - `IT-06`

Deferred slices should be planned only after slice C lands and is used.

## Acceptance Criteria

This DAG is successful when:

- the next implementation tickets can be chosen from the live repo state
  instead of from stale roadmap assumptions
- the critical path is explicit
- export/import responsibilities are visible early
- mission and handoff work no longer look like one monolithic refactor
- clearly optional ideas are separated from the current implementation bar
