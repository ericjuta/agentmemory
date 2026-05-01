import {
  loadCodexLiveRetrievalCases,
  runCodexLiveRetrievalEval,
} from "./codex-live-retrieval.js";

const DEFAULT_FIXTURE = "src/eval/fixtures/codex-live-retrieval-cases.json";
const DEFAULT_ARTIFACT = "/tmp/agentmemory-codex-live-retrieval-latest.json";
const DEFAULT_JSONL = "/tmp/agentmemory-codex-live-retrieval-latest.jsonl";

function usage(): string {
  return `Usage:
  npm run eval:codex-live-retrieval

Environment:
  CODEX_LIVE_RETRIEVAL_FIXTURE        Fixture path (default: ${DEFAULT_FIXTURE})
  CODEX_LIVE_RETRIEVAL_ARTIFACT       JSON artifact path (default: ${DEFAULT_ARTIFACT})
  CODEX_LIVE_RETRIEVAL_JSONL          JSONL artifact path (default: ${DEFAULT_JSONL})
  CODEX_LIVE_RETRIEVAL_BASE_URL       AgentMemory origin or /agentmemory URL
  CODEX_LIVE_RETRIEVAL_TIMEOUT_MS     Per-request timeout
  CODEX_LIVE_RETRIEVAL_REQUIRE_LATENCY=true to fail latency misses
  CODEX_LIVE_RETRIEVAL_START_SESSIONS=false to skip session start
  CODEX_LIVE_RETRIEVAL_END_SESSIONS=false to skip session end
`;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

function readPositiveInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

const fixturePath = process.env.CODEX_LIVE_RETRIEVAL_FIXTURE || DEFAULT_FIXTURE;
const artifactPath =
  process.env.CODEX_LIVE_RETRIEVAL_ARTIFACT || DEFAULT_ARTIFACT;
const baseUrl =
  process.env.CODEX_LIVE_RETRIEVAL_BASE_URL ||
  process.env.AGENTMEMORY_EVAL_BASE_URL ||
  process.env.AGENTMEMORY_URL ||
  `http://127.0.0.1:${process.env.III_REST_PORT || "3111"}`;
const cases = loadCodexLiveRetrievalCases(fixturePath, {
  defaultProject:
    process.env.CODEX_LIVE_RETRIEVAL_PROJECT ||
    process.env.AGENTMEMORY_CODEX_LIVE_EVAL_PROJECT,
  defaultCodexProject:
    process.env.CODEX_LIVE_RETRIEVAL_CODEX_PROJECT ||
    process.env.AGENTMEMORY_CODEX_LIVE_EVAL_CODEX_PROJECT,
});

const result = await runCodexLiveRetrievalEval({
  baseUrl,
  cases,
  artifactPath,
  jsonlPath: process.env.CODEX_LIVE_RETRIEVAL_JSONL || DEFAULT_JSONL,
  timeoutMs: readPositiveInt("CODEX_LIVE_RETRIEVAL_TIMEOUT_MS", 20_000, 100, 120_000),
  requireLatency: envFlag("CODEX_LIVE_RETRIEVAL_REQUIRE_LATENCY", false),
  startSessions: envFlag("CODEX_LIVE_RETRIEVAL_START_SESSIONS", true),
  endSessions: envFlag("CODEX_LIVE_RETRIEVAL_END_SESSIONS", true),
  sessionPrefix:
    process.env.CODEX_LIVE_RETRIEVAL_SESSION_PREFIX ||
    "codex-live-retrieval-eval",
});

console.log(
  JSON.stringify(
    {
      summary: result.summary,
      artifactPath,
      fixturePath,
      failures: result.summary.failures,
    },
    null,
    2,
  ),
);

process.exitCode = result.summary.passed ? 0 : 1;
