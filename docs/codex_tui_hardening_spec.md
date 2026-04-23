<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Codex TUI Hardening Spec

## Goal

Define the backend hardening work that makes direct Codex TUI use of
`agentmemory` faster, higher-signal, and more reliable.

This spec is intentionally about the native Codex TUI path only:

- startup and resume
- prompt-time retrieval
- tool-time enrichment
- session closeout
- operator-facing memory reads

It is not about MCP coverage, generic external clients, or public integration
marketing.

## Non-Goals

- adding more MCP tools
- pushing ranking policy into Codex
- making Codex own more orchestration logic than necessary
- redesigning the current retrieval engine from scratch
- widening the always-on runtime lane without a latency reason

## Current Shape

Today the direct Codex TUI path is functional, but it still has several
backend seams that leak into the caller:

1. `POST /agentmemory/session/start` creates a session and returns only
   `session + context`.
2. resume handoff lookup requires a separate `GET /agentmemory/handoffs` read.
3. prompt-time retrieval is split across:
   - `POST /agentmemory/context/refresh`
   - `POST /agentmemory/context`
4. shutdown is fragmented across:
   - `POST /agentmemory/summarize`
   - `POST /agentmemory/session/end`
   - `POST /agentmemory/crystals/auto`
   - `POST /agentmemory/consolidate-pipeline`
5. richer coordination surfaces exist, but startup/retrieval do not yet return
   them as a small structured operating picture.

That shape works, but it is not the best long-term backend contract for a TUI.

## Primary Problems

### Too many round trips

Codex should not need to assemble its startup and closeout lifecycle from a
chain of loosely related endpoints.

### Too much caller branching

Codex currently has to know when to use `context/refresh` versus `context`, and
how to stitch together resume state from multiple backend reads.

### Retrieval returns too little structure

The backend is still too text-centric in places where the TUI wants structured
state:

- why something was retrieved
- freshness and confidence
- blockers and next step
- relevant files and concepts
- whether a result is a resume artifact, a guardrail, a decision, or general
  context

### Closeout is fragile

Multiple independent shutdown calls increase the chance of partial success,
duplicate work, or invisible failure.

## End-State Contract

The direct Codex TUI backend contract should converge on three main calls:

1. session bootstrap
2. prompt-time retrieval
3. bounded closeout

Everything else can remain as supporting internal surfaces or explicit
operator-facing reads.

## Track 1: Session Bootstrap

### Goal

Turn startup and resume into one high-signal backend read.

### Current Problem

`session/start` currently returns only the new session record and plain context.
Resume-specific state requires additional reads.

### Required End-State

`POST /agentmemory/session/start` should return a bootstrap payload shaped more
like:

```ts
{
  session: Session;
  bootstrap: {
    context: string;
    latestHandoff?: HandoffPacket | null;
    nextAction?: Action | null;
    guardrails: Guardrail[];
    activeDecisions: Decision[];
    branchOverlaySummary?: string | null;
    retrievalTrace?: RetrievalTrace;
  };
}
```

### Expectations

- startup should produce a usable operator picture in one call
- resume should not need a second generic handoff listing call for the common
  path
- the returned set should stay small and latency-sensitive
- absence of one component should not fail the full bootstrap

### Implementation Notes

- keep the existing session creation semantics
- add a backend-owned latest-handoff selection path instead of forcing the
  caller through generic list/filter logic
- cap supporting surfaces aggressively so bootstrap remains fast

## Track 2: Prompt-Time Retrieval

### Goal

Make prompt-time recall one semantic backend action, not a caller-side branch.

### Current Problem

The direct TUI path currently has to reason about:

- `context/refresh` for query-aware recall
- `context` for fallback and explicit recall
- `enrich` for file/tool-local help

### Required End-State

The backend should support one retrieval contract with explicit intent:

```ts
{
  sessionId: string;
  project: string;
  intent:
    | "resume"
    | "user_turn"
    | "manual_recall"
    | "file_enrich"
    | "next_action";
  query?: string;
  filePath?: string;
  budget?: number;
}
```

### Expectations

- Codex should call one backend retrieval surface for prompt-time recall
- the backend decides whether query-aware ranking, hot-path continuity, or
  file-local enrichment dominates
- short or noisy queries should degrade gracefully instead of producing an empty
  special-case branch that the caller must interpret

### Quality Requirements

Return structured result metadata alongside text:

```ts
{
  context: string;
  items: Array<{
    sourceType: string;
    sourceId: string;
    title: string;
    why: string;
    freshness: "hot" | "warm" | "cold";
    confidence: number;
    relevantFiles: string[];
    concepts: string[];
    blocker?: string | null;
    recommendedNextStep?: string | null;
  }>;
  trace?: RetrievalTrace;
}
```

### Ranking Requirements

- fresh same-session truth wins by default
- resume artifacts should only dominate when intent is clearly resume-oriented
- decisions and guardrails should be promoted when they directly constrain the
  current request
- old durable memory should not swamp active turn state

## Track 3: Tool-Time Enrichment

### Goal

Keep `enrich` useful for Codex tool-time help without letting it become a noisy
general retrieval path.

### Required End-State

- treat `enrich` as an internal specialization of the shared retrieval engine
- bias results toward the touched file, nearby files, and relevant failures
- keep token budgets smaller than prompt-time recall
- return structured file-local signals, not only appended prose

### Guardrails

- do not expose generic memory spray during file-touching operations
- do not let enrich outrank fresh turn context for non-file intents

## Track 4: Bounded Closeout

### Goal

Replace the current multi-call shutdown choreography with one backend-owned
closeout pipeline.

### Required End-State

Add a closeout operation such as:

```ts
POST /agentmemory/session/closeout
```

with semantics equivalent to:

1. summarize session
2. end session
3. auto-crystallize
4. run bounded consolidation maintenance

### Expected Response

```ts
{
  success: boolean;
  steps: {
    summarize: "ok" | "skipped" | "failed";
    endSession: "ok" | "skipped" | "failed";
    crystallize: "ok" | "skipped" | "failed";
    consolidate: "ok" | "skipped" | "failed";
  };
  errors?: Array<{ step: string; message: string }>;
}
```

### Reliability Requirements

- closeout must be idempotent
- partial success must be visible
- a failed maintenance step must not erase a successful session end
- the backend should own retries/bounding instead of making Codex orchestrate
  each substep separately

## Track 5: Internal Performance

### Goal

Lower latency for the Codex TUI hot path without regressing retrieval quality.

### Required Work

1. precompute a latest-handoff pointer for resume
2. cache small bootstrap bundles for immediate resume cases
3. extend scoped retrieval indexing for direct intent-aware lookups
4. keep repeated identical recall requests under short TTL caching
5. prefer partial-good results when one retrieval lane is slow

### Guardrails

- no global scans on the hot path
- no Git shell-outs on the hot path
- no all-or-nothing failure when one secondary surface is degraded

## Track 6: Validation

### Goal

Prove direct Codex TUI behavior, not just narrow native payload acceptance.

### Required Test Coverage

Expand the Codex compatibility lane to cover:

1. startup bootstrap
2. resume with latest handoff selection
3. prompt-time retrieval with intent-aware ranking
4. file-local enrich behavior
5. closeout pipeline success and partial failure cases
6. idempotent retry behavior for startup and closeout
7. degraded partial-success retrieval when one secondary lane fails

### Standard Of Done

This hardening lane is done when:

- Codex startup gets a one-call bootstrap view
- prompt-time retrieval is exposed as one semantic backend action
- closeout is backend-owned and idempotent
- structured retrieval metadata is available for the TUI
- direct-TUI compatibility tests cover the full lifecycle, not just ingest

## Implementation Order

1. add bootstrap payload to `session/start`
2. add backend latest-handoff selection
3. unify prompt-time retrieval intent handling
4. add bounded `session/closeout`
5. expand direct Codex lifecycle tests

## References

- [`docs/codex_surface_contract_spec.md`](./codex_surface_contract_spec.md)
- [`docs/codex_payload_quality_spec.md`](./codex_payload_quality_spec.md)
- [`src/triggers/api.ts`](../src/triggers/api.ts)
- [`src/functions/context.ts`](../src/functions/context.ts)
- [`src/functions/enrich.ts`](../src/functions/enrich.ts)
- [`src/functions/handoffs.ts`](../src/functions/handoffs.ts)
- [`src/functions/summarize.ts`](../src/functions/summarize.ts)
- [`src/functions/consolidation-pipeline.ts`](../src/functions/consolidation-pipeline.ts)
- [`test/codex-compat.test.ts`](../test/codex-compat.test.ts)
