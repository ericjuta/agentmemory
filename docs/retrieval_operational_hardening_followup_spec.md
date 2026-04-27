# Retrieval Operational Hardening Follow-Up Spec

## Goal

Define the next implementation slice after `feat: harden retrieval quality and
performance`.

The shipped retrieval hardening pass made project/branch isolation, lifecycle
cleanup, bounded retry, and drift verification real. The remaining work is
operational: reduce live KV pressure, make repair provable on demand, and
recover useful legacy memories without reintroducing cross-project leakage.

## Implementation Status

- P0 logical sharded retrieval-index persistence and manual/startup
  verification are implemented.
- 2026-04-27 live investigation found the logical index shards still share the
  same StateKV scope, so the file-based iii adapter still stores them in giant
  physical scope files.
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

As of 2026-04-27, the live worker is healthy and serving `v0.8.12`, and the
read path is correct, but iii-engine remains under physical StateKV pressure:

- `agentmemory-worker` was idle at roughly `0.62% CPU` and `496MiB` RSS.
- `iii-engine` was still running at roughly `105% CPU` and `13.95GiB` RSS.
- `/agentmemory/health` returned `status: healthy` with write gates open, but
  `maintenanceStatus: behind` and `149` deferred work items.
- No `failed to persist index` spam appeared in the last hour, which means the
  new health gates are containing the brownout.
- A read-only `POST /agentmemory/retrieval-index/verify` with
  `scanBlocks: false`, `repair: false`, and `vectorBackfill: false` reported
  clean retrieval drift: `blockCount=101`, `bm25Size=101`,
  `vectorSize=101`, `bm25Drift=0`, `vectorDrift=0`.
- Observation index persistence was logically healthy:
  `documentCount=30373`, `bm25Shards=235`, `vectorShards=62`, last
  successful save `2026-04-27T11:45:50.371Z`.
- Retrieval index persistence was logically healthy but still had a pending
  save: `documentCount=101`, `bm25Shards=2`, `vectorShards=7`, last
  successful save `2026-04-27T11:46:00.273Z`.
- The iii data volume was `2.8G` with `12121` files. The largest physical
  StateKV files were `mem:index:retrieval-blocks.bin` at about `1.07G`,
  `mem:index:bm25.bin` at about `1.06G`, and
  `mem:retrieval-blocks.bin` at about `435M`.

These are not request-path correctness failures. They are still brownout
signals because logical sharding did not reduce the physical StateKV scope-file
size.

## Priorities

### P0. Physically Shard Index Persistence Scopes

Problem:

- `IndexPersistence` now chunks BM25/vector payloads, but
  `writePayloadShards()` still writes every shard with
  `kv.set(this.scope, key, chunk)`.
- With iii-engine's file-based StateKV adapter, the scope is the physical file
  boundary. Separate keys under `mem:index:bm25` still produce one giant
  `mem:index:bm25.bin`; separate keys under `mem:index:retrieval-blocks` still
  produce one giant `mem:index:retrieval-blocks.bin`.
- Current live files are roughly `1G` per index scope, so even successful
  logical shard saves keep iii-engine hot and make delete/compact operations
  expensive.
- A restart may temporarily clear RSS/CPU, but it does not remove the giant
  scope files and can reload the same pressure.

End state:

- BM25/vector shard payloads live in separate physical StateKV scopes, not just
  separate keys inside `KV.bm25Index` or `KV.retrievalBlockIndex`.
- Parent index scopes contain only compact manifests and small control records.
- A single shard save rewrites a bounded physical scope file.
- Restart reconstructs indexes from physical shard scopes or falls back to
  repair when a complete manifest is unavailable.
- Legacy monolith payloads and same-scope shard keys are removed only after a
  complete physical-scope manifest has been published and drift verification is
  clean.
- Persistence diagnostics distinguish logical shard count from physical scope
  mode and report whether legacy monolith payloads are still present.

Implementation:

1. Add a v2 physical-scope manifest format. Each shard descriptor should include
   its physical StateKV scope, key, byte length, checksum, payload kind,
   generation, and index.
2. Add scope naming helpers for physical index shards in `src/state/schema.ts`.
   Keep the existing parent scopes for manifests:
   - `KV.bm25Index` for observation index manifest/control records
   - `KV.retrievalBlockIndex` for retrieval index manifest/control records
3. Change `IndexPersistence.writePayloadShards()` to write each shard to its
   own physical StateKV scope, for example with a stable scope derived from
   parent scope, payload kind, generation, and shard index, and a small key such
   as `data`.
4. Publish the v2 manifest only after all required physical shard writes are
   complete and verified by byte length/checksum. Keep the last complete
   manifest active on partial failure.
5. Load order:
   - prefer complete v2 physical-scope manifest
   - then support current v1 same-scope shard manifests for compatibility
   - then use legacy `data`/`vectors` payloads only when no complete manifest
     exists
6. Add an explicit migration/cleanup path that rewrites current v1 same-scope
   shards to v2 physical scopes, verifies drift, then deletes legacy same-scope
   payload keys through StateKV under the maintenance/write gate.
7. Add a one-shot operator endpoint or maintenance function for legacy index
   compaction. It must be idempotent, health-gated, and bounded so the cleanup
   itself cannot brown out the worker.
8. Extend diagnostics for both observation and retrieval index persistence:
   `manifestVersion`, `physicalScopeMode`, `legacyPayloadPresent`,
   `legacySameScopeShardCount`, `physicalShardScopeCount`,
   `lastSuccessfulSaveAt`, `pendingSave`, `deferredCount`, and
   `deferReason`.

Tests:

- large observation and retrieval indexes write shard payloads to multiple
  physical StateKV scopes, not multiple keys under one parent scope
- parent index scopes contain only compact manifests/control records after v2
  save
- restart load succeeds from complete v2 physical shards
- current v1 same-scope shard manifests still load during migration
- legacy `data`/`vectors` payload fallback is used only when no complete
  manifest exists
- missing physical shard marks persistence incomplete and triggers repair
- failed physical shard save does not publish a new manifest or corrupt the last
  complete manifest
- cleanup deletes legacy same-scope shard and monolith keys only after v2
  manifest verification and clean drift proof
- diagnostics report physical scope mode and legacy payload presence

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

1. Physical StateKV scope sharding for index persistence and legacy index
   compaction.
2. Manual and delayed startup retrieval-index verify.
3. Legacy consolidated memory backfill.
4. Consolidation throttling.
5. Dependency audit remediation.

The first item should land before further retrieval feature work because it is
the remaining live brownout signal in the current deployment.
