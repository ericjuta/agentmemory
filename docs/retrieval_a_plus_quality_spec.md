# Retrieval A+ Quality Spec

## Goal

Move AgentMemory retrieval from operationally safe but noisy to consistently sharp.

The previous hardening pass made deferred retrieval work durable and visible. This spec defines the relevance layer needed for A+: measurable quality, complete semantic coverage, better ranking, duplicate control, freshness under write gates, and caller contracts that do not silently return empty or generic results.

## Original Baseline

Live probe before this A+ implementation on 2026-04-26:

- stored retrieval blocks: 4091
- BM25 index size: 4091
- vector index size: 2550
- vector drift: 1541
- project-scoped smart-search returns relevant results
- unscoped smart-search can return empty results
- exact-query ranking is noisy: current working_set can outrank specific evidence
- context retrieval selects useful hot, warm, and cold blocks, but cold semantic memory results contain near-duplicate concepts
- during CPU pressure, fresh retrieval blocks queue correctly but ranking can temporarily lag source truth until recovery drains the queue

Current grade: B-/B.

A+ means the right evidence appears near the top, is current, scoped, non-duplicative, explainable, and stable under normal maintenance churn.

## Implementation Status

Status: implemented on `main`; current normal-load proof is A+. Remaining work is degraded-mode burn-in, broader eval coverage, and continued output-budget discipline under worker pressure.

The A+ path now has:

- deterministic and seeded retrieval-quality eval coverage through `npm run eval:retrieval-quality`
- compact eval-summary persistence in `KV.config` under `retrieval-quality:last-summary`
- active-scope vector backfill with health gates, cursor state, bounded scan/batch/concurrency, and exact active-ID coverage accounting
- staged active-scope retrieval-index repair that swaps rebuilt BM25/vector state only after the rebuild succeeds
- fail-closed smart-search and MCP recall/smart-search scope contracts unless `project`, `cwd`, or explicit `global: true` is supplied
- branch-aware retrieval filtering for smart-search/context-backed retrieval
- intent/source-prior/exact-boost/vector-coverage/graph-expansion score traces
- near-duplicate suppression with duplicate trace metadata
- freshness diagnostics for deferred retrieval-block work
- bounded operator retry catch-up for deferred retrieval-block work, including `timeBudgetMs` to return deferred work cleanly before iii-engine invocation timeout
- optional reranking behind `RERANKER_ENABLED=true` or legacy `RERANK_ENABLED=true`
- operator diagnostics for BM25/vector coverage, freshness lag, duplicate rate, eval grade, recall, and leakage

Live proof checkpoint on 2026-04-28:

- `npm run eval:retrieval` returned grade `A+` with top1 precision `1.0`, recall@3 `1.0`, MRR `1.0`, duplicate rate `0`, leakage `0`, p95 latency `240ms`, and published the compact summary
- `POST /agentmemory/retrieval-proof` returned `pass: true`, health `healthy`, and maintenance status `caught_up`
- retrieval diagnostics reported `2204` manifest documents, BM25 size `2204`, vector coverage `1.0`, vector missing count `0`, and deferred retrieval-block queue `0`
- index persistence was healthy and saved successfully, but the runtime still recorded recent CPU pressure, so degraded-mode proof stays open

Remaining long-term ideal gaps:

- live degraded-mode proof must repeatedly return bounded partial/degraded traces instead of full-scope scans, endpoint timeouts, or worker OOM
- the eval suite needs a broader real-traffic corpus beyond the current seeded golden cases before the grade represents full long-term retrieval quality
- context and refresh payloads need continued budget enforcement so useful retrieval does not become oversized handoff output
- maintenance backfill, graph catch-up, compression catch-up, and index persistence must remain paused during warning-level pressure while proof endpoints are running

Required proof bundle:

- `npm run build`
- `npm test`
- `npm run eval:retrieval-quality`
- live proof under normal load does not OOM or invoke 30s endpoint timeouts
- live degraded-mode proof returns bounded partial/degraded traces instead of full-scope scans
- live `POST /agentmemory/retrieval-vector/backfill` dry-run shows vector coverage at least `0.98`
- live `POST /agentmemory/retrieval-index/verify` with `{ "scanBlocks": true, "repair": false, "vectorBackfill": false }` shows active vector coverage at least `0.98`
- live `POST /agentmemory/smart-search` without scope returns a scope-required error
- live `POST /agentmemory/smart-search` with `project` or `cwd` returns scoped results
- live diagnostics show `lastEvalGrade`, `duplicateRate`, `lastEvalRecallAt3`, and zero leakage after the eval summary is published
- deferred retrieval-block work drains after health gates are clear; operators can force due catch-up with `POST /agentmemory/retrieval-blocks/retry` and a bounded `timeBudgetMs` when proving recovery

## A+ Acceptance Gates

### Relevance

- Project-scoped smart-search top-1 precision is at least 70% on the golden eval set.
- Project-scoped smart-search top-3 recall is at least 90% on the golden eval set.
- mem::context includes at least one gold-supporting block for at least 95% of context eval cases.
- Mean reciprocal rank is at least 0.80 for exact issue, file, and feature queries.
- Project leakage count is zero.
- Branch-local blocks are excluded unless the caller supplies the matching branch or explicitly asks for broad search.

### Coverage

- BM25 coverage equals stored retrieval-block count outside active writes.
- Vector coverage is at least 98% of vector-eligible retrieval blocks.
- Deferred retrieval-block queue drains to zero within 5 minutes after health gates reopen.
- Current session working-set and turn-capsule blocks are visible to context immediately through stored blocks or bounded source fallback.

### Precision And Diversity

- Near-duplicate semantic and procedural memories occupy at most one result slot in top 5 unless the query explicitly asks for alternatives or history.
- Current working_set blocks do not outrank exact observation, decision, guardrail, or file-matching blocks unless the query is resume/current-state oriented.
- Generic architecture memories do not outrank specific operational evidence for incident or debugging queries.
- Results expose trace data that explains why each selected block won.

### Latency

- smart-search p50 under 250ms and p95 under 1s for project-scoped queries on warm indexes.
- mem::context p50 under 500ms and p95 under 2s for normal budgets.
- Under temporary CPU pressure, retrieval returns bounded degraded results instead of timing out, with an explicit trace reason.

### Operator Proof

- /agentmemory/retrieval-index/verify reports coverage, drift, and repair status without expensive full scans by default.
- Diagnostics expose duplicate rate, vector backlog, scoped index health, and freshness lag.
- A single eval command can produce the current grade and regression summary.

## Non-Goals

- Do not replace iii-engine or StateKV.
- Do not require an LLM reranker for the default hot path.
- Do not make unscoped retrieval broad by default if that increases project leakage risk.
- Do not solve all memory consolidation quality problems before improving retrieval ranking.

## P0: Build A Retrieval Quality Eval Harness

Problem: the current quality read depends on ad hoc probes. That makes it easy to declare success after health is green while ranking remains mediocre.

End state:

- A deterministic eval harness runs against a seeded in-memory store and optionally against the live service.
- Each case names expected project, branch, query, intent, required hits, forbidden hits, and acceptable source types.
- The harness reports precision@1, recall@3, MRR, duplicate rate, leakage count, latency, and selected trace reasons.

Implementation:

- Add test/fixtures/retrieval-quality-cases.json.
- Add cases for exact incident recall, current-session resume, file-specific lookup, branch-local lookup, broad architecture lookup, negative/noise query, duplicate semantic-memory cluster, and source freshness after deferred writes.
- Add test/retrieval-quality-eval.test.ts using the existing mock KV and retrieveRelevantBlocks().
- Add npm run eval:retrieval-quality for optional live REST evaluation.
- Store query/result traces in a compact artifact under /tmp by default, not in repo.

Tests:

- eval harness fails when a required block is outside top 3
- eval harness detects duplicate clusters in top 5
- eval harness detects project leakage
- eval harness reports latency and trace fields

Acceptance:

- Current baseline is reproducible from one command.
- Future ranking changes cannot claim A+ without passing this harness.

## P0: Complete Vector Coverage Without Brownouts

Problem: BM25 coverage is complete, but vector coverage is materially incomplete. With 2550 / 4091 vectors present, semantic search cannot reliably carry recall.

End state:

- Vector-eligible blocks are explicitly counted.
- Missing vectors are backfilled by a bounded worker.
- Backfill obeys health gates, provider rate limits, and retry backoff.
- Vector coverage remains visible in health and diagnostics.

Implementation:

- Define vector eligibility in src/state/retrieval-block-indexing.ts.
- Extend retrieval index verification to report vectorEligibleCount, vectorIndexedCount, vectorMissingCount, vectorCoverageRatio, and oldestMissingVectorAt.
- Add mem::retrieval-vector-backfill.
- Process oldest missing vectors first, capped by batch size, provider concurrency, elapsed time budget, and health gate.
- Reuse the existing retrieval-block retry queue for transient provider and StateKV failures.
- Persist progress and last scanned key in KV.config so backfill resumes without full list pressure every run.

Tests:

- verifier reports missing vectors separately from BM25 drift
- backfill embeds only missing vector-eligible blocks
- backfill respects batch and time caps
- provider 429 queues retry instead of dropping work
- health gate pauses without burning retries

Acceptance:

- Live vector coverage reaches at least 98%.
- No mem::smart-search timeout is introduced by backfill.

## P0: Fix Scope Contracts For Smart Search And Context

Problem: unscoped smart search can return empty or misleading results. Project-scoped retrieval is much better. A+ requires callers and APIs to make scope explicit or fail loudly.

End state:

- Agent-facing retrieval always sends project/cwd and branch when available.
- REST smart-search either has a scope or explicitly marks the query as global.
- Unscoped empty results are not confused with no relevant memory.

Implementation:

- Add optional cwd, branch, and global fields to mem::smart-search and api::smart-search payload typing.
- Resolve project from project || cwd at the REST boundary.
- If neither project, cwd, nor global: true is supplied, return scope_required.
- Thread branch into retrieveRelevantBlocks().
- Exclude branch-specific blocks by default when branch is unknown.
- Update MCP/agent tool schemas if they expose smart-search or recall.
- Keep broad/global search available only as explicit operator intent.

Tests:

- unscoped smart-search returns scope_required
- project-scoped smart-search returns expected project blocks
- cwd resolves to project scope
- branch-local block is returned only for matching branch
- explicit global: true can search global memories

Acceptance:

- No silent empty result for ordinary unscoped agent queries.
- Project leakage remains zero in evals.

## P1: Improve Ranking For Specificity

Problem: the engine can find relevant blocks, but generic/current blocks sometimes rank above the specific evidence the user actually needs.

End state:

- Specific evidence wins over generic context for specific queries.
- Current working-set blocks are strong for resume/current-state queries but weaker for exact historical or debugging queries.
- Ranking decisions are traceable.

Implementation:

- Add query intent classification before scoring: resume, debug, file, decision, implementation, architecture, and broad.
- Add source-type priors by intent.
- Add exact title/source boosts for phrase match, all query terms in title, file basename/path match, and source id/block id match.
- Downrank working_set when the query is not resume/current-state, title is generic, or overlap comes only from recent user wording.
- Normalize BM25, vector, and graph scores before blending.
- Include final score components in retrievalTrace.

Tests:

- exact retrieval-block query ranks the specific observation above working-set
- resume query ranks working-set or turn-capsule first
- file path query ranks file-bearing blocks above generic semantic memories
- debug query ranks incident observations above architecture summaries
- score trace contains source prior, exact boost, lane score, and final score

Acceptance:

- Golden eval MRR reaches at least 0.80.
- Exact incident and implementation queries have the gold block in top 3.

## P1: Collapse Duplicate And Near-Duplicate Memories

Problem: cold results contain repeated semantic memories with nearly identical claims. This wastes context budget and makes retrieval feel less sharp.

End state:

- Top results are diverse by claim, source, and session unless the user asks for historical variants.
- Duplicate clusters are still inspectable through expansion.

Implementation:

- Add a normalized claim fingerprint for semantic, procedural, insight, lesson, and memory blocks.
- At retrieval time, cluster blocks by normalized title, normalized canonical text prefix, concept overlap, and linked memory supersession chain.
- Keep the highest-scoring representative in top results.
- Attach duplicateClusterSize and duplicateIds to trace metadata.
- Add expandIds support to fetch cluster members if needed.
- Prefer newer/high-confidence memory within a duplicate cluster unless a query term only appears in an older member.

Tests:

- near-identical semantic memories collapse to one top-5 result
- expansion can retrieve suppressed cluster members
- non-duplicate memories with shared concepts remain separate
- newer/high-confidence duplicate wins

Acceptance:

- Top-5 duplicate rate is under 10% on the eval suite.

## P1: Make Freshness Fail Closed But Useful

Problem: health gates now preserve deferred work, but user-visible retrieval can lag while blocks are queued.

End state:

- Current session context can include source-state fallback even when retrieval block writes are temporarily deferred.
- Search responses can say when results are stale or missing queued work.
- Deferred work does not look like successful absence.

Implementation:

- Add freshnessLag to retrieval diagnostics with queued count, oldest queued block, affected source types, and affected projects/sessions when available.
- In retrieveRelevantBlocks(), use bounded source fallback for current working set, latest turn capsules, and high-importance observations when querying a scope with queued work.
- Add degradedFreshness: true to trace when fallback or queued gaps are involved.
- Do not run full collectRetrievalBlocksFromState() in request hot paths.

Tests:

- current-session context includes a deferred turn capsule through fallback
- search trace marks freshness degraded when queue affects scope
- bounded fallback does not list every session
- stale queued block disappears from trace after retry drains

Acceptance:

- Current-turn/context retrieval remains useful during write gates.
- Operators can see exactly which queue is delaying freshness.

## P2: Improve Vector And Graph Fusion

Problem: hybrid search exists, but partial vector coverage and graph supplements can create uneven ranking.

End state:

- Vector score is trusted only when coverage and query embedding are available.
- Graph boosts supplement evidence instead of overpowering lexical/source specificity.
- Missing vector coverage degrades ranking predictably.

Implementation:

- Add a vector coverage confidence factor to query scoring.
- If vector coverage for the scoped candidate set is below threshold, lower vector weight and emit trace.
- Boost graph-linked blocks only when the relationship is direct or high confidence, same project, and source text has minimal query overlap.
- Add graph context only once per selected block.
- Avoid graph expansion for broad unscoped/global queries unless explicit.

Tests:

- low vector coverage lowers vector influence
- direct graph relation boosts a related observation into top 5
- graph relation cannot pull cross-project blocks into scoped results
- graph-only generic block does not outrank exact lexical match

Acceptance:

- Vector and graph improve eval scores without increasing leakage or noise.

## P2: Add Optional Second-Stage Reranking

Problem: deterministic ranking should be strong enough by default, but some ambiguous queries need a second pass.

End state:

- Default retrieval remains deterministic and cheap.
- Optional reranking improves top-10 ordering when enabled.
- Reranking is bounded and never blocks core context injection under pressure.

Implementation:

- Add RERANKER_ENABLED=false default.
- Rerank only the top 20 deterministic candidates.
- Use a local/lightweight reranker if available; LLM reranking must be explicit and separately gated.
- Cache rerank results by query fingerprint plus candidate IDs.
- Emit trace showing deterministic rank and reranked rank.

Tests:

- reranker is skipped by default
- reranker reorders top candidates when enabled
- reranker timeout falls back to deterministic ranking
- reranker respects project/branch filtering

Acceptance:

- Reranking improves eval MRR without harming p95 latency when disabled.

## P3: Operator Dashboard And Regression Guardrails

Problem: operators need a single quality read, not raw scattered signals.

End state:

- Diagnostics can answer coverage, freshness, latency, duplicate rate, eval grade, and recent regressions.

Implementation:

- Add retrieval quality fields to diagnostics: bm25Coverage, vectorCoverage, deferredFreshnessLag, duplicateRate, lastEvalGrade, and lastEvalAt.
- Add a viewer diagnostics panel if the viewer is in scope.
- Store only compact eval summaries in KV; keep large artifacts out of StateKV.
- Alert on vector coverage below 95%, retrieval queue older than 10 minutes, eval top-3 recall below threshold, or project leakage greater than zero.

Tests:

- diagnostics returns all quality metrics
- alert thresholds fire on synthetic degraded metrics
- eval summary storage remains compact

## Rollout Plan

### Phase 1: Measurement First

- Add eval harness.
- Add vector eligibility and coverage metrics.
- Add duplicate-rate measurement.
- No ranking behavior changes yet.

Exit:

- Current baseline grade can be reproduced.
- Metrics match live probes within expected drift.

### Phase 2: Coverage And Scope

- Implement vector backfill.
- Enforce scoped smart-search behavior.
- Add branch threading.

Exit:

- Vector coverage at least 98%.
- Unscoped search no longer silently returns empty.
- No project/branch leakage in tests.

### Phase 3: Ranking And Diversity

- Add intent-aware source priors.
- Add exact/source boosts.
- Downrank generic working sets for non-resume queries.
- Collapse duplicate memory clusters.

Exit:

- Top-1 precision at least 70%.
- Top-3 recall at least 90%.
- Duplicate rate below 10%.

### Phase 4: Freshness And Fusion

- Add scoped freshness fallback.
- Tune vector/graph fusion.
- Add optional reranker behind a flag.

Exit:

- Current-session context stays useful under write gates.
- p95 latency remains within target.
- Eval grade is A or better.

### Phase 5: A+ Gate

- Run live eval after a normal working session.
- Run degraded-mode eval while health gates are active.
- Confirm diagnostics show no hidden drift.

Exit:

- Eval grade A+ for two consecutive runs.
- Live vector coverage at least 98%.
- Deferred retrieval-block queue drains after health recovers.
- No silent empty project-less search in agent-facing paths.

## Code Anchors

- src/functions/retrieval-engine.ts
- src/functions/smart-search.ts
- src/functions/context.ts
- src/functions/retrieval-blocks.ts
- src/functions/retrieval-block-retry.ts
- src/state/retrieval-block-indexing.ts
- src/functions/retrieval-index-verify.ts
- src/functions/retrieval-block-diagnostics.ts
- src/mcp/tools-registry.ts
- src/mcp/server.ts
- src/triggers/api.ts
- test/retrieval-engine.test.ts
- test/smart-search.test.ts
- test/context.test.ts
- test/retrieval-index-verify.test.ts
- test/retrieval-block-retry.test.ts

## Final Definition Of A+

Retrieval is A+ when a user can ask a specific project-scoped question and get the right evidence in the first few results, with minimal duplicate filler, clear traceability, current-session freshness, no project leakage, and stable latency under normal load.

Operational durability was the prerequisite. This spec is the relevance and sharpness layer.
