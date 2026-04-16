<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# OpenClaw Full Replace Spec

This document defines the agentmemory-side work required before agentmemory can
truthfully replace OpenClaw's `active-memory` and `memory-core` plugins without
material semantic loss.

`memory-wiki` may remain enabled, but a true replacement still has to preserve
the public seams and operator workflows that the current OpenClaw memory stack
provides.

This is a greenfield target for agentmemory-native design. It is not a request
to port OpenClaw memory internals line-for-line.

## Current Answer

Current agentmemory is not a full replacement.

It already covers:

- shared session lifecycle capture
- prompt-time context injection
- timeline and project profile generation
- semantic and procedural consolidation
- crystal generation for action-chain compression
- `MEMORY.md` export via the Claude bridge

It does not yet cover:

- grounded short-term promotion semantics
- the light / REM / deep dreaming model
- `DREAMS.md` and phase report artifacts
- grounded historical backfill and rollback
- OpenClaw-style `memory_search` / `memory_get` compatibility over live
  workspace files
- the public artifact contract expected by `memory-wiki` bridge mode

## Scope

In scope:

- everything needed so OpenClaw can disable `active-memory`
- everything needed so OpenClaw can disable `memory-core`
- enough artifact and shared-search parity so `memory-wiki` can keep working
  without depending on `memory-core`

Out of scope:

- replacing `memory-wiki`'s compiled-vault product entirely
- changing OpenClaw core to fit agentmemory's current semantics without parity
- declaring success because "recall seems good enough" while operator workflows
  still regress

## Design Principles

- Agentmemory-native state is the source of truth. The server's native store,
  indexes, and lifecycle state own memory behavior.
- Markdown artifacts are views, projections, sync targets, or ingest sources,
  not the primary runtime database.
- Preserve semantics, not implementation trivia. Matching the user and operator
  experience matters; copying OpenClaw file layouts and lock mechanics does not.
- Do not recreate `memory-core` internals such as `.dreams` storage formats,
  stale lock files, or file-backed promotion state unless no cleaner
  agentmemory-native design can satisfy the same contract.
- Replacement means OpenClaw can depend on agentmemory as a first-class memory
  runtime, not as a patchwork of adapters hiding a second memory system.

## Replacement Bar

Agentmemory is only a full replacement when all of the following are true:

1. OpenClaw can disable `active-memory` and `memory-core` in config with no
   major behavior cliff for the main agent.
2. Prompt-time recall, tool-time recall, and operator-time memory maintenance
   all still exist.
3. Durable promotion preserves grounded snippet semantics instead of replacing
   them with synthesis-only memory objects.
4. Existing workspace artifacts remain usable as stable agentmemory-projected
   or synchronized views:
   `MEMORY.md`, `memory/*.md`, `DREAMS.md`, and `memory/dreaming/*`.
5. `memory-wiki` bridge mode still has usable artifacts and provenance inputs,
   or agentmemory ships an equivalent public contract and migration path.
6. The new stack has an operator-visible diagnostic and repair story for stale
   state, failed sync, and contamination.

## Semantic Gap

The current semantic mismatch is not cosmetic.

| Current OpenClaw behavior | Current agentmemory behavior | Gap |
|---|---|---|
| Weighted promotion starts from short-term recall entries tied to specific source snippets, then rehydrates against the live daily note before writing to `MEMORY.md`. | Consolidation synthesizes semantic/procedural memory records from clustered observations. | Synthesis is not the same as grounded snippet promotion. |
| Dreaming has light / REM / deep phases, with separate human-readable artifacts and contamination guards. | Consolidation and crystals run as maintenance jobs. | Maintenance exists, but dreaming semantics do not. |
| Grounded historical backfill can preview, write, stage, and roll back diary/promote candidates. | No first-class grounded backfill lane exists. | Review and recovery workflow is missing. |
| `memory_search` / `memory_get` operate over workspace files and indexed transcripts with path + line semantics. | `memory_recall` and `memory_save` are server-native abstractions; Claude bridge sync exports a rendered `MEMORY.md`. | File-native recall contract is missing. |
| `memory-wiki` bridge mode consumes public artifacts from the active memory plugin. | No equivalent OpenClaw public artifact contract is exposed today. | Wiki bridge parity is missing. |

## Required Deliverables

### 1. Native OpenClaw Plugin

Ship a modern OpenClaw-native plugin in this repository instead of the legacy
`integrations/openclaw` drop-in.

Required capabilities:

- current OpenClaw plugin manifest and entrypoint shape
- hooks for `session_start`, `before_prompt_build`, `after_tool_call`,
  `session_end`, and any prompt/tool persistence seams needed for parity
- explicit config for service URL, auth secret, token budget, scoping, and
  duplicate-injection controls
- clean coexistence rules so enabling the plugin while `active-memory` or
  `memory-core` is still present does not double-inject recall

Likely touchpoints:

- `integrations/openclaw/`
- `README.md`
- new tests for OpenClaw plugin lifecycle behavior

### 2. OpenClaw-Facing Recall Interface

Provide an OpenClaw-facing recall interface backed by agentmemory-native state.

Minimum bar:

- `memory_search` equivalent behavior over workspace memory sources
- `memory_get` equivalent behavior for targeted snippet reads
- support for path + line-oriented citations, not only opaque memory IDs
- corpus behavior compatible with OpenClaw expectations for `memory`, and
  enough extensibility for `wiki` / `all` interop

This can be implemented as:

- native OpenClaw tools exposed by the new plugin
- agentmemory MCP/REST functions used internally by that plugin

It should not require OpenClaw prompts and skills to be rewritten just to keep
basic memory usage working.

### 3. Artifact Projection And Workspace Bridge

Implement a real workspace bridge instead of a one-way export.

The source of truth should stay in agentmemory-native state. Workspace markdown
should be projected from, or reconciled with, that state.

Required semantics:

- ingest `MEMORY.md` and `memory/*.md` as first-class external sources when
  present
- preserve source identity so recalls can point back to exact file locations
- two-way sync policy with conflict handling
- stable markers or fingerprints for promoted entries so repeat syncs and
  dedupe are reliable
- explicit source-of-truth rules for generated versus human-edited content

The current Claude bridge in
[`src/functions/claude-bridge.ts`](../src/functions/claude-bridge.ts) is not
enough. It exports a rendered file, but it does not provide full grounded file
semantics.

### 4. Grounded Durable Promotion

Implement an agentmemory-native grounded promotion subsystem that preserves the
important semantics of OpenClaw promotion without cloning its internal file
formats.

Required behavior:

- store and update short-term recall traces keyed to concrete snippets
- rank candidates using recall frequency, score, diversity, recency, and
  consolidation-style reinforcement
- rehydrate candidates from the live source file before durable write
- skip deleted, moved, or contaminated snippets
- append promoted candidates into `MEMORY.md` with stable markers
- expose an explain/debug path for why a candidate does or does not promote

This is the core feature that makes current OpenClaw `memory-core` semantics
meaningfully different from consolidation.

### 5. Dreaming And Reflection Lifecycle

Implement a first-class agentmemory lifecycle for dreaming/reflection and
durable promotion instead of treating consolidation as "close enough."

Required behavior:

- light phase for recent short-term staging
- REM phase for pattern/reflection generation
- deep phase for durable promotion decisions
- contamination guards so dream-generated artifacts do not recursively seed
  future promotion
- managed background scheduling with health-aware pause behavior

Required artifacts:

- `DREAMS.md` diary output
- optional phase reports under `memory/dreaming/<phase>/YYYY-MM-DD.md`
- agentmemory-native machine state that covers the current short-term store,
  phase signals, and checkpoints semantics without requiring the same on-disk
  layout

### 6. Historical Replay And Grounded Review Lane

Implement an agentmemory-native review and recovery lane for historical daily
notes.

Required behavior:

- preview grounded diary/promote output from historical `YYYY-MM-DD.md` notes
- write reversible backfill entries
- stage grounded candidates into the same promotion pipeline used by normal
  deep promotion
- rollback written diary entries
- rollback staged short-term candidates independently

Without this, agentmemory still lacks a full replacement for the operator lane
used to inspect and replay older notes safely.

### 7. Public Artifact Feed For `memory-wiki`

Expose a public artifact feed that gives `memory-wiki` the same effective input
surface it currently gets from the active memory plugin.

Required artifact classes:

- memory root artifact
- daily note artifacts
- dream report artifacts
- memory event log or equivalent public event stream

Required behavior:

- stable artifact discovery for one or more workspaces
- public-only paths so wiki bridge mode does not need private store access
- enough provenance to preserve `memory-wiki`'s source pages and dashboards

### 8. Operator Status, Repair, And Migration

A full replace needs operator trust, not just model recall.

Required behavior:

- inspect current memory health, sync state, and workspace bridge status
- detect stale locks, unreadable stores, sync drift, and contamination
- repair fixable problems
- migrate existing OpenClaw memory state into agentmemory-backed state
- support dual-run burn-in mode before cutover

Existing agentmemory diagnostics, heal, consolidation, and crystal tools are a
good base, but they do not yet cover OpenClaw-specific memory-state parity.

## Suggested Repo Workstreams

| Workstream | What must be added or changed |
|---|---|
| OpenClaw plugin | Replace legacy integration with a modern native plugin package and tests. |
| Artifact projection | Add ingest + sync code for workspace memory artifacts, while keeping native state authoritative. |
| Promotion | Add a grounded short-term recall and promotion subsystem with ranking, explain, apply, and rehydrate logic. |
| Dreaming | Add a native phase orchestration and artifact projection lifecycle with contamination controls. |
| Backfill | Add grounded preview/write/stage/rollback workflow for historical daily notes. |
| Public artifact feed | Expose OpenClaw-compatible public artifacts for wiki bridge mode. |
| Diagnostics | Extend health and repair paths to cover bridge drift, promotion state, and dreaming state. |

## Acceptance Criteria

Do not call this complete until the following are true:

- OpenClaw runs with `active-memory` disabled.
- OpenClaw runs with `memory-core` disabled.
- Prompt-time recall still works through the agentmemory plugin.
- Tool-time recall still works through `memory_search` / `memory_get`
  compatible behavior.
- Server-native promotion state writes grounded entries into `MEMORY.md`.
- Dreaming outputs write to `DREAMS.md` and phase reports.
- Grounded historical backfill can preview, apply, and roll back.
- `memory-wiki` bridge mode still sees usable memory artifacts.
- There are tests proving the new semantics, not just smoke docs.

## Recommended Cutover Sequence

1. Build the native OpenClaw plugin and run it in parallel with current
   `memory-core`, but with recall injection disabled.
2. Enable dual-write / dual-observe mode and validate source mapping,
   contamination controls, and `MEMORY.md` sync behavior.
3. Cut prompt-time recall from `active-memory` to agentmemory.
4. Implement grounded promotion and dreaming parity.
5. Implement grounded backfill and rollback.
6. Validate `memory-wiki` artifact compatibility.
7. Only then disable `memory-core`.

## Non-Goals

These do not count as completion:

- "recall feels better"
- "the viewer looks richer"
- "consolidation exists"
- "we can export something to `MEMORY.md`"
- "OpenClaw can technically boot with the plugin enabled"
- "we copied the old `.dreams` file layout into agentmemory"

The bar is semantic replacement, not partial overlap.
