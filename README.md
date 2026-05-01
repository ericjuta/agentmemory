# agentmemory

Persistent memory runtime for the local Codex integration, backed by iii-engine.

This fork is intentionally Codex-native. The shipped runtime exposes the REST
surface Codex uses for session lifecycle, observation ingest, context retrieval,
search, closeout, and operator diagnostics. Legacy MCP, Claude plugin, hook
package, and Claude bridge distribution surfaces have been removed from this
repo.

## Runtime Shape

- Engine: iii-engine over WebSocket, default `ws://localhost:49134`
- Docker engine image: `docker.io/iiidev/iii:0.11.3`
- REST API: default `http://localhost:3111/agentmemory/*`
- Viewer: default `http://localhost:3113`
- State: iii-engine StateKV file-backed SQLite under `./data/state_store.db`
- Build: TypeScript to ESM with `tsdown`

## Commands

```bash
npm install
npm run build
npm test
npm run eval:retrieval
npm run eval:codex-live-retrieval
```

```bash
npx @agentmemory/agentmemory
npx @agentmemory/agentmemory status
npx @agentmemory/agentmemory codex-proof --port 3111
```

`npm run eval:codex-live-retrieval` exercises live REST `/context` and
`/smart-search` against the checked-in Codex/AgentMemory fixture corpus. It
writes the latest JSON summary to
`/tmp/agentmemory-codex-live-retrieval-latest.json`; set
`CODEX_LIVE_RETRIEVAL_JSONL` to also append per-case JSONL trace rows.

After code changes, redeploy the Docker worker from the repo root:

```bash
npm test
docker compose up -d --build agentmemory-worker
npx @agentmemory/agentmemory codex-proof --port 3111
```

That rebuilds the code container while leaving `iii-engine` and the `iii-data`
volume in place. If engine config or the pinned Docker image changed, rebuild the
whole compose stack instead:

```bash
docker compose up -d --build
```

For a harder restart that still preserves memory state:

```bash
docker compose down
docker compose up -d --build
```

Do not run `docker compose down -v` unless deleting the `iii-data` volume is
intentional.

## Codex Contract

Keep these endpoints healthy for the native Codex path:

- `GET /agentmemory/health`
- `POST /agentmemory/session/start`
- `POST /agentmemory/session/end`
- `POST /agentmemory/session/closeout`
- `POST /agentmemory/observe`
- `POST /agentmemory/context`
- `POST /agentmemory/context/refresh`
- `POST /agentmemory/enrich`
- `POST /agentmemory/smart-search`
- `POST /agentmemory/summarize`
- `POST /agentmemory/crystals/auto`
- `POST /agentmemory/consolidate-pipeline`
- `GET /agentmemory/handoffs`
- `GET /agentmemory/handoffs/:id`
- `POST /agentmemory/handoffs/generate`

Operator proof and repair endpoints are also part of the local support contract:

- `POST /agentmemory/codex-integration/proof`
- `POST /agentmemory/retrieval-proof`
- `POST /agentmemory/retrieval-index/verify`
- `POST /agentmemory/index-persistence/compact`
- `POST /agentmemory/active-scopes/diagnostics`
- `POST /agentmemory/retrieval-blocks/diagnostics`
- `POST /agentmemory/retrieval-blocks/retry`
- `POST /agentmemory/compress-retry`

`npm run eval:codex-live-retrieval` runs the P1 live Codex retrieval corpus
through `POST /agentmemory/context` and `POST /agentmemory/smart-search`. It
reports relevance, freshness, leakage, and latency, then writes case metrics,
bounded previews, and REST result traces to
`/tmp/agentmemory-codex-live-retrieval-latest.json`.

## Configuration

Common environment variables:

- `III_ENGINE_URL`
- `III_REST_PORT`
- `III_STREAMS_PORT`
- `AGENTMEMORY_SECRET`
- `TOKEN_BUDGET`
- `MAX_OBS_PER_SESSION`
- `EMBEDDING_PROVIDER`
- `AGENTMEMORY_AUTO_COMPRESS`
- `CONSOLIDATION_ENABLED`
- `SNAPSHOT_ENABLED`
- `TEAM_ID`
- `USER_ID`

Provider selection is automatic from the configured API keys. Without an
external provider, the runtime uses the local agent SDK provider path.

## Development Rules

Everything goes through iii-engine primitives:

- `sdk.registerFunction(...)`
- `sdk.registerTrigger(...)`
- `sdk.trigger(...)`

Do not bypass iii-engine with a standalone SQLite or in-process state path.
REST endpoints must validate inputs and whitelist fields before triggering
memory functions.

When adding REST endpoints, update:

1. `src/triggers/api.ts`
2. `src/index.ts` endpoint log line
3. this README

When bumping version, update:

1. `package.json`
2. `src/version.ts`
3. `src/types.ts`
4. `src/functions/export-import.ts`
5. `test/export-import.test.ts`

## Current Surface

- 150 REST endpoints
- 50+ iii functions
- Codex integration proof CLI and REST endpoint

Run `npm test` before shipping code changes. For runtime changes, also run the
live Codex proof against the active service.
