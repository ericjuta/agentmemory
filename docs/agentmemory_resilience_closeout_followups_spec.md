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

Tests:

- Diagnostics identify large physical scopes without loading their full
  payloads.
- Dry-run compaction performs no writes.
- Mutating compaction refuses to run when runtime health is degraded or
  critical.

Acceptance:

- A green health endpoint plus large iii-engine RSS has a direct diagnostic path
  and a documented operator decision.

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
