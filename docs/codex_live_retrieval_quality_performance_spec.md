# Codex Live Retrieval Quality And Performance Spec

## Goal

Make the real Codex CLI memory path consistently useful under live backlog, not
only correct in deterministic ranking evals.

The current system proves two important things:

- retrieval relevance can score A+ under the repo-owned eval gate
- live Codex CLI integration can pass end to end

The remaining gap is operational quality under pressure: context/session-start
latency can spike, context can return an empty degraded response, vector
freshness is incomplete, and maintenance backlog can make proof output read as
warn/fail even when ranking quality is strong.

This spec owns the bridge from "retrieval is relevant" to "Codex gets relevant
memory fast enough in real sessions."

## Relationship To Existing Specs

This does not replace:

- `docs/retrieval_a_plus_quality_spec.md` for ranking/relevance gates
- `docs/retrieval_operational_hardening_followup_spec.md` for index
  persistence and verifier hardening
- `docs/agentmemory_resilience_closeout_followups_spec.md` for compression
  backlog and broader runtime resilience

This spec ties those together around the user-visible Codex contract.

## Current Live Evidence

2026-04-30 live probes after deploying `9247834`:

- `npm run eval:retrieval` returned A+:
  - top1Precision: `1`
  - recallAt3: `1`
  - MRR: `1`
  - duplicateRate: `0`
  - leakageCount: `0`
  - p95LatencyMs: `140`
- real Codex quick smoke passed:
  - `codex exec` returned the marker
  - smart-search found the marker on the first poll
- real Codex full integration eval passed:
  - server proof contract: pass
  - server proof quality: pass
  - liveSessionQualityPass: pass
  - REST lifecycle observe/session/closeout: ok
  - context for the live Codex session: `6579` chars, `14` items
- `POST /agentmemory/retrieval-proof` returned `pass: false` because
  maintenance freshness was behind:
  - vectorCoverage: `0.6654661864745899`
  - vectorMissingCount: `836`
  - deferred retrieval blocks: `445`
  - blocking freshness lag: `45`
  - scanRisk: high
- deferred work remained high:
  - compression queued: `2516`
  - observe-derived queued: `1298`
  - total queued: about `4264`
- latency probe:
  - REST health median: about `21ms`
  - observe p50: about `30-52ms` depending on hook class
  - session-start context median: about `4.19s`, max about `5.40s`
  - manual context had a `5.51s` spike
  - a later manual context request returned empty after
    `context_deferred_timeout`

Interpretation: relevance is strong, ingest is fast, but live context delivery
is not yet consistently performant or useful under pressure.

## Target End State

Codex should see memory as reliable infrastructure:

1. Relevant: project-scoped retrieval keeps the A+ eval grade.
2. Fresh: hot and warm retrieval freshness queues do not block proof.
3. Fast: session-start and explicit context calls stay inside Codex-facing SLOs.
4. Useful under pressure: degraded context returns bounded useful evidence or a
   last-known-good scoped fallback, not an empty payload unless there is truly no
   eligible evidence.
5. Honest: health/proof separates ranking quality, retrieval freshness,
   compression backlog, and serving status.

## SLOs

Normal-load SLOs:

- `npm run eval:retrieval`: grade A or better, with zero leakage
- smart-search p95: under `1s` for project-scoped queries
- `/agentmemory/context` p95: under `2s` for normal budgets
- session-start context p95: under `2s`
- observe ingest p95: under `250ms`
- vector coverage: at least `0.98`
- hot/warm retrieval freshness blocking queue: `0`

Pressure-mode SLOs:

- serving health remains healthy when only compression backlog is behind
- context returns within `3s` with either:
  - non-empty fresh/scoped context, or
  - non-empty last-known-good scoped fallback, or
  - explicit degraded trace proving why no eligible evidence exists
- context must not trigger broad full-scope scans when scan risk is high
- proof endpoints return bounded degraded output instead of timing out

## P0. Bound Codex Context Under Pressure

Problem:

- `/agentmemory/context` can return empty degraded output after
  `context_deferred_timeout`.
- session-start context can spend 4-5s under backlog.
- Codex quality can pass in one full eval while later manual context calls still
  degrade empty.

End state:

- context pressure fallback is useful, bounded, scoped, and traceable.
- Codex gets non-empty relevant memory when eligible evidence exists.

Implementation outline:

1. Add a pressure-safe context fallback path that only reads bounded scoped
   surfaces:
   - same-session recent observations
   - current project working set
   - latest successful context cache by project/branch/query intent
   - newest hot/warm retrieval blocks from scope membership, without broad scan
2. Attach trace fields for fallback source, pressure reason, candidate counts,
   and skipped expensive lanes.
3. Treat empty degraded context as a quality failure when eligible evidence was
   available from a bounded fallback.
4. Keep the normal retrieval path unchanged when pressure is low.
5. Add tests for `context_deferred_timeout` returning useful bounded fallback.

Acceptance:

- A forced timeout/pressure test returns non-empty scoped fallback when recent
  same-project evidence exists.
- No fallback call performs a full retrieval-block scan when scan risk is high.
- Codex full eval still passes and reports whether context was fresh or fallback.

## P0. Make Freshness Catch-Up Win Before Compression Debt

Problem:

- Retrieval quality proof fails when hot/warm freshness is behind, even if the
  deterministic ranking eval is A+.
- Compression backlog is large and can consume runtime headroom while retrieval
  freshness still has blocking work.

End state:

- Hot/warm retrieval freshness reaches zero blocking lag before compression
  catch-up consumes significant CPU.
- Compression-only debt does not make retrieval quality look failed.

Implementation outline:

1. Prioritize retrieval-block retry and vector backfill over compression retry
   when blocking freshness lag exists.
2. Add a maintenance status split:
   - `retrieval_freshness_blocked`
   - `retrieval_freshness_draining`
   - `compression_backlog_draining`
   - `compression_backlog_stalled`
3. Make `retrieval-proof` fail on hot/warm freshness lag, not on
   compression-only backlog.
4. Expose queue age and lane movement in proof output so "behind" is not a
   single ambiguous state.

Acceptance:

- `/agentmemory/retrieval-proof` returns `pass: true` when ranking is A+,
  vector coverage is at target, hot/warm freshness is clear, and only
  compression backlog remains.
- Compression retry pauses or slows while retrieval freshness has blocking work.

## P0. Finish Vector Freshness Coverage

Problem:

- Live vector coverage is about `66.5%`, with `836` missing vectors in the
  current proof surface.
- BM25 can carry many queries, but semantic recall is not fully trustworthy
  until vector coverage is near complete.

End state:

- Active project vector coverage is at least `0.98`.
- Missing vector count trends down under bounded health gates.
- Coverage state is visible in health/proof without expensive scans.

Implementation outline:

1. Keep vector backfill bounded by batch, time budget, provider concurrency, and
   health gates.
2. Prefer active hot/warm project scopes before cold/global scopes.
3. Persist progress by scope so backfill does not restart broad scans.
4. Add a low-side-effect proof command for active-project vector coverage.

Acceptance:

- `POST /agentmemory/retrieval-proof` reports vectorCoverage at least `0.98`.
- vectorMissingCount reaches zero or a known non-eligible remainder for the
  active project.
- No worker restart or StateKV timeout burst appears during backfill burn-in.

## P1. Broaden The Real-Codex Eval Corpus

Problem:

- The deterministic eval is strong, but it is still a seeded corpus.
- The Codex smoke tests prove mechanics and marker retrieval, not broader
  usefulness across real coding questions.

End state:

- A real-Codex eval suite exercises common memory needs:
  - recent deploy status
  - exact commit/branch recall
  - failure/root-cause recall
  - file/module-specific context
  - stale-vs-current decision disambiguation
  - no-leakage across projects

Implementation outline:

1. Add a small fixture set generated from recent real AgentMemory/Codex sessions.
2. For each case, define required evidence ids or required substrings and
   forbidden stale/project-leak substrings.
3. Run through live REST context and smart-search, not only in-memory ranking.
4. Record latency and result trace in `/tmp`.

Acceptance:

- `npm run eval:codex-live-retrieval` or equivalent reports relevance,
  freshness, leakage, and latency.
- The suite fails if context is empty for a known-evidence query.

Implementation note:

- `npm run eval:codex-live-retrieval` runs the P1 suite against live REST
  `/agentmemory/context` and `/agentmemory/smart-search`.
- The default fixture corpus is
  `src/eval/fixtures/codex-live-retrieval-cases.json` and covers recent deploy
  status, branch/commit recall, root-cause recall, file/module context,
  stale-vs-current disambiguation, and cross-project leakage.
- The command writes `/tmp/agentmemory-codex-live-retrieval-latest.json` and
  `/tmp/agentmemory-codex-live-retrieval-latest.jsonl` by default.
- Override the fixture or artifacts with
  `CODEX_LIVE_RETRIEVAL_FIXTURE`, `CODEX_LIVE_RETRIEVAL_ARTIFACT`, and
  `CODEX_LIVE_RETRIEVAL_JSONL`.
- Latency is always reported; pass/fail gating for latency is opt-in with
  `CODEX_LIVE_RETRIEVAL_REQUIRE_LATENCY=true`
  so this P1 corpus does not claim the broader P0/SLO proof bundle by itself.

## Proof Bundle

Before declaring this lane closed:

1. `npm run eval:retrieval` returns A or better with zero leakage.
2. Real Codex quick smoke passes.
3. Real Codex full integration eval passes with liveSessionQualityPass.
4. `POST /agentmemory/retrieval-proof` returns `pass: true`.
5. `scripts/probe-runtime-latency.mjs` meets the SLOs above.
6. Context pressure simulation returns bounded non-empty fallback when eligible
   evidence exists.
7. Worker burn-in holds:
   - `RestartCount=0`
   - serving health healthy
   - no repeated StateKV timeout burst
   - RSS/CPU return to idle range after probes

## Non-Goals

- Do not replace iii-engine or StateKV.
- Do not make compression backlog the same thing as retrieval quality failure.
- Do not add an LLM reranker to compensate for freshness or latency bugs.
- Do not broaden unscoped retrieval; scope-required behavior remains the safe
  default.
- Do not claim long-term retrieval ideal solely from marker-smoke success.
