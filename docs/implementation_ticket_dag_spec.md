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

Planning spec only.

This document exists because the implementation baseline has already moved past
parts of the earlier plan.

Most importantly:

- belief projection is already implemented
- retrieval feedback is only partially implemented
- mission and handoff state do not exist yet

## Live Baseline

Current state in the repo:

- belief graph is already shipped in
  - `src/functions/beliefs.ts`
  - `src/functions/context.ts`
  - `src/functions/verify.ts`
  - `src/triggers/api.ts`
  - `test/beliefs.test.ts`
- retrieval usefulness plumbing exists, but explicit retrieval trace does not
  - `src/functions/access-tracker.ts`
  - `src/functions/context.ts`
  - `src/functions/summarize.ts`
- there is no mission or handoff durable state
  - no `src/functions/missions.ts`
  - no `src/functions/handoffs.ts`
  - no `Mission`, `MissionRun`, or `HandoffPacket` types
- branch awareness exists only as worktree/session lookup
  - `src/functions/branch-aware.ts`
- the existing MCP `session_handoff` prompt is only a thin session + summary
  dump
  - `src/mcp/server.ts`
- export/import already includes beliefs, but it does not yet include some
  coordination state that should be durable in the same lane
  - `Lease`
  - `RoutineRun`

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

## Ticket DAG

```text
IT-01 -> IT-03
IT-01 -> IT-05
IT-02 -> IT-03
IT-02 -> IT-05
IT-03 -> IT-04
IT-04 -> IT-05
IT-05 -> IT-06
IT-04 -> IT-07
IT-05 -> IT-07
IT-07 -> IT-08
IT-04 -> IT-09
IT-06 -> IT-09
IT-07 -> IT-10
IT-08 -> IT-10
IT-07 -> IT-11
IT-04 -> IT-11
IT-04 -> IT-12
IT-11 -> IT-12
```

Interpretation:

- the critical path is retrieval trace -> mission core -> mission linkage ->
  handoff packets
- branch overlays and guardrails come after mission/handoff state is stable
- viewer work is explicitly off the main path
- dossiers, decisions, and routine compilation stay late

## Ticket Specs

### IT-01: Retrieval Trace Core

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

### IT-07: Branch Overlay Foundation

Blocked by:

- `IT-04`
- `IT-05`

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

### IT-08: Guardrail Memory

Blocked by:

- `IT-07`

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

### IT-09: Mission And Handoff Viewer Cards

Blocked by:

- `IT-04`
- `IT-06`

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

### IT-10: Component Dossiers

Blocked by:

- `IT-07`
- `IT-08`

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

### IT-11: Decision Memory

Blocked by:

- `IT-07`
- `IT-04`

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

### IT-12: Routine Compiler

Blocked by:

- `IT-04`
- `IT-11`

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
4. slice D
   - `IT-07`
   - `IT-08`
5. slice E
   - `IT-09`
6. slice F
   - `IT-10`
   - `IT-11`
   - `IT-12`

## Acceptance Criteria

This DAG is successful when:

- the next implementation tickets can be chosen from the live repo state
  instead of from stale roadmap assumptions
- the critical path is explicit
- export/import responsibilities are visible early
- mission and handoff work no longer look like one monolithic refactor
