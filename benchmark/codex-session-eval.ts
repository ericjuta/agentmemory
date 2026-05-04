import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const defaultFixtureDir = join(__dirname, "data", "codex-session-eval");
const defaultJsonResultsPath = join(__dirname, "data", "codex_session_eval_results.json");
const defaultMarkdownResultsPath = join(__dirname, "CODEX-SESSION-EVAL-RESULTS.md");
const hooksDir = join(repoRoot, "plugin", "scripts");

const hookNames = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;

const HookEventSchema = z.object({
  hook: z.enum(hookNames),
  timestamp: z.string().datetime(),
  observationId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
});

const SessionSchema = z.object({
  sessionId: z.string().min(1),
  events: z.array(HookEventSchema).min(1),
});

const FixtureSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  project: z.string().min(1),
  priorSessions: z.array(SessionSchema),
  currentSession: SessionSchema,
  gold: z.object({
    requiredFacts: z.array(z.string().min(1)).min(1),
    forbiddenFacts: z.array(z.string().min(1)),
    goldObservationIds: z.array(z.string().min(1)),
    expectedSessionStatus: z.enum(["active", "completed"]),
  }),
  budgets: z.object({
    contextTokens: z.number().int().positive(),
    hookP95Ms: z.number().int().positive(),
  }),
});

export type CodexSessionEvalFixture = z.infer<typeof FixtureSchema>;

type HookEvent = CodexSessionEvalFixture["currentSession"]["events"][number];
type HookName = HookEvent["hook"];

interface HookRun {
  hook: HookName;
  sessionId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  tookMs: number;
}

interface Observation {
  id: string;
  sessionId: string;
  hookType: string;
  project: string;
  text: string;
}

interface CandidateSelectionTrace {
  id: string;
  score: number;
  matchedQueryTerms: string[];
  estimatedTokens: number;
  selected: boolean;
}

export interface FixtureResult {
  fixtureId: string;
  category: string;
  passed: boolean;
  requiredFactRecall: number;
  forbiddenFactLeakRate: number;
  goldObservationRecallAtK: number;
  contextPrecisionProxy: number;
  sessionStateCorrect: boolean;
  hookContractCorrect: boolean;
  contextBytes: number;
  estimatedContextTokens: number;
  hookLatencyMs: { p50: number; p95: number; max: number };
  observationsCaptured: number;
  missingRequiredFacts: string[];
  leakedForbiddenFacts: string[];
  selectedObservationIds: string[];
  candidateSelectionTrace: CandidateSelectionTrace[];
  diagnostics: number;
}

export interface EvalResults {
  mode: "mock" | "local-service";
  generatedAt: string;
  passed: boolean;
  fixtures: FixtureResult[];
  metrics: {
    fixtureCount: number;
    requiredFactRecallAtContext: number;
    forbiddenFactLeakRate: number;
    goldObservationRecallAtK: number;
    contextPrecisionProxy: number;
    sessionStateCorrectness: number;
    hookContractCorrectness: number;
    hookP95Ms: number;
    maxContextTokens: number;
    observationsCaptured: number;
    disabledInjectionNoOutput: boolean;
  };
  gates: Record<string, boolean>;
}

interface MockState {
  sessions: Map<string, { status: "active" | "completed"; project: string; stopSeen: boolean; postStopActivity: boolean }>;
  observations: Observation[];
  diagnostics: unknown[];
  nextObservationId?: string;
  selectedObservationIds: string[];
  candidateSelectionTrace: CandidateSelectionTrace[];
  lastContext: string;
}

interface GradeState {
  sessions: Map<string, { status: string }>;
  observationsCaptured: number;
  diagnostics: number;
  selectedObservationIds: string[];
  candidateSelectionTrace: CandidateSelectionTrace[];
  lastContext: string;
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9./_-]+/g, " ").trim();
}

function terms(text: string): Set<string> {
  return new Set(normalize(text).split(/\s+/).filter((term) => term.length >= 3));
}

function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function observationText(body: Record<string, unknown>): string {
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  return [
    body.hookType,
    data.prompt,
    data.tool_name,
    stringifyValue(data.tool_input),
    stringifyValue(data.tool_output),
    stringifyValue(data.tool_response),
    data.last_assistant_message,
  ].filter(Boolean).join(" ");
}

function selectObservations(fixture: CodexSessionEvalFixture, state: MockState, query: string, budget: number): Observation[] {
  const queryTerms = terms([query, fixture.project, fixture.category].join(" "));
  const scored = state.observations
    .filter((obs) => obs.project === fixture.project)
    .map((obs) => {
      const obsTerms = terms(obs.text);
      const matchedQueryTerms = [...queryTerms].filter((term) => obsTerms.has(term));
      let score = 0;
      score += matchedQueryTerms.length * 2;
      if (obs.hookType === "post_tool_use") score += 1;
      if (obs.hookType === "prompt_submit") score += 0.5;
      return { obs, score, matchedQueryTerms };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.obs.id.localeCompare(b.obs.id));

  const selected: Observation[] = [];
  let used = 0;
  const selectedIds = new Set<string>();
  const costs = new Map<string, number>();
  for (const entry of scored) {
    const cost = estimateTokens(entry.obs.text) + 12;
    costs.set(entry.obs.id, cost);
    if (selected.length > 0 && used + cost > budget) continue;
    selected.push(entry.obs);
    selectedIds.add(entry.obs.id);
    used += cost;
  }
  state.candidateSelectionTrace = scored.map((entry) => ({
    id: entry.obs.id,
    score: entry.score,
    matchedQueryTerms: entry.matchedQueryTerms,
    estimatedTokens: costs.get(entry.obs.id) || estimateTokens(entry.obs.text) + 12,
    selected: selectedIds.has(entry.obs.id),
  }));
  return selected.slice(0, 8);
}

function renderContext(fixture: CodexSessionEvalFixture, state: MockState, query: string, budget: number): string {
  const selected = selectObservations(fixture, state, query, budget);
  state.selectedObservationIds = selected.map((obs) => obs.id);
  const lines = selected.map((obs) => "- [" + obs.id + "] " + obs.text);
  const context = [
    "<agentmemory-context>",
    "<project>" + fixture.project + "</project>",
    "<observations>",
    ...lines,
    "</observations>",
    "</agentmemory-context>",
  ].join("\n");
  state.lastContext = context;
  return context;
}

async function startMockServer(fixture: CodexSessionEvalFixture): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { sessions: new Map(), observations: [], diagnostics: [], selectedObservationIds: [], candidateSelectionTrace: [], lastContext: "" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = req.method === "GET" ? {} : await bodyJson(req);

    if (url.pathname === "/agentmemory/session/start") {
      const sessionId = String(body.sessionId || "unknown");
      const project = String(body.project || body.cwd || fixture.project);
      state.sessions.set(sessionId, { status: "active", project, stopSeen: false, postStopActivity: false });
      sendJson(res, { context: renderContext(fixture, state, "session start continue current work", fixture.budgets.contextTokens) });
      return;
    }

    if (url.pathname === "/agentmemory/observe") {
      const sessionId = String(body.sessionId || "unknown");
      const project = String(body.project || body.cwd || fixture.project);
      const session = state.sessions.get(sessionId) || { status: "active" as const, project, stopSeen: false, postStopActivity: false };
      const hookType = String(body.hookType || "unknown");
      if (hookType === "stop") session.stopSeen = true;
      else if (session.stopSeen) session.postStopActivity = true;
      state.sessions.set(sessionId, { ...session, status: "active", project });
      state.observations.push({
        id: state.nextObservationId || sessionId + ":obs_" + String(state.observations.length + 1),
        sessionId,
        hookType,
        project,
        text: observationText(body),
      });
      state.nextObservationId = undefined;
      sendJson(res, {});
      return;
    }

    if (url.pathname === "/agentmemory/context") {
      const prompt = state.observations.at(-1)?.text || "current prompt";
      const budget = typeof body.budget === "number" ? body.budget : fixture.budgets.contextTokens;
      sendJson(res, { context: renderContext(fixture, state, prompt, budget) });
      return;
    }

    if (url.pathname === "/agentmemory/session/end") {
      const sessionId = String(body.sessionId || "unknown");
      const existing = state.sessions.get(sessionId) || { project: fixture.project, stopSeen: false, postStopActivity: false };
      state.sessions.set(sessionId, { ...existing, status: "completed" });
      sendJson(res, {});
      return;
    }

    if (url.pathname === "/agentmemory/replay/load") {
      const sessionId = url.searchParams.get("sessionId");
      const observationCount = state.observations.filter((obs) => obs.sessionId === sessionId).length;
      sendJson(res, { session: { observationCount } });
      return;
    }

    if (url.pathname === "/agentmemory/hooks/diagnostics") {
      state.diagnostics.push(body);
      sendJson(res, {});
      return;
    }

    if (["/agentmemory/summarize", "/agentmemory/crystals/auto", "/agentmemory/consolidate-pipeline"].includes(url.pathname)) {
      sendJson(res, {});
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind to a port");
  return {
    url: "http://127.0.0.1:" + String(address.port),
    state,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function scriptForHook(hook: HookName): string {
  const scripts: Record<HookName, string> = {
    SessionStart: "session-start.mjs",
    UserPromptSubmit: "prompt-submit.mjs",
    PostToolUse: "post-tool-use.mjs",
    Stop: "stop.mjs",
    SessionEnd: "session-end.mjs",
  };
  return scripts[hook];
}

function hookPayload(fixture: CodexSessionEvalFixture, sessionId: string, event: HookEvent): string {
  return JSON.stringify({ hook_event_name: event.hook, session_id: sessionId, cwd: fixture.project, ...event.payload });
}

function runHook(scriptName: string, stdin: string, env: Record<string, string>): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [join(hooksDir, "codex-env-wrapper.mjs"), scriptName], {
      env: { PATH: process.env["PATH"] || "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ hook: "SessionStart", sessionId: "", stdout, stderr, exitCode, tookMs: Date.now() - start });
    });
    child.stdin.end(stdin);
  });
}

async function replaySession(
  fixture: CodexSessionEvalFixture,
  sessionId: string,
  events: HookEvent[],
  server: { url: string; state?: MockState; secret?: string },
): Promise<HookRun[]> {
  const runs: HookRun[] = [];
  for (const event of events) {
    const createsObservation = ["UserPromptSubmit", "PostToolUse", "Stop"].includes(event.hook);
    if (server.state) server.state.nextObservationId = createsObservation
      ? event.observationId || "obs_" + fixture.id + "_" + String(server.state.observations.length + 1)
      : undefined;
    const run = await runHook(scriptForHook(event.hook), hookPayload(fixture, sessionId, event), {
      AGENTMEMORY_ENV_FILE: join(repoRoot, "does-not-exist.env"),
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_PROMPT_CONTEXT_BUDGET: String(fixture.budgets.contextTokens),
      AGENTMEMORY_URL: server.url,
      ...(server.secret ? { AGENTMEMORY_SECRET: server.secret } : {}),
      AGENTMEMORY_HOOK_PROCESS_TIMEOUT_MS: "5000",
    });
    runs.push({ ...run, hook: event.hook, sessionId });
  }
  if (server.state) server.state.nextObservationId = undefined;
  return runs;
}

function parseAdditionalContext(run: HookRun): string {
  if (!run.stdout.trim()) return "";
  try {
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } };
    return typeof parsed.hookSpecificOutput?.additionalContext === "string" ? parsed.hookSpecificOutput.additionalContext : "";
  } catch {
    return "";
  }
}

function gradeFixture(fixture: CodexSessionEvalFixture, runs: HookRun[], state: GradeState): FixtureResult {
  const contexts = runs.map(parseAdditionalContext).filter(Boolean);
  const context = contexts.at(-1) || state.lastContext;
  const missingRequiredFacts = fixture.gold.requiredFacts.filter((fact) => !context.includes(fact));
  const leakedForbiddenFacts = fixture.gold.forbiddenFacts.filter((fact) => context.includes(fact));
  const requiredFactRecall = (fixture.gold.requiredFacts.length - missingRequiredFacts.length) / fixture.gold.requiredFacts.length;
  const forbiddenFactLeakRate = fixture.gold.forbiddenFacts.length === 0 ? 0 : leakedForbiddenFacts.length / fixture.gold.forbiddenFacts.length;
  const selected = new Set(state.selectedObservationIds);
  const goldObservationRecallAtK = fixture.gold.goldObservationIds.length === 0 ? 1 : fixture.gold.goldObservationIds.filter((id) => selected.has(id)).length / fixture.gold.goldObservationIds.length;
  const factualClaims = context.split(/\n+/).filter((line) => line.trim().startsWith("- ["));
  const contextPrecisionProxy = factualClaims.length === 0 ? 0 : fixture.gold.requiredFacts.filter((fact) => context.includes(fact)).length / factualClaims.length;
  const status = state.sessions.get(fixture.currentSession.sessionId)?.status;
  const sessionStateCorrect = status === fixture.gold.expectedSessionStatus;
  const contextJsonHooks = runs.filter((run) => ["SessionStart", "UserPromptSubmit"].includes(run.hook) && run.stdout.trim());
  const hookContractCorrect = runs.every((run) => run.exitCode === 0 && run.stderr === "")
    && contextJsonHooks.every((run) => parseAdditionalContext(run).length > 0)
    && state.diagnostics >= runs.length;
  const latencies = runs.map((run) => run.tookMs);
  const estimatedContextTokens = estimateTokens(context);
  const passed = hookContractCorrect
    && sessionStateCorrect
    && requiredFactRecall >= 0.85
    && forbiddenFactLeakRate <= 0.05
    && percentile(latencies, 95) <= fixture.budgets.hookP95Ms
    && estimatedContextTokens <= fixture.budgets.contextTokens + 64;

  return {
    fixtureId: fixture.id,
    category: fixture.category,
    passed,
    requiredFactRecall,
    forbiddenFactLeakRate,
    goldObservationRecallAtK,
    contextPrecisionProxy,
    sessionStateCorrect,
    hookContractCorrect,
    contextBytes: Buffer.byteLength(context, "utf8"),
    estimatedContextTokens,
    hookLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(...latencies, 0) },
    observationsCaptured: state.observationsCaptured,
    missingRequiredFacts,
    leakedForbiddenFacts,
    selectedObservationIds: state.selectedObservationIds,
    candidateSelectionTrace: state.candidateSelectionTrace,
    diagnostics: state.diagnostics,
  };
}

function gradeStateFromMock(state: MockState): GradeState {
  return {
    sessions: state.sessions,
    observationsCaptured: state.observations.length,
    diagnostics: state.diagnostics.length,
    selectedObservationIds: state.selectedObservationIds,
    candidateSelectionTrace: state.candidateSelectionTrace,
    lastContext: state.lastContext,
  };
}

export function loadFixtures(dir = defaultFixtureDir): CodexSessionEvalFixture[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return files.map((file) => FixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))));
}

async function runDisabledInjectionProbe(fixtures: CodexSessionEvalFixture[]): Promise<boolean> {
  const server = await startMockServer(fixtures[0]);
  try {
    const result = await runHook("prompt-submit.mjs", JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "disabled_probe",
      cwd: "/tmp/agentmemory-codex-eval",
      prompt: "probe disabled injection",
    }), {
      AGENTMEMORY_ENV_FILE: join(repoRoot, "does-not-exist.env"),
      AGENTMEMORY_URL: server.url,
    });
    return result.exitCode === 0 && result.stdout === "";
  } finally {
    await server.close();
  }
}

async function runFixture(fixture: CodexSessionEvalFixture): Promise<FixtureResult> {
  const server = await startMockServer(fixture);
  try {
    const priorRuns: HookRun[] = [];
    for (const prior of fixture.priorSessions) {
      priorRuns.push(...await replaySession(fixture, prior.sessionId, prior.events, server));
    }
    const currentRuns = await replaySession(fixture, fixture.currentSession.sessionId, fixture.currentSession.events, server);
    return gradeFixture(fixture, [...priorRuns, ...currentRuns], gradeStateFromMock(server.state));
  } finally {
    await server.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("ephemeral port allocation failed")));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function distinctFreePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

async function waitForJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : {};
      lastError = "HTTP " + String(res.status) + (text ? ": " + text.slice(0, 200) : "");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timed out waiting for " + url + (lastError ? " (" + lastError + ")" : ""));
}

function serviceEnv(tmp: string, restPort: number, streamPort: number, workerPort: number, secret?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] || "",
    HOME: tmp,
    III_REST_PORT: String(restPort),
    III_STREAMS_PORT: String(streamPort),
    III_WORKER_MANAGER_PORT: String(workerPort),
    III_ENGINE_URL: "ws://127.0.0.1:" + String(workerPort),
    AGENTMEMORY_URL: "http://127.0.0.1:" + String(restPort),
    AGENTMEMORY_ENV_FILE: join(tmp, ".agentmemory", ".env"),
    AGENTMEMORY_INJECT_CONTEXT: "true",
    AGENTMEMORY_CONTEXT_DEBUG_IDS: "true",
    AGENTMEMORY_AUTO_COMPRESS: "false",
    AGENTMEMORY_SESSION_IDLE_CLOSEOUT_ENABLED: "false",
    GRAPH_EXTRACTION_ENABLED: "false",
    CONSOLIDATION_ENABLED: "false",
    CLAUDE_MEMORY_BRIDGE: "false",
    EMBEDDING_PROVIDER: "",
    OTEL_DISABLED: "true",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    OPENROUTER_API_KEY: "",
    MINIMAX_API_KEY: "",
    OPENAI_API_KEY: "",
    VOYAGE_API_KEY: "",
    COHERE_API_KEY: "",
    AGENTMEMORY_ALLOW_AGENT_SDK: "",
  };
  if (secret) env.AGENTMEMORY_SECRET = secret;
  return env;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function serviceConfig(restPort: number, streamPort: number, workerPort: number): string {
  return [
    "workers:",
    "  - name: iii-worker-manager",
    "    config:",
    "      port: " + String(workerPort),
    "      host: 127.0.0.1",
    "  - name: iii-http",
    "    config:",
    "      port: " + String(restPort),
    "      host: 127.0.0.1",
    "      default_timeout: 180000",
    "      cors:",
    "        allowed_origins: [\"http://127.0.0.1:" + String(restPort) + "\"]",
    "        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]",
    "  - name: iii-state",
    "    config:",
    "      adapter:",
    "        name: kv",
    "        config:",
    "          store_method: file_based",
    "          file_path: ./data/state_store.db",
    "  - name: iii-queue",
    "    config:",
    "      adapter:",
    "        name: builtin",
    "  - name: iii-pubsub",
    "    config:",
    "      adapter:",
    "        name: local",
    "  - name: iii-cron",
    "    config:",
    "      adapter:",
    "        name: kv",
    "  - name: iii-stream",
    "    config:",
    "      port: " + String(streamPort),
    "      host: 127.0.0.1",
    "      adapter:",
    "        name: kv",
    "        config:",
    "          store_method: file_based",
    "          file_path: ./data/stream_store",
    "",
  ].join("\n");
}

async function startLocalService(): Promise<{ url: string; secret: string; close: () => Promise<void> }> {
  const [restPort, streamPort, workerPort] = await distinctFreePorts(3);
  const tmp = mkdtempSync(join(tmpdir(), "agentmemory-codex-eval-"));
  chmodSync(tmp, 0o755);
  mkdirSync(join(tmp, "data"), { recursive: true });
  mkdirSync(join(tmp, ".agentmemory"), { recursive: true });
  const configPath = join(tmp, "iii-config.yaml");
  writeFileSync(configPath, serviceConfig(restPort, streamPort, workerPort));
  writeFileSync(join(tmp, ".agentmemory", ".env"), [
    "AGENTMEMORY_INJECT_CONTEXT=true",
    "AGENTMEMORY_AUTO_COMPRESS=false",
    "GRAPH_EXTRACTION_ENABLED=false",
    "CONSOLIDATION_ENABLED=false",
    "CLAUDE_MEMORY_BRIDGE=false",
    "",
  ].join("\n"));
  const secret = "codex-session-eval-secret";
  const env = serviceEnv(tmp, restPort, streamPort, workerPort, secret);
  const iii = spawn("iii", ["--config", configPath, "--no-update-check"], {
    cwd: tmp,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let iiiOutput = "";
  iii.stdout.on("data", (chunk) => { iiiOutput += chunk.toString(); });
  iii.stderr.on("data", (chunk) => { iiiOutput += chunk.toString(); });

  const tsxPath = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const workerBin = existsSync(tsxPath) ? tsxPath : "tsx";
  const worker = spawn(workerBin, [join(repoRoot, "src", "index.ts")], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerOutput = "";
  worker.stdout.on("data", (chunk) => { workerOutput += chunk.toString(); });
  worker.stderr.on("data", (chunk) => { workerOutput += chunk.toString(); });

  const url = "http://127.0.0.1:" + String(restPort);
  const authHeaders = { Authorization: "Bearer " + secret };
  try {
    await waitForJson(url + "/agentmemory/livez", {}, 15_000);
    const unauth = await fetch(url + "/agentmemory/health", { signal: AbortSignal.timeout(1000) });
    if (unauth.status !== 401) throw new Error("expected unauthenticated /agentmemory/health to return 401, got " + String(unauth.status));
    await waitForJson(url + "/agentmemory/health", authHeaders, 15_000);
  } catch (error) {
    await stopProcess(worker);
    await stopProcess(iii);
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      "local-service eval could not start isolated agentmemory/iii-engine. " +
      "This mode requires the iii binary on PATH and free ephemeral localhost ports. " +
      (error instanceof Error ? error.message : String(error)) +
      "\niii output:\n" + iiiOutput.slice(-2000) +
      "\nworker output:\n" + workerOutput.slice(-2000),
    );
  }

  return {
    url,
    secret,
    close: async () => {
      await stopProcess(worker);
      await stopProcess(iii);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function serviceJson(service: { url: string; secret: string }, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + service.secret,
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(service.url + path, { ...init, headers, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!res.ok) throw new Error(path + " failed with HTTP " + String(res.status) + ": " + text.slice(0, 500));
  return json;
}

function observationsInReplay(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const timeline = (value as { timeline?: unknown }).timeline;
  if (!timeline || typeof timeline !== "object") return 0;
  const events = (timeline as { events?: unknown }).events;
  return Array.isArray(events) ? events.length : 0;
}

function expectedObservationCount(session: CodexSessionEvalFixture["priorSessions"][number]): number {
  return session.events.filter((event) => ["UserPromptSubmit", "PostToolUse", "Stop"].includes(event.hook)).length;
}

async function loadServiceSession(service: { url: string; secret: string }, sessionId: string): Promise<Record<string, unknown>> {
  return serviceJson(service, "/agentmemory/replay/load?sessionId=" + encodeURIComponent(sessionId), { method: "GET" });
}

async function waitForServiceObservations(fixture: CodexSessionEvalFixture, service: { url: string; secret: string }): Promise<void> {
  const sessions = [...fixture.priorSessions, fixture.currentSession];
  const expectedTotal = sessions.reduce((sum, session) => sum + expectedObservationCount(session), 0);
  const start = Date.now();
  while (Date.now() - start < 5000) {
    let observedTotal = 0;
    for (const session of sessions) {
      const replay = await loadServiceSession(service, session.sessionId);
      const loadedSession = replay.session && typeof replay.session === "object" ? replay.session as { observationCount?: unknown } : null;
      observedTotal += typeof loadedSession?.observationCount === "number" ? loadedSession.observationCount : observationsInReplay(replay);
    }
    if (observedTotal >= expectedTotal) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function serviceGradeState(fixture: CodexSessionEvalFixture, service: { url: string; secret: string }): Promise<GradeState> {
  await waitForServiceObservations(fixture, service);
  const fixtureIdByActualId = new Map<string, string>();
  const sessions = new Map<string, { status: string }>();
  let observationsCaptured = 0;
  for (const session of [...fixture.priorSessions, fixture.currentSession]) {
    const replay = await loadServiceSession(service, session.sessionId);
    const loadedSession = replay.session && typeof replay.session === "object" ? replay.session as { status?: unknown; observationCount?: unknown } : null;
    if (loadedSession?.status) sessions.set(session.sessionId, { status: String(loadedSession.status) });
    if (typeof loadedSession?.observationCount === "number") observationsCaptured += loadedSession.observationCount;
    else observationsCaptured += observationsInReplay(replay);
    const timeline = replay.timeline && typeof replay.timeline === "object" ? replay.timeline as { events?: unknown } : null;
    const events = Array.isArray(timeline?.events) ? timeline.events : [];
    const expectedObservationIds = session.events
      .filter((event) => ["UserPromptSubmit", "PostToolUse", "Stop"].includes(event.hook))
      .map((event) => event.observationId)
      .filter((id): id is string => typeof id === "string");
    for (let i = 0; i < expectedObservationIds.length && i < events.length; i++) {
      const event = events[i] as { id?: unknown };
      if (typeof event.id === "string") fixtureIdByActualId.set(event.id, expectedObservationIds[i]);
    }
  }
  const contextResult = await serviceJson(service, "/agentmemory/context", {
    method: "POST",
    body: JSON.stringify({
      sessionId: fixture.currentSession.sessionId + ":eval-context",
      project: fixture.project,
      budget: fixture.budgets.contextTokens,
      includeRetrievalIds: true,
    }),
  });
  const context = typeof contextResult.context === "string" ? contextResult.context : "";
  const selectedObservationIds = Array.isArray(contextResult.selectedObservationIds)
    ? contextResult.selectedObservationIds.filter((id): id is string => typeof id === "string")
    : [];
  const selectedSet = new Set(selectedObservationIds);
  const selectedFixtureIds = [...selectedSet]
    .map((id) => fixtureIdByActualId.get(id))
    .filter((id): id is string => typeof id === "string");
  const diagnostics = await serviceJson(service, "/agentmemory/hooks/diagnostics", { method: "GET" });
  const summary = diagnostics.summary && typeof diagnostics.summary === "object" ? diagnostics.summary as { attempts?: unknown } : {};
  return {
    sessions,
    observationsCaptured,
    diagnostics: typeof summary.attempts === "number" ? summary.attempts : 0,
    selectedObservationIds: [...selectedObservationIds, ...selectedFixtureIds],
    candidateSelectionTrace: [],
    lastContext: context,
  };
}

async function runServiceFixture(fixture: CodexSessionEvalFixture, service: { url: string; secret: string }): Promise<FixtureResult> {
  const priorRuns: HookRun[] = [];
  const started = new Set<string>();
  const ensureSession = async (sessionId: string, events: HookEvent[]) => {
    if (started.has(sessionId) || events.some((event) => event.hook === "SessionStart")) return;
    started.add(sessionId);
    const firstCwd = events
      .map((event) => event.payload.cwd)
      .find((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    const project = firstCwd || fixture.project;
    await serviceJson(service, "/agentmemory/session/start", {
      method: "POST",
      body: JSON.stringify({ sessionId, project, cwd: project }),
    });
  };
  for (const prior of fixture.priorSessions) {
    await ensureSession(prior.sessionId, prior.events);
    priorRuns.push(...await replaySession(fixture, prior.sessionId, prior.events, service));
  }
  await ensureSession(fixture.currentSession.sessionId, fixture.currentSession.events);
  const currentRuns = await replaySession(fixture, fixture.currentSession.sessionId, fixture.currentSession.events, service);
  const state = await serviceGradeState(fixture, service);
  return gradeFixture(fixture, [...priorRuns, ...currentRuns], state);
}

async function runLocalServiceEval(fixtures = loadFixtures()): Promise<EvalResults> {
  const service = await startLocalService();
  try {
    await runHook("prompt-submit.mjs", JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "service_warmup",
      cwd: "/tmp/agentmemory-codex-eval-warmup",
      prompt: "warm local-service hook subprocess",
    }), {
      AGENTMEMORY_ENV_FILE: join(repoRoot, "does-not-exist.env"),
      AGENTMEMORY_URL: service.url,
      AGENTMEMORY_SECRET: service.secret,
      AGENTMEMORY_HOOK_PROCESS_TIMEOUT_MS: "5000",
    });
    const results = await runMockEval(fixtures, "local-service", async (fixture) => runServiceFixture(fixture, service), false);
    await serviceJson(service, "/agentmemory/health", { method: "GET" });
    return results;
  } finally {
    await service.close();
  }
}

export async function runMockEval(
  fixtures = loadFixtures(),
  mode: EvalResults["mode"] = "mock",
  runOne: (fixture: CodexSessionEvalFixture) => Promise<FixtureResult> = runFixture,
  includeDisabledInjectionProbe = true,
): Promise<EvalResults> {
  const fixtureResults: FixtureResult[] = [];
  for (const fixture of fixtures) {
    fixtureResults.push(await runOne(fixture));
  }
  const disabledInjectionNoOutput = includeDisabledInjectionProbe ? await runDisabledInjectionProbe(fixtures) : true;
  const latencies = fixtureResults.map((result) => result.hookLatencyMs.p95);
  const requiredFactRecallAtContext = avg(fixtureResults.map((result) => result.requiredFactRecall));
  const forbiddenFactLeakRate = avg(fixtureResults.map((result) => result.forbiddenFactLeakRate));
  const sessionStateCorrectness = avg(fixtureResults.map((result) => result.sessionStateCorrect ? 1 : 0));
  const hookContractCorrectness = avg(fixtureResults.map((result) => result.hookContractCorrect ? 1 : 0));
  const maxContextTokens = Math.max(...fixtureResults.map((result) => result.estimatedContextTokens), 0);
  const gates = {
    hookContractCorrectness: hookContractCorrectness === 1,
    sessionStateCorrectness: sessionStateCorrectness === 1,
    requiredFactRecall: requiredFactRecallAtContext >= 0.85,
    forbiddenFactLeakRate: forbiddenFactLeakRate <= 0.05,
    hookP95: percentile(latencies, 95) <= 1500,
    contextBudget: fixtureResults.every((result, index) => result.estimatedContextTokens <= fixtures[index].budgets.contextTokens + 64),
    disabledInjectionNoOutput,
  };
  return {
    mode,
    generatedAt: new Date().toISOString(),
    passed: Object.values(gates).every(Boolean) && fixtureResults.every((result) => result.passed),
    fixtures: fixtureResults,
    metrics: {
      fixtureCount: fixtureResults.length,
      requiredFactRecallAtContext,
      forbiddenFactLeakRate,
      goldObservationRecallAtK: avg(fixtureResults.map((result) => result.goldObservationRecallAtK)),
      contextPrecisionProxy: avg(fixtureResults.map((result) => result.contextPrecisionProxy)),
      sessionStateCorrectness,
      hookContractCorrectness,
      hookP95Ms: percentile(latencies, 95),
      maxContextTokens,
      observationsCaptured: fixtureResults.reduce((sum, result) => sum + result.observationsCaptured, 0),
      disabledInjectionNoOutput,
    },
    gates,
  };
}

function markdownSummary(results: EvalResults): string {
  const lines = [
    "# Codex Session Eval Results",
    "",
    "Generated: " + results.generatedAt,
    "Mode: " + results.mode,
    "Status: " + (results.passed ? "PASS" : "FAIL"),
    "",
    "## Metrics",
    "",
    "- fixtures: " + String(results.metrics.fixtureCount),
    "- required_fact_recall@context: " + results.metrics.requiredFactRecallAtContext.toFixed(3),
    "- forbidden_fact_leak_rate: " + results.metrics.forbiddenFactLeakRate.toFixed(3),
    "- gold_observation_recall@k: " + results.metrics.goldObservationRecallAtK.toFixed(3),
    "- context_precision_proxy: " + results.metrics.contextPrecisionProxy.toFixed(3),
    "- session_state_correctness: " + results.metrics.sessionStateCorrectness.toFixed(3),
    "- hook_contract_correctness: " + results.metrics.hookContractCorrectness.toFixed(3),
    "- hook_p95_ms: " + String(results.metrics.hookP95Ms),
    "- max_context_tokens: " + String(results.metrics.maxContextTokens),
    "",
    "## Fixtures",
    "",
    "| Fixture | Status | Recall | Leak | Obs Recall | Tokens | Missing | Leaked |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...results.fixtures.map((result) => [
      "| " + result.fixtureId,
      result.passed ? "PASS" : "FAIL",
      result.requiredFactRecall.toFixed(3),
      result.forbiddenFactLeakRate.toFixed(3),
      result.goldObservationRecallAtK.toFixed(3),
      String(result.estimatedContextTokens),
      result.missingRequiredFacts.join("; ") || "-",
      (result.leakedForbiddenFacts.join("; ") || "-") + " |",
    ].join(" | ")),
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "mock";
  if (mode !== "mock" && mode !== "local-service") {
    process.stderr.write("Supported Codex session eval modes: mock, local-service.\n");
    process.exit(1);
  }
  const results = mode === "local-service" ? await runLocalServiceEval() : await runMockEval();
  mkdirSync(dirname(defaultJsonResultsPath), { recursive: true });
  writeFileSync(defaultJsonResultsPath, JSON.stringify(results, null, 2) + "\n");
  writeFileSync(defaultMarkdownResultsPath, markdownSummary(results));
  process.stdout.write(markdownSummary(results));
  if (!results.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\n");
    process.exit(1);
  });
}
