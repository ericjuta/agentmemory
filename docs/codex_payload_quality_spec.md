<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Codex Ingest Contract Companion

## Purpose

This is the receiver-side companion to the main native Codex integration spec,
which now lives in the Codex repo.

Main ownership split:

- Codex repo
  - sender contract
  - payload normalization
  - lifecycle emission coverage
  - event identity/version/source semantics
  - live sender-side contract verification
- agentmemory repo
  - ingest validation
  - persistence-class handling
  - compatibility behavior for supported native payload versions

This file should stay narrow. It is not the primary home for the full native
Codex integration design.

## Receiver Responsibilities

agentmemory should ensure:

1. only supported native hook families are accepted for normal ingestion
2. supported native payload versions are explicit and test-covered
3. unsupported or malformed native payloads fail clearly
4. persistence class is respected so diagnostics-only lifecycle events do not
   pollute recall storage
5. compatibility tests cover the native Codex wire shapes that agentmemory
   claims to support

## Required Ingest Guarantees

### Hook allowlisting

`/agentmemory/observe` and `mem::observe` should reject unknown hook families
rather than silently storing them.

### Payload version awareness

If Codex sends `payload_version`, agentmemory should validate it and fail
cleanly on unsupported versions instead of guessing.

### Event identity handling

If Codex sends `event_id`, agentmemory should use it for stronger idempotency
and retry handling where appropriate.

### Persistence classes

agentmemory should support distinct handling for:

- `persistent`
- `ephemeral`
- `diagnostics_only`

At minimum, shutdown markers and similar low-signal lifecycle events should not
automatically land in the same long-term retrieval lane as real memory-bearing
observations.

## Required Tests

agentmemory-side coverage should include:

1. rejection of unknown hook families
2. supported native Codex post-tool payload shapes
3. supported native Codex post-tool-failure payload shapes
4. handling of explicit payload version semantics
5. handling of event identity where provided
6. persistence-class behavior for low-signal lifecycle events

## Reference

The main sender-side spec belongs in the Codex repo under:

- `docs/agentmemory-payload-quality.md`
