<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Mission Layer Spec

## Goal

Introduce a first-class mission object that groups actions, leases,
checkpoints, sentinels, and routines into one persistent objective container.

This is phase two work and depends on belief projection existing first.

Status:

- implemented in the live backend on April 20, 2026

## Problem

The repo already has strong mechanism primitives:

- actions
- frontier
- next
- leases
- checkpoints
- sentinels
- routines
- sketches
- signals

But they are still adjacent primitives, not one durable objective model.

That means the system can answer:

- what actions exist

more easily than:

- what objective is underway
- who owns it
- what phase it is in
- whether it is blocked

## Scope

This v1 spec covers:

- mission container
- mission ownership of existing mechanism primitives
- mission status projection

This v1 spec does not cover:

- autonomous mission creation from every user turn
- nested mission hierarchies

## Data Model

Add to `src/types.ts`:

- `Mission`
- `MissionRun`

### Mission

Required fields:

- `id`
- `createdAt`
- `updatedAt`
- `project`
- `cwd?`
- `branch?`
- `goal`
- `successCriteria`
- `status`
  - `draft`
  - `active`
  - `blocked`
  - `completed`
  - `cancelled`
- `phase`
- `owner`
- `summary`
- `risk`
- `confidence`
- `actionIds`
- `checkpointIds`
- `sentinelIds`
- `leaseIds`
- `routineIds`
- `latestHandoffPacketId?`

### MissionRun

Required fields:

- `id`
- `missionId`
- `startedAt`
- `updatedAt`
- `endedAt?`
- `actor`
- `status`
- `notes`

## Storage

Add KV scopes in `src/state/schema.ts`:

- `missions: "mem:missions"`
- `missionRuns: "mem:mission-runs"`

## Functions

Add `src/functions/missions.ts`.

Required functions:

- `mem::mission-create`
- `mem::mission-update`
- `mem::mission-get`
- `mem::mission-list`

### `mem::mission-create`

Input:

- `goal`
- `project`
- `cwd?`
- `branch?`
- `successCriteria?: string[]`
- `owner?: string`

Behavior:

- create mission in `draft` or `active`
- audit creation

### `mem::mission-update`

Input:

- `missionId`
- partial fields:
  - `status`
  - `phase`
  - `summary`
  - `risk`
  - `confidence`
  - `owner`

Behavior:

- update mission atomically
- audit update

### `mem::mission-get`

Input:

- `missionId`

Output:

- mission
- linked actions
- linked checkpoints
- linked sentinels
- derived status summary

### `mem::mission-list`

Input:

- `project?`
- `status?`
- `owner?`
- `limit?`

Output:

- missions sorted by `updatedAt desc`

## Existing Primitive Integration

Do not replace existing actions or checkpoints.

Instead:

- add optional `missionId` field to:
  - `Action`
  - `Checkpoint`
  - `Sentinel`
  - `Lease`
  - `Routine`

Linkage rules:

- linkage is optional
- mission summary derives from linked primitives

## Status Projection

Mission status should be derived conservatively:

- `completed`
  - all required actions done and no open blocking checkpoints
- `blocked`
  - at least one active blocking checkpoint or sentinel-triggered block
- `active`
  - work is in progress and not blocked
- `draft`
  - no active run and no linked active actions

Do not compute status from beliefs in v1 beyond copying mission confidence.

## Viewer

Add viewer support only after function and REST layers are stable.

Required viewer card:

- goal
- status
- phase
- owner
- blockers
- linked action count

## REST Surface

Add endpoints in `src/triggers/api.ts`:

- `POST /agentmemory/missions`
- `POST /agentmemory/missions/update`
- `GET /agentmemory/missions`
- `GET /agentmemory/missions/:id`

## MCP Surface

Do not add MCP tools in v1.

## Tests

Add:

- `test/missions.test.ts`

Required cases:

- mission create/update/list/get
- mission status derives from linked action/checkpoint state
- blocked checkpoints force mission blocked
- completed required actions can mark mission completed

## Acceptance Criteria

- mission state exists independently of any one action
- existing primitives can link to missions without migration pain
- mission retrieval returns a durable objective summary
