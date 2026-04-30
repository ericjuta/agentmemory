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

2026-04-29 final spec closeout:

- main is aligned with origin/main at `bcc2b7c fix: store compact working set
  capsule summaries`.
- New working sets no longer duplicate the full turn capsule in
  `latestCompletedCapsule`; they store the compact capsule summary used by
  recall/context plus the existing working-set file and concept fields.
- Existing working sets can retain older larger embedded capsule payloads until
  the session naturally rewrites. Do not add a historical migration unless
  active-scope diagnostics show renewed storage or RSS pressure.
- Session cleanup has removed the real stale set: active sessions older than
  24h are at zero after diagnostics heal marked the abandoned sessions. Active
  sessions older than 1h remain allowed because the built-in abandon policy is
  currently 24h.
- Live service is healthy and usable with write gates open, retrieval queue
  clear, smart search working, and compression draining as maintenance debt.
- Recovery is closed. The only active operational work is passive watch until
  the compression queue reaches zero and stays non-blocking.

Passive watch criteria:

- /agentmemory/health remains healthy for runtime and serving.
- write gates remain open.
- retrieval block queue remains zero or drains immediately.
- graph queue remains near zero and non-blocking.
- compression queued count trends down during no-new-observation windows and
  eventually reaches zero.
- active sessions older than 24h stay at zero after routine heal/cleanup.
- no repeated StateKV timeout burst or pressure streak reappears.

2026-04-29 observe-pressure cooldown update:

- Live service hit an observe/write-pressure brownout after compression and
  pruning work: health could return 200, but mem::observe calls were timing out
  at the iii-engine 30s invocation boundary, hot-path pressure skips were
  frequent, and Codex proof latency was degraded.
- Compression retry was disabled in live .env.local with
  COMPRESS_RETRY_ENABLED=false because retrieval and graph queues were clear and
  compression was maintenance debt, not serving-critical work.
- Ingestion was then temporarily disabled in live .env.local with
  AGENTMEMORY_INGEST_ENABLED=false to stop the observe storm and let the
  worker/StateKV path cool down.
- After the cooldown restart, /agentmemory/health returned HTTP 200 in about
  10ms, CPU dropped to single digits for both worker and iii-engine, KV latency
  was low, and recent pressure logs were quiet.
- Read latency improved but was not fully solved: search was roughly 1-2s, and
  Codex proof still passed with slow session/context legs.
- This is a temporary service-protection posture. It intentionally stops memory
  capture and must not be treated as the desired steady state.

Cooldown re-enable criteria:

- Keep AGENTMEMORY_INGEST_ENABLED=false and COMPRESS_RETRY_ENABLED=false until
  the service has a quiet window with no repeated mem::observe, StateKV timeout,
  or hot-path pressure log bursts.
- Re-enable ingestion before compression retry. Recreate the worker, then watch
  health, Codex proof, observe logs, and queue deltas.
- If observe timeouts return immediately, leave compression retry disabled and
  implement the observe hot-path fail-fast work below before restoring normal
  capture.
- Re-enable compression retry only after ingestion is stable and read latency is
  acceptable. Drain compression in tiny automatic or manual wakes; do not prune
  during this recovery path.

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

## P1. Observe Hot-Path Fail-Fast Under StateKV Pressure

Problem:

- During the 2026-04-29 live brownout, mem::observe calls accumulated enough
  StateKV/write pressure to hit the iii-engine 30s invocation timeout.
- Hot-path pressure detection shed some ephemeral observations and deferred
  synthetic compression, but persistent observe calls could still spend too long
  trying to capture state while the service was already hot.
- Operator relief required disabling AGENTMEMORY_INGEST_ENABLED, which protects
  serving but intentionally stops capture. That is acceptable as an emergency
  posture, not as the steady-state answer.

End state:

- Observe remains best-effort under pressure and returns quickly, even when
  StateKV writes or derived indexing are slow.
- Persistent observations are bounded by short local budgets before they reach
  iii-engine's 30s invocation timeout.
- User-facing session start, context, search, and Codex proof stay available
  while low-priority capture is shed or queued.
- Operators can tell from health/logs whether capture is enabled, shedding,
  queued, or emergency-disabled.

Implementation:

1. Add a short observe write budget for the hot path. When the budget expires,
   return a successful skipped/deferred result instead of waiting for the engine
   invocation timeout.
2. Make StateKV timeout and temporary-unavailable errors first-class observe
   pressure signals:
   - do not retry synchronously on the hot path
   - record a compact pressure reason
   - defer only bounded follow-up work
3. Split observe work into required and optional phases:
   - required: validate payload, decide persistence class, record minimal
     acceptance/skipped result
   - optional: full observation write, retrieval block upsert, access tracking,
     synthetic compression, graph/index work
4. Ensure optional phases obey existing write gates and have their own small
   budgets. A failure in one optional phase must not keep the HTTP call open.
5. Add a capture status field to health/readback:
   - enabled
   - shedding
   - degraded
   - emergency_disabled
   - last pressure reason and last transition time
6. Keep AGENTMEMORY_INGEST_ENABLED=false as the emergency kill switch, but
   document that the durable fix is observe fail-fast, not long-term disabled
   ingestion.

Tests:

- Slow StateKV set/list in observe returns before the configured hot-path budget
  and does not wait for the 30s iii-engine timeout.
- Critical hot-path pressure sheds ephemeral and diagnostics-only observations
  immediately.
- Persistent observation under pressure returns a bounded skipped/deferred result
  and does not run synthetic compression inline.
- Retrieval block/index/access-tracker failures from observe do not fail or hang
  the whole observe call.
- Health reports capture status and pressure reason when observe shedding is
  active or ingestion is disabled by env.

Acceptance:

- Under injected StateKV write timeout, /agentmemory/observe completes within the
  configured budget and no Invocation timeout after 30000ms: mem::observe appears
  in engine logs.
- Codex proof still passes while observe is shedding.
- Ingestion can be re-enabled with compression retry still off, and observe
  pressure does not recreate the brownout.
- Compression backlog remains maintenance debt and is not drained until observe
  capture is stable.

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
- The 2026-04-29 diagnostics showed no stale active-scope candidates at the
  30-day threshold; the largest pressure was duplicated per-record payload, not
  old rows.

End state:

- High-cardinality active data is split across bounded physical StateKV scopes.
- Old, rarely queried data can be archived or compacted without touching hot
  active scopes.
- Scope size is part of health diagnostics before it becomes a brownout.

Implementation:

1. Measure and rank active scope files by bytes, key count, and write rate.
2. First reduce duplicated payloads inside active records before introducing
   new physical sharding.
3. Pick one remaining high-impact scope only if live diagnostics still show
   growth after payload slimming, likely retrieval blocks or observation
   indexes.
4. Move it to physically sharded StateKV scopes using a deterministic shard key.
5. Add a manifest that tracks shard set, schema version, and migration cursor.
6. Keep read compatibility during migration through a bounded dual-read path.
7. Add compaction or archive policy for cold shards.

Status:

- Implemented the first payload-slimming step for working sets in
  `bcc2b7c fix: store compact working set capsule summaries`.
- No historical migration is planned. Older large working-set records should age
  out through normal session rewrites unless diagnostics show pressure returning.
- Further sharding is a future capacity project, not part of the recovery
  closeout.

Acceptance:

- The largest active StateKV scope shrinks or stops growing unbounded.
- iii-engine RSS has a path down that does not depend only on restart.

### P1. Explicit Maintenance Lane State Machine

Problem:

- Health now exposes enough compression lane fields to infer the lane state,
  but the state is still assembled from timers, streaks, timestamps, and skip
  reasons.
- Operators should not need to infer whether maintenance is draining,
  idle-gated, backing off, stalled, or paused.

End state:

- Each maintenance lane reports a first-class state such as `idle`,
  `eligible`, `running`, `draining`, `succeeded`, `backing_off`,
  `paused`, or `stalled`.
- Every transition records reason, timestamp, queue count, and pressure inputs.
- Serving health stays separate from maintenance state: compression-only debt
  can read as usable/draining rather than degraded serving.

Implementation:

1. Define a common maintenance lane state type shared by compression,
   retrieval-block retry, graph catch-up, and future cold lanes.
2. Derive state transitions inside the scheduler path instead of only in the
   health formatter.
3. Include the current state, previous state, reason, last transition time, and
   alert eligibility in deferred-work status.
4. Map states to operator language:
   - `draining`: queue decreasing, gates open
   - `idle_gated`: waiting for CPU/event-loop/KV headroom
   - `backing_off`: recent StateKV timeout or lane pressure
   - `stalled`: no progress past the configured window
   - `paused`: runtime/serving pressure or disabled lane
5. Keep this as readback polish; do not block recovery closeout on it.

Acceptance:

- A healthy service with compression debt reports a clear maintenance state
  without log inspection.
- A stalled lane emits a maintenance warning with a bounded next action.
- Compression debt alone does not make serving health critical.

### P2. Session Abandon Policy Tuning

Problem:

- Diagnostics heal currently treats sessions older than 24h as abandoned.
- After cleanup, active sessions older than 24h were zero, but active sessions
  older than 1h remained. Some may be legitimate long-running threads, so the
  system should not blindly close them.

End state:

- Operators can preview shorter abandon thresholds without mutating state.
- Any shorter policy is project-aware or evidence-based, not a global destructive
  cleanup.

Implementation:

1. Add a dry-run session cleanup preview that accepts an abandon threshold and
   returns counts by project, age bucket, and recent activity.
2. Keep the default mutating heal threshold at 24h unless explicitly configured.
3. Require endedAt/status updates to go through the existing diagnostics heal
   path and audit trail.

Acceptance:

- The 24h cleanup remains safe and routine.
- A shorter threshold can be evaluated from live data before being enabled.

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

## P1. Codex Integration Performance And Quality

Problem:

- The Codex-facing contract is live and correct, but large Codex project
  retrievals are slower than ideal during maintenance debt.
- Live proof on 2026-04-29 for
  `/home/ericjuta/.openclaw/workspace/repos/codex` showed:
  - `/agentmemory/session/start`: 200, expected
    `bootstrap/context/session` envelope, about 4.7s
  - `/agentmemory/context`: 200, about 20k chars / 6.7k tokens, about 4.0s
  - `/agentmemory/smart-search`: 200, 5 results, about 3.5s
  - `latestHandoff` can be null and is handled through session bootstrap, not
    a standalone REST URL
  - health was serving healthy with write gates open, retrieval queue 0,
    graph queue 3, compression queue 516
- This is usable for Codex, but not yet snappy enough to call fully optimized.

End state:

- Codex startup and recall get the same useful context with lower and more
  predictable latency.
- Session start remains non-blocking for Codex when retrieval is slow.
- Context payloads are useful, compact, and traceable: the operator can see why
  each block was selected and what was omitted.
- AgentMemory can prove the Codex contract in one command without manual route
  probing.

Targets:

- `session/start` p95 under 1s when includeContext is deferred/default.
- Explicit context fetch p95 under 2s for the Codex repo during healthy runtime.
- Smart search p95 under 1.5s for 5-result project-scoped queries.
- Context injection usually stays under the caller budget and avoids returning
  more than about 6k to 8k tokens unless explicitly requested.
- Retrieval queue remains 0 during normal Codex use; compression-only backlog
  does not degrade session start or manual recall.

Implementation:

1. Add a Codex integration proof command or endpoint that runs:
   - health summary
   - `session/start` against the Codex repo
   - `context` against the Codex repo with a fixed prompt and budget
   - `smart-search` against the Codex repo
   - optional observe smoke with diagnostics-only persistence
   - summarized latency, token, block, and result counts
2. Split correctness and latency in the proof output:
   - contract pass/fail
   - context quality pass/fail
   - latency warning
   - maintenance-debt warning
3. Add a context budget profile for Codex:
   - default startup coordination context should be compact
   - explicit recall can be larger
   - file-enrich context should prioritize local path evidence
4. Add trace readback for Codex context blocks:
   - source class
   - project/session/branch match
   - score/freshness signals
   - omission reason for high-scoring blocks that were dropped
5. Cache or coalesce repeated project-scoped retrieval work over a short window
   so startup, status, and immediate manual recall do not recompute the same
   large context independently.
6. Add latency guards around Codex startup retrieval:
   - session registration must complete or fail open quickly
   - bootstrap can include compact coordination context
   - slow full context should be deferred to explicit recall/status surfaces
7. Keep the wire contract stable unless Codex-side changes are coordinated:
   - `/agentmemory/session/start`
   - `/agentmemory/context`
   - `/agentmemory/observe`
   - bootstrap `latestHandoff: null | HandoffPacket`
   - bootstrap/context/session top-level envelope

Tests:

- Codex compatibility test asserts session start accepts Codex-shaped payloads
  and returns the bootstrap/context/session envelope.
- Slow context retrieval does not fail session start or block registration.
- Context budget tests cover the Codex repo shape and cap default startup
  injection.
- Smart search returns project-scoped results while retrieval queue is empty and
  compression backlog exists.
- Proof command reports latency warnings without marking the contract failed.

Acceptance:

- A single proof command says Codex contract pass, context quality pass, and
  gives latency/maintenance warnings separately.
- Codex startup remains usable during compression-only backlog.
- Explicit Codex recall returns relevant project context within the target
  latency window on a healthy runtime.
- No Codex-side change is required for backend-internal retrieval or compaction
  improvements.

Status:

- Implemented 2s short-window in-process Codex context caching/coalescing for
  non-file-enrich `mem::context` calls.
- Cache scope is keyed by project, branch, query, intent, budget, and maxBlocks;
  session id is intentionally excluded so immediate startup/status/manual recall
  can reuse the same project context.
- File-enrich requests and file/term-focused context stay uncached to preserve
  path-specific retrieval.
- Responses include `cache.status` as `miss`, `hit`, or `coalesced` for
  proof and operator readback.
- Successful Codex context is also persisted as last-known-good at two scopes:
  the exact cache key and the Codex project+branch. Under critical hot-path
  pressure, cold Codex sessions first try the exact key and then project+branch
  before returning an empty degraded response.
- Degraded non-empty context fallback reports `fallback: "last-known-good"`,
  `degraded: true`, `pressure`, and `ageMs`; this is a proof warning, not a
  quality failure. Empty fallback with zero tokens remains a quality failure.

2026-04-29 live closeout:

- `36da76f feat: add Codex integration proof` is on `main` and pushed to
  `origin/main`.
- The worker was rebuilt/recreated from that commit and iii-engine remained up.
- Live health is serving healthy with write gates open.
- Retrieval freshness queue returned to 0 after a transient block; Codex proof
  returned `contractPass: true`, `qualityPass: true`, and `pass: true`.
- Direct repeated Codex context proved the 2s cache behavior:
  first call recomputed, immediate second call hit cache, and calls after the
  TTL recompute.
- Cold Codex context can still take about 4-5s while maintenance debt remains;
  this is accepted latency debt, not a contract or quality failure.
- Stop coding unless retrieval freshness becomes nonzero again, Codex proof
  fails quality, or cold context remains too slow after compression drains.

2026-04-30 pressure deploy closeout:

- `1cacd23 fix: preserve cold Codex context under pressure` is pushed to
  `origin/scratch/upstream-selected-fixes-20260429` and deployed through
  `docker compose up -d --build --force-recreate agentmemory-worker`.
- The worker image rebuilt successfully and was recreated while iii-engine
  stayed up.
- The first post-deploy `codex-proof` correctly exposed the missing case: a
  brand-new Codex session under `runtimeStatus: critical` still returned empty
  context because no exact session/query last-known-good existed.
- The fix stores project+branch last-known-good context from any successful
  Codex context generation and lets new Codex sessions use it under critical
  pressure.
- Live direct proof after redeploy:
  - warm Codex context: 10 blocks, 1992 tokens, `cache.status: "miss"`
  - cold Codex context under critical pressure: 10 blocks, 1992 tokens,
    `degraded: true`, `fallback: "last-known-good"`,
    `pressure.reason: "critical"`
- The all-in-one `codex-proof` CLI can still time out under current critical
  CPU/RSS pressure. Treat that as the runtime-pressure lane, not as a context
  quality regression when direct context proof returns non-empty fallback.
- Current runtime is not fully happy: serving is degraded/critical, observe may
  shed, write gates may close under CPU pressure, and compression backlog is
  still maintenance debt. Stop changing retrieval/context code unless direct
  context fallback returns empty again; next work should target runtime pressure
  and maintenance scheduling.
