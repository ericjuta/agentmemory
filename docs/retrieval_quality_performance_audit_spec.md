# Retrieval Quality And Performance Audit Implementation Spec

## Goal

Define the implementation plan for hardening unified retrieval so it returns
current, scoped, relevant context without avoidable hot-path latency or worker
load.

This spec turns the 2026-04-24 retrieval audit into concrete engineering work.

## Scope

This spec covers:

- retrieval-block lifecycle correctness
- scope membership correctness and scalability
- retrieval-block index drift detection and repair
- MCP recall/search scoping
- vector, graph, fallback, and retry hot-path performance
- relevance thresholds and project leakage risks
- test and validation coverage for the above

This spec does not cover:

- replacing iii-engine or StateKV
- changing the public memory model beyond fields needed for retrieval scoping
- building a new retrieval UI
- changing Codex-side caller behavior except where MCP tool contracts need
  better backend arguments

## Current Audit Summary

The unified retrieval architecture is the right direction: `mem::context`,
`mem::search`, `mem::smart-search`, and `mem::enrich` now use
`retrieveRelevantBlocks()` over canonical retrieval blocks.

The remaining gaps are mostly not conceptual. They are correctness and
operational hardening issues:

- stale retrieval blocks can outlive source truth
- scope membership can be partial while reported complete
- retrieval-block indexes are not drift-verified
- MCP recall/search omit scoping fields
- graph and vector retrieval are still global scans
- fallback and retry paths can burst KV/provider load
- some relevance rules are too permissive

## Implementation Priorities

### P0. Keep Retrieval Blocks In Sync With Source State

Problem:

- `mem::decision-save` marks superseded decisions as `superseded`, but only
  upserts the new active decision block.
- `mem::guardrail-save` marks superseded guardrails as `superseded`, but only
  upserts the new active guardrail block.
- `expireElapsedGuardrails()` marks elapsed guardrails as `expired`, but leaves
  old retrieval blocks in storage and indexes.

Code anchors:

- `src/functions/decisions.ts`
- `src/functions/guardrails.ts`
- `src/functions/retrieval-blocks.ts`
- `src/functions/retrieval-engine.ts`

End state:

- Active guardrails and decisions have retrieval blocks.
- Superseded or expired guardrails and decisions do not remain retrievable as
  active context.
- Cache invalidation happens whenever these retrieval blocks are deleted or
  replaced.

Implementation:

1. Import `deleteStoredRetrievalBlock()` and `retrievalBlockId()` where status
   transitions happen.
2. When a decision is superseded, delete
   `retrievalBlockId("decision", superseded.id)`.
3. When a guardrail is superseded or expired, delete
   `retrievalBlockId("guardrail", guardrail.id)`.
4. Ensure delete failures are best-effort but logged or surfaced enough for
   diagnostics.
5. Keep `listScopedGuardrails()` and `listScopedDecisions()` behavior unchanged:
   they remain source-of-truth filters.

Tests:

- saving a superseding decision removes the old decision retrieval block
- saving a superseding guardrail removes the old guardrail retrieval block
- an elapsed guardrail is expired and removed from retrieval blocks
- context/search no longer returns the stale block after status transition

### P0. Make Scope Membership Correct Before Trusting It

Problem:

- `writeScopeEntry()` swallows `kv.set()` failures.
- `upsertRetrievalBlockScopeMembership()` can partially update scope arrays.
- `loadScopedRetrievalBlocks()` can return `complete: true` even when requested
  scope entries are missing or stale.
- `retrieveRelevantBlocks()` trusts that complete result and may skip fallback.

Code anchors:

- `src/functions/retrieval-block-scope-index.ts`
- `src/functions/retrieval-engine.ts`
- `src/functions/retrieval-blocks.ts`

End state:

- A scoped retrieval read is complete only when every requested scope has a
  valid membership view for the current generation.
- Write failures do not silently mark the scope index ready.
- Partial scope membership degrades to a safer read path instead of omitting
  relevant blocks.

Implementation:

1. Stop swallowing write errors inside `writeScopeEntry()`.
2. Add a scope-index metadata record with a generation or updated-at marker.
3. Mark ready only after all scope writes for an upsert/warm pass succeed.
4. In `loadScopedRetrievalBlocks()`, return `complete: false` when any requested
   scope entry is missing while the index claims to be ready.
5. Consider storing per-scope update health in diagnostics so operators can see
   membership failures.
6. Keep the fallback path bounded so a bad scope index does not create a full
   KV storm.

Tests:

- missing project scope returns `complete: false`
- failed membership write prevents ready state from being trusted
- retrieval falls back and still finds a block when scope membership is partial
- stale/missing block IDs are pruned without losing valid IDs

### P0. Add Retrieval-Block Index Drift Detection And Repair

Problem:

- Startup loads persisted retrieval BM25/vector indexes if present.
- Startup explicitly logs that retrieval-block inspection is skipped.
- `Index verify` only checks the older observation index, not retrieval blocks.
- If persisted retrieval indexes are missing, stale, or partial, unified
  retrieval can degrade until enough writes rebuild the indexes indirectly.

Code anchors:

- `src/index.ts`
- `src/state/retrieval-block-indexing.ts`
- `src/state/index-persistence.ts`
- `src/functions/retrieval-blocks.ts`

End state:

- The worker periodically verifies retrieval-block index size and vector
  coverage against `KV.retrievalBlocks`.
- Drift repair is bounded and adaptive.
- Repair does not run as a blocking startup rebuild.

Implementation:

1. Add a retrieval index verification maintenance task next to current
   observation `Index verify`.
2. Count stored retrieval blocks and compare with retrieval BM25 size.
3. If an embedding provider exists, compare vector size against blocks with
   expected embeddings.
4. Rebuild with `rebuildRetrievalBlockIndex(kv)` when drift exceeds thresholds.
5. Schedule `retrievalIndexPersistence.save()` after repair.
6. Surface repair counts and failures in health diagnostics if practical.

Tests:

- verifier triggers rebuild when BM25 drift exceeds threshold
- verifier triggers rebuild when vector index is empty but blocks exist
- verifier does not rebuild for tiny harmless drift
- rebuild failures do not crash the worker

### P0. Scope MCP Recall And Smart Search

Problem:

- `memory_recall` does not accept or pass `project`, `cwd`, or `branch`.
- `memory_smart_search` does not expose `project` even though
  `mem::smart-search` accepts it.
- With no branch argument, branch-specific blocks pass `branchMatches()`.

Code anchors:

- `src/mcp/tools-registry.ts`
- `src/mcp/server.ts`
- `src/functions/search.ts`
- `src/functions/smart-search.ts`
- `src/functions/retrieval-engine.ts`

End state:

- MCP recall/search callers can supply `project`, `cwd`, and `branch`.
- Backend search paths receive those fields.
- Branch-specific retrieval blocks are not returned for unknown branches unless
  the caller explicitly opts into broad search.

Implementation:

1. Add optional `project`, `cwd`, and `branch` fields to
   `memory_recall` and `memory_smart_search` schemas.
2. Pass `project || cwd` to `mem::search` and `mem::smart-search`.
3. Add branch support to `mem::search` and `mem::smart-search` payloads.
4. Thread branch into `retrieveRelevantBlocks()`.
5. Reconsider `branchMatches()` default behavior for branch-specific blocks:
   unknown branch should usually exclude branch-local blocks for recall/context.

Tests:

- MCP `memory_recall` passes project/cwd into `mem::search`
- MCP `memory_smart_search` passes project and branch into `mem::smart-search`
- branch-local blocks are excluded when branch is unknown
- branch-local blocks are included when branch matches

### P1. Replace Scope Arrays With Scalable Membership Storage

Problem:

- Every retrieval block upsert reads and rewrites entire scope ID arrays.
- Large project/session scopes create StateKV write amplification.
- Scoped reads hydrate all IDs with unbounded `Promise.all(kv.get(...))`.

Code anchors:

- `src/functions/retrieval-block-scope-index.ts`
- `src/functions/retrieval-blocks.ts`
- `src/functions/retrieval-engine.ts`

End state:

- Hot-path upsert writes a small delta, not a full scope array.
- Scoped reads can be bounded by lane/recency before hydrating full blocks.
- Retrieval remains correct when a scope contains thousands of blocks.

Implementation:

1. Introduce sharded membership records or per-scope per-block keys.
2. Include metadata needed for pre-hydration ordering:
   source type, lane, event time, project, branch, session, and block ID.
3. Load only the highest-value candidate IDs first for context/enrich.
4. Keep broad `search`/`smart-search` able to fan out deeper, but with bounded
   batches.
5. Add a compaction task if sharded records can accumulate tombstones.

Tests:

- inserting N blocks does not rewrite an N-sized array on each upsert
- scoped context retrieval hydrates only a bounded candidate set
- search can still find old cold blocks when explicitly queried
- membership compaction preserves active block IDs

### P1. Make Graph Retrieval A Cached Snapshot

Problem:

- A single retrieval can call both entity search and expansion.
- Each graph call lists all nodes and all edges.
- BFS repeatedly filters the entire edge list and linearly finds nodes.

Code anchors:

- `src/functions/retrieval-engine.ts`
- `src/functions/graph-retrieval.ts`

End state:

- One retrieval call loads graph data at most once.
- Graph traversal uses adjacency and node maps.
- Repeated retrievals can reuse a short-lived graph snapshot when graph data is
  unchanged.

Implementation:

1. Split graph loading from graph traversal.
2. Build `{ nodesById, edgesByNodeId }` once per retrieval.
3. Pass a `GraphRetrievalSnapshot` into `searchByEntities()` and
   `expandFromChunks()`.
4. Add optional short TTL caching with explicit invalidation from graph writes.

Tests:

- combined entity and expansion retrieval performs one node list and one edge
  list
- traversal returns the same results as the current implementation
- stale nodes/edges are excluded

### P1. Add Vector Relevance Thresholds And Scope Filtering

Problem:

- Vector search scans the global in-memory vector index.
- Results are normalized relative to the best hit.
- Any positive vector score counts as explicit relevance.

Code anchors:

- `src/state/vector-index.ts`
- `src/functions/retrieval-engine.ts`

End state:

- Vector-only candidates need an absolute similarity floor.
- Retrieval can limit vector work to relevant project/branch candidate IDs.
- Weak vector hits do not crowd out lexical, file, concept, or freshness
  evidence.

Implementation:

1. Add an optional candidate-ID filter or metadata filter to `VectorIndex`.
2. Keep global vector search available for broad search, but use scoped
   candidates for context/enrich.
3. Add a minimum cosine threshold before setting vector relevance.
4. Treat vector-only results below the threshold as non-explicit relevance.

Tests:

- low positive cosine does not make a block eligible by itself
- high cosine still retrieves a semantically relevant block
- scoped vector search does not return another project's block
- lexical/file hits still rank correctly without vector support

### P1. Bound Fallback And Retry Load

Problem:

- Fallback retrieval can list many top-level scopes and recent observation
  buckets.
- Full fallback can scan all sessions and observations.
- Retrieval-block retry scans the full retry queue and retries all entries on
  every tick.
- Gemini `embedBatch()` currently serializes individual embedding calls.

Code anchors:

- `src/functions/retrieval-engine.ts`
- `src/functions/retrieval-blocks.ts`
- `src/functions/retrieval-block-retry.ts`
- `src/state/retrieval-block-indexing.ts`
- `src/providers/embedding/gemini.ts`

End state:

- Fallback provides partial-good context quickly and schedules repair.
- Retry work is rate-limited, backoff-aware, and jittered.
- Embedding rebuilds happen in bounded chunks.

Implementation:

1. Make lightweight fallback the default repair path for context/enrich.
2. Trigger async retrieval-block repair when fallback is used because stored
   blocks are missing or incomplete.
3. Add `nextAttemptAt` and capped batch size to retrieval-block retry entries.
4. Chunk `rebuildRetrievalBlockIndex()` stale embeddings.
5. Add provider-aware rate limiting for Gemini embedding calls.

Tests:

- fallback returns bounded hot/project context under missing storage
- fallback schedules repair without blocking the response
- retry skips entries whose `nextAttemptAt` is in the future
- retry processes no more than the configured batch cap
- rebuild chunks stale embeddings

### P2. Tighten Dossier File Matching

Problem:

- File matching allows basename and substring matches.
- Common files like `index.ts`, `config.ts`, or `route.ts` can merge unrelated
  module evidence into one dossier.

Code anchors:

- `src/functions/file-path-match.ts`
- `src/functions/component-dossiers.ts`

End state:

- Exact normalized/project-relative matches win.
- Segment-boundary suffix matches are allowed.
- Basename-only matches are used only when unambiguous.

Implementation:

1. Normalize paths before comparison.
2. Prefer exact and project-relative exact matches.
3. Allow suffix matches only on path segment boundaries.
4. Treat basename-only matches as ambiguous when multiple candidates share the
   basename.
5. Keep legacy mixed-shape dossier resilience.

Tests:

- `src/auth/config.ts` does not match `src/payments/config.ts` by basename only
- exact full path matches
- segment-boundary suffix matches
- dossier refresh ignores unrelated duplicate basename observations

### P2. Scope Consolidated Semantic And Procedural Memory

Problem:

- Semantic memory has no project field.
- Semantic and procedural retrieval blocks are emitted as `project: "global"`.
- Project-scoped retrieval accepts global blocks.

Code anchors:

- `src/types.ts`
- `src/functions/retrieval-blocks.ts`
- `src/functions/consolidation-pipeline.ts`
- `src/functions/skill-extract.ts`

End state:

- Consolidated memories carry project scope when they derive from project-local
  source observations.
- Only explicitly global memories are globally retrievable.
- Existing global rows remain readable with conservative behavior.

Implementation:

1. Add optional project/source-scope fields to semantic/procedural memory types.
2. Populate those fields during consolidation and skill extraction.
3. Emit retrieval blocks with project scope when project is known.
4. Keep legacy global rows but consider reducing their ranking weight in
   project-scoped no-query context.

Tests:

- project-scoped semantic memory retrieves only for that project
- explicit global semantic memory still retrieves globally
- legacy rows do not crash retrieval

### P2. Maintain Belief Retrieval Blocks At Write Time

Problem:

- `mem::belief-project` updates `KV.beliefs` and evidence.
- Belief retrieval blocks are synthesized only during fallback/state
  collection.
- If retrieval-block storage already has project coverage, changed beliefs may
  not surface.

Code anchors:

- `src/functions/beliefs.ts`
- `src/functions/retrieval-blocks.ts`
- `src/functions/retrieval-engine.ts`

End state:

- Belief projection writes directly upsert active belief retrieval blocks.
- Deleted or inactive beliefs remove their retrieval blocks.
- Context cache is invalidated after projection changes.

Implementation:

1. Export a write helper for belief retrieval blocks.
2. Upsert active projected beliefs during `mem::belief-project`.
3. Delete retrieval blocks for beliefs removed by projection refresh.
4. Keep fallback synthesis as backward-compatible repair only.

Tests:

- projecting beliefs creates retrieval blocks
- deleting a belief projection removes retrieval blocks
- context retrieves a newly projected belief without fallback

## Verification Plan

Run before committing implementation changes:

- `npm test`
- targeted tests while developing:
  - `test/retrieval-engine.test.ts`
  - `test/retrieval-block-indexing.test.ts`
  - `test/retrieval-block-retry.test.ts`
  - `test/deferred-memory.test.ts`
  - `test/smart-search.test.ts`
  - `test/search.test.ts`
  - `test/component-dossiers.test.ts`
  - MCP tests covering tool schema/handler changes

Live validation after implementation:

1. Rebuild and recreate the worker.
2. Check `/agentmemory/health`.
3. Confirm function list includes retrieval repair/retry functions.
4. Run scoped `smart-search` for this repo and a different repo and verify no
   cross-project leakage.
5. Supersede a temporary guardrail/decision and verify the old retrieval block
   is absent from search/context.
6. Confirm retrieval-block drift verifier logs healthy/no-op after repair.

## Rollout Order

1. Retrieval-block lifecycle cleanup for guardrails and decisions.
2. Scope index correctness.
3. Retrieval-block drift verifier and repair.
4. MCP scoping.
5. Graph snapshot optimization.
6. Vector threshold and scope filtering.
7. Bounded fallback/retry.
8. Dossier path matching.
9. Consolidated memory scoping.
10. Belief retrieval block write-through.

The first four items are correctness work and should land before performance
polish. They directly affect whether retrieval returns current and properly
scoped truth.
