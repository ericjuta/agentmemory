# Retrieval Operational Hardening Follow-Up Spec

## Goal

Define the next implementation slice after `feat: harden retrieval quality and
performance`.

The shipped retrieval hardening pass made project/branch isolation, lifecycle
cleanup, bounded retry, and drift verification real. The remaining work is
operational: reduce live KV pressure, make repair provable on demand, and
recover useful legacy memories without reintroducing cross-project leakage.

## Implementation Status

- P0 sharded retrieval-index persistence and manual/startup verification are
  implemented.
- P1 legacy consolidated-memory backfill is implemented as
  `mem::consolidated-memory-backfill` and
  `POST /agentmemory/consolidated-memory/backfill`.
- P1 live-safe retrieval-block diagnostics are implemented as
  `mem::retrieval-blocks-diagnostics` and
  `POST /agentmemory/retrieval-blocks/diagnostics`.
- P1 consolidation throttling now uses per-run caps, persisted cursors in
  `KV.config`, project-batched selection, and retrieval-index persistence
  cooldown deferral.
- P2 dependency audit remediation applied non-breaking lockfile updates for
  `defu`, `picomatch`, `vite`, and top-level `protobufjs`. The remaining
  `@xenova/transformers`/`onnxruntime-web` chain still requires a breaking
  migration decision.

## Current Live Signals

As of 2026-04-24, the live worker is healthy and serving `v0.8.12`, but logs
still show retrieval index persistence pressure:

- repeated `Failed to persist index` warnings for `mem:index:retrieval-blocks`
  with `StateKV state::set timed out after 20000ms`
- occasional retrieval block embedding persistence timeouts that now enqueue
  retry work correctly
- consolidation timeout/time-budget pressure during broad maintenance passes

These are not correctness failures in request handling, but they are still
brownout signals. The next work should reduce the size and frequency of large
StateKV writes and make index repair directly observable.

## Priorities

### P0. Shard Or Delta-Save Retrieval Index Persistence

Problem:

- Retrieval BM25/vector index persistence still writes large blobs into
  `KV.retrievalBlockIndex`.
- Live logs show repeated 20s StateKV timeouts for that scope.
- The retry queue protects individual embedding writes, but full index
  persistence can still fail repeatedly under load.

End state:

- Retrieval index persistence writes bounded chunks.
- A single large index save cannot monopolize StateKV.
- Restart can reconstruct indexes from shards or fall back to repair.
- Persistence health is visible in diagnostics.

Implementation:

1. Split persisted retrieval BM25/vector state into versioned shards.
2. Save only dirty shards when possible.
3. Keep a small manifest with schema version, shard IDs, document count, vector
   count, and last successful save time.
4. Load from the manifest when all shards are present.
5. If shards are missing or stale, start with available persisted state and let
   retrieval index verify repair the rest.
6. Add diagnostics for latest retrieval-index persistence success/failure.

Tests:

- large retrieval indexes save as multiple bounded StateKV writes
- restart load succeeds from complete shards
- missing shard marks persistence incomplete and triggers repair
- failed shard save does not corrupt the last complete manifest

### P0. Add Manual And Delayed Startup Retrieval-Index Verify

Problem:

- Retrieval index verification now exists, but the adaptive maintenance timer
  runs every 120 minutes.
- Operators need a direct way to prove drift state after deploy or after a
  persistence failure.

End state:

- `mem::retrieval-index-verify` can run verification on demand.
- A REST endpoint exposes the same operation for live probes.
- Startup schedules one delayed non-blocking verification pass.
- The result reports block count, BM25 size, vector size, drift, repair action,
  and persistence status.

Implementation:

1. Register `mem::retrieval-index-verify`.
2. Add `POST /agentmemory/retrieval-index/verify`.
3. Reuse `verifyRetrievalBlockIndex(kv)` for the implementation.
4. Schedule a delayed startup call after the worker has settled.
5. Keep startup non-blocking and failure-contained.

Tests:

- function returns no-op when indexes are aligned
- function triggers bounded repair when drift exceeds threshold
- REST endpoint validates auth and returns verifier result
- delayed startup verify failure does not crash the worker

### P1. Backfill Legacy Global Consolidated Memories

Problem:

- Legacy semantic/procedural rows can lack project scope.
- Project-scoped retrieval now excludes legacy global consolidated rows to
  prevent leakage.
- Some useful old consolidated memories are therefore hidden until they are
  backfilled with a project scope.

End state:

- Legacy rows with a single clear source project are migrated to project scope.
- Rows with multiple possible source projects remain explicit global or become
  non-project-scoped archival memories.
- Backfill is idempotent, resumable, and reports ambiguous rows.

Implementation:

1. Add a backfill function that inspects `sourceSessionIds`,
   `sourceMemoryIds`, and `sourceObservationIds`.
2. Infer project only when all resolved sources agree.
3. Set `project`, `sourceScope`, and `sourceProjects` on safe rows.
4. Rebuild retrieval blocks for changed rows.
5. Emit a report with updated, unchanged, ambiguous, and missing-source counts.

Tests:

- single-project semantic memory is backfilled and reindexed
- multi-project semantic memory remains global/ambiguous
- procedural memory infers project from source memories
- rerunning backfill is a no-op

### P1. Throttle Consolidation Against Maintenance Budget

Problem:

- Broad consolidation can time out or consume KV/provider budget while retrieval
  maintenance is also active.
- Consolidation is valuable, but it should not amplify retrieval index
  persistence contention.

End state:

- Consolidation is project-batched and budget-aware.
- A run stops before timeout and records a resumable cursor.
- Retrieval/index maintenance gets priority during live pressure.

Implementation:

1. Add per-run caps for sessions, summaries, memories, and provider calls.
2. Persist a cursor per consolidation tier and project.
3. Skip or defer consolidation when KV cooldown or retrieval-index persistence
   failures are recent.
4. Prefer project-scoped consolidation batches over global sweeps.

Tests:

- consolidation stops at configured caps
- cursor resumes the next batch
- recent retrieval-index persistence failure defers consolidation
- project-scoped run does not scan unrelated projects

### P2. Dependency Audit Lane

Problem:

- Docker build reports `7 vulnerabilities` from `npm audit`, including
  `4 critical`.
- This is separate from retrieval runtime correctness, but should be triaged.

End state:

- Audit output is reviewed against runtime exposure.
- Safe non-breaking upgrades are applied.
- Breaking upgrades are captured in a separate migration ticket/spec.

Tests:

- dependency tree still installs with `npm ci --legacy-peer-deps`
- `npm test`
- `npm run build`

## Suggested Rollout Order

1. Sharded/delta retrieval index persistence.
2. Manual and delayed startup retrieval-index verify.
3. Legacy consolidated memory backfill.
4. Consolidation throttling.
5. Dependency audit remediation.

The first item should land before further retrieval feature work because it is
the remaining live brownout signal in the current deployment.
