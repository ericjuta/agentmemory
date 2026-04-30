# AgentMemory Worker OOM Incident Spec

Date: 2026-04-30
Branch: scratch/upstream-selected-fixes-20260429
Status: incident captured; bounded mitigation enacted in repo

## Summary

A compression-maintenance smoothing patch was built, tested, pushed, and deployed as
`3ecce29 fix: smooth compression maintenance pressure`. Live proof after deploy
failed: the worker hit V8 heap OOM, reset health/context connections, and was
restarted. The patch was reverted as `a30a456 revert: back out compression
maintenance smoothing`, pushed, and redeployed.

Current live service is back to the prior behavior and serving, but observe
derived work remains degraded under turn-capsule write pressure. This repo now
contains a bounded mitigation for the identified hot-path fanout.

## Live Evidence

Reverted live state after redeploy:

- repo/local/upstream: `a30a456 == origin/scratch/upstream-selected-fixes-20260429`
- worker container: healthy
- `:3113/health`: `status=healthy`, `servingStatus=healthy`,
  `runtimeStatus=healthy`
- worker heap after revert sample: `heapUsed ~= 420MB`, `rss ~= 794MB`
- docker stats after revert sample: worker about `95% CPU / 2.0GiB RSS`
- queues: compression `888`, retrieval blocks `0`, graph extraction `0`

OOM evidence captured from the failed deploy window:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

During that failed proof window:

- `:3113/health` returned empty/reset replies
- direct `/agentmemory/context` returned `error: "Invocation stopped"`
- docker stats showed worker CPU around `372%` and RSS around `3.5GiB`
- logs showed V8 GC near the 4GB heap limit before restart

## Current Pressure Evidence

After revert, the service still emits repeated observe pressure warnings:

```
observe_write_budget_exceeded_during_turn_capsule after 5000ms
```

Health readback also showed:

- `observeCapture.status = "defer_derived"`
- `observeCapture.derivedWorkDeferred = true`
- `observeCapture.state.status = "degraded"`
- write gates temporarily closed for `event_loop_lag_warn_416ms`
- active invocations were nonzero during the sample

This makes the current evidence point more strongly at observe-derived
turn-capsule/retrieval-block fanout and StateKV latency than at compression retry
alone.

## Relevant Code Paths

### Observe Derived Work

`src/functions/observe.ts` calls `upsertTurnCapsuleFromRaw(...)` under
`withObserveBudget(..., "observe_write_budget_exceeded_during_turn_capsule")`
for non-diagnostics observations when hot-path pressure is not already active.
On timeout it defers derived work but the timed-out promise can continue running.

### Turn Capsules

`src/functions/turn-capsules.ts` performs:

1. `kv.get(KV.turnCapsules, key)`
2. merge files/concepts/source observation ids
3. `kv.set(KV.turnCapsules, key, next)`
4. `upsertTurnCapsuleRetrievalBlock(kv, next)`
5. `updateSessionWorkingSet(kv, next, hookType)`

That is several StateKV/index writes per observation on the derived path.

### Retrieval Block Upsert

`src/functions/retrieval-blocks.ts` builds a hot retrieval block from the whole
turn capsule. The block carries `sourceObservationIds: capsule.sourceObservationIds`.
Repeated observations in a long turn can grow that list and rewrite the
retrieval block repeatedly.

### Index Loading

Startup loads persisted BM25/vector indexes:

- BM25 index: about `38106` docs
- vector index: about `1167` vectors
- retrieval BM25 index: about `10509` docs
- retrieval vector index: about `7017` vectors

These are baseline heap consumers; they are probably not the only trigger, but
they reduce available headroom for observe/context bursts.

## Decisions

- Do not retry blind compression scheduler tuning.
- Treat compression backlog `888` as correlated maintenance debt until direct
  evidence shows it is the heap trigger.
- The enacted code fix bounds observe-derived turn-capsule signals, avoids retry
  queue scans on context/viewer health hot paths, and caps scoped retrieval-block
  fanout before falling back to lightweight state collection.
- Any future scheduler change must be proven under a live check that includes:
  health, context, observe logs, docker stats, and no restart/OOM over a quiet
  window.

## Candidate Fix Lanes

1. **Bound turn-capsule derived writes**
   - Add a per-session/turn derived-write coalescer or cooldown.
   - Do not rewrite turn capsule retrieval block for every low-value ephemeral
     observation.
   - Cap stored `sourceObservationIds` on turn capsules/retrieval blocks while
     preserving important ids.

2. **Make observe budget cancelable in practice**
   - `Promise.race` returns quickly, but the underlying StateKV/index work can
     continue. Add explicit best-effort queueing/coalescing so timed-out derived
     work cannot pile up.

3. **Add heap-aware gates**
   - Gate derived observe work on heap/RSS/event-loop headroom, not only health
     status after the fact.
   - Surface a compact heap pressure reason in observe/deferred status.

4. **Improve proof harness**
   - Add a live read-only OOM proof script that captures restart count, heap/RSS,
     active invocations, recent pressure logs, and context response.

## Acceptance For Next Fix

- No worker restart or OOM during a 5-10 minute live proof window.
- `:3113/health` and `:3111/agentmemory/health` respond consistently.
- Direct Codex context returns non-empty or non-empty fallback.
- Observe pressure warnings do not grow unbounded during normal tool/check load.
- Retrieval and graph queues remain at `0`; compression backlog may remain as
  maintenance debt.

