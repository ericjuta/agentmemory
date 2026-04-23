<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Codex Surface Contract Spec

## Goal

Define the receiver-side, end-state UX contract for Codex integration with
`agentmemory`.

This document is about surface shape and user experience, not sender-side
payload details. The main native Codex sender contract belongs in the Codex
repo. The narrow ingest companion remains
[`docs/codex_payload_quality_spec.md`](./codex_payload_quality_spec.md).

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
- [`src/triggers/api.ts`](../src/triggers/api.ts)
- [`test/codex-compat.test.ts`](../test/codex-compat.test.ts)
