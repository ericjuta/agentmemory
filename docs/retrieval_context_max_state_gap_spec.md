# Retrieval Context Max-State Gap Spec

## Goal

Make Codex-facing retrieval context injection consistently maximum quality and
low latency, not just good when the runtime is calm.

The current backend can produce dense, relevant Codex context near the configured
budget. The remaining gap is reliability under runtime pressure: during CPU,
StateKV, or observe pressure, context can skip entirely and Codex proof reports a
quality failure even though the retrieval index itself is fresh.

## 2026-04-29 Live Read

Checked after rebuilding and force-recreating the worker from
`scratch/upstream-selected-fixes-20260429`.

Current strengths:

- `AGENTMEMORY_INJECT_CONTEXT=true`.
- `AGENTMEMORY_SESSION_START_INCLUDE_CONTEXT=true`.
- Vector retrieval is enabled through Gemini embeddings.
- Weighting is vector-heavy: `BM25_WEIGHT=0.15`, `VECTOR_WEIGHT=0.85`.
- Direct Codex `/agentmemory/context` returned relevant context for
  `/home/ericjuta/.openclaw/workspace/repos/codex`.
- Direct context filled the current default budget: `10` blocks, about
  `1997` tokens.
- `/agentmemory/session/start` also returned the same useful bootstrap context.
- Retrieval-block queue was `0`.

Current failures:

- Codex proof can fail quality during runtime pressure because context returns
  `0` blocks.
- A pressure window showed:
  - `runtimeStatus=critical`
  - `maintenanceStatus=paused`
  - observe capture `status=shedding`
  - write gates closed by `cpu_critical_152%`
  - worker RSS about `3.4 GB`
  - KV latency about `90 ms`
  - event-loop lag about `59 ms`
- Immediately after pressure cleared, health recovered to:
  - `runtimeStatus=healthy`
  - observe capture `status=capturing`
  - CPU about `59%`
  - KV about `2 ms`
  - event-loop lag about `0.12 ms`
- Compression backlog remained `888`; retrieval backlog stayed `0`.

Current grade:

- Context injection capacity: A when calm.
- Context injection reliability: B, because pressure can return empty context.
- Retrieval relevance/quality: B+/A- on live probes, pending broader real-traffic
  eval and repeated proof.
- Performance: C+ until pressure, RSS, and compression backlog settle.

## End State

AgentMemory should be able to say "max retrieval context" only when all of these
are true at the same time:

- Codex proof contract passes.
- Codex proof quality passes.
- Direct Codex `/context` returns non-empty useful context under the default
  budget.
- Smart search returns scoped results quickly.
- Runtime is not critical.
- Observe capture is not shedding.
- Retrieval queue is `0`.
- Compression-only backlog does not cause context to skip.
- Degraded mode returns bounded partial context with a reason instead of empty
  context whenever source data is available.

## SLO Targets

Healthy runtime:

- `/agentmemory/session/start`: p95 under `1s` when context is cached or
  compact.
- `/agentmemory/context` for Codex repo: p95 under `2s`.
- `/agentmemory/smart-search`: p95 under `1.5s` for `limit=5`.
- Context payload: 8-12 high-signal blocks, normally 1800-2200 tokens unless the
  caller explicitly asks for more.
- Retrieval queue: `0`.
- Codex proof: `contract=pass`, `quality=pass`, overall no worse than
  latency warning.

Pressure runtime:

- Context endpoint must not perform unbounded scans.
- Context endpoint must not block behind cold maintenance.
- If full retrieval is gated by pressure, return:
  - cached context if fresh enough
  - last known good project context if available
  - or a bounded degraded partial response with `pressure.reason`
- Empty context is acceptable only when there is truly no scoped source data.

## Implementation Plan

### P0: Context Pressure Fallback

Problem: current hot-path pressure handling can return an empty skipped context.
That is operationally safe but bad for Codex quality.

Implementation:

1. Persist a compact last-known-good context capsule per project and branch.
2. Update it after successful non-file-enrich context calls.
3. Under hot-path pressure, before returning empty:
   - try the short-window in-process context cache
   - then try the persisted last-known-good capsule
   - then return bounded empty with explicit `pressure.reason`
4. Mark fallback responses with:
   - `degraded: true`
   - `fallback: "memory-cache" | "last-known-good" | "empty"`
   - `pressure.reason`
   - `ageMs` when serving persisted context
5. Keep file-enrich/path-specific context uncached unless the path set matches.

Tests:

- pressure + existing in-process cache returns cached context
- pressure + no in-process cache + persisted last-known-good returns degraded
  non-empty context
- pressure + no fallback returns empty with explicit reason
- file-enrich does not reuse unrelated project context

### P0: Proof Should Split Quality From Pressure

Problem: `codex-proof` reports quality fail when context is empty under
pressure, but the operator also needs to know whether relevance is bad or the
runtime shed the request.

Implementation:

1. Extend proof output with:
   - `contextStatus: full | degraded | empty`
   - `pressureReason`
   - `fallback`
   - `runtimeStatus`
   - `observeCapture.status`
2. Treat degraded non-empty context as quality warning, not quality fail, if it
   contains scoped Codex evidence and explicitly reports pressure.
3. Keep empty context as quality fail unless no source data exists.

Tests:

- proof shows quality pass on full context
- proof shows warning on degraded fallback context
- proof shows fail on empty context with available data
- proof includes runtime pressure metadata

### P1: Backlog Must Not Starve Hot Context

Problem: compression backlog is nonblocking in theory, but live pressure still
correlates with context skips and observe shedding.

Implementation:

1. Audit which timers or maintenance lanes can run immediately after worker
   restart.
2. Add a restart grace period for cold maintenance lanes while indexes warm.
3. Make retrieval-vector repair and compression drain respect a shared
   `contextHotPathActive` or equivalent pressure signal.
4. During Codex proof or active Codex context requests, pause cold maintenance
   for a short TTL.
5. Ensure compression backlog alone never closes context read paths.

Tests:

- simulated compression backlog does not make context return empty
- retrieval-vector repair pauses under critical CPU and records pause reason
- Codex proof does not trigger concurrent heavy maintenance work
- restart warmup does not run cold maintenance before health stabilizes

### P1: RSS And Heap Recovery

Problem: after force recreate, worker RSS climbed above `3 GB` and heap was
near pressure territory. Context quality was available after recovery, but this
headroom is too thin.

Implementation:

1. Capture heap/RSS before and after:
   - index load
   - direct context call
   - codex proof
   - retrieval-vector repair
   - compression drain wake
2. Identify which resident structures dominate:
   - BM25 indexes
   - vector indexes
   - retrieval block caches
   - context caches
   - graph snapshots
3. Add explicit cache size bounds and eviction metrics for each in-memory cache.
4. Consider lazy loading or segmented loading for cold indexes only if live
   evidence points there.

Tests:

- cache size metrics are present in diagnostics
- repeated Codex proof does not monotonically increase RSS
- warm context calls reuse cache without growing unbounded memory

### P2: Broader Quality Eval

Problem: current A+ eval is too small to call long-term max retrieval quality.

Implementation:

1. Add real Codex traffic cases:
   - branch state
   - last commit / push state
   - runtime health
   - handoff packet
   - agentmemory compatibility
   - config/env questions
2. Add negative/noise cases:
   - same keyword in unrelated project
   - old superseded branch notes
   - generic memory versus specific recent evidence
3. Track:
   - precision@1
   - recall@3
   - MRR
   - duplicate rate
   - leakage count
   - p95 latency
   - context token budget fit
4. Persist and expose the latest live eval summary through diagnostics.

Acceptance:

- grade A on broader real-traffic eval
- zero project leakage
- duplicate rate below threshold
- p95 within SLO on healthy runtime

## Proof Bundle

Run after implementation and after a calm burn-in window:

1. `npm run build`
2. `npm test`
3. `npm run eval:retrieval-quality`
4. Live health:
   - `GET /agentmemory/health`
   - `GET :3113/health`
5. Live Codex proof:
   - `node dist/cli.mjs codex-proof --port 3111`
6. Direct context proof:
   - `POST /agentmemory/context` for the Codex repo, default budget
   - immediate repeat to prove cache/coalescing
7. Pressure proof:
   - simulate or induce hot-path pressure in tests
   - verify degraded non-empty fallback when source data exists
8. Log proof:
   - last 10m logs show no context skip burst
   - observe capture is `capturing`, not `shedding`

## Non-Goals

- Do not increase context tokens just to look better.
- Do not make unscoped retrieval broad.
- Do not run prune or compaction as part of this spec.
- Do not merge the upstream-selected scratch branch into `main` until retrieval
  context reliability is calm or explicitly accepted.

## Operator Guidance

Until this spec is implemented, the honest status is:

- "max context when calm" is mostly true.
- "max context under pressure" is false.
- Quality failures immediately after restart or during CPU critical windows are
  reliability failures, not necessarily ranking failures.
- If runtime is critical or observe is shedding, do not tune ranking first; fix
  hot-path pressure/fallback behavior first.

