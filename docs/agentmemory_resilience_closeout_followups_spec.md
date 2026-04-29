# AgentMemory Resilience Closeout Follow-Ups

## Goal

Capture the remaining non-blocking work after the 2026-04-27 live recovery.
The live service is serving correctly with normal features enabled; the next
work should reduce background debt and make future recovery less operator-led.

## Current Accepted State

As of the closeout check on 2026-04-27:

- main is aligned with origin/main.
- /agentmemory/health is healthy on both the viewer and canonical runtime
  ports.
- Runtime health is healthy, serving health is healthy, and write gates are
  open.
- AGENTMEMORY_AUTO_COMPRESS=true and the normal ingestion/context features are
  enabled.
- Context refresh without an explicit caller budget is bounded and returns
  context instead of skipping under a normal deferred backlog.
- Maintenance is still behind, with the queue dominated by compression retry
  work.
- iii-engine RSS remains high enough that it should be treated as residual
  operational debt, not a request-path correctness failure.

2026-04-28 update:

- main is aligned with origin/main at the deployed compression retry maintenance
  fix.
- AGENTMEMORY_AUTO_COMPRESS=false is a valid live posture while queued
  compression drains synthetically through mem::compress-retry; vector backfill
  remains a separate lane.
- The service can be usable while maintenance is behind: health can be 200,
  runtime and serving can be healthy, write gates can be open, and a compression
  queue can still be burning down.
- The compression retry loop now drains on its own under idle headroom, but it
  can still pause on CPU critical or StateKV timeout pressure. That pause is
  correct; the remaining work is smoother pacing and clearer operator readback.

2026-04-29 closeout update:

- main is aligned with origin/main at `5e0ad40 fix: ignore transient
  compression CPU spikes`.
- The deployed worker exposes compression lane state in health/deferred-work
  readback and records wake timestamps, work done, skip/error reasons,
  batch/interval settings, success and pressure streaks, drain rate, and ETA.
- Compression CPU gating now follows the runtime health model: one transient or
  stale high CPU sample no longer stalls compression; repeated high CPU samples
  still pause the lane.
- Live burn-in is acceptable for serving: health 200, runtime and serving
  healthy, write gates open, KV latency low, retrieval queue clear, context and
  smart search working, pressureStreak 0, and compression backlog draining as
  maintenance debt.
- Remaining work is passive watch until compression reaches zero plus optional
  SLO/FSM polish; not another hot-path recovery fix.

## P1. Predictable Compression Backlog Drain

Problem:

- Compression retry is enabled, but live recovery still leaves a persistent
  compression queue after serving returns to healthy.
- Operator-triggered drain can reduce the queue, but the system should converge
  on its own when runtime pressure is low.

End state:

- A healthy idle worker drains compression backlog predictably without manual
  intervention.
- Drain work remains single-flight and budgeted.
- Context reads and observe hot paths stay available while the compression
  queue drains.

Implementation:

1. Add compression queue age to deferred-work status.
2. Teach maintenance catch-up to prioritize old compression items when
   retrieval and graph queues are empty.
3. Use an adaptive batch size that increases only when CPU, event-loop lag, and
   KV latency are all healthy.
4. Persist enough retry metadata to distinguish new write pressure from old
   backlog.
5. Add a live-safe operator endpoint that runs one bounded compression drain
   wake and returns work done, skipped reason, and remaining queue.

Tests:

- Old compression backlog drains across repeated healthy maintenance wakes.
- Compression catch-up performs at most one batch per wake.
- CPU or event-loop pressure pauses compression catch-up.
- Context hot-path backpressure does not trigger for normal compression-only
  backlog below the configured threshold.

Acceptance:

- With no new observations and healthy runtime, compression queued count trends
  down across maintenance wakes without operator action.

Status:

- Implemented by the compression retry maintenance loop:
  - COMPRESS_RETRY_ENABLED=true enables an adaptive timer.
  - The timer calls mem::maintenance-catch-up with explicit lane: compression,
    bounded batch size, and bounded time budget.
  - Explicit lane timers are allowed to run their own lane; small retrieval or
    graph backlogs no longer starve compression retry.
  - Automatic catch-up still prioritizes enabled retrieval and graph lanes
    before compression when no lane is requested.
  - Compression retry is gated on idle CPU, event-loop lag, and KV latency.
- Live proof after deployment showed automatic compression drain success,
  context injection returning non-empty context, smart search returning
  results, and memory_recall returning parsed results.
- Current remaining debt is backlog burn-down and StateKV/RSS smoothness, not
  recall/context correctness.
- 2026-04-29 proof: deployed current main, health 200, serving healthy, write
  gates open, retrieval queue 0, compression queue draining under the explicit
  compression lane.

## P1. Compression Burn-In Pacing And Visibility

Problem:

- Compression retry can now drain unattended, but live burn-in still shows
  short pauses when StateKV writes time out or CPU briefly spikes.
- Operators can see queue totals, but not enough scheduler state to know
  whether the queue is actively draining, paused for a valid reason, or stuck.
- A fixed safe batch can be too conservative while idle and too aggressive
  immediately after StateKV pressure.

End state:

- Compression backlog drains steadily during idle windows without creating new
  StateKV pressure.
- The scheduler backs off after StateKV timeouts and resumes cautiously after a
  cool-down.
- Health and the operator dashboard expose enough lane state to answer
  "working, paused, or stuck" without reading logs.

Implementation:

1. Persist a small per-lane maintenance state record for compression:
   - lastWakeAt
   - lastSuccessAt
   - lastWorkDone
   - lastDurationMs
   - lastSkippedReason
   - lastErrorReason
   - currentIntervalMs
   - currentBatchSize
   - successStreak
   - pressureStreak
2. Treat StateKV write timeout as a first-class compression pressure signal:
   - halve the next batch size down to the floor
   - increase the next interval up to the configured max
   - require one healthy idle health sample before increasing batch again
3. Grow batch size only after consecutive successful wakes with low CPU,
   low event-loop lag, and low KV latency.
4. Add queue trend fields to deferred-work status:
   - queuedDeltaSinceLastWake
   - drainRatePerHour
   - estimatedDrainEtaMs
   - oldestAgeMs
   - newestAgeMs
5. Keep compression synthetic while AGENTMEMORY_AUTO_COMPRESS=false; do not
   reintroduce LLM compression into the drain path unless explicitly enabled.
6. Keep graph catch-up disabled by default during compression burn-in unless the
   graph queue becomes blocking or aged past a separate threshold.

Tests:

- A successful compression wake records lane state and updates drain-rate
  fields.
- A StateKV timeout reduces the next compression batch and increases interval.
- Batch size grows only after consecutive low-pressure successful wakes.
- Compression remains paused while runtime is critical, and resumes after
  health recovers.
- Health/deferred-work readback stays bounded when lane state is missing or
  stale.

Acceptance:

- During a no-new-observation burn-in, compression queued count trends down
  across multiple maintenance wakes.
- A StateKV timeout produces a visible paused/backoff reason and does not cause
  repeated timeout bursts.
- An operator can inspect health or the dashboard and see whether compression
  is draining, paused with reason, or stuck past the alert window.

Status:

- Implemented and deployed in `bae914d fix: expose compression maintenance
  state` and `5e0ad40 fix: ignore transient compression CPU spikes`.
- Health/deferred-work now includes compression laneState plus
  queuedDeltaSinceLastWake, drainRatePerHour, estimatedDrainEtaMs, oldestAgeMs,
  and newestAgeMs.
- StateKV pressure records lastErrorReason, increments pressureStreak, reduces
  the next batch, and backs off the interval.
- Successful wakes record lastSuccessAt, lastWorkDone, lastDurationMs,
  successStreak, currentBatchSize, and lastQueued.
- CPU pause behavior now requires repeated high CPU samples, preventing stale
  one-off samples from pinning the lane in skipped state while still preserving
  pressure safety.
- Live burn-in after deploy showed compression draining, retrieval retry
  clearing, pressureStreak 0, open write gates, and fast health after idle.

## P1. Compression Backlog SLO And Alerting

Problem:

- maintenance: behind is too broad. A compression-only backlog should be
  visible as maintenance debt without implying serving failure.
- There is no explicit alert when compression stops making progress for too
  long while runtime is otherwise healthy.

End state:

- Compression has its own burn-down SLO separate from serving health and
  retrieval freshness.
- Alert text tells the operator whether to wait, lower batch settings, inspect
  StateKV, or escalate to compaction/RSS work.

Suggested SLOs:

- Serving remains healthy while compression is behind.
- Write gates remain open during normal compression burn-down.
- Compression retry should perform at least one successful wake within 10
  minutes of an idle healthy window when backlog exists.
- Compression queued count should trend down over a 30-minute no-new-observation
  window.
- Repeated StateKV timeout pauses over 15 minutes should raise a maintenance
  warning, not a serving critical state.

Implementation:

1. Add compression-specific warning codes:
   - compression_backlog_draining
   - compression_backlog_stalled
   - compression_paused_cpu
   - compression_paused_event_loop_lag
   - compression_paused_kv_latency
   - compression_paused_statekv_timeout
2. Include those warnings in health, dashboard, and recovery proof output.
3. Keep serving status healthy for compression-only backlog unless hot-path
   context/observe calls are failing.
4. Add a runbook branch:
   - wait when drain rate is positive and gates are open
   - lower batch or increase interval when StateKV timeouts repeat
   - run StateKV dry-run compaction when RSS stays high after backlog clears
   - restart iii-engine only after diagnostics show no active cleanup path

Tests:

- Compression-only backlog does not flip serving health critical.
- Stalled compression under healthy runtime emits a maintenance warning.
- Positive drain trend suppresses stalled warnings.
- Repeated StateKV timeout pauses emit the StateKV-specific warning.

Acceptance:

- A healthy serving system with compression debt reads as "usable, draining" or
  "usable, stalled maintenance" instead of a generic green/red ambiguity.

## P1. iii-engine RSS Reduction And Scope Compaction

Problem:

- The worker process can be healthy and idle while iii-engine remains large in
  RSS because StateKV physical scope files and loaded runtime state do not
  shrink quickly.
- Health being green is necessary but not enough to prove the engine has
  released old pressure.

End state:

- Operators can distinguish healthy-but-large RSS from active brownout.
- Compaction and restart guidance is explicit, bounded, and evidence-based.
- Large physical scopes are surfaced before they become live incidents.

Implementation:

1. Add diagnostics for largest StateKV physical scope files and total data
   volume size.
2. Report whether each large scope is active, legacy, shard payload, or
   cleanup-eligible.
3. Add an operator runbook section for when to compact, when to restart
   iii-engine, and when to leave it alone.
4. Add a bounded compaction dry-run that estimates bytes/files removable before
   mutating anything.
5. Keep compaction under existing write gates and maintenance pressure checks.

Status:

- Implemented in `/agentmemory/index-persistence/compact` with `dryRun: true`.
- Dry-run reports StateKV data-dir total bytes, largest physical scope files,
  scope classification, and removable orphan shard estimates without reading
  payload values.
- Mutating compaction refuses degraded or critical runtime health even when
  `force: true`.

Operator runbook:

1. Confirm service health and maintenance posture:
   `curl -fsS http://127.0.0.1:3111/agentmemory/health`.
2. Compare worker and iii-engine RSS:
   `docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.PIDs}}' | rg 'agentmemory|iii'`.
3. Run the non-mutating StateKV scope diagnostic:
   `curl -fsS -X POST http://127.0.0.1:3111/agentmemory/index-persistence/compact -H 'content-type: application/json' -d '{"dryRun":true}'`.
4. Compact only when health is healthy and dry-run reports cleanup candidates.
5. Restart iii-engine only when scope diagnostics show little removable state
   but RSS remains high after worker-side pressure has cleared.
6. Leave the process alone when health is green, write gates are open, and the
   dry-run shows active shard payloads rather than orphan cleanup candidates.

Tests:

- Diagnostics identify large physical scopes without loading their full
  payloads.
- Dry-run compaction performs no writes.
- Mutating compaction refuses to run when runtime health is degraded or
  critical.

Acceptance:

- A green health endpoint plus large iii-engine RSS has a direct diagnostic path
  and a documented operator decision.

## Longer-Term Improvement Backlog

This backlog is lower urgency than compression burn-in, but it is the durable
shape for making AgentMemory boring under load.

### P1. Single Maintenance Scheduler

Problem:

- Background work is still spread across separate adaptive timers.
- Each timer is pressure-aware, but the system does not yet have one global view
  of available maintenance budget.

End state:

- One scheduler owns cold and warm maintenance wakes.
- Each lane declares work class, max batch, current pressure score, and stale
  age.
- The scheduler spends a small per-window budget and records exactly why each
  lane ran or yielded.

Implementation:

1. Add a scheduler state record with per-lane leases and last-decision metadata.
2. Model lanes explicitly:
   - retrieval retry
   - compression retry
   - graph catch-up
   - vector backfill
   - index verification
   - compaction
3. Compute a global budget from runtime pressure:
   - hot path always allowed with short timeouts
   - warm work allowed when serving is healthy
   - cold work allowed only during idle windows
4. Replace independent cold timers with scheduler lane registrations.
5. Expose last scheduler decisions in health and dashboard.

Acceptance:

- No two cold maintenance lanes compete blindly during StateKV pressure.
- The operator can see which lane is next and why.

### P1. Active StateKV Scope Slimming

Problem:

- Dry-run compaction can identify orphan cleanup, but active physical scopes can
  still be large enough to keep iii-engine RSS high.
- Long-lived active scopes need a layout that bounds per-scope load and write
  amplification.

End state:

- High-cardinality active data is split across bounded physical StateKV scopes.
- Old, rarely queried data can be archived or compacted without touching hot
  active scopes.
- Scope size is part of health diagnostics before it becomes a brownout.

Implementation:

1. Measure and rank active scope files by bytes, key count, and write rate.
2. Pick one high-impact scope first, likely retrieval blocks or observation
   indexes.
3. Move it to physically sharded StateKV scopes using a deterministic shard key.
4. Add a manifest that tracks shard set, schema version, and migration cursor.
5. Keep read compatibility during migration through a bounded dual-read path.
6. Add compaction or archive policy for cold shards.

Acceptance:

- The largest active StateKV scope shrinks or stops growing unbounded.
- iii-engine RSS has a path down that does not depend only on restart.

### P2. Brownout Chaos Harness

Problem:

- Most regressions appear only when StateKV is slow, CPU spikes, or iii-engine
  queues are already deep.
- Unit tests cover logic, but not the combined live pressure behavior.

End state:

- A local harness can simulate hung context, slow kv.set, slow kv.list, CPU
  pressure, StateKV write timeouts, and unavailable embedding providers.
- The harness proves hot paths fail open and cold lanes pause.

Implementation:

1. Add fault-injection hooks behind a test-only env flag.
2. Add scripted scenarios for:
   - session start while context hangs
   - observe while StateKV writes time out
   - health while diagnostics are slow
   - compression retry while CPU is critical
   - smart search while vector provider is rate-limited
3. Emit a compact pass/fail bundle with p95 timings and queue deltas.

Acceptance:

- A brownout scenario cannot block session start or empty context fallback.
- Cold maintenance pauses without generating repeated timeout bursts.

### P2. Context Quality And Budget Discipline

Problem:

- Recall and context can be non-empty but still too noisy, too large, or poorly
  matched to the current turn.
- Operational recovery should not trade correctness for bloated prompt
  injection.

End state:

- Context injection has explicit quality and size targets.
- The system reports why each block was selected and what was omitted.
- Budget pressure reduces lower-value blocks before dropping fresh relevant
  evidence.

Implementation:

1. Add context trace fields for selected block source, score components,
   freshness, scope, and omission reason.
2. Track output budget by section:
   - working set
   - fresh observations
   - durable memories
   - lessons
   - handoff/crystal context
3. Add eval cases for noisy long-running repos and multi-session handoffs.
4. Add a compact proof that checks non-empty output, source diversity, and max
   token budget.

Acceptance:

- Context remains useful under backlog pressure and does not exceed its caller
  budget.

### P2. Retention And Lifecycle Policy

Problem:

- Compression, diagnostics, observations, retrieval blocks, graph edges, and
  embeddings currently age differently.
- Without an explicit lifecycle, background debt can return after the immediate
  queue is drained.

End state:

- Each data class has a retention class, compaction path, and archive/delete
  rule.
- Diagnostics and ephemeral observations do not become permanent operational
  load.

Implementation:

1. Define lifecycle classes:
   - hot session state
   - durable memory
   - retrieval index blocks
   - compressed summaries
   - graph facts
   - diagnostics-only observations
   - transient maintenance state
2. Add retention metrics by class to health or diagnostics.
3. Add dry-run retention cleanup before any mutating cleanup.
4. Keep audit records for destructive cleanup.

Acceptance:

- A month of normal agent activity has a bounded storage-growth story.
- Cleanup can be previewed, audited, and run without degrading serving.

## P2. Recovery Proof Bundle

Problem:

- Recovery currently requires several separate commands: health endpoints,
  docker stats, env readback, context proof, git status, and logs.

End state:

- One command produces a concise redacted recovery bundle suitable for handoff.

Implementation:

1. Add an operator script that collects:
   - git branch, head, and dirty state
   - feature env readback with secrets redacted
   - viewer and canonical health summaries
   - docker CPU/RSS stats for worker and engine
   - context-refresh proof with omitted budget
   - recent warning/error log tail
2. Keep output JSON plus a human summary.
3. Ensure the script never prints secrets.

Tests:

- Secret-like environment variables are redacted.
- Missing Docker or unreachable health endpoint returns partial proof instead
  of crashing.

Acceptance:

- Recovery closeout no longer depends on manually stitching together ad hoc
  command output.
