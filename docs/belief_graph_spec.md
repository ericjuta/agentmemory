<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Belief Graph Spec

## Goal

Add a first-class belief layer that projects current truth from existing
memory and relation primitives without destroying historical evidence.

This is the first implementation slice from
[`memory_mechanisms_implementation_spec.md`](./memory_mechanisms_implementation_spec.md).

## Problem

The repo already stores:

- `Memory`
- `MemoryRelation`
- supersession lineage
- verification citations

What it cannot answer directly is:

- which claim is current
- what evidence supports it
- what contradicts it
- why retrieval should prefer one claim over another

That gap causes agents to retrieve stale or conflicting facts as if they were
equally current.

## Scope

This v1 spec covers:

- beliefs built from existing memories
- support / contradiction / supersession evidence
- current-truth projection
- retrieval of current projected beliefs

This v1 spec does not cover:

- autonomous belief extraction from every observation
- branch-local belief overlays
- mission-owned beliefs

## Data Model

Add to `src/types.ts`:

- `Belief`
- `BeliefEvidence`
- `BeliefProjection`

### Belief

Required fields:

- `id`
- `createdAt`
- `updatedAt`
- `project`
- `claim`
- `normalizedClaim`
- `status`
  - `active`
  - `superseded`
  - `contradicted`
  - `uncertain`
- `confidence`
- `supportingMemoryIds`
- `contradictingMemoryIds`
- `supersededByBeliefId?`
- `supersedesBeliefIds`
- `sourceTypes`
- `files`
- `concepts`

### BeliefEvidence

Required fields:

- `memoryId`
- `relationType`
  - `supports`
  - `contradicts`
  - `supersedes`
- `weight`
- `createdAt`

### BeliefProjection

Required fields:

- `beliefId`
- `claim`
- `status`
- `confidence`
- `supportCount`
- `contradictionCount`
- `superseded`
- `files`
- `concepts`

## Storage

Add KV scopes in `src/state/schema.ts`:

- `beliefs: "mem:beliefs"`
- `beliefEvidence: "mem:belief-evidence"`

## Derivation Rules

Initial belief creation should be conservative.

### Rule 1

Every latest memory can seed at most one belief candidate.

Seed input:

- `memory.title`
- `memory.content`
- `memory.type`
- `memory.files`
- `memory.concepts`

### Rule 2

`normalizedClaim` should be a deterministic normalization of the claim text:

- trim whitespace
- lowercase
- collapse repeated spaces

Do not use embeddings or LLM normalization in v1.

### Rule 3

Supersession handling:

- if memory `B` supersedes memory `A`
- then the belief seeded from `B` supersedes the belief seeded from `A`
- the older belief remains stored with status `superseded`

### Rule 4

Contradiction handling:

- if a `MemoryRelation` of type `contradicts` exists between source and target
  memories
- then beliefs seeded from those memories gain contradiction evidence
- contradiction does not delete either belief

### Rule 5

Confidence scoring should be deterministic and simple in v1:

Base score:

- start at `0.5`

Add:

- latest memory source: `+0.2`
- supporting evidence count capped at `+0.2`
- contradiction count penalty capped at `-0.2`
- explicit superseded status forces `status = superseded`

Clamp to `[0, 1]`.

## Functions

Add `src/functions/beliefs.ts`.

Required functions:

- `mem::belief-project`
- `mem::belief-get`
- `mem::belief-list`

### `mem::belief-project`

Purpose:

- derive or refresh beliefs for a project from `Memory` and `MemoryRelation`

Input:

- `project?: string`
- `memoryIds?: string[]`
- `force?: boolean`

Output:

- `success`
- `beliefCount`
- `updatedBeliefIds`

### `mem::belief-get`

Purpose:

- return one belief plus supporting and contradicting evidence

Input:

- `beliefId`

Output:

- `success`
- `belief`
- `projection`
- `supportingMemories`
- `contradictingMemories`

### `mem::belief-list`

Purpose:

- list projected current truths for a project

Input:

- `project?: string`
- `status?: string`
- `limit?: number`

Output:

- `success`
- `beliefs`

## Retrieval Integration

Update `src/functions/context.ts`.

New behavior:

- when context is built for a project, current active beliefs may contribute a
  new context block type
- belief blocks should rank above stale non-latest memories when the claim
  overlaps the query or current working set concepts

Do not let beliefs crowd out:

- latest turn capsule
- latest working set

Priority rule:

1. current turn / working set freshness
2. active belief projection
3. historical memory

## Verification Integration

Update `src/functions/verify.ts`.

New behavior:

- verifying a belief should explain:
  - why it is active / superseded / contradicted
  - which memories support it
  - which memories contradict it

## REST Surface

Add endpoints in `src/triggers/api.ts`:

- `POST /agentmemory/beliefs/project`
- `GET /agentmemory/beliefs`
- `GET /agentmemory/beliefs/:id`

## MCP Surface

Do not add MCP tools in v1.

Reason:

- stabilize internal data model and retrieval behavior first

## Audit

All state-changing belief operations must write audit entries.

New audit operations needed:

- `belief_project`
- `belief_update`

## Tests

Add:

- `test/beliefs.test.ts`

Required cases:

- latest memory seeds active belief
- superseded memory becomes superseded belief
- contradiction evidence downgrades confidence but does not delete belief
- list returns current active beliefs only by default
- verify explains support and contradiction

## Acceptance Criteria

- beliefs persist separately from raw memories
- superseded and contradicted claims remain historically inspectable
- retrieval can prefer active projected beliefs over stale latest=false memory
- belief verification explains the current-truth projection
