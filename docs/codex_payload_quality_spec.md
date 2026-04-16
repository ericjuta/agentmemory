<!-- Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE. -->

# Codex Payload Quality and Observation Hygiene Spec

## Goal

Make the native Codex -> agentmemory integration good enough for:

- maximum recall utility
- clean observability
- low-noise storage
- explicit compatibility coverage

This spec is about payload quality and lifecycle hygiene, not about proving that
Codex can already talk to agentmemory in principle.

## Why This Exists

The current integration is real but still lossy.

Current problems:

1. native Codex post-tool events do not match the payload shape that
   `agentmemory` currently parses
2. query-aware recall intent is dropped on the main runtime recall path
3. shutdown stores low-signal lifecycle junk as ordinary observations
4. some secondary events can be attributed to the wrong project/cwd
5. pre-tool enrichment is only partially wired, so utilization is lower than it
   looks from the docs and config
6. compatibility tests prove a friendlier synthetic payload shape, not the
   actual native Codex wire shape now emitted by the fork

## Scope

This lane covers:

- native Codex lifecycle payload normalization before `/agentmemory/observe`
- query propagation for runtime recall
- observation hygiene for shutdown and non-turn lifecycle events
- project/cwd attribution correctness
- pre-tool enrichment coverage
- explicit repo-side compatibility tests
- documentation updates where current wording overstates parity

This lane does not require:

- a full external integration harness against the Codex repo
- replacing the current freshness architecture
- changing agentmemory into a generic event lake for every low-value runtime
  event

## Design Principles

### 1. One canonical observation contract

For native Codex capture, the stored observation shape should converge on one
canonical structure before it reaches `mem::observe`.

Required top-level fields:

- `sessionId`
- `hookType`
- `project`
- `cwd`
- `timestamp`
- `data`

Required `data` fields by event family:

- prompt submit
  - `session_id`
  - `turn_id`
  - `cwd`
  - `model`
  - `prompt`
- post tool use
  - `session_id`
  - `turn_id`
  - `cwd`
  - `model`
  - `tool_name`
  - `tool_use_id`
  - `tool_input`
  - `tool_output`
- post tool failure
  - `session_id`
  - `turn_id`
  - `cwd`
  - `model`
  - `tool_name`
  - `tool_use_id`
  - `tool_input`
  - `error`
- assistant result
  - `session_id`
  - `turn_id`
  - `cwd`
  - `model`
  - `assistant_text`
  - `is_final`
- stop
  - `session_id`
  - `turn_id`
  - `cwd`
  - `model`
  - `last_assistant_message`

### 2. Normalize at the boundary

Preferred implementation:

- Codex normalizes native runtime payloads into the canonical agentmemory
  observation shape before calling `/agentmemory/observe`

Fallback implementation:

- agentmemory accepts both current native Codex payloads and the canonical
  shape, but still converts them internally into one normalized raw observation
  representation before dedup, compression, indexing, and turn-capsule updates

Preferred winner is boundary normalization in Codex, because it keeps the
agentmemory ingestion contract simple and makes downstream reasoning easier.

### 3. Do not store junk

Not every lifecycle event deserves persistent observation storage.

Events with no turn id, no user prompt, no assistant conclusion, and no useful
tool payload should not become ordinary observations just because they are easy
to emit.

### 4. Freshness first, query aware when available

The runtime recall path should preserve the current freshness-oriented behavior
while honoring a query when the caller has one.

This means:

- same-session latest completed turn still wins by default
- recent same-project turns remain hot
- query-aware ranking helps reorder otherwise similar candidates
- query-aware recall must not collapse into generic search behavior

## Required Changes

## 1. PostToolUse and PostToolUseFailure Payload Convergence

### Current Problem

Current native Codex capture sends `command` and `tool_response` through the
agentmemory adapter, but current `agentmemory` observation parsing expects
`tool_input`, `tool_output`, and optionally `error`.

Effects:

- `raw.toolInput` and `raw.toolOutput` are lost
- dedup hashes key off missing data
- synthetic compression produces weak titles/subtitles/narratives
- turn capsules lose file/concept extraction from tool payloads

### Required Outcome

Native Codex post-tool captures must preserve structured input and structured
result/error semantics all the way into `mem::observe`.

### Required Contract

For successful tool calls, `/agentmemory/observe` must receive:

```json
{
  "hookType": "post_tool_use",
  "data": {
    "session_id": "...",
    "turn_id": "...",
    "cwd": "...",
    "model": "...",
    "tool_name": "...",
    "tool_use_id": "...",
    "tool_input": { "...": "..." },
    "tool_output": { "...": "..." }
  }
}
```

For failed tool calls:

```json
{
  "hookType": "post_tool_failure",
  "data": {
    "session_id": "...",
    "turn_id": "...",
    "cwd": "...",
    "model": "...",
    "tool_name": "...",
    "tool_use_id": "...",
    "tool_input": { "...": "..." },
    "error": "..."
  }
}
```

### Acceptance Criteria

- `observe.ts` can extract tool name, tool input, tool output, and error from a
  real native Codex payload
- dedup sees stable tool payload input instead of `undefined`
- synthetic compression has non-empty narrative/subtitle for native Codex
  post-tool events
- turn capsules gain files and concepts from native post-tool events

## 2. Runtime Recall Query Propagation

### Current Problem

Codex runtime recall sends `query` to `/agentmemory/context`, but the current
REST adapter drops it before calling `mem::context`.

Effect:

- `memory_recall` and native runtime recall do not actually use query-aware
  ranking

### Required Outcome

If `/agentmemory/context` receives a query, `mem::context` must receive the
same query.

### Required Contract

`POST /agentmemory/context`

Input:

```json
{
  "sessionId": "...",
  "project": "...",
  "budget": 1200,
  "query": "..."
}
```

Internal forwarding:

- preserve `query`
- preserve `budget`
- preserve `sessionId`
- preserve `project`

### Acceptance Criteria

- a runtime recall with a query changes ranking in a predictable way
- behavior without a query stays materially unchanged
- current `/agentmemory/context/refresh` behavior remains intact

## 3. Low-Signal Shutdown Observation Hygiene

### Current Problem

Codex currently emits synthetic `Stop` and `SessionEnd` observations during
shutdown with only `session_id` and `cwd`.

Effects:

- low-value observations get persisted
- no turn capsule can be updated because there is no `turn_id`
- synthetic compression produces generic junk entries
- storage and observability get noisier without adding recall value

### Required Outcome

Bare shutdown lifecycle markers must not be stored as normal observations unless
they carry real recall value.

### Allowed persistent cases

- a stop event tied to a real turn with `turn_id` and
  `last_assistant_message`
- a session-end event with meaningful summary-like content, if such a lane is
  intentionally designed

### Disallowed persistent cases

- `Stop` with only `session_id` + `cwd`
- `SessionEnd` with only `session_id` + `cwd`

### Recommended implementations

Pick one:

1. stop emitting these synthetic shutdown observations from Codex
2. allow emission, but make agentmemory ingestion explicitly drop them before
   storage
3. route them to diagnostics-only observability instead of observation storage

### Acceptance Criteria

- shutdown no longer creates low-value compressed observations
- no fake generic stop/session-end observations appear in the viewer or recall
  path

## 4. Project and CWD Attribution Correctness

### Current Problem

Some Codex-emitted secondary events omit `cwd`, and the adapter falls back to
process current directory.

Effects:

- project attribution can drift
- cross-project observability becomes misleading
- downstream memory clustering may attach the event to the wrong repo

### Required Outcome

All events sent to `/agentmemory/observe` must carry explicit `cwd`, and
project derivation must come from that explicit value.

### Minimum event families to fix

- `TaskCompleted`
- `SubagentStop`
- `Notification`
- any other emitted event family that currently relies on `current_dir()`

### Acceptance Criteria

- every emitted native Codex observation payload includes `cwd`
- no native capture path depends on process cwd fallback for project identity

## 5. Pre-Tool Enrichment Coverage Expansion

### Current Problem

The enrich gate claims to cover `Edit | Write | Read | Glob | Grep`, but most
tool handlers still pass `agentmemory_input: None`.

Effects:

- fewer enrich calls than the docs and config imply
- lower recall utilization before file-touching actions

### Required Outcome

All high-signal file/search tools covered by the enrichment gate must provide
structured enrich input.

### Minimum payload fields

- file-touching tools
  - `file_path`, `path`, or `paths`
- directory/search tools
  - `dir_path`, `pattern`, `query`, or `terms`

### Acceptance Criteria

- `Read`, `Glob`, and `Grep` paths actually reach `/agentmemory/enrich`
- enrichment remains skipped for tools with no meaningful file/query signal
- docs stop overstating coverage if some tools intentionally remain out of lane

## 6. Non-Shell Post-Tool Capture Coverage

### Current Problem

Current native Codex post-tool observation capture is still effectively
shell-only.

Effects:

- file reads, writes, edits, globs, and greps executed through native tools are
  under-observed after execution
- observability is skewed toward shell-based work
- memory usefulness and freshness are worse for the exact high-signal tool
  families most likely to matter

### Required Outcome

Post-tool capture coverage should include the same high-signal native tool
families that the integration already treats as important enough for pre-tool
enrichment.

### Minimum lane

- `Edit`
- `Write`
- `Read`
- `Glob`
- `Grep`

### Acceptance Criteria

- these tool families emit post-tool observations with useful result payloads
- post-tool capture is no longer biased toward shell-only execution
- docs and tests reflect the actual capture set

## 7. AssistantResult Capture and Freshness Completeness

### Current Problem

The current agentmemory freshness model supports `assistant_result`, but the
reviewed native Codex capture path does not clearly emit it.

Effect:

- freshest final-answer capture depends mostly on `stop`

### Required Outcome

Either:

1. Codex emits a real native `AssistantResult` observation with final assistant
   text and turn id

or:

2. docs and tests explicitly state that current native freshness is stop-driven
   and treat `assistant_result` as optional host-specific support

Preferred outcome is a real `AssistantResult` event.

### Acceptance Criteria

- if emitted, `assistant_result` updates turn capsules and working set
- if not emitted, docs and tests stop implying stronger host parity than exists

## 8. Strict Hook-Type Validation

### Current Problem

`/agentmemory/observe` and `mem::observe` currently accept any string-like hook
type instead of enforcing the known hook family set.

Effects:

- unknown event families can silently enter storage
- typos and drift become persistent data problems instead of clean failures
- downstream logic has to tolerate malformed or unsupported hook semantics

### Required Outcome

The observe surface must reject unknown hook types by default.

### Acceptance Criteria

- unsupported hook types return a clear validation failure
- only the declared hook family set is accepted for normal observation storage
- intentional future expansion requires explicit schema/type updates

## 9. Event Identity, Ordering, and Source Semantics

### Current Problem

Current native Codex observe payloads are stamped at send time and do not carry
stable event identity.

Effects:

- retries cannot be made strongly idempotent
- cross-event ordering is fuzzier than necessary
- downstream debugging has weaker provenance

### Required Outcome

Native Codex observation payloads should carry enough source metadata to make
ordering and dedup explicit.

### Required fields

- `event_id`
  - stable per emitted lifecycle event
- `source_timestamp`
  - timestamp from the source event, not only send-time stamping
- `source`
  - e.g. `codex-native`
- `payload_version`
  - explicit schema version for the native adapter contract

### Optional fields

- `sequence`
  - monotonic per session or per turn if available
- `capabilities`
  - explicit booleans or strings describing optional lanes the sender supports

### Acceptance Criteria

- retries can be deduplicated by identity instead of heuristics alone
- ordering logic can rely on source timestamps when available
- payload drift is versioned instead of silent

## 10. Schema Negotiation and Capability Signaling

### Current Problem

Right now native Codex integration largely assumes shared implied knowledge
between sender and receiver.

Effects:

- contract drift is hard to detect early
- the receiver cannot distinguish old native senders from newer ones cleanly
- optional lanes like `assistant_result` or richer post-tool payloads are not
  explicitly negotiable

### Required Outcome

The native payload contract should advertise version and capability semantics.

### Minimum advertised semantics

- sender identity
- payload version
- optional lane support, such as:
  - `assistant_result`
  - structured post-tool payloads
  - query-aware context
  - event ids

### Acceptance Criteria

- agentmemory can branch on declared payload version if needed
- docs define the versioned native contract
- capability mismatches fail clearly in tests or diagnostics

## 11. Persistence Classes and Storage Policy

### Current Problem

Observation storage policy is still too blunt. Events are mostly either
captured or not, without a first-class persistence class.

Effects:

- diagnostics-only or ephemeral signals can leak into long-term retrieval
- low-value operational metadata competes with actual recall material

### Required Outcome

The integration should distinguish between:

- `persistent`
  - normal memory-bearing observations
- `ephemeral`
  - useful during the active session, not intended for long-term recall
- `diagnostics_only`
  - useful for operators/viewers/logs, not for memory retrieval

### Acceptance Criteria

- shutdown markers and similar low-signal lifecycle events do not enter the
  same persistence lane as real recall material
- docs define the intended persistence class for each event family

## 12. Compatibility and Regression Coverage

### Current Problem

Existing compatibility tests prove a synthetic Codex-friendly payload, not the
actual native Codex wire shape currently emitted by the reviewed fork.

### Required Test Coverage

Add explicit tests for:

1. native Codex `post_tool_use` shape with `command` + `tool_response` if that
   shape remains supported
2. canonical normalized shape with `tool_input` + `tool_output`
3. `post_tool_failure` shape with a real error field
4. `/agentmemory/context` preserving `query`
5. shutdown hygiene: bare stop/session-end payloads are not stored as useful
   observations
6. events with omitted `cwd` are rejected or normalized before storage
7. enrichment coverage for the intended file/search tool lanes
8. non-shell post-tool capture for native file/search tools
9. strict hook-type validation failures for unknown types
10. event identity / source timestamp preservation where the native adapter
    claims to provide them
11. payload version / capability signaling
12. persistence-class behavior for non-recall lifecycle events

### Required Principle

Tests should pin the actual supported wire contract, not an idealized one.

## 13. Live End-to-End Contract Verification

### Current Problem

Unit tests are necessary but not enough. Full integration can still drift if
the live native Codex process emits a different wire shape than the test
fixtures.

### Required Outcome

Add one end-to-end verification lane using a real native Codex session against
an instrumented agentmemory test server.

### Minimum proof points

- what actually hits `/agentmemory/observe`
- what actually hits `/agentmemory/context`
- what actually hits `/agentmemory/enrich`
- what actually hits `/agentmemory/session/start`
- what actually hits `/agentmemory/session/end`

### Acceptance Criteria

- at least one test or harness path validates the live native contract instead
  of only mocked internal fixtures

## 14. Documentation Updates

At minimum update docs so they do not overstate current parity.

Required clarifications:

- native Codex lifecycle capture exists but payload quality is only as strong as
  the current adapter normalization
- query-aware runtime recall depends on `/agentmemory/context` preserving
  `query`
- freshness may still be stop-driven unless the host emits `assistant_result`
- pre-tool enrichment coverage should reflect the tools that actually send
  structured enrich input
- post-tool capture coverage should reflect whether native non-shell tools are
  included
- strict hook allowlisting, payload versioning, and persistence classes are
  part of the full native integration contract

## Recommended Implementation Order

1. Fix native post-tool payload convergence
2. Preserve query in `/agentmemory/context`
3. remove or drop low-signal shutdown observations
4. fix missing cwd/project attribution on secondary events
5. expand pre-tool enrichment coverage
6. expand non-shell post-tool capture
7. add strict hook allowlisting
8. add `event_id`, `payload_version`, `source`, and source timestamp semantics
9. define persistence classes for lifecycle events
10. add compatibility and hygiene tests
11. add live end-to-end contract verification
12. update docs to match reality
13. add native `assistant_result` emission if the host can support it

## Standard Of Done

This lane is done when:

- native Codex post-tool observations retain useful input/output/error payloads
- runtime recall preserves query intent end to end
- bare shutdown markers no longer create low-value observations
- all native capture payloads have stable project/cwd attribution
- enrichment coverage matches the stated gate
- non-shell post-tool capture is first-class for the intended native tools
- unknown hook families are rejected instead of silently stored
- native payloads carry stable identity/version/source semantics
- persistence class is explicit for non-recall lifecycle events
- compatibility tests pin the real supported wire shapes
- at least one live end-to-end verification path exists
- docs describe actual parity, not aspirational parity
