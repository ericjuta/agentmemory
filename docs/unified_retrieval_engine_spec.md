<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Unified Retrieval Engine Spec

## Goal

Define the long-term retrieval end state for `agentmemory`:

- one retrieval engine
- one indexed retrieval unit
- embedding-first ranking
- no separate ranking stacks for `context`, `enrich`, and search

This document is intentionally an end-state contract, not a staged rollout plan.

## Problem

The repository currently has useful retrieval pieces, but they are still split
across multiple paths:

- `mem::context` assembles bespoke hot / warm / cold blocks with mostly lexical
  query overlap and recency logic
- `mem::enrich` uses a separate lightweight path
- `mem::search` remains BM25-oriented
- `mem::smart-search` uses hybrid BM25 + vector + graph over compressed
  observations, but not over the full context surface

That split creates three structural problems:

1. relevance quality is inconsistent by caller
2. embeddings are not the system of record for context injection
3. the same memory objects are reformatted and re-ranked differently depending
   on which endpoint asked for them

## Decision

`agentmemory` should converge on one unified retrieval engine backed by
canonical retrieval blocks.

The unified engine should own:

- candidate generation
- ranking
- dedupe
- lane-aware token packing
- explainability / retrieval trace

All user-facing retrieval surfaces should become thin adapters over that shared
engine:

- `mem::context`
- `mem::enrich`
- `mem::search`
- `mem::smart-search`
- `POST /agentmemory/context`
- `POST /agentmemory/context/refresh`
- `POST /agentmemory/enrich`

Codex or any other caller should decide when to retrieve and what intent to
send, but not re-rank retrieved memory independently.

## Non-Goals

- pure vector-only retrieval
- a second Codex-side reranker
- keeping `mem::enrich` as a permanently separate retrieval implementation
- treating raw observations as the long-term retrieval unit for all cases
- requiring one endpoint per memory type

## Design Principles

1. One block, many callers.
2. Embeddings are first-class, not an afterthought.
3. Exact lexical matches still matter for code, file paths, identifiers, and
   error strings.
4. Graph expansion is supporting evidence, not a separate product.
5. Freshness, durability, and resume state should be expressed as metadata on
   the same indexed block model.
6. Retrieval trace must explain semantic and lexical wins, not only lane
   selection.

## Canonical Retrieval Unit

### Retrieval Block

Every retrievable object should compile to one or more `RetrievalBlock` rows.

Examples:

- turn capsules
- working-set snapshots
- session summaries
- consolidated memories
- semantic / procedural memory
- guardrails
- decisions
- component dossiers
- handoff packets
- branch overlays
- selected high-signal observations where no stronger higher-level block exists

### Required Shape

Suggested `src/types.ts` addition:

```ts
export interface RetrievalBlock {
  id: string;
  sourceType:
    | "turn_capsule"
    | "working_set"
    | "session_summary"
    | "memory"
    | "semantic_memory"
    | "procedural_memory"
    | "guardrail"
    | "decision"
    | "dossier"
    | "handoff"
    | "branch_overlay"
    | "observation"
    | "profile";
  sourceId: string;
  project: string;
  branch?: string;
  sessionId?: string;
  turnId?: string;
  scope: "session" | "branch" | "project" | "global";
  freshnessLane: "hot" | "warm" | "cold";
  canonicalText: string;
  title: string;
  files: string[];
  concepts: string[];
  entities: string[];
  sourceObservationIds: string[];
  hadFailure: boolean;
  hadDecision: boolean;
  hadAssistantConclusion: boolean;
  isResumeArtifact: boolean;
  importance: number;
  createdAt: string;
  updatedAt: string;
  eventAt: string;
  embeddingModel?: string;
  embeddingVersion?: string;
}
```

### Important Consequences

- all retrieval callers operate over the same object model
- lane membership is block metadata, not a separate retrieval pipeline
- blocks can be re-rendered differently for different callers without being
  re-ranked differently

## Storage Model

### KV / Schema

Suggested `src/state/schema.ts` additions:

- `mem:retrieval-blocks`
- `mem:retrieval-blocks-by-source`
- `mem:retrieval-embeddings:{blockId}` or equivalent embedding storage keyed by
  retrieval block id

Suggested rules:

- retrieval blocks are keyed by `block.id`
- every producer owns deterministic `sourceType + sourceId -> block id` mapping
- deletion / eviction must remove both block rows and index membership

### Indexes

The shared retrieval engine should index retrieval blocks into:

- lexical index
- vector index
- graph/entity lookup surface

This implies generalizing current search infra away from
`CompressedObservation`-only assumptions.

Likely existing files to refactor:

- `src/state/search-index.ts`
- `src/state/vector-index.ts`
- `src/state/hybrid-search.ts`
- `src/state/index-persistence.ts`

## Block Producers

Every major memory surface should upsert retrieval blocks at write time.

Likely producers:

- `src/functions/compress.ts`
- `src/functions/turn-capsules.ts`
- `src/functions/working-set.ts`
- `src/functions/summarize.ts`
- `src/functions/consolidate.ts`
- `src/functions/beliefs.ts`
- `src/functions/guardrails.ts`
- `src/functions/decisions.ts`
- `src/functions/component-dossiers.ts`
- `src/functions/handoffs.ts`
- `src/functions/branch-aware.ts`
- `src/functions/profile.ts`

Recommended new shared helper:

- `src/functions/retrieval-blocks.ts`

Responsibilities:

- format canonical retrieval text
- normalize files / concepts / entities
- assign freshness lane
- compute deterministic block identity
- persist block row
- generate / refresh embedding
- update lexical / vector indexes

## Embedding Contract

Embeddings should be generated for retrieval blocks, not only for raw or
compressed observations.

### Required End-State Behavior

- if an embedding provider is configured, every retrieval block gets an
  embedding at create/update time
- if embedding generation fails, the block remains retrievable lexically, but is
  marked as missing-vector for repair
- re-embedding can happen when:
  - the block text changes
  - the provider changes
  - the embedding version changes

### Why Block-Level Embeddings

This keeps semantic ranking aligned with what the model will actually receive:

- a capsule embeds the capsule text
- a handoff embeds the handoff text
- a guardrail embeds the guardrail text

instead of embedding one lower-level source and hoping the caller reconstructs
the right higher-level context later.

## Retrieval Intent

All retrieval callers should compile their request to one shared intent shape.

Suggested `RetrievalIntent`:

```ts
export interface RetrievalIntent {
  reason: "session_start" | "user_turn" | "pre_tool" | "manual_recall" | "search";
  query?: string;
  files: string[];
  concepts: string[];
  entities: string[];
  toolName?: string;
  toolCapability?: "file_read" | "file_search" | "file_write" | "patch";
  project: string;
  branch?: string;
  sessionId?: string;
  turnId?: string;
  preferResumeArtifacts: boolean;
  budgetTokens: number;
}
```

Intent compilation should be caller-specific.
Ranking should not be.

## Candidate Generation

The unified engine should assemble one candidate set from four sources:

1. metadata-exact candidates
   - same session
   - same branch
   - same file
   - same concept
   - resume artifacts
2. lexical candidates
   - BM25 / exact token matches
3. vector candidates
   - nearest retrieval blocks by embedding similarity
4. graph candidates
   - entity-linked blocks

These are candidate generators, not final rankers.

## Ranking Model

### Rule

Final ranking should be embedding-first with explicit structured boosts.

### Required Signals

- vector similarity
- exact file overlap
- exact basename/path overlap
- concept overlap
- entity overlap
- same-session affinity
- same-branch affinity
- recency
- importance
- failure present
- decision present
- assistant conclusion present
- resume artifact present when intent prefers resume

### Required Demotions

- low-signal routine `pre_tool_use`
- stale blocks superseded by stronger newer blocks from the same source family
- duplicate/near-duplicate blocks already covered by a stronger block
- noisy shell churn without meaningful outcome

### Important Constraint

Lexical exact-match features must remain strong enough that:

- file paths
- identifiers
- stack traces
- error strings
- short code terms

still retrieve correctly even when embedding similarity is weak.

## Lane-Aware Packing

Hot / warm / cold should remain in the end state, but as packing constraints
over unified ranked blocks, not as isolated retrieval implementations.

That means:

- blocks carry `freshnessLane`
- ranking happens across the full candidate set
- packing enforces lane budgets
- leftover fill can reclaim unused budget across lanes

`mem::context` and `mem::enrich` should differ mainly in:

- intent
- token budget
- output formatting

not in how relevance is computed.

## Output Surfaces

### `mem::context`

Should:

- call unified retrieval with context intent
- pack blocks into XML/context output
- include retrieval trace with vector / lexical / graph contribution summaries

### `mem::enrich`

Should:

- stop hand-assembling `file-context + search + bug memory`
- call unified retrieval with pre-tool intent
- return a smaller packed context window from the same ranked block set

### `mem::search`

Should:

- stop being BM25-only in end state
- become a formatting/view over unified retrieval results
- preserve its existing response shapes where possible

### `mem::smart-search`

Should:

- become a compact result mode of the same engine
- not own a separate ranking truth from `context`

## Retrieval Trace

Trace must evolve from lane-only explainability to ranking explainability.

Suggested additions:

- vector similarity score
- lexical score
- graph score
- exact file overlap count
- exact concept overlap count
- session / branch affinity markers
- producer source type
- block freshness lane
- final packed / skipped reason

This trace should be the debugging surface for:

- why a block was selected
- why a semantically close block lost
- why a duplicate block was suppressed
- why a pre-tool inject and a user-turn inject differed

## API / Type Surface Changes

Likely files:

- `src/types.ts`
- `src/state/schema.ts`
- `src/state/search-index.ts`
- `src/state/vector-index.ts`
- `src/state/hybrid-search.ts`
- `src/functions/retrieval-blocks.ts`
- `src/functions/context.ts`
- `src/functions/enrich.ts`
- `src/functions/search.ts`
- `src/functions/smart-search.ts`
- `src/functions/query-expansion.ts`
- `src/functions/graph-retrieval.ts`
- `src/index.ts`
- `test/context.test.ts`
- `test/enrich.test.ts`
- `test/search.test.ts`
- `test/smart-search.test.ts`
- `test/hybrid-search.test.ts`

## Acceptance Criteria

The end state is reached when all of the following are true:

1. every major retrievable memory surface upserts canonical retrieval blocks
2. retrieval blocks, not only observations, are embedded and indexed
3. `mem::context`, `mem::enrich`, `mem::search`, and `mem::smart-search` all
   use one retrieval engine
4. pre-tool injection and user-turn retrieval differ by intent and budget, not
   by unrelated ranking stacks
5. retrieval trace explains semantic, lexical, graph, and packing decisions
6. exact file / identifier / error-string recall still works without relying on
   embedding similarity alone
7. Codex can remain a thin caller and never needs to add its own reranker

## Explicit Rejections

Do not treat any of these as the end state:

- query embedding over the current bespoke `mem::context` block list without
  unifying storage
- pure vector retrieval with lexical fallback bolted on later
- keeping `mem::enrich` permanently separate because it is "smaller"
- pushing ranking policy into Codex
- embedding only raw observations while higher-level retrieval still happens on
  reconstructed text

## Short Version

The long-term target is:

- compile all meaningful memory objects into canonical retrieval blocks
- embed those blocks
- index those blocks once
- retrieve those blocks through one engine
- let every caller format from the same ranked truth

That is the clean end state.
