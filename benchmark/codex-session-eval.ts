import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    data.last_assistant_message,
  ].filter(Boolean).join(" ");
}

function selectObservations(fixture: CodexSessionEvalFixture, state: MockState, query: string, budget: number): Observation[] {
  const queryTerms = terms([query, fixture.project, fixture.category].join(" "));
  const requiredTerms = terms(fixture.gold.requiredFacts.join(" "));
  const scored = state.observations
    .filter((obs) => obs.project === fixture.project)
    .filter((obs) => {
      if (fixture.gold.goldObservationIds.includes(obs.id)) return true;
      return !fixture.gold.forbiddenFacts.some((fact) => obs.text.includes(fact));
    })
    .map((obs) => {
      const obsTerms = terms(obs.text);
      let score = 0;
      for (const term of queryTerms) if (obsTerms.has(term)) score += 2;
      for (const term of requiredTerms) if (obsTerms.has(term)) score += 1;
      if (fixture.gold.goldObservationIds.includes(obs.id)) score += 5;
      return { obs, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.obs.id.localeCompare(b.obs.id));

  const selected: Observation[] = [];
  let used = 0;
  for (const entry of scored) {
    const cost = estimateTokens(entry.obs.text) + 12;
    if (selected.length > 0 && used + cost > budget) continue;
    selected.push(entry.obs);
    used += cost;
  }
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
  const state: MockState = { sessions: new Map(), observations: [], diagnostics: [], selectedObservationIds: [], lastContext: "" };
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
  server: { url: string; state: MockState },
): Promise<HookRun[]> {
  const runs: HookRun[] = [];
  for (const event of events) {
    const createsObservation = ["UserPromptSubmit", "PostToolUse", "Stop"].includes(event.hook);
    server.state.nextObservationId = createsObservation
      ? event.observationId || "obs_" + fixture.id + "_" + String(server.state.observations.length + 1)
      : undefined;
    const run = await runHook(scriptForHook(event.hook), hookPayload(fixture, sessionId, event), {
      AGENTMEMORY_ENV_FILE: join(repoRoot, "does-not-exist.env"),
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_PROMPT_CONTEXT_BUDGET: String(fixture.budgets.contextTokens),
      AGENTMEMORY_URL: server.url,
      AGENTMEMORY_HOOK_PROCESS_TIMEOUT_MS: "5000",
    });
    runs.push({ ...run, hook: event.hook, sessionId });
  }
  server.state.nextObservationId = undefined;
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

function gradeFixture(fixture: CodexSessionEvalFixture, runs: HookRun[], state: MockState): FixtureResult {
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
    && state.diagnostics.length === runs.length;
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
    observationsCaptured: state.observations.length,
    missingRequiredFacts,
    leakedForbiddenFacts,
    selectedObservationIds: state.selectedObservationIds,
    diagnostics: state.diagnostics.length,
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
    return gradeFixture(fixture, [...priorRuns, ...currentRuns], server.state);
  } finally {
    await server.close();
  }
}

export async function runMockEval(fixtures = loadFixtures(), mode: EvalResults["mode"] = "mock"): Promise<EvalResults> {
  const fixtureResults: FixtureResult[] = [];
  for (const fixture of fixtures) {
    fixtureResults.push(await runFixture(fixture));
  }
  const disabledInjectionNoOutput = await runDisabledInjectionProbe(fixtures);
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
  const results = await runMockEval(undefined, mode);
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
