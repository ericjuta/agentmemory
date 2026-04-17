<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Memory + Mechanisms Expansion Spec

## Status

Forward-looking audit and expansion roadmap.

This document answers a narrower product question than the existing fork docs:

- given the current state of `agentmemory`,
- what should be expanded next on the memory side,
- what should be expanded next on the mechanism side,
- and which bets would compound the most for serious coding agents?

## Executive Summary

`agentmemory` is already past the point where "better search" is the main
opportunity.

The repository now contains real substrate for:

- fresh retrieval
- durable memory
- graph relationships
- action planning
- work leasing
- checkpoints and sentinels
- routines
- sketches
- lessons and insights
- diagnostics and healing

That means the next frontier is not another search primitive. The next
frontier is to make memory and mechanism compose into an actual agent
operating model.

The highest-leverage shift is:

1. move from "memory store with retrieval" toward "belief system with current
   truth projection",
2. move from "action list with helper primitives" toward "mission control for
   agents",
3. make handoff, verification, and routine induction first-class rather than
   accidental byproducts of logs.

If this lands well, `agentmemory` stops being mainly:

- searchable past context

and becomes:

- a persistent control plane for multi-turn and multi-agent work.

## Current Strengths

The repo already has unusually strong primitives in five categories.

### 1. Freshness Retrieval

Current strength:

- turn capsules
- session working sets
- hot / warm / cold context assembly
- query-aware lane shifts

Primary files:

- `src/functions/context.ts`
- `src/functions/turn-capsules.ts`
- `src/functions/working-set.ts`
- `docs/retrieval_freshness_spec.md`

### 2. Knowledge Distillation

Current strength:

- semantic and procedural memory
- lessons
- crystals
- insights via reflection
- relations / evolution

Primary files:

- `src/functions/remember.ts`
- `src/functions/lessons.ts`
- `src/functions/crystallize.ts`
- `src/functions/reflect.ts`
- `src/functions/relations.ts`

### 3. Mechanism Layer

Current strength:

- actions
- frontier / next
- leases
- routines
- checkpoints
- sentinels
- sketches
- signals

Primary files:

- `src/functions/actions.ts`
- `src/functions/frontier.ts`
- `src/functions/leases.ts`
- `src/functions/routines.ts`
- `src/functions/checkpoints.ts`
- `src/functions/sentinels.ts`
- `src/functions/sketches.ts`
- `src/functions/signals.ts`

### 4. Structural Retrieval

Current strength:

- graph extraction
- graph retrieval
- temporal graph support
- query expansion
- branch-aware session lookup

Primary files:

- `src/functions/graph.ts`
- `src/functions/graph-retrieval.ts`
- `src/functions/temporal-graph.ts`
- `src/functions/query-expansion.ts`
- `src/functions/branch-aware.ts`

### 5. Self-Maintenance

Current strength:

- diagnostics
- maintenance gates
- decay sweeps
- retention scoring
- auto-forget / eviction / cleanup

Primary files:

- `src/functions/diagnostics.ts`
- `src/functions/retention.ts`
- `src/functions/auto-forget.ts`
- `src/functions/evict.ts`
- `src/health/*`

## Core Thesis

The system already has enough pieces to become more than a memory engine.

The best next investments are the ones that:

- turn stored knowledge into current, verifiable beliefs,
- turn action primitives into persistent mission state,
- and turn successful work patterns into reusable executable structure.

Those are compounding bets.

By contrast, lower-leverage expansion would be:

- more generic search variants,
- more hook types without stronger state models,
- more memory object types without better composition,
- or more retrieval knobs without stronger explanation / verification.

## Expansion Tracks

## Track 1: Belief Graph and Current-Truth Projection

### Problem

Today the system can store:

- memories,
- relations,
- temporal graph edges,
- supersession chains,
- and citation/verification metadata.

What it does not yet do is project a first-class answer to:

- what is currently believed true,
- what evidence supports it,
- what contradicts it,
- how stale it is,
- and what confidence the system should expose now.

That gap matters because coding agents constantly accumulate:

- outdated architecture facts,
- conflicting bug explanations,
- superseded conventions,
- and "this used to be true" implementation details.

### Proposal

Introduce a belief layer above raw memories and graph edges.

Core object:

- `Belief`
  - canonical claim
  - scope
  - current confidence
  - support evidence
  - contradiction evidence
  - supersession lineage
  - current-truth status
  - valid-from / valid-to when known

Required capabilities:

- ingest claims from lessons, semantic memory, crystals, and temporal edges
- merge equivalent claims across different sources
- mark contradictions explicitly
- produce a "current truth projection" for retrieval
- keep old claims accessible as historical beliefs rather than deleting them

### Why This Matters

This is the missing bridge between:

- "we recorded many useful facts"

and:

- "the agent now knows which fact is the one it should act on."

### Suggested Implementation Surface

New types / scopes:

- `Belief`
- `BeliefEvidence`
- `BeliefProjection`

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/beliefs.ts`
- `src/functions/relations.ts`
- `src/functions/temporal-graph.ts`
- `src/functions/verify.ts`
- `src/functions/context.ts`

### Acceptance Criteria

- a belief can cite multiple supporting memories / observations
- contradictions do not destroy historical evidence
- retrieval can prefer current projected beliefs over stale superseded claims
- the verification surface can explain why a belief is current

## Track 2: Mission Layer

### Problem

The repo already has:

- actions
- frontier
- leases
- checkpoints
- sentinels
- routines
- sketches
- signals

Those are powerful, but today they still feel like adjacent primitives rather
than one mission system.

### Proposal

Add a first-class `Mission` and `MissionRun` layer that unifies the mechanism
graph.

Core concept:

- a mission is the persistent container for a real objective
- actions, routines, checkpoints, sentinels, leases, and handoffs become
  mission-owned structure

Mission fields should include:

- goal
- project / branch / cwd scope
- success criteria
- active owner
- current phase
- blockers
- linked actions
- linked checkpoints / sentinels
- current summary
- current risk / confidence
- last handoff packet

### Why This Matters

Without missions, the system can track work items.

With missions, the system can track actual objectives across:

- multiple turns
- multiple sessions
- multiple agents
- and pauses / handoffs

### Suggested Implementation Surface

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/missions.ts`
- `src/functions/actions.ts`
- `src/functions/frontier.ts`
- `src/functions/leases.ts`
- `src/functions/checkpoints.ts`
- `src/functions/sentinels.ts`
- `src/functions/routines.ts`
- `src/viewer/*`

### Acceptance Criteria

- a mission can own actions, checkpoints, sentinels, and leases
- a mission can compute its own status independently of any one action
- the viewer can render mission state directly
- a handoff can target a mission, not only an action

## Track 3: Handoff Packets

### Problem

Signals and leases exist, but they do not yet provide a truly durable,
high-signal handoff artifact for agent-to-agent or session-to-session transfer.

### Proposal

Add a generated `HandoffPacket` object.

Each packet should summarize:

- mission / action scope
- what is already known
- what changed recently
- relevant files / concepts
- open questions
- current blockers
- confidence
- next recommended step
- "do not redo" guidance

Sources should include:

- latest turn capsule
- working set
- linked actions
- checkpoints / sentinels
- relevant beliefs / lessons / crystals

### Why This Matters

Persistent coordination is where most memory systems fail.

The model may remember facts, but it still wastes turns re-establishing:

- where things stand,
- what is done,
- what is still risky,
- and what the next agent should touch.

### Suggested Implementation Surface

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/handoffs.ts`
- `src/functions/signals.ts`
- `src/functions/turn-capsules.ts`
- `src/functions/working-set.ts`
- `src/functions/frontier.ts`
- `src/functions/verify.ts`

### Acceptance Criteria

- a handoff packet can be generated for an action or mission
- a handoff packet can be delivered through `handoff` signals
- handoff packets are retrievable and auditable later
- retrieval can prefer the latest handoff packet when resuming work

## Track 4: Component Dossiers

### Problem

The system knows about:

- files,
- concepts,
- observations,
- and project profiles.

It does not yet have durable memory centered on the practical unit of coding
work:

- the file,
- module,
- subsystem,
- or symbol.

### Proposal

Add `ComponentDossier` objects for:

- files
- modules
- optionally symbols later

Each dossier should track:

- recent conclusions
- common failures
- local conventions
- dangerous edges
- dependencies / neighbors
- open debt
- recommended tests
- branch-specific drift when relevant

### Why This Matters

This is the shortest path from generic memory to codebase-native memory.

Agents often need:

- "what is weird about this file?"
- "what usually breaks here?"
- "which test should I run if I touch this?"

That is not the same as project profile and not the same as global semantic
memory.

### Suggested Implementation Surface

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/component-dossiers.ts`
- `src/functions/file-index.ts`
- `src/functions/branch-aware.ts`
- `src/functions/turn-capsules.ts`
- `src/functions/context.ts`

### Acceptance Criteria

- a file/module dossier can be built and updated incrementally
- retrieval can include dossier summaries when the query or tool payload names a
  matching file/module
- dossiers can carry branch-aware notes without polluting global memory

## Track 5: Decision Memory

### Problem

The temporal graph already extracts:

- reasoning
- alternatives
- sentiment

But there is still no clean first-class way to answer:

- what alternatives were rejected,
- why,
- and under what conditions that decision might change.

### Proposal

Introduce structured `DecisionRecord` memory.

Required fields:

- decision
- alternatives considered
- rejection reasons
- constraints that dominated
- expiration / reconsideration conditions
- evidence

### Why This Matters

This is the missing memory primitive for architectural continuity.

It prevents the classic loop:

- agent proposes an already rejected design
- humans re-explain the same tradeoff
- rejection rationale gets lost again

### Suggested Implementation Surface

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/decisions.ts`
- `src/functions/temporal-graph.ts`
- `src/functions/reflect.ts`
- `src/functions/context.ts`

### Acceptance Criteria

- a decision can cite alternatives and rejection reasons
- retrieval can surface a relevant prior decision when the same design space
  reappears
- outdated decisions can be superseded without losing history

## Track 6: Routine Compiler

### Problem

The repo already has routines and routine runs, but they are still largely
human-authored or explicit. The system does not yet learn routines from
successful work at scale.

### Proposal

Add a routine compiler that mines repeated successful action graphs and turns
them into proposed reusable routines.

Inputs:

- action chains
- crystals
- lessons
- checkpoints crossed
- outcomes and failures

Outputs:

- candidate routine
- confidence score
- preconditions
- success criteria
- risky branches

### Why This Matters

This turns memory into executable organizational leverage.

Instead of only remembering:

- "we often do X"

the system can propose:

- "this is now a routine, here are the steps, here are the gates, and here is
  when to use it."

### Suggested Implementation Surface

Likely files:

- `src/functions/routines.ts`
- `src/functions/actions.ts`
- `src/functions/crystallize.ts`
- `src/functions/lessons.ts`
- `src/functions/routine-compiler.ts`

### Acceptance Criteria

- the compiler can produce routine candidates from repeated successful chains
- candidates expose source evidence and confidence
- operators can freeze / reject / revise compiled routines

## Track 7: Retrieval Trace and Influence Feedback

### Problem

The retrieval engine is strong, but it is still hard to answer:

- why did this block get injected?
- what was skipped?
- did this memory actually help?

### Proposal

Add a retrieval trace and downstream influence loop.

Retrieval trace should expose:

- selected lane blocks
- skipped lane blocks
- dedupe collapses
- request budget
- tokens used
- final selected set

Influence loop should track:

- which memories were injected
- whether the turn later succeeded, failed, or dead-ended
- whether the injected memory should strengthen, weaken, or stay neutral

### Why This Matters

This is the shortest path to:

- trust
- debuggability
- and self-correcting retrieval

### Suggested Implementation Surface

Likely files:

- `src/functions/context.ts`
- `src/functions/verify.ts`
- `src/functions/retention.ts`
- `src/functions/access-tracker.ts`
- `src/state/schema.ts`
- `src/viewer/*`

### Acceptance Criteria

- every retrieval can produce an explainable trace
- access / injection telemetry feeds a usefulness signal
- memory strength can be updated from actual downstream use rather than only
  manual decay / reinforcement

## Track 8: Branch / PR Memory

### Problem

`branch-aware.ts` exists, but branch awareness is still mostly lookup rather
than first-class memory semantics.

### Proposal

Add branch-scoped memory packs and merge-time distillation.

Required capabilities:

- branch-local component dossiers
- branch-local decisions
- branch-local open blockers
- merge-time distillation into durable project memory
- conflict-memory for repeated merge hazards

### Why This Matters

Coding agents do real work in branches and worktrees. Memory that only thinks
in project-global terms will eventually blur:

- experiments
- WIP
- and merged truth

### Suggested Implementation Surface

Likely files:

- `src/functions/branch-aware.ts`
- `src/functions/component-dossiers.ts`
- `src/functions/decisions.ts`
- `src/functions/summarize.ts`
- `src/functions/consolidate.ts`

### Acceptance Criteria

- branch-local memory can be retrieved without contaminating global memory
- completed / merged branch knowledge can be distilled into durable memory
- repeated conflict areas can form their own durable guardrails

## Track 9: Negative Memory and Guardrails

### Problem

The system has lessons and sentinels, but it does not yet have a crisp
first-class negative-memory primitive for:

- anti-patterns
- forbidden edits
- dangerous sequences
- "never do X without Y"

### Proposal

Add `GuardrailMemory`.

Required fields:

- scope
- trigger conditions
- risk level
- explanation
- expiry / review conditions
- evidence

### Why This Matters

The fastest way to save agent turns is not only surfacing what works, but also
surfacing what reliably goes wrong.

### Suggested Implementation Surface

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/functions/guardrails.ts`
- `src/functions/context.ts`
- `src/functions/sentinels.ts`

### Acceptance Criteria

- guardrails can be retrieved by scope, file, concept, or mission
- a guardrail can expire or be superseded
- retrieval can surface negative memory without drowning positive context

## Prioritization

If only three tracks are funded in the next serious push, the highest-leverage
set is:

1. Belief graph and current-truth projection
2. Mission layer
3. Handoff packets

Why these three:

- they unlock better retrieval and better coordination simultaneously
- they compound with the strong substrate already in the repo
- they reduce the most repeated agent waste:
  - stale facts
  - confused ownership
  - poor handoffs

## Recommended Order

### Phase 1

- Belief graph
- Handoff packets
- Retrieval trace

This phase makes retrieval more trustworthy and more explainable.

### Phase 2

- Mission layer
- Branch / PR memory
- Negative memory / guardrails

This phase makes coordination and control durable.

### Phase 3

- Component dossiers
- Decision memory
- Routine compiler

This phase makes the system more codebase-native and more self-improving.

## What I Would Not Expand Next

Do not spend the next cycle primarily on:

- more generic search modes
- more MCP tools that are thin wrappers over existing primitives
- more hook events without stronger state models
- more graph extraction sophistication before belief projection exists

Those are not the highest-compounding bottlenecks anymore.

## Standard Of Done

This roadmap is succeeding when all of the following become true:

- the system can answer "what is currently true?" rather than only "what was
  once observed?"
- the system can carry a real objective across sessions and agents
- handoffs stop requiring a human-written recap
- branch-local work can remain local until it deserves promotion
- repeated successful workflows become executable routines
- repeated failure patterns become durable guardrails
- retrieval becomes explainable enough that operators can trust and tune it

## Suggested Immediate Deliverable

If the project wants one concrete next spec rather than a broad roadmap, the
best single next document would be:

- `docs/belief_graph_spec.md`

That is the most leverage-dense mechanism gap in the current repo.
