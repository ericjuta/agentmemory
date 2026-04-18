<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Handoff Packets Spec

## Goal

Create a durable, generated handoff artifact for resuming work across sessions
or agents without relying on a human-written recap.

This spec depends on:

- working set
- turn capsules
- frontier
- and ideally belief projection

## Problem

Signals and leases exist, but they are not enough to carry a high-signal
summary of:

- current objective
- what changed
- what is blocked
- what should happen next

That causes repeated resume overhead.

## Scope

This v1 spec covers:

- packet generation
- storage
- retrieval
- optional signal delivery linkage

This v1 spec does not cover:

- auto-injecting packets into every turn
- mandatory packet generation for every session

## Data Model

Add to `src/types.ts`:

- `HandoffPacket`

Required fields:

- `id`
- `createdAt`
- `updatedAt`
- `project`
- `scopeType`
  - `action`
  - `mission`
  - `session`
- `scopeId`
- `summary`
- `recentChanges`
- `knownFacts`
- `relevantFiles`
- `relevantConcepts`
- `blockers`
- `openQuestions`
- `recommendedNextStep`
- `confidence`
- `sourceObservationIds`
- `sourceActionIds`
- `sourceBeliefIds?`

## Storage

Add KV scope in `src/state/schema.ts`:

- `handoffPackets: "mem:handoff-packets"`

## Generation Rules

Add `src/functions/handoffs.ts`.

Required function:

- `mem::handoff-generate`

Input:

- `scopeType`
- `scopeId`
- `project?`

Generation sources:

- latest turn capsule
- latest working set
- linked actions
- frontier / next
- checkpoints / sentinels
- beliefs when available

Packet generation should be deterministic in v1:

- no mandatory LLM summarization
- compose from structured state first

## Retrieval

Required functions:

- `mem::handoff-get`
- `mem::handoff-list`

### `mem::handoff-get`

Input:

- `handoffPacketId`

### `mem::handoff-list`

Input:

- `scopeType?`
- `scopeId?`
- `project?`
- `limit?`

## Signal Integration

Optional but recommended in v1:

- allow `Signal.type = "handoff"` to point at a `handoffPacketId`

Do not mutate signal semantics beyond adding packet linkage.

## REST Surface

Add endpoints in `src/triggers/api.ts`:

- `POST /agentmemory/handoffs/generate`
- `GET /agentmemory/handoffs`
- `GET /agentmemory/handoffs/:id`

## Retrieval Integration

Update `src/functions/context.ts` later so:

- latest matching handoff packet may be included as a context block for resume
  style queries

Do not add that until handoff packet quality is stable.

## Tests

Add:

- `test/handoffs.test.ts`

Required cases:

- packet generation for action scope
- packet generation for session scope
- packets include current blockers and next step
- packets are retrievable and listable

## Acceptance Criteria

- a generated handoff packet exists as durable state
- packets can summarize current work without human-written recap
- handoff packet retrieval is stable and auditable
