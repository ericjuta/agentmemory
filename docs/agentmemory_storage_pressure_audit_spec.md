# AgentMemory Storage Pressure Audit Spec

Date: 2026-04-30
Branch: scratch/upstream-selected-fixes-20260429
Status: audit captured; durable fix not complete

## Summary

AgentMemory is not failing because of one bad maintenance timer or one slow endpoint. The current live store has crossed a size threshold where several StateKV scopes are too large to read or rewrite safely on interactive paths.

The system can appear healthy, pass liveness, and even pass Codex proof, then hit V8 heap pressure minutes later when a different path lists or rewrites a large scope. This explains the repeated pattern from the last week: fixing one hot path only moves pressure to observe, closeout, context fallback, index persistence, or maintenance.

The durable fix is to stop using monolithic StateKV scopes for high-churn or high-cardinality data and to remove broad fallback scans from hot paths.

## Current Live Posture

Live is serving only because the worker is in a survival posture:

- `/agentmemory/livez` returns ok.
- `/agentmemory/health` returns healthy when the worker is calm.
- `codex-proof` can pass contract and quality, but with latency warnings.
- Worker restart count increased during this lane.
- Maintenance is partially disabled in `.env.local` to keep the worker stable.

Disabled or survival-mode lanes include:

- retrieval index startup verify
- retrieval vector backfill / repair
- broad index verify
- graph catch-up
- retrieval block retry
- auto-forget
- eviction

These toggles are mitigation, not a product state. They prevent background work from competing with serving, but they do not fix the storage shape.

## Evidence

### Live OOM Pattern

Recent logs show the worker can reach Ready, serve requests, then later hit V8 heap OOM:

    FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory

Before OOM, logs showed a pattern like:

    Session summarized
    Retrieval block upsert deferred while health is unhealthy ... memory_critical_96%
    Retrieval block upsert deferred while health is unhealthy ... memory_critical_97%

Another window showed:

    Observe derived work deferred under write pressure
    Synthetic compression deferred under write pressure
    Failed to persist index ... StateKV state::set timed out after 20000ms
    Retrieval block upsert deferred while health is unhealthy ... memory_critical_97%

This means the failure is not only scheduled maintenance. Session closeout, summarization, derived retrieval-block writes, observe-derived writes, and index persistence can all participate.

### Store Shape

The iii state store is file-backed by scope. Current live volume inspection showed very large single-scope files:

- `mem:insights.bin`: about 88 MB
- `mem:turn-capsules.bin`: about 69 MB
- `mem:working-sets.bin`: about 51 MB
- `mem:graph:edges.bin`: about 14 MB
- `mem:semantic.bin`: about 9 MB
- `mem:audit.bin`: about 8 MB
- `mem:access.bin`: about 6 MB
- retrieval block shards: about 60 MB total
- retrieval index shards: about 206 MB total
- observation index shards: about 147 MB total
- total state-store payload: about 1.07 GB across about 22k files

The retrieval block store itself is already sharded. The worst remaining interactive problems are older monolithic scopes such as turn capsules, working sets, insights, audit, semantic, access, graph edges, and context injections.

### Hot-Path Broad Reads

`collectLightweightRetrievalBlocksFromState()` still lists large global scopes:

- `KV.turnCapsules`
- `KV.workingSets`
- `KV.summaries`
- `KV.memories`
- `KV.semantic`
- `KV.procedural`
- handoffs, overlays, guardrails, decisions, dossiers, profiles

That helper is reachable from retrieval context fallback. If scoped retrieval blocks are incomplete or missing coverage, context can fall back to listing these large scopes. This turns a quality fallback into a heap and latency risk.

### Closeout Path

`event::session::stopped` drains compression, runs `mem::summarize`, then may trigger graph extraction over compressed observations.

The REST closeout path runs multiple heavy steps inline:

1. `mem::summarize`
2. session end update
3. `mem::auto-crystallize`
4. `mem::consolidate-pipeline`

On a large store, closeout is not a safe hot or interactive path. It should be a bounded enqueue/ack with background work that respects pressure.

### Observe Path

Observe now defers and bounds derived work, which is directionally correct. The deferred work still eventually writes large monolithic scopes:

- turn capsules
- working sets
- synthetic observations
- retrieval blocks
- index persistence

So the observe changes reduce immediate user-facing latency but do not fix the underlying data layout. Deferred work can still accumulate or push the process into memory pressure later.

### Test Signal Risk

The current observe burst test is useful but not sufficient. It can pass when a previous observe-pressure cooldown prevents derived work from starting at all. The production direction is still right, but the test should be tightened before relying on it as proof of burst serialization.

## Root Cause

The root cause is architectural storage pressure:

1. Large logical collections are stored as monolithic StateKV scopes.
2. Common code paths use `kv.list(scope)` or rewrite whole scopes.
3. Node keeps large decoded objects, indexes, traces, and request results in the same process heap.
4. Maintenance and closeout work wake in the same worker as interactive serving.
5. Health can look green immediately after startup because the bad work has not run yet.

The worker is doing too much in one process, against state shapes that require large object materialization.

## Non-Goals

Do not solve this by:

- Increasing Node heap as the primary fix.
- Re-enabling all maintenance and hoping adaptive timers handle it.
- Adding more broad fallback scans.
- Treating compression backlog alone as the root cause.
- Treating health 200 as proof that the runtime is stable.
- Running destructive `docker compose down -v` or deleting state.

Heap bumps can be temporary diagnostic tools, but they do not address the shape that creates runaway heap use.

## Remediation Plan

### P0: Keep Live Serving

Current posture should remain until durable fixes land:

- Keep cold maintenance disabled or heavily gated.
- Keep auto-compress off.
- Keep observe sync embeddings off.
- Do not run broad repair/backfill jobs during interactive use.
- Verify with live health, docker stats, logs, restart count, and Codex proof after every change.

Acceptance:

- No worker restart during a quiet 10-minute observation window.
- Liveness and health respond quickly.
- Codex proof passes or returns a bounded degraded result, not timeout/OOM.

### P0: Remove Hot-Path Broad Fallback Reads

Context and smart search must not broad-list large source scopes when scoped retrieval blocks are incomplete.

Implementation direction:

1. Change context retrieval so scoped-index incomplete returns bounded partial retrieval blocks with `degradedFreshness`, not a full state rebuild.
2. Make `collectLightweightRetrievalBlocksFromState()` unavailable to hot context by default once scope indexes exist.
3. For Codex/project context, load by scoped retrieval-block ids only.
4. If scoped index coverage is insufficient, return last-known-good or bounded degraded context.
5. Add explicit telemetry for `retrieval_scope_incomplete_partial`.

Tests:

- Context does not call `kv.list(KV.turnCapsules)` under scoped-index incomplete.
- Context does not call `kv.list(KV.workingSets)` under scoped-index incomplete.
- Context returns partial/degraded context instead of empty or broad fallback.
- Codex proof reports freshness lag separately from contract failure.

### P0: Make Closeout Bounded And Fail-Open

Closeout must not synchronously run summarize, crystallize, consolidate, graph, and retrieval-block indexing in the request path.

Implementation direction:

1. Add a closeout queue or lane entry.
2. Make `/session/closeout` return an ack after marking intent.
3. Run summarize/crystallize/consolidate as pressure-gated background work.
4. Limit summary input observations by recency/importance and payload bytes.
5. Skip graph extraction under pressure.
6. Defer retrieval-block upserts without embedding/index save under pressure.

Tests:

- Closeout returns under a small budget when summarize hangs.
- Closeout returns under pressure without OOM-producing broad reads.
- Background closeout records pending/deferred status.
- Re-running closeout is idempotent.

### P0: Gate Derived Retrieval-Block Upserts

`upsertRetrievalBlock()` currently checks health before writes, but if the health snapshot is stale or still green it can proceed into expensive writes and embedding/index persistence.

Implementation direction:

1. Add a cheap process-local heap/RSS/event-loop preflight before derived retrieval-block writes.
2. Treat derived retrieval-block upsert as warm work, not hot work.
3. Under pressure, queue compact retry metadata, not full large block payloads where avoidable.
4. Skip embedding and index persistence for low-value derived blocks while pressure is elevated.
5. Coalesce repeated working-set and turn-capsule block writes by session/turn.

Tests:

- Derived block writes are skipped/queued under simulated memory pressure.
- Repeated observe events for the same turn coalesce into one block update.
- Queued retry entry size is bounded.

### P1: Shard High-Cardinality Scopes

Shard or otherwise partition large scopes that are currently monolithic:

- `KV.turnCapsules`
- `KV.workingSets`
- `KV.insights`
- `KV.audit`
- `KV.semantic`
- `KV.accessLog`
- `KV.contextInjections`
- graph edges if graph retrieval remains enabled

Implementation direction:

1. Add schema helpers like `turnCapsuleShard(sessionId, turnId)`.
2. Update read/write call sites to use key-addressable shards.
3. Keep compatibility readers for old monolithic scopes during migration.
4. Add a backfill/migration function that moves old entries incrementally.
5. Add diagnostics that report scope file sizes and top offenders.

Tests:

- New writes go to shards.
- Reads find both sharded and legacy entries.
- Migration is idempotent and resumable.
- No hot path lists the legacy monolithic scope after migration.

Acceptance:

- `mem:turn-capsules.bin` and `mem:working-sets.bin` stop growing.
- Context/observe/closeout no longer materialize those whole scopes.

### P1: Budget Index Persistence

Index persistence is a large heap and StateKV contributor.

Implementation direction:

1. Do not persist indexes while runtime is degraded or critical.
2. Add a maximum pending-save frequency per index.
3. Make persistence skip or compact under repeated `StateKV state::set timed out`.
4. Include index persistence state in live proof.

Tests:

- Repeated schedule-save calls coalesce.
- Persistence does not run under memory pressure.
- A failed persistence attempt does not leave an invalid manifest.

### P1: Reintroduce Maintenance One Lane At A Time

Maintenance should come back only after hot paths are fixed.

Order:

1. Retrieval block retry with tiny batch and strict time budget.
2. Retrieval vector repair/backfill.
3. Graph catch-up.
4. Auto-forget and eviction.
5. Broad index verify.
6. Compression retry only if explicitly needed and budgeted.

Each lane needs a pressure gate, time budget, item budget, heap preflight, live proof window, and clear status in `/health`.

### P2: Split Serving And Maintenance Workers

Longer-term, keep interactive serving and cold maintenance in separate workers or processes. A maintenance OOM should not take down Codex-facing serving.

## Acceptance For The Full Fix

The lane is not done until all are true:

- No worker restart or V8 OOM during a 30-minute interactive proof window.
- `/agentmemory/livez` and `/agentmemory/health` stay responsive.
- Codex proof passes without HTTP timeout.
- Context returns full or explicit degraded fallback, not unbounded scan or empty due to avoidable pressure.
- Observe persists required raw observations and coalesces optional derived work.
- Closeout returns quickly and records queued/deferred work under pressure.
- No hot path broad-lists `turnCapsules`, `workingSets`, or `insights`.
- Maintenance lanes can be re-enabled individually without destabilizing serving.

## Open Questions

- Which scopes need immediate sharding versus deletion/pruning?
- How much of `insights` is useful versus stale derived data?
- Should graph extraction stay enabled by default for Codex-only use?
- Should closeout default to summary-only and skip crystallize/consolidate unless explicitly requested?
- Should Codex proof avoid creating active proof sessions that add more live state during incident diagnosis?

## Operator Notes

When auditing this again, collect these before changing code:

- `docker inspect` worker status, health, OOM, restart count, and start time.
- `docker stats --no-stream` for worker and iii-engine.
- `/agentmemory/livez` and `/agentmemory/health`.
- `node dist/cli.mjs codex-proof --port 3111`.
- recent worker logs and engine logs.
- state-store file sizes only; do not dump values.

State-store size check:

    sudo find /var/lib/docker/volumes/agentmemory_iii-data/_data/state_store.db -maxdepth 1 -type f -printf '%s %f\n' | sort -nr | head -60

