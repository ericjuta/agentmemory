# Dashboard UI Audit And Improvement Spec

## Goal

Define the next UI pass for the built-in viewer so the dashboard reflects the
current backend reality after the recent retrieval, scoping, handoff, and
dossier hardening work.

This is a viewer/UI spec, not a backend spec.

## Scope

This spec covers:

- the dashboard landing view in `src/viewer/index.html`
- adjacent tab/navigation changes required to support the dashboard
- frontend rendering of existing backend fields
- minimal new backend read shapes only where the current viewer contract is
  clearly insufficient

This spec does not cover:

- changing retrieval ranking policy
- reworking memory semantics
- redesigning the graph canvas physics
- replacing the built-in viewer with a SPA framework

## Context

Recent backend work materially changed what the product can explain:

- bootstrap now returns `latestHandoff`, `nextAction`, `guardrails`,
  `activeDecisions`, `branchOverlaySummary`, and `retrievalTrace`
- `mem::context` now returns structured `items` and `trace`
- durable memory is now scoped by project, branch, and session instead of
  effectively global bleed-through
- dossier refresh now survives mixed live KV shapes and keeps relevance tied to
  file/retrieval state
- richer observation signals and turn-capsule data are available for continuity

The dashboard does not yet expose that model. It still presents the system
mostly as a storage browser plus health counters.

## Current Audit

## What exists now

The current viewer already has useful raw coverage:

- health and worker/runtime state
- session counts and recent audit activity
- semantic/procedural memory summaries
- separate tabs for guidance, components, coordination, operations, profile,
  sessions, timeline, graph, audit, and more

The dashboard itself fetches 17 endpoints in parallel and renders:

- topline counts
- system resources and runtime diagnostics
- recent sessions and audit activity
- function metrics
- semantic/procedural memory snippets
- consolidation counts

## Main problems

### 1. The dashboard is storage-centric, not operator-centric

The current landing page answers:

- how many things exist
- whether the worker is healthy

It does not answer the higher-value questions the new backend can now support:

- what should I pay attention to right now
- what is constraining current work
- what changed recently that matters
- what would a resume path look like
- why a file/module is considered relevant

### 2. The best new backend fields are not surfaced

The dashboard does not show:

- latest handoff packet
- recommended next action
- branch overlay summary
- retrieval trace
- retrieval item metadata (`why`, `freshness`, `confidence`,
  `recommendedNextStep`, `relevantFiles`, `concepts`)

Those are the fields that make the recent backend work legible.

### 3. Counts dominate detail

The first screen is a large wall of stat cards. Many are useful, but most are
not decision-driving on every visit:

- lessons
- crystals
- handoffs
- guardrails
- decisions
- dossiers
- routine proposals
- branch overlays

These are better as compact summary counters attached to actionable panels, not
as the primary visual hierarchy.

### 4. Navigation is too flat

The viewer currently exposes 15 top-level tabs. That is too many for the amount
of overlap in the content model. The main result:

- guidance, components, coordination, operations, sessions, and dashboard all
  compete as landing views
- the user has to remember where "important current truth" lives
- related surfaces are split even when they answer the same operator question

### 5. Cross-linking is weak

Examples:

- dashboard cards do not open the corresponding focused surfaces
- a dossier does not directly show the guardrails/decisions/handoffs that make
  it important
- a decision does not point to the dossiers or files it constrains
- recent sessions do not highlight the resume-worthy session versus just the
  newest session

### 6. Error handling collapses to empty state too often

`api()` returns `null` on non-OK or fetch failure. The dashboard then silently
renders:

- empty tables
- missing sections
- zero-like counts

That makes degraded backend state look similar to "no data yet."

### 7. Freshness and scope are mostly invisible

Recent work made scope and recency more trustworthy, but the UI does not show:

- whether a memory/decision/guardrail is project-scoped, branch-scoped, or
  session-scoped
- whether a dossier is warm/current versus old
- whether a recommendation is from hot turn context, warm active state, or cold
  durable history

### 8. The header contains stale product metadata

The viewer header shows `v0.7.0` as a hardcoded string. That is no longer a
reliable runtime indicator and reduces trust in the UI.

### 9. Refresh behavior is heavy and opaque

The dashboard does a full 17-endpoint reload every 30 seconds. Problems:

- all panels refresh together even if only one lane changed
- there is no per-panel loading state after initial load
- there is no "last updated" indicator
- live events only imply activity; they do not explain what was refreshed

## Design Principles

The next dashboard should follow these rules:

1. Show "what matters now" before "what exists."
2. Put continuity and constraints above aggregate counts.
3. Make scope and freshness visible everywhere they affect trust.
4. Distinguish empty, loading, degraded, and partial-success states.
5. Use existing backend structure before inventing new endpoints.
6. Keep the landing page useful in under 5 seconds of scanning.
7. Treat the rest of the viewer as drill-down surfaces behind the dashboard,
   not as peer landing experiences.

## Required End State

The dashboard landing page should become an operator home with four primary
bands:

1. system health
2. current work posture
3. continuity and retrieval
4. memory quality and coverage

The first viewport should answer:

- is the system healthy enough to trust
- what is the next recommended work
- what are the active blockers/guardrails/decisions
- what session or handoff should I resume
- which files/modules currently matter

## Information Architecture

## New top-level tab model

Reduce top-level tabs from 15 to 7:

- `Overview`
- `Sessions`
- `Memory`
- `Coordination`
- `Files`
- `Graph`
- `Diagnostics`

## Mapping from current tabs

- `Dashboard` becomes `Overview`
- `Memories`, `Lessons`, `Crystals`, `Audit`, `Activity`, `Profile` collapse
  under `Memory`
- `Actions`, `Operations`, `Guidance`, `Coordination` collapse under
  `Coordination`
- `Components` becomes `Files`
- `Sessions` stays
- `Graph` stays
- health/runtime/function metrics live under `Diagnostics`

This is an IA change first. The first implementation can preserve current
renderers internally while moving them behind grouped tabs/subsections.

## Overview Page Specification

## Section 1: Status Rail

Place a compact horizontal status rail at the top with:

- overall health
- connection state
- live updates state
- worker count
- last refreshed timestamp
- viewer version/runtime version

Requirements:

- use current `health` payload
- replace hardcoded version with runtime version if available, otherwise omit
  the version label
- show degraded/error explicitly, not as muted text

## Section 2: Current Work Posture

This is the highest-priority section on the page.

Render four cards:

### Suggested Next Work

Source:

- `mem::next` or `bootstrap.nextAction`

Show:

- title
- short description
- priority
- score
- tags
- project
- lease state if available

CTA:

- `Open Coordination`

If no suggestion exists:

- show an honest empty state with the backend message

### Active Constraints

Source:

- guardrails
- active decisions
- branch overlay summary

Show:

- up to 3 guardrails with risk badge, scope badge, short explanation
- up to 3 active decisions with title, chosen decision, reconsider trigger
- one branch overlay summary block if present

This replaces the current pattern where these items are only counted on the
dashboard and hidden in separate tabs.

### Resume Candidate

Source:

- latest handoff packet
- recent active or recently-ended sessions

Show:

- best resume summary
- blockers
- recommended next step
- relevant files
- scope badge (`session`, `mission`, `action`)
- age/freshness label

Rule:

- prefer `bootstrap.latestHandoff` or the newest packet with useful content,
  not simply the newest session row

### Attention Needed

Source:

- health alerts
- open circuit breaker
- failed runtime diagnostics
- blocked missions

Show only actionable warnings. Do not repeat generic green states here.

## Section 3: Retrieval And Continuity

This section is the main UI expression of the recent backend changes.

Render two side-by-side cards:

### Why This Context Matters

Source:

- session bootstrap retrieval items for the current or most recent session
- or a lightweight overview retrieval call if no active session exists

Show each item as a structured retrieval chip/list row:

- title
- source type
- `why`
- freshness badge: `hot`, `warm`, `cold`
- confidence score
- top 2 relevant files
- top 3 concepts
- optional blocker
- optional recommended next step

This is the core missing UI today.

### Retrieval Trace Summary

Source:

- `retrievalTrace`

Do not dump raw JSON by default.

Show:

- query or intent label
- lane budget usage (`hot`, `warm`, `cold`)
- selected item count
- skipped item count
- top trace decisions
- partial-success/degraded note if one lane failed or fell back

Provide an expandable raw trace view for debugging.

## Section 4: File And Module Relevance

Use the new dossier confidence/relevance work to make file state visible.

Render:

- top dossiers by current relevance
- each dossier row shows file path, summary, active risks, open questions, and
  linked concepts
- decisions/guardrails affecting that dossier should appear as inline badges or
  secondary chips

Rule:

- do not show dossier count as the main value
- show the top 5 most operationally relevant dossiers first

This section should answer:

- which files matter now
- what is risky in those files
- what decisions or guardrails constrain those files

## Section 5: Memory Quality And Coverage

Move aggregate metrics below the operator sections.

Render compact panels for:

- semantic memory count and top recent facts
- procedural memory count and top routines
- consolidation status
- relation coverage
- token savings

Requirements:

- label token savings as an estimate unless the calculation becomes grounded in
  persisted measured values
- demote raw total counts visually

## Section 6: Diagnostics Snapshot

Keep a compact diagnostic summary on the overview page:

- heap
- CPU
- event loop lag
- KV connectivity
- snapshot persistence
- pipeline activity

Detailed function metrics, worker rows, and circuit-breaker internals should
move behind `Diagnostics` by default, with only alerting summary on `Overview`.

## Secondary Surface Specs

## Sessions

Improve session detail so it is continuity-aware:

- highlight sessions with handoffs
- highlight sessions with unfinished active work
- show bootstrap-style summary when selected
- add "resume picture" subsection:
  - latest handoff
  - next action
  - active guardrails
  - active decisions

## Files

This tab becomes the canonical home for dossiers and routine candidates.

Required changes:

- searchable dossier list
- sort by relevance/freshness, not only insertion order
- scope badges for project/branch linkage
- direct display of linked decisions and guardrails
- expandable evidence section with key facts and relevant files/concepts

## Coordination

Collapse:

- current `actions`
- current `operations`
- current `guidance`
- current `coordination`

into one coordinated workspace with subsections:

- next work
- frontier
- blockers
- missions
- handoffs
- guardrails
- decisions

This aligns with the operator question: "what work should move next and what is
stopping it?"

## Diagnostics

Make diagnostics explicitly operational:

- health summary
- runtime probes
- function metrics
- worker inventory
- circuit breaker details
- fetch errors / partial data state

The current dashboard content for these areas can mostly move here unchanged.

## Interaction Requirements

## Cross-linking

All major rows/cards should be navigable:

- clicking `Suggested Next Work` opens Coordination with the relevant action
  highlighted
- clicking a dossier opens Files filtered to that file
- clicking a guardrail or decision opens Coordination or the relevant filtered
  panel
- clicking a retrieval item with file references opens Files filtered to those
  files
- clicking a session in Resume Candidate opens that session detail

## Progressive disclosure

Default cards should show short summaries only. Add expanders for:

- retrieval trace raw detail
- full handoff summary
- dossier evidence
- decision rationale
- guardrail triggers

## State handling

Every section must distinguish:

- loading
- loaded with data
- loaded but empty
- degraded/partial
- failed

Do not reuse the same empty-state copy for network failure and no data.

## Data Contract Requirements

## Use existing fields first

The first implementation should use existing surfaces:

- `GET /agentmemory/health`
- `POST /agentmemory/session/start`
- `GET /agentmemory/sessions`
- `GET /agentmemory/handoffs`
- `GET /agentmemory/guardrails`
- `GET /agentmemory/decisions`
- `GET /agentmemory/dossiers`
- `GET /agentmemory/routine-candidates`
- `GET /agentmemory/missions`
- `GET /agentmemory/next`
- `POST /agentmemory/context`

## Preferred new read shape

If the current Overview page would otherwise require too many overlapping reads,
add one aggregated viewer-oriented endpoint:

```ts
GET /agentmemory/viewer/overview
```

with response shape:

```ts
{
  generatedAt: string;
  health: HealthResponse;
  resume: {
    latestHandoff: HandoffPacket | null;
    nextAction: SessionBootstrap["nextAction"];
    guardrails: GuardrailMemory[];
    activeDecisions: DecisionMemory[];
    branchOverlaySummary?: string | null;
  };
  retrieval: {
    items: RetrievalContextItem[];
    trace?: RetrievalTrace;
  };
  files: {
    dossiers: ComponentDossier[];
    routineCandidates: RoutineCandidate[];
  };
  memory: {
    semantic: SemanticMemory[];
    procedural: ProceduralMemory[];
    relationCount: number;
    tokenSavingsEstimate: {
      tokensSaved: number;
      savingsPct: number;
      estimatedCostSavedUsd: number;
      estimated: true;
    };
  };
}
```

Rules:

- keep it bounded and overview-only
- do not dump hundreds of rows
- prefer top-N per lane
- partial-success must be allowed

## Performance Requirements

1. Overview first paint should not wait on every secondary lane.
2. Health and current-work sections should render first.
3. Retrieval/file/memory quality sections may stream in after initial paint.
4. Auto-refresh should be sectional, not full-page, when possible.
5. Live update events should invalidate only the affected panels.

## Accessibility Requirements

1. Every badge/color state must have text, not color only.
2. Keyboard focus must work across tabs, cards, expanders, and filters.
3. Tables that act like navigation must become buttons/links or have explicit
   row actions.
4. Dense cards must maintain readable contrast in both themes.
5. Mobile/tablet layouts must stack cleanly without horizontal overflow in the
   first viewport.

## Visual Direction

Keep the current distinctive editorial look. Do not flatten it into generic app
chrome.

Preserve:

- serif/display identity
- structured borders
- strong sectioning

Improve:

- clearer primary/secondary hierarchy
- less first-screen metric noise
- better badge grammar for scope, freshness, and risk
- stronger spacing between actionable and informational panels

## Implementation Plan

## Phase 1: Dashboard Restructure

- rename `Dashboard` to `Overview`
- replace stat-wall-first layout with:
  - status rail
  - current work posture
  - retrieval and continuity
  - file relevance
  - memory quality
  - compact diagnostics
- remove hardcoded version string
- add last-updated indicator
- add error/degraded state rendering per panel

## Phase 2: Navigation Consolidation

- reduce top-level tabs
- regroup existing renderers behind the new IA
- add cross-links between cards and destination tabs

## Phase 3: Retrieval And Dossier Legibility

- surface retrieval items and retrieval trace
- render scope/freshness badges
- rank dossiers by operational relevance
- show linked decisions/guardrails inline

## Phase 4: Viewer Aggregation

- if needed, add `viewer/overview`
- switch overview fetch path from many raw calls to bounded aggregate reads
- preserve direct tabs for deep inspection

## Acceptance Criteria

This spec is done when:

1. The first screen answers what matters now without leaving the Overview page.
2. Retrieval metadata is visible in the UI without reading raw JSON.
3. Guardrails, decisions, next action, and latest handoff appear as first-class
   overview elements.
4. Dossiers are shown as active file/module posture, not just a count.
5. Empty vs degraded vs failed states are visibly distinct.
6. The top-level tab count is materially reduced.
7. The header no longer shows stale hardcoded version data.
8. Auto-refresh and live updates feel bounded rather than full-page churn.

## Test Coverage Requirements

Add or update viewer tests for:

1. overview renders suggested next work from existing payload
2. overview renders latest handoff and blockers
3. overview renders retrieval item metadata and trace summary
4. degraded fetch state produces an error panel instead of fake emptiness
5. scope/freshness badges render correctly
6. stale hardcoded version string is removed
7. top-level tab reduction does not break existing route/tab switching

## Stop Rules

- Do not rewrite the viewer in React or another framework for this pass.
- Do not block the UI pass on a larger backend redesign.
- Do not expose raw trace JSON by default as the main user-facing experience.
- Do not add new backend writes just to support dashboard rendering.
