# AgentMemory Operational Resilience Spec

## Goal

Make AgentMemory a reliable enhancement layer for Codex and other agents under
load. The serving path must fail open, startup must render fast, and background
maintenance must consume explicit runtime budget instead of competing with
interactive work.

This spec turns the 2026-04 startup/maintenance incident learnings into a
long-term implementation plan.

## Current Baseline

Committed and deployed baseline:

- `d70a6d5 fix: harden startup and maintenance pressure`
  - `/agentmemory/session/start` defers context by default.
  - Startup bootstrap has bounded fail-open behavior.
  - Health separates `servingStatus`, `runtimeStatus`, and
    `maintenanceStatus`.
  - Maintenance catch-up is adaptive and pressure-aware.
  - Retrieval proof ignores non-blocking diagnostic/cold backlog.
  - Retrieval vector backfill uses loaded BM25 ids before expensive KV listing.
  - Retrieval vector manifest persistence is guarded against partial overwrite.
- `6ac336c chore: add retrieval vector repair script`
  - Adds `npm run repair:retrieval-vectors -- ...`.
  - Operator repair polls live health gates, backs off under pressure, verifies
    coverage, and waits for persistence flush.

Remaining problem:

- The architecture still depends on conventions and scripts for some pressure
  management. Durable reliability requires first-class contracts, scheduler
  budgets, chaos tests, and operator visibility.

## Core Invariants

These invariants apply to all future work in this area:

1. Memory is an enhancement path, not a startup dependency.
2. No optional memory request can block first render.
3. Serving health and maintenance health are distinct.
4. Maintenance work must be budgeted and preemptible.
5. Diagnostic/proof traffic must not create the backlog being measured.
6. Index persistence must be non-regressing and transaction-like.
7. Repair must be resumable, observable, and safe to stop.
8. Live operator truth must be visible without reading logs.

## Definitions

Hot path:

- `/agentmemory/session/start`
- Codex first render contract
- lightweight session persistence
- immediate user-facing context reads
- observe calls that must not stall the user turn

Warm path:

- context/bootstrap enrichment after render
- retrieval freshness catch-up
- small retry batches
- incremental index persistence

Cold path:

- compression catch-up
- graph extraction
- broad vector backfill
- legacy backfills
- export and audit jobs

Diagnostic path:

- health checks
- proof checks
- dashboard probes
- operator scripts
- readbacks from agents

## P0. Codex-Side Startup Timeout

Problem:

- Backend now fails open, but Codex should not trust any external service on the
  pre-render path.
- `inject_context=false` alone is insufficient when the Codex backend is
  `agentmemory`; Codex still calls `/agentmemory/session/start`.

End state:

- Codex renders even if AgentMemory never responds.
- Codex records the memory startup failure as a warning, not a startup failure.
- First render has a bounded wall-clock budget.

Implementation:

1. In the Codex repo, wrap `AgentmemoryAdapter::start_session(...).await` with
   a short timeout.
2. Recommended default: 500-1500ms.
3. On timeout/error, continue startup with memory marked unavailable for that
   initial bootstrap.
4. Keep later explicit memory calls available if the service recovers.
5. Emit a visible but non-blocking status event for diagnostics.

Tests:

- Codex first render succeeds when `/session/start` hangs forever.
- Codex first render succeeds when `/session/start` returns HTTP 500.
- Codex later memory calls still work if AgentMemory recovers.
- The timeout path does not retry in a tight loop.

Acceptance:

- A hung AgentMemory service cannot block Codex TUI render.

## P0. Two-Phase Session Startup Contract

Problem:

- `/session/start` historically mixed session creation with context/bootstrap
  retrieval.
- Combining these made context quality work part of startup availability.

End state:

- `/session/start` is an ack-only hot-path operation.
- Context/bootstrap is fetched after render through an explicit warm-path
  contract.
- Existing clients remain compatible with the current response shape.

Implementation:

1. Keep `/agentmemory/session/start` fast and fail-open.
2. Keep default context behavior as deferred:
   `session_start_context_deferred`.
3. Add a dedicated endpoint or function for post-render bootstrap enrichment:
   `POST /agentmemory/session/bootstrap` or equivalent.
4. Return a stable status shape:
   - `session`
   - `context: ""` for deferred startup
   - `bootstrap.partial: true`
   - `bootstrap.omitted: ["context"]`
   - `bootstrap.warnings: ["session_start_context_deferred"]`
5. Keep `AGENTMEMORY_SESSION_START_INCLUDE_CONTEXT=true` as an explicit
   compatibility escape hatch, not the default path.

Tests:

- `/session/start` does not call `mem::context` by default.
- `/session/start` returns within budget when `mem::context` hangs.
- `/session/start` returns within budget when KV persistence is slow.
- Explicit include-context mode remains bounded.

Acceptance:

- Startup context retrieval is never required for session creation.

## P0. Startup And Pressure Chaos Tests

Problem:

- Conventional unit tests do not catch hangs caused by stalled async services or
  StateKV pressure.

End state:

- The failure modes from the incident are locked as tests.
- Hot-path budget regressions are visible before deploy.

Implementation:

1. Add tests that simulate hung `mem::context`.
2. Add tests that simulate hung `kv.set(KV.sessions)`.
3. Add tests that simulate hung `kv.list` in diagnostic/proof code.
4. Add tests that simulate index persistence failure and verify manifest
   non-regression.
5. Add a small latency assertion budget for `api::session::start`.

Tests:

- Test cases are the implementation.

Acceptance:

- Hot-path timeout behavior is covered by deterministic tests.

## P1. Unified Runtime Pressure Model

Problem:

- CPU alerts, event-loop lag, KV failure streaks, backlog freshness, and
  persistence lag are currently interpreted in multiple places.
- Maintenance timers can still wake independently and compete for resources.

End state:

- A single pressure model decides whether hot, warm, cold, and diagnostic work
  may run.
- All maintenance work consumes a budget.

Implementation:

1. Introduce a runtime pressure snapshot with:
   - CPU status
   - event-loop lag status
   - KV connectivity status
   - StateKV operation timeout streaks
   - deferred queue totals by lane
   - oldest queued age by lane
   - index persistence pending/in-flight age
   - embedding provider circuit state
2. Map pressure to work classes:
   - hot: always attempted with short timeout
   - warm: allowed when serving is healthy and gates are open
   - cold: allowed only under low pressure
   - diagnostic: read-only by default, bounded, never indexing by default
3. Replace independent broad maintenance timers with a single budgeted
   scheduler wake.
4. Track per-wake budget:
   - max wall time
   - max StateKV operations
   - max embedding calls
   - max LLM calls
   - max persistence bytes/shards

Tests:

- CPU critical pauses warm/cold work but not hot session ack.
- Event-loop critical pauses maintenance.
- KV timeout streak pauses index persistence and graph extraction.
- Cold work does not run while retrieval freshness is behind.
- Scheduler performs at most one lane per wake.

Acceptance:

- All maintenance entry points share the same pressure decision.

## P1. Promote Vector Repair Script Into Maintenance Worker

Problem:

- `npm run repair:retrieval-vectors` is safe and useful, but it is still an
  operator tool.
- Long-running repair should be resumable without manual supervision.

End state:

- Vector repair runs as an internal leased maintenance job.
- The operator script remains as a manual override and debug tool.

Implementation:

1. Add a `mem::retrieval-vector-repair-worker` function or fold the script logic
   into the maintenance catch-up lane.
2. Persist repair progress:
   - cursor
   - last run
   - coverage before/after
   - last pause reason
   - last successful persistence flush
3. Use a lease so only one worker repairs vectors at a time.
4. Use the unified pressure model before each batch.
5. Keep batch size adaptive:
   - low pressure: larger batch
   - moderate pressure: small batch
   - any critical gate: pause
6. Keep the npm script as a client for the same repair contract.

Tests:

- Worker resumes from cursor after restart.
- Lease prevents two workers from running concurrently.
- Worker pauses under CPU/event-loop/KV pressure.
- Worker does not regress persistence manifest coverage.

Acceptance:

- Vector repair completes over time without an operator babysitting it.

## P1. Transactional Retrieval Index Persistence

Problem:

- Persisting BM25/vector index state is large and can fail under StateKV
  pressure.
- A partial save must never become the newest trusted manifest.

End state:

- Index persistence is epoch-based and non-regressing.
- New manifests are published only after all required shards are written and
  validated.

Implementation:

1. Save shards under a pending epoch id.
2. Write a pending manifest that is not used for normal load.
3. Verify shard count, document count, vector count, and checksum/fingerprint.
4. Publish by atomically flipping the complete manifest pointer.
5. Keep the last complete manifest until the new epoch is complete.
6. Refuse to publish a vector manifest with lower coverage unless explicitly
   marked as a rebuild reset.
7. Expose persistence state:
   - current complete epoch
   - pending epoch
   - pending shard count
   - failed shard count
   - last publish time
   - last non-regression guard trigger

Tests:

- Complete epoch loads after restart.
- Missing shard does not publish.
- Lower vector count does not replace a higher complete manifest.
- Interrupted save resumes or restarts without corrupting the active manifest.

Acceptance:

- Restart never loses vector coverage because of a partial persistence write.

## P1. Diagnostic Traffic Non-Pollution

Problem:

- Operator probes can create observations and retrieval blocks, increasing the
  queues they are measuring.
- Health/proof/dashboard traffic should not perturb freshness unless explicitly
  requested.

End state:

- Diagnostics are low priority, non-indexing, and easy to filter.
- Proof checks do not create blocking retrieval backlog.

Implementation:

1. Classify known diagnostic endpoints and commands as `diagnostics_only`.
2. Suppress or downgrade retrieval block creation for diagnostic observations.
3. Add an explicit `promoteDiagnostics` option for rare cases where diagnostic
   output should become durable memory.
4. Keep retrieval proof focused on blocking hot/warm freshness.
5. Extend retry coalescing for recurring operator probes.

Tests:

- Health/proof/dashboard probes do not increase blocking retrieval backlog.
- Diagnostic observations are queryable only in diagnostic mode.
- Explicit promotion creates normal retrieval blocks.

Acceptance:

- Measuring health no longer makes health worse.

## P1. Operator Dashboard Truth

Problem:

- A single green health indicator hides the distinction between serving,
  runtime pressure, and maintenance lag.

End state:

- The dashboard shows the real operator state without requiring logs.

Implementation:

1. Add or refine dashboard panels for:
   - serving status
   - runtime status
   - maintenance status
   - write gates
   - vector coverage
   - retrieval freshness lag
   - deferred queue totals by lane
   - oldest backlog age by lane
   - index persistence pending/in-flight/last success
   - session-start latency and deferred context status
2. Make degraded states explain the next action:
   - wait
   - run repair
   - lower batch size
   - inspect KV
   - restart worker only if serving is stuck
3. Keep dashboard reads bounded and diagnostics-only.

Tests:

- Dashboard renders serving healthy while maintenance is behind.
- Dashboard renders runtime critical separately from serving critical.
- Dashboard does not trigger indexing/backfill.

Acceptance:

- An operator can tell whether the service is safe to use, safe to repair, or
  needs intervention from the first viewport.

## P2. Maintenance Work Classes And Queue Policy

Problem:

- All backlog is not equal. Retrieval freshness, compression, graph extraction,
  diagnostics, and vector repair need different priorities.

End state:

- Queue policy encodes the hot/warm/cold/diagnostic split.
- Oldest blocking user-facing work drains before optional enrichment.

Implementation:

1. Store lane metadata for deferred work:
   - work class
   - source endpoint/hook
   - priority
   - createdAt
   - lastAttemptAt
   - attempt count
   - pause reason
2. Compute blocking backlog separately from non-blocking backlog.
3. Make freshness proof fail only on blocking lag.
4. Ensure cold maintenance yields when hot/warm queues are stale.

Tests:

- Diagnostic backlog does not fail retrieval proof.
- Cold backlog does not block session start.
- Hot retrieval backlog outranks graph/compression.

Acceptance:

- Backlog numbers are actionable instead of noisy.

## P2. SLOs And Alerts

Problem:

- Current health output is useful but not yet expressed as operational targets.

End state:

- AgentMemory has explicit SLOs for serving and maintenance.

Suggested SLOs:

- `/agentmemory/session/start` p95 under 500ms.
- `/agentmemory/health` p95 under 1000ms when serving is healthy.
- Context explicit fetch p95 under configured budget or returns partial.
- Event-loop lag critical should self-clear after maintenance pauses.
- Retrieval vector coverage target: 98%+ for active projects.
- Index persistence manifest lag under 5 minutes after repair batches.
- Blocking retrieval freshness lag under target window for active projects.

Implementation:

1. Add lightweight rolling metrics for the SLOs above.
2. Expose them in health and dashboard.
3. Add warnings before hard critical state.
4. Keep metrics reads bounded and cached when StateKV is pressured.

Tests:

- Metrics degrade gracefully when StateKV is unavailable.
- SLO warnings do not change serving status unless the serving path is affected.

Acceptance:

- Health explains whether an issue is a serving incident or maintenance debt.

## P2. Codex And AgentMemory Wire Contract Hardening

Problem:

- Backend-internal changes should not require Codex changes unless the wire
  contract changes.
- Startup behavior is now subtle enough to deserve a formal compatibility
  contract.

End state:

- Codex and AgentMemory have a documented contract for startup, context, and
  degraded memory behavior.

Implementation:

1. Document stable response fields for:
   - `/session/start`
   - explicit context fetch
   - closeout
   - observe
2. Define warning codes:
   - `session_start_context_deferred`
   - `session_start_bootstrap_timeout`
   - `session_start_persistence_timeout`
   - `memory_unavailable`
3. Define client behavior for each warning.
4. Add compatibility tests that assert Codex-safe payloads.

Tests:

- Warning codes are stable.
- Missing optional bootstrap fields do not break clients.
- Context-deferred startup remains backward compatible.

Acceptance:

- Future AgentMemory backend hardening does not surprise Codex.

## Rollout Plan

1. P0 Codex timeout and chaos tests.
2. P0 explicit two-phase bootstrap contract.
3. P1 unified pressure model and scheduler budget.
4. P1 vector repair worker using the existing script behavior.
5. P1 transactional index persistence epoch publishing.
6. P1 diagnostic non-pollution hardening.
7. P1 dashboard operator truth.
8. P2 queue policy and SLO polish.
9. P2 Codex/AgentMemory compatibility contract doc and tests.

## Open Questions

- Should Codex fetch deferred context automatically after first render, or should
  it wait until a user-visible memory status is available?
- What is the right default startup timeout for Codex on slower machines:
  500ms, 1000ms, or 1500ms?
- Should repair worker runs be scheduled by wall-clock cadence, backlog age, or
  pressure idle windows?
- Do we need a separate StateKV maintenance queue for large index persistence
  writes, or is shard budgeting enough?
- Should dashboard probes use a cached health snapshot by default under StateKV
  pressure?
