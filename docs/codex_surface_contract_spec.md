<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Codex Surface Contract Spec

## Goal

Define the receiver-side, end-state UX contract for Codex integration with
`agentmemory`.

This document is about surface shape and user experience, not sender-side
payload details. The main native Codex sender contract belongs in the Codex
repo. The narrow ingest companion remains
[`docs/codex_payload_quality_spec.md`](./codex_payload_quality_spec.md).
For backend performance and quality hardening of the direct TUI path, see
[`docs/codex_tui_hardening_spec.md`](./codex_tui_hardening_spec.md).

## Problem

The repository already documents two useful but incomplete views:

- generic Codex CLI setup as an MCP client in `README.md`
- narrow native-payload ingest guarantees in
  [`docs/codex_payload_quality_spec.md`](./codex_payload_quality_spec.md)

That still leaves one important gap: the active Codex integration has two
different live surfaces, but the repo does not say so clearly enough.

Without that split, three UX mistakes become likely:

1. MCP-only setup gets described as equivalent to native lifecycle capture.
2. The always-on runtime lane gets treated like a grab bag of optional tools.
3. Future additions to the explicit command surface risk being mistaken for
   baseline runtime dependencies.

## Decision

Document Codex integration as three distinct levels:

1. `Generic Codex CLI`
   - MCP-only setup via `.codex/config.yaml`
   - no native lifecycle capture implied
2. `Codex-native runtime lane`
   - always-on REST-backed lifecycle and retrieval path
   - small, stable, latency-sensitive
3. `Codex explicit memory lane`
   - broader human-invoked memory, planning, and review surface
   - useful, but not required for baseline automatic capture and resume

## Interface Boundary

This document describes the receiver-side backend contract.

- the runtime-critical native lane is REST-backed in `agentmemory`
- the explicit memory lane may be presented inside Codex as tools, slash
  commands, prompts, or other adapter-owned UX
- docs in this repo should not imply that every Codex-facing command has a
  one-to-one MCP tool defined here
- generic MCP-only Codex setup remains a separate, thinner integration level

## Runtime-Critical Native Subset

This is the receiver-side always-on lane that should remain small and stable.

### Resume and startup

- `POST /agentmemory/session/start`
- `GET /agentmemory/handoffs`

Expected UX:

- starting or resuming a session should return immediate context
- resume should be able to review the latest durable handoff packet without
  requiring a human recap

### In-turn capture and recall

- `POST /agentmemory/observe`
- `POST /agentmemory/context/refresh`
- `POST /agentmemory/context`
- `POST /agentmemory/enrich`

Expected UX:

- prompt submit should prefer query-aware `context/refresh` when the adapter has
  retrieval intent
- `context` remains the fallback path and also the explicit recall path
- observe is the canonical capture sink for native lifecycle events
- enrich remains a supporting retrieval surface for file-touching/tool-time UX

### Session-end distillation

- `POST /agentmemory/summarize`
- `POST /agentmemory/session/end`
- `POST /agentmemory/crystals/auto`
- `POST /agentmemory/consolidate-pipeline`

Expected UX:

- shutdown should distill useful state without requiring a human-written recap
- maintenance work should be best-effort and bounded, not a fragile hard block
  on session close

## Broader Explicit Memory Lane

This is the broader Codex command/tool/slash surface. It should stay available,
but it must not be treated as a prerequisite for baseline automatic capture.

### Durable memory and retrieval

- `POST /agentmemory/remember`
- `POST /agentmemory/consolidate`
- `GET /agentmemory/lessons`
- `POST /agentmemory/lessons/search`
- `GET /agentmemory/crystals`
- `POST /agentmemory/crystals/create`
- `POST /agentmemory/reflect`
- `GET /agentmemory/insights`
- `POST /agentmemory/insights/search`

### Planning and coordination

- `GET /agentmemory/actions`
- `POST /agentmemory/actions`
- `POST /agentmemory/actions/update`
- `GET /agentmemory/frontier`
- `GET /agentmemory/next`
- `GET /agentmemory/missions`
- `GET /agentmemory/missions/:id`
- `GET /agentmemory/handoffs`
- `GET /agentmemory/handoffs/:id`
- `POST /agentmemory/handoffs/generate`
- `GET /agentmemory/branch-overlays`

### Policy, decisions, and file context

- `GET /agentmemory/guardrails`
- `POST /agentmemory/guardrails/search`
- `GET /agentmemory/decisions`
- `POST /agentmemory/decisions/search`
- `GET /agentmemory/dossiers`
- `GET /agentmemory/dossiers/get`
- `GET /agentmemory/routine-candidates`

### Explicit caveat

`POST /agentmemory/forget` exists in the adapter/backend surface, but it should
not be described as part of the active Codex native lane unless the live Codex
path actually routes delete semantics through that endpoint.

## UX Requirements

1. Do not describe MCP-only Codex setup as equivalent to native lifecycle
   capture.
2. Do not let the explicit memory lane become an implicit dependency of the
   always-on runtime lane.
3. Keep the runtime lane centered on capture, query-aware recall, resume, and
   session-end distillation.
4. Prefer the smallest stable runtime contract over exposing every backend
   primitive as "required for Codex."
5. When docs mention mission or handoff detail routes, prefer the real REST
   shape (`:id`) instead of inventing placeholder names that differ from the
   current API.
6. Keep sender-side payload evolution and receiver-side ingest compatibility as
   separate documents and responsibilities.

## Codex-Only Runtime Diet Spec

This section scopes a host-local diet for the current environment where the
native Codex adapter is the only real client. It is not a public product
position and should not be applied to upstream packaging without an explicit
distribution decision.

### Current Live Finding

2026-04-29 diagnostics show the installed runtime is not oversized because MCP
stores a large database. MCP, plugin, and Claude integration code mostly add
registered functions, handlers, docs, and package surface.

The larger storage/RSS contributors are active StateKV scopes and loaded indexes:

- active StateKV data is about 785 MB across about 18k files
- observation/retrieval indexes account for about 174 MB by manifest size
- turn capsules plus working sets account for about 124 MB
- Codex project entries inside turn capsules plus working sets are only about
  1.7 MB of that 124 MB
- compaction dry-run reported 0 removable index bytes, so the immediate issue is
  active retained data, not orphaned shards

Implication: cutting MCP will simplify the process surface and reduce startup
registration/attack area, but it will not by itself halve the database. Halving
the database requires retention and project-scope policy, especially for old or
non-Codex projects.

### Keep For Native Codex

Keep these backend surfaces until Codex has migrated to any replacement
contract:

- `GET /agentmemory/health`
- `POST /agentmemory/session/start`
- `POST /agentmemory/session/closeout`
- `POST /agentmemory/session/end` until closeout fully replaces direct end calls
- `POST /agentmemory/observe`
- `POST /agentmemory/context`
- `POST /agentmemory/context/refresh` until unified retrieval replaces the
  caller branch
- `POST /agentmemory/enrich` until file-enrich is folded into unified retrieval
- `POST /agentmemory/smart-search`
- `POST /agentmemory/summarize` until closeout fully owns summarization
- `POST /agentmemory/crystals/auto` until closeout fully owns crystallization
- `POST /agentmemory/consolidate-pipeline` until closeout fully owns bounded
  distillation
- `GET /agentmemory/handoffs` and `GET /agentmemory/handoffs/:id` until
  bootstrap returns latest handoff inline
- `POST /agentmemory/handoffs/generate`
- `GET /agentmemory/actions`, `POST /agentmemory/actions`,
  `POST /agentmemory/actions/update`, `GET /agentmemory/frontier`, and
  `GET /agentmemory/next` if Codex continues to expose explicit work-item
  memory tools
- guardrail, decision, dossier, lesson, insight, crystal, and branch-overlay
  reads that are consumed by explicit Codex memory commands
- operational proof/repair endpoints:
  `/agentmemory/codex-integration/proof`, `/agentmemory/retrieval-proof`,
  `/agentmemory/retrieval-index/verify`,
  `/agentmemory/index-persistence/compact`,
  `/agentmemory/active-scopes/diagnostics`,
  `/agentmemory/retrieval-blocks/diagnostics`,
  `/agentmemory/retrieval-blocks/retry`, and `/agentmemory/compress-retry`

### P0 Cut: Remove Unused Client Surfaces

For this host, prefer deletion and direct pruning over a compatibility profile.
The operating assumption is that native Codex is the only real client, so extra
runtime branches are more complexity than value.

Cut directly:

1. Remove MCP endpoint/resource/prompt registration from the main worker.
2. Keep the standalone `agentmemory mcp` command only if it remains cheap and
   isolated from the live worker; otherwise remove it too.
3. Remove Claude bridge runtime registration and shipped Claude plugin
   hooks/skills from the live path.
4. Remove multi-client setup/docs from the host-local operator path.
5. Delete tests whose only purpose is proving removed client surfaces, and keep
   only contract tests for native Codex and operator diagnostics.

Expected impact:

- lower function/trigger registration count
- smaller active API surface
- less confusion around Codex-native versus MCP-only behavior
- modest process memory reduction
- little direct database reduction

Guardrail:

- the native Codex proof must still pass after MCP registration is disabled
- `npm test` should pass after removed-surface tests are deleted or narrowed
- package/export cleanup should happen in the same cut so dead files are not
  left behind

### P1 Cut: Remove Non-Codex Coordination Primitives From The Hot Runtime

The following primitives are not required for the current native Codex hot path
unless the Codex explicit memory lane is actively using them:

- team memory
- mesh sync
- signals
- checkpoints
- sentinels
- sketches
- routines and routine compiler
- snapshots
- Obsidian export
- Claude bridge
- generic MCP governance wrappers
- generic import/export endpoints, except for operator backup/restore

Implementation shape:

1. Remove registration, endpoint wrappers, docs, tests, and package entries in
   one lane per feature family.
2. Keep StateKV schemas readable for one cleanup release only if old data needs
   migration.
3. Delete disabled endpoints instead of returning compatibility stubs.
4. Add one native Codex contract test that proves the reduced worker still
   registers every endpoint Codex needs.

Expected impact:

- meaningful complexity reduction
- less iii-engine function registry churn
- smaller viewer/API surface
- database reduction only after a retention migration deletes their stored scopes

### P1 Data Diet: Project-Scoped Retention

This is the lane that can actually cut the database.

Codex-only mode should define a retained project allowlist:

- `/home/ericjuta/.openclaw/workspace/repos/codex`
- `/home/ericjuta/.openclaw/workspace/repos/agentmemory`
- optionally `/home/ericjuta/.openclaw/workspace` for operator control-plane
  context
- optionally sibling runtime repos such as `codex-lb` only if Codex queries them
  often

For all other projects:

1. Preserve durable, high-signal memories first:
   decisions, guardrails, lessons, handoffs, crystals, summaries, and explicit
   remembered facts.
2. Drop or archive raw observations, old turn capsules, working sets, access
   logs, and per-session transient state.
3. Rebuild retrieval indexes from the retained set.
4. Run index compaction and restart iii-engine once to measure cold RSS.

Expected impact:

- likely the largest storage win
- likely reduces loaded index and StateKV scan pressure
- direct Codex recall quality should improve if stale non-Codex project material
  stops competing for rank

Guardrail:

- dry-run must report bytes by scope and project before mutation
- destructive deletion must require an explicit `force: true` request
- export/archive must be available before the first destructive run
- Codex integration proof and a project-scoped recall probe must pass after
  rebuild

### P2 Cut: Replace Generic Multiplexed Calls With Codex-Native Calls

After the backend contracts in `docs/codex_tui_hardening_spec.md` land, cut the
old generic endpoints from the native Codex path:

- replace `GET /agentmemory/handoffs` at startup with inline
  `session/start.bootstrap.latestHandoff`
- replace the `context` versus `context/refresh` branch with one unified
  retrieval endpoint
- replace `summarize` + `session/end` + `crystals/auto` +
  `consolidate-pipeline` with `session/closeout`
- keep the old endpoints only as compatibility/operator surfaces, then gate them
  out of `codex-native` after Codex no longer calls them

Expected impact:

- lower latency and fewer failure modes
- fewer live endpoints needed for the only client
- easier future deletion because Codex has one contract per lifecycle phase

### P2 Data Diet: Active-Scope Slimming

The current active-scope diagnostics show no stale candidates under the default
30-day policy, but the host-local Codex-only posture can be more aggressive.

New policy:

- keep working sets for active projects only
- keep turn capsules for non-allowlisted projects only when they contain
  decisions, failures, handoff-worthy summaries, or high importance
- cap per-session capsule and working-set payload size
- shorten access-log retention
- decay or compact insights that are not referenced by active projects

Expected impact:

- cuts the current active working set/capsule footprint
- reduces repeated context scans
- avoids weakening Codex recall because Codex project data is a small minority
  of the current active-scope bytes

### Do Not Cut Yet

- retrieval-block storage and indexes: Codex recall quality depends on them
- observations for active Codex sessions: needed for freshness
- handoff packets: startup/resume depends on them
- summaries/crystals/lessons/decisions/guardrails: these are the high-signal
  durable memory layer
- health, proof, diagnostics, retry, and compaction endpoints: needed for
  operator confidence while slimming the runtime
- iii-engine itself: project rules require StateKV through iii-engine

### Measurement Required Before Enacting

Before deleting data or permanently disabling surfaces, collect:

1. endpoint/function registration count before and after each cut
2. Docker RSS after cold start before and after each cut
3. StateKV bytes by scope and by project
4. index bytes before and after rebuild
5. Codex proof latency and quality before and after
6. top recall examples for Codex before and after, to prove no useful memory was
   lost

### Suggested Implementation Order

1. Remove MCP/plugin/Claude/team/mesh registration from the live worker.
2. Add a dry-run retention endpoint that reports deletable bytes by project and
   scope for the Codex-only allowlist.
3. Add archive-then-delete support for non-allowlisted raw observations, turn
   capsules, working sets, and transient scopes.
4. Rebuild retrieval indexes from retained data and compact.
5. Restart iii-engine during a quiet window and compare cold RSS.
6. Migrate Codex to the unified bootstrap/retrieval/closeout contracts.
7. Gate now-dead generic lifecycle endpoints from `codex-native`.

## Documentation Outcome

The repo should present Codex using the same UX clarity already used for
OpenClaw:

- generic client setup
- deeper native lifecycle path
- explicit note that the deeper path depends on a compatible host adapter or
  fork, not on a plugin shipped by this repo

## References

- [`README.md`](../README.md)
- [`docs/codex_payload_quality_spec.md`](./codex_payload_quality_spec.md)
- [`docs/codex_followups_spec.md`](./codex_followups_spec.md)
- [`docs/codex_tui_hardening_spec.md`](./codex_tui_hardening_spec.md)
- [`src/triggers/api.ts`](../src/triggers/api.ts)
- [`test/codex-compat.test.ts`](../test/codex-compat.test.ts)
