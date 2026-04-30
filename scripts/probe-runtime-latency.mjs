#!/usr/bin/env node

const DEFAULT_REST_BASE_URL = "http://127.0.0.1:3111/agentmemory";
const DEFAULT_VIEWER_BASE_URL = "http://127.0.0.1:3113";
const DEFAULT_PROJECT = process.cwd();
const DEFAULT_BRANCH = "main";
const DEFAULT_TIMEOUT_MS = 20000;

function usage() {
  return `Usage:
  npm run ops:latency -- [options]

Options:
  --rest-base-url <url>     AgentMemory REST base URL (default: ${DEFAULT_REST_BASE_URL})
  --viewer-base-url <url>   AgentMemory viewer base URL (default: ${DEFAULT_VIEWER_BASE_URL})
  --project <path>          Project scope for probe payloads (default: cwd)
  --cwd <path>              Cwd for hook/session payloads (default: project)
  --branch <name>           Branch for session start payloads (default: ${DEFAULT_BRANCH})
  --session-id <id>         Session id to use (default: generated)
  --runs <n>                Repetitions for observe calls (default: 5)
  --context-runs <n>        Repetitions for context/session calls (default: 3)
  --large-bytes <n>         Output bytes for large post_tool_use probe (default: 200000)
  --timeout-ms <n>          Per-request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --help                    Show this help
`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    restBaseUrl: DEFAULT_REST_BASE_URL,
    viewerBaseUrl: DEFAULT_VIEWER_BASE_URL,
    project: DEFAULT_PROJECT,
    cwd: undefined,
    branch: DEFAULT_BRANCH,
    sessionId: `latency_probe_${Date.now()}`,
    runs: 5,
    contextRuns: 3,
    largeBytes: 200_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--rest-base-url":
        options.restBaseUrl = next().replace(/\/$/, "");
        break;
      case "--viewer-base-url":
        options.viewerBaseUrl = next().replace(/\/$/, "");
        break;
      case "--project":
        options.project = next();
        break;
      case "--cwd":
        options.cwd = next();
        break;
      case "--branch":
        options.branch = next();
        break;
      case "--session-id":
        options.sessionId = next();
        break;
      case "--runs":
        options.runs = parsePositiveInt(next(), "--runs");
        break;
      case "--context-runs":
        options.contextRuns = parsePositiveInt(next(), "--context-runs");
        break;
      case "--large-bytes":
        options.largeBytes = parsePositiveInt(next(), "--large-bytes");
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(next(), "--timeout-ms");
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.cwd ??= options.project;
  return options;
}

function seconds(ms) {
  return (ms / 1000).toFixed(6);
}

async function requestJson(method, url, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const elapsedMs = performance.now() - start;
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs,
      bytes: Buffer.byteLength(text),
      json,
      error: response.ok ? undefined : text.slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      status: "ERR",
      elapsedMs: performance.now() - start,
      bytes: 0,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function observePayload(options, hookType, outputBytes, persistenceClass) {
  const output = outputBytes > 0 ? "x".repeat(outputBytes) : "ok";
  return {
    hookType,
    sessionId: options.sessionId,
    project: options.project,
    cwd: options.cwd,
    timestamp: new Date().toISOString(),
    source: "latency-probe",
    eventId: `lat_probe_${hookType}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    persistenceClass,
    data: {
      command: "latency-probe",
      exit_code: 0,
      output,
    },
  };
}

async function sample(label, runs, fn) {
  const rows = [];
  for (let run = 1; run <= runs; run++) {
    const result = await fn(run);
    rows.push({ label, run, ...result });
    console.log([
      label,
      run,
      result.status,
      seconds(result.elapsedMs),
      result.bytes,
      result.error ? JSON.stringify(result.error) : "",
    ].join(","));
  }
  return rows;
}

function summarize(rows) {
  const byLabel = new Map();
  for (const row of rows) {
    const entry = byLabel.get(row.label) ?? [];
    entry.push(row);
    byLabel.set(row.label, entry);
  }

  console.log("");
  console.log("summary_action,runs,ok,min_seconds,median_seconds,max_seconds");
  for (const [label, entries] of byLabel.entries()) {
    const elapsed = entries.map((entry) => entry.elapsedMs).sort((a, b) => a - b);
    const median = elapsed[Math.floor(elapsed.length / 2)];
    const ok = entries.filter((entry) => entry.ok).length;
    console.log([
      label,
      entries.length,
      ok,
      seconds(elapsed[0]),
      seconds(median),
      seconds(elapsed[elapsed.length - 1]),
    ].join(","));
  }
}

function pressureSummary(health) {
  const body = health.json ?? {};
  const runtime = body.runtimeStatus ?? body.status ?? "unknown";
  const serving = body.servingStatus ?? "unknown";
  const maintenance = body.maintenanceStatus ?? "unknown";
  const observe = body.observeCapture ?? {};
  const memory = body.health?.memory ?? {};
  const cpu = body.health?.cpu ?? {};
  const deferred = body.deferredWork ?? {};

  return {
    runtime,
    serving,
    maintenance,
    observeStatus: observe.status ?? "unknown",
    observePressure: observe.pressure?.reason ?? null,
    heapUsed: memory.heapUsed ?? null,
    heapLimit: memory.heapLimit ?? null,
    rss: memory.rss ?? null,
    cpuPercent: cpu.percent ?? null,
    eventLoopLagMs: body.health?.eventLoopLagMs ?? null,
    totalQueued: deferred.totalQueued ?? null,
    compressionQueued: deferred.compression?.queued ?? null,
    observeDerivedQueued: deferred.observeDerived?.queued ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rest = options.restBaseUrl;
  const viewer = options.viewerBaseUrl;
  const rows = [];

  console.log("action,run,http_status,total_seconds,response_bytes,error");
  rows.push(...await sample("health_viewer", 3, () =>
    requestJson("GET", `${viewer}/health`, undefined, options.timeoutMs)
  ));
  rows.push(...await sample("health_rest", 3, () =>
    requestJson("GET", `${rest}/health`, undefined, options.timeoutMs)
  ));
  rows.push(...await sample("session_start_context", options.contextRuns, () =>
    requestJson("POST", `${rest}/session/start`, {
      sessionId: options.sessionId,
      project: options.project,
      cwd: options.cwd,
      branch: options.branch,
      budget: 2000,
    }, options.timeoutMs)
  ));
  rows.push(...await sample("context_manual_recall", options.contextRuns, () =>
    requestJson("POST", `${rest}/context`, {
      sessionId: options.sessionId,
      project: options.project,
      query: "agentmemory observe hook latency performance audit",
      intent: "manual_recall",
      budget: 2000,
    }, options.timeoutMs)
  ));
  rows.push(...await sample("pre_tool_observe", options.runs, () =>
    requestJson("POST", `${rest}/observe`, observePayload(options, "pre_tool_use", 0, "diagnostics_only"), options.timeoutMs)
  ));
  rows.push(...await sample("post_tool_small_observe", options.runs, () =>
    requestJson("POST", `${rest}/observe`, observePayload(options, "post_tool_use", 2, "persistent"), options.timeoutMs)
  ));
  rows.push(...await sample("post_tool_large_observe", options.runs, () =>
    requestJson("POST", `${rest}/observe`, observePayload(options, "post_tool_use", options.largeBytes, "persistent"), options.timeoutMs)
  ));
  rows.push(...await sample("assistant_result_observe", options.runs, () =>
    requestJson("POST", `${rest}/observe`, observePayload(options, "assistant_result", 2000, "persistent"), options.timeoutMs)
  ));

  summarize(rows);

  const postHealth = await requestJson("GET", `${viewer}/health`, undefined, options.timeoutMs);
  const pressure = pressureSummary(postHealth);
  console.log("");
  console.log("post_probe_health=" + JSON.stringify(pressure));

  const failures = rows.filter((row) => !row.ok);
  const unhealthy = postHealth.ok && ["critical", "degraded"].includes(String(postHealth.json?.runtimeStatus));
  const observeUnhealthy = ["degraded", "shedding"].includes(pressure.observeStatus);
  if (failures.length > 0 || unhealthy || observeUnhealthy) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
