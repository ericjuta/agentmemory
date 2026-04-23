<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Fork Intent

This repository is a public fork of
[rohitg00/agentmemory](https://github.com/rohitg00/agentmemory).

The intent of this fork is not to rename or replace the upstream project. The
intent is to make `agentmemory` work cleanly in a local Docker-first setup,
support a Codex-native adapter path, improve freshness-oriented retrieval, and
add stronger runtime diagnostics and self-healing around long-lived sessions.

This document is the public-facing map of why the fork exists and which parts
of the tree changed to support that goal.

## Fork Goals

1. Make local runtime and plugin packaging reliable for public and local use.
2. Support Codex-native lifecycle ingestion in addition to the existing
   Claude/MCP paths.
3. Improve retrieval freshness so recent turns are available before background
   consolidation finishes.
4. Harden long-running operation with better maintenance, diagnostics, and
   viewer visibility.
5. Keep the fork's public intent legible instead of hiding changes inside a
   long commit history.

## Change Map

| Area | Intent | Key files |
|---|---|---|
| Runtime and packaging | Make the repo boot reliably via Docker, publish a Claude-compatible plugin layout, and smooth local install/runtime defaults. | [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml), [`iii-config.yaml`](../iii-config.yaml), [`.dockerignore`](../.dockerignore), [`plugin/plugin.json`](../plugin/plugin.json), [`plugin/.claude-plugin/plugin.json`](../plugin/.claude-plugin/plugin.json), [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), [`plugin/hooks.json`](../plugin/hooks.json), [`plugin/.claude-plugin/hooks.json`](../plugin/.claude-plugin/hooks.json) |
| Codex-native integration | Clarify and support a host-specific adapter path where a Codex fork posts lifecycle events directly to `agentmemory`, rather than using only MCP. | [`docs/codex_followups_spec.md`](./codex_followups_spec.md), [`docs/codex_surface_contract_spec.md`](./codex_surface_contract_spec.md), [`README.md`](../README.md), [`src/triggers/api.ts`](../src/triggers/api.ts), [`src/types.ts`](../src/types.ts), [`test/codex-compat.test.ts`](../test/codex-compat.test.ts) |
| Retrieval freshness | Make `what just happened?` retrievable immediately through turn capsules, working sets, fresh context lanes, and final-turn capture. | [`docs/retrieval_freshness_spec.md`](./retrieval_freshness_spec.md), [`src/functions/context.ts`](../src/functions/context.ts), [`src/functions/turn-capsules.ts`](../src/functions/turn-capsules.ts), [`src/functions/working-set.ts`](../src/functions/working-set.ts), [`src/functions/observe.ts`](../src/functions/observe.ts), [`src/functions/summarize.ts`](../src/functions/summarize.ts), [`src/hooks/assistant-result.ts`](../src/hooks/assistant-result.ts), [`src/hooks/prompt-submit.ts`](../src/hooks/prompt-submit.ts), [`src/hooks/stop.ts`](../src/hooks/stop.ts), [`test/context.test.ts`](../test/context.test.ts), [`test/turn-capsules.test.ts`](../test/turn-capsules.test.ts), [`test/observe.test.ts`](../test/observe.test.ts) |
| Query-aware context ranking | Use retrieval intent when the caller has it, without breaking the default freshness-first behavior. | [`src/functions/context.ts`](../src/functions/context.ts), [`src/hooks/prompt-submit.ts`](../src/hooks/prompt-submit.ts), [`src/triggers/api.ts`](../src/triggers/api.ts), [`test/context.test.ts`](../test/context.test.ts) |
| Unified retrieval end state | Converge context injection, enrich, and search onto one embedding-first retrieval engine over canonical retrieval blocks. | [`docs/unified_retrieval_engine_spec.md`](./unified_retrieval_engine_spec.md), [`src/functions/context.ts`](../src/functions/context.ts), [`src/functions/enrich.ts`](../src/functions/enrich.ts), [`src/functions/search.ts`](../src/functions/search.ts), [`src/functions/smart-search.ts`](../src/functions/smart-search.ts), [`src/state/hybrid-search.ts`](../src/state/hybrid-search.ts) |
| Autonomous maintenance and memory evolution | Expand background lifecycle management: consolidation flow control, usefulness feedback, adaptive timers, eviction cleanup, relation derivation, and maintenance automation. | [`src/functions/compress.ts`](../src/functions/compress.ts), [`src/functions/consolidate.ts`](../src/functions/consolidate.ts), [`src/functions/consolidation-pipeline.ts`](../src/functions/consolidation-pipeline.ts), [`src/functions/auto-forget.ts`](../src/functions/auto-forget.ts), [`src/functions/evict.ts`](../src/functions/evict.ts), [`src/functions/relations.ts`](../src/functions/relations.ts), [`src/functions/graph.ts`](../src/functions/graph.ts), [`src/state/adaptive-timer.ts`](../src/state/adaptive-timer.ts), [`src/state/compression-tracker.ts`](../src/state/compression-tracker.ts), [`src/state/semaphore.ts`](../src/state/semaphore.ts), [`src/state/search-index.ts`](../src/state/search-index.ts), [`src/triggers/events.ts`](../src/triggers/events.ts) |
| Diagnostics and viewer visibility | Surface degradation earlier with health metrics, diagnostics endpoints, and a viewer dashboard that exposes runtime state. | [`src/functions/diagnostics.ts`](../src/functions/diagnostics.ts), [`src/health/monitor.ts`](../src/health/monitor.ts), [`src/health/thresholds.ts`](../src/health/thresholds.ts), [`src/viewer/server.ts`](../src/viewer/server.ts), [`src/viewer/index.html`](../src/viewer/index.html), [`test/diagnostics.test.ts`](../test/diagnostics.test.ts), [`test/health-thresholds.test.ts`](../test/health-thresholds.test.ts) |
| Hook and skill delivery | Keep the shipped plugin hooks and skills aligned with the runtime changes above, especially the freshness and host-routing updates. | [`plugin/scripts/prompt-submit.mjs`](../plugin/scripts/prompt-submit.mjs), [`plugin/scripts/post-tool-use.mjs`](../plugin/scripts/post-tool-use.mjs), [`plugin/scripts/post-tool-failure.mjs`](../plugin/scripts/post-tool-failure.mjs), [`plugin/scripts/stop.mjs`](../plugin/scripts/stop.mjs), [`plugin/scripts/assistant-result.mjs`](../plugin/scripts/assistant-result.mjs), [`plugin/skills/recall/SKILL.md`](../plugin/skills/recall/SKILL.md), [`plugin/skills/remember/SKILL.md`](../plugin/skills/remember/SKILL.md), [`plugin/skills/forget/SKILL.md`](../plugin/skills/forget/SKILL.md), [`plugin/skills/session-history/SKILL.md`](../plugin/skills/session-history/SKILL.md) |

## Short Version

If you only want the high-level answer, the fork exists for four practical
reasons:

1. Local Docker and plugin packaging needed cleanup to be usable and publishable.
2. This environment uses a Codex fork that can emit native lifecycle payloads,
   so the repo was extended to document and support that path explicitly.
3. Same-session retrieval needed to become freshness-oriented instead of waiting
   on slow consolidation.
4. Long-running runtime behavior needed better diagnostics, healing, and viewer
   visibility.

## What This Fork Is Not

- It is not a claim to authorship over upstream `agentmemory`.
- It is not a separate product with a new license.
- It is not a generic Codex plugin shipped by this repo; the Codex-native path
  still depends on a compatible host fork or adapter.

## Related Docs

- [`README.md`](../README.md)
- [`NOTICE`](../NOTICE)
- [`docs/codex_followups_spec.md`](./codex_followups_spec.md)
- [`docs/codex_surface_contract_spec.md`](./codex_surface_contract_spec.md)
- [`docs/retrieval_freshness_spec.md`](./retrieval_freshness_spec.md)
- [`docs/unified_retrieval_engine_spec.md`](./unified_retrieval_engine_spec.md)
- [`docs/memory_mechanisms_expansion_spec.md`](./memory_mechanisms_expansion_spec.md)
