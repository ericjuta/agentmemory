#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";

const DEFAULT_BASE_URL = "http://127.0.0.1:3111";
const DEFAULT_TIMEOUT_MS = 180000;
const CODEX_SESSION_PATTERN = /session id:\s*([0-9a-f-]{36})/i;
const DEFAULT_SEARCH_ATTEMPTS = 8;
const DEFAULT_POLL_MS = 1500;

function usage() {
  return `Usage:
  node scripts/smoke-codex-cli-full-integration.mjs [options] [-- codex args...]

Options:
  --base-url <url>          AgentMemory origin, without /agentmemory (default: ${DEFAULT_BASE_URL})
  --codex-bin <path>        Codex binary to run (default: codex)
  --project <path>          Project/cwd scope to verify in AgentMemory (default: cwd)
  --branch <name>           Branch scope to query (default: current git branch when available, else main)
  --marker <text>           Unique marker to ask Codex to print and later search
  --timeout-ms <n>          Codex command timeout (default: ${DEFAULT_TIMEOUT_MS})
  --search-attempts <n>     Poll attempts for smart-search proof (default: ${DEFAULT_SEARCH_ATTEMPTS})
  --poll-ms <n>             Delay between search attempts (default: ${DEFAULT_POLL_MS})
  --skip-codex              Skip spawning Codex and run only REST contract checks
  --json                    Print a machine-readable JSON summary
  --no-default-codex-flags  Do not add "-a never --sandbox read-only"
  --help                    Show this help
`;
}

function readArgValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.AGENTMEMORY_SMOKE_BASE_URL || process.env.AGENTMEMORY_URL || DEFAULT_BASE_URL,
    codexBin: process.env.CODEX_BIN || "codex",
    project: process.cwd(),
    branch: undefined,
    marker: `agentmemory-codex-full-smoke-${randomUUID()}`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    searchAttempts: DEFAULT_SEARCH_ATTEMPTS,
    pollMs: DEFAULT_POLL_MS,
    codex: true,
    json: false,
    defaultCodexFlags: true,
    codexArgs: [],
  };
  const separator = argv.indexOf("--");
  const args = separator === -1 ? argv : argv.slice(0, separator);
  options.codexArgs = separator === -1 ? [] : argv.slice(separator + 1);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--base-url":
        options.baseUrl = readArgValue(args, i, arg).replace(/\/$/, "");
        i++;
        break;
      case "--codex-bin":
        options.codexBin = readArgValue(args, i, arg);
        i++;
        break;
      case "--project":
        options.project = readArgValue(args, i, arg);
        i++;
        break;
      case "--branch":
        options.branch = readArgValue(args, i, arg);
        i++;
        break;
      case "--marker":
        options.marker = readArgValue(args, i, arg);
        i++;
        break;
      case "--timeout-ms":
        options.timeoutMs = positiveInt(readArgValue(args, i, arg), arg);
        i++;
        break;
      case "--search-attempts":
        options.searchAttempts = positiveInt(readArgValue(args, i, arg), arg);
        i++;
        break;
      case "--poll-ms":
        options.pollMs = positiveInt(readArgValue(args, i, arg), arg);
        i++;
        break;
      case "--skip-codex":
        options.codex = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-default-codex-flags":
        options.defaultCodexFlags = false;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function log(options, message) {
  if (!options.json) console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 700);
}

function containsMarker(value, marker) {
  return JSON.stringify(value ?? {}).includes(marker);
}

async function requestJson(method, url, body, timeoutMs = 15000) {
  const headers = body === undefined ? {} : { "content-type": "application/json" };
  if (process.env.AGENTMEMORY_SECRET) {
    headers.authorization = `Bearer ${process.env.AGENTMEMORY_SECRET}`;
  }
  const startedAt = Date.now();
  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    body: parsed,
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.project,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, error: error.message, timedOut, ms: Date.now() - startedAt });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - startedAt });
    });
  });
}

async function assertExecutable(command) {
  if (command.includes("/") || command.startsWith(".")) {
    await access(command, constants.X_OK);
  }
}

async function gitBranch(project) {
  const result = await runProcess("git", ["branch", "--show-current"], {
    project,
    timeoutMs: 5000,
  });
  const branch = result.stdout.trim();
  return result.code === 0 && branch ? branch : "main";
}

function codexArgs(options) {
  const prompt = [
    "You are running a full smoke test for AgentMemory integration.",
    "Reply with exactly this marker on its own line and do not edit files:",
    options.marker,
  ].join("\n");
  const defaultFlags = options.defaultCodexFlags
    ? ["-a", "never", "--sandbox", "read-only"]
    : [];
  return [...defaultFlags, "exec", ...options.codexArgs, prompt];
}

function extractSessionId(...texts) {
  for (const text of texts) {
    const match = CODEX_SESSION_PATTERN.exec(text || "");
    if (match?.[1]) return match[1];
  }
  return null;
}

function passIf(summary, condition, failure) {
  if (!condition) summary.failures.push(failure);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.branch ||= await gitBranch(options.project);
  await assertExecutable(options.codexBin);

  const base = `${options.baseUrl}/agentmemory`;
  const summary = {
    pass: false,
    baseUrl: options.baseUrl,
    project: options.project,
    branch: options.branch,
    marker: options.marker,
    failures: [],
    warnings: [],
    health: null,
    serverProof: null,
    codex: null,
    smartSearch: null,
    session: null,
    observations: null,
    context: null,
    closeout: null,
    handoffs: null,
  };

  log(options, `Checking ${base}/health`);
  const health = await requestJson("GET", `${base}/health`, undefined, 10000);
  summary.health = {
    status: health.status,
    ok: health.ok,
    runtimeStatus: health.body?.runtimeStatus ?? health.body?.status ?? null,
    servingStatus: health.body?.servingStatus ?? null,
    maintenanceStatus: health.body?.maintenanceStatus ?? health.body?.maintenance?.status ?? null,
    observeCaptureStatus: health.body?.observeCapture?.status ?? null,
    totalQueued: health.body?.deferredWork?.totalQueued ?? health.body?.maintenance?.totalQueued ?? null,
    writeGates: health.body?.writeGates ?? null,
  };
  passIf(summary, health.ok, "health_http_failed");

  log(options, "Running server-side Codex integration proof");
  const proofSessionId = `codex-cli-full-proof-${randomUUID()}`;
  const proof = await requestJson(
    "POST",
    `${base}/codex-integration/proof`,
    {
      sessionId: proofSessionId,
      project: options.project,
      cwd: options.project,
      branch: options.branch,
      query: options.marker,
      contextBudget: 8000,
      searchLimit: 5,
      latencyTargetsMs: { sessionStart: 1000, context: 3000, smartSearch: 2500 },
    },
    45000,
  );
  summary.serverProof = {
    status: proof.status,
    ok: proof.ok,
    pass: proof.body?.pass === true,
    contractPass: proof.body?.contractPass === true,
    qualityPass: proof.body?.qualityPass === true,
    warnings: Array.isArray(proof.body?.warnings) ? proof.body.warnings : [],
    health: proof.body?.health ?? null,
    sessionId: proof.body?.sessionId ?? proofSessionId,
    steps: proof.body?.steps ?? null,
  };
  passIf(summary, proof.ok, "server_proof_http_failed");
  passIf(summary, proof.body?.contractPass === true, "server_contract_failed");
  passIf(summary, proof.body?.qualityPass === true, "server_quality_failed");

  const args = codexArgs(options);
  log(options, `Running ${options.codexBin} ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`);
  const codex = await runProcess(options.codexBin, args, options);
  const codexSessionId = extractSessionId(codex.stderr, codex.stdout);
  const markerInOutput = codex.stdout.includes(options.marker) || codex.stderr.includes(options.marker);
  summary.codex = {
    code: codex.code,
    signal: codex.signal,
    timedOut: codex.timedOut,
    ms: codex.ms,
    error: codex.error,
    sessionId: codexSessionId,
    markerInOutput,
    stdoutSnippet: snippet(codex.stdout),
    stderrSnippet: snippet(codex.stderr),
  };
  passIf(summary, codex.code === 0 && !codex.timedOut && !codex.error, "codex_exec_failed");
  passIf(summary, markerInOutput, "codex_marker_missing");
  passIf(summary, Boolean(codexSessionId), "codex_session_id_missing");

  log(options, "Checking marker retrieval through smart-search");
  const search = await requestJson(
    "POST",
    `${base}/smart-search`,
    {
      query: options.marker,
      project: options.project,
      cwd: options.project,
      branch: options.branch,
      limit: 5,
      trace: true,
    },
    20000,
  );
  const searchResults = Array.isArray(search.body?.results) ? search.body.results : [];
  summary.smartSearch = {
    status: search.status,
    ok: search.ok,
    results: searchResults.length,
    markerFound: containsMarker(search.body, options.marker),
    topTitle: searchResults[0]?.title ?? null,
  };
  passIf(summary, search.ok, "smart_search_http_failed");
  passIf(summary, containsMarker(search.body, options.marker), "smart_search_marker_missing");

  if (codexSessionId) {
    log(options, "Checking Codex session persistence");
    const sessions = await requestJson("GET", `${base}/sessions?limit=80`, undefined, 15000);
    const sessionList = Array.isArray(sessions.body?.sessions) ? sessions.body.sessions : [];
    const storedSession = sessionList.find((session) => session?.id === codexSessionId) || null;
    summary.session = {
      status: sessions.status,
      ok: sessions.ok,
      found: Boolean(storedSession),
      sessionStatus: storedSession?.status ?? null,
      observationCount: storedSession?.observationCount ?? null,
    };
    passIf(summary, sessions.ok, "sessions_http_failed");
    passIf(summary, Boolean(storedSession), "codex_session_not_found");

    log(options, "Checking Codex observations");
    const observations = await requestJson(
      "GET",
      `${base}/observations?sessionId=${encodeURIComponent(codexSessionId)}`,
      undefined,
      20000,
    );
    const observationList = Array.isArray(observations.body?.observations) ? observations.body.observations : [];
    summary.observations = {
      status: observations.status,
      ok: observations.ok,
      count: observationList.length,
      markerFound: containsMarker(observationList, options.marker),
      sampleTitle: observationList[0]?.title ?? null,
    };
    passIf(summary, observations.ok, "observations_http_failed");
    passIf(summary, observationList.length > 0, "codex_observations_empty");
    if (!containsMarker(observationList, options.marker)) {
      summary.warnings.push("marker_not_found_in_raw_observations");
    }

    log(options, "Checking context retrieval for Codex session");
    const context = await requestJson(
      "POST",
      `${base}/context`,
      {
        sessionId: codexSessionId,
        project: options.project,
        cwd: options.project,
        branch: options.branch,
        query: options.marker,
        budget: 8000,
      },
      30000,
    );
    summary.context = {
      status: context.status,
      ok: context.ok,
      chars: typeof context.body?.context === "string" ? context.body.context.length : 0,
      items: Array.isArray(context.body?.items) ? context.body.items.length : null,
      markerFound: containsMarker(context.body, options.marker),
      contextStatus: context.body?.status ?? context.body?.contextStatus ?? null,
    };
    passIf(summary, context.ok, "context_http_failed");
    if (summary.observations?.count > 0) {
      passIf(summary, summary.context.chars > 0 || summary.context.items > 0, "context_empty_for_observed_session");
    } else if (summary.context.chars === 0 && summary.context.items === 0) {
      summary.warnings.push("context_empty_because_codex_session_has_no_observations");
    }

    log(options, "Closing out Codex session");
    const closeout = await requestJson(
      "POST",
      `${base}/session/closeout`,
      { sessionId: codexSessionId },
      30000,
    );
    summary.closeout = {
      status: closeout.status,
      ok: closeout.ok,
      success: closeout.body?.success === true,
      steps: closeout.body?.steps ?? null,
      errors: closeout.body?.errors ?? [],
    };
    passIf(summary, closeout.ok, "closeout_http_failed");
    passIf(summary, closeout.body?.success === true, "closeout_failed");
  }

  log(options, "Checking handoff list API");
  const handoffs = await requestJson(
    "GET",
    `${base}/handoffs?project=${encodeURIComponent(options.project)}&limit=5`,
    undefined,
    15000,
  );
  const packets = Array.isArray(handoffs.body?.handoffPackets) ? handoffs.body.handoffPackets : [];
  summary.handoffs = {
    status: handoffs.status,
    ok: handoffs.ok,
    count: packets.length,
    latestId: packets[0]?.id ?? packets[0]?.handoffPacketId ?? null,
  };
  passIf(summary, handoffs.ok, "handoffs_http_failed");

  summary.pass = summary.failures.length === 0;
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("");
    console.log(`AgentMemory Codex CLI full integration eval: ${summary.pass ? "pass" : "fail"}`);
    console.log(`Marker:  ${summary.marker}`);
    console.log(`Health:  http=${summary.health?.status}, runtime=${summary.health?.runtimeStatus}, maintenance=${summary.health?.maintenanceStatus}`);
    console.log(`Proof:   contract=${summary.serverProof?.contractPass ? "pass" : "fail"}, quality=${summary.serverProof?.qualityPass ? "pass" : "fail"}`);
    console.log(`Codex:   code=${summary.codex?.code}, session=${summary.codex?.sessionId ?? "missing"}, marker=${summary.codex?.markerInOutput ? "yes" : "no"}`);
    console.log(`Search:  results=${summary.smartSearch?.results ?? "?"}, marker=${summary.smartSearch?.markerFound ? "yes" : "no"}`);
    console.log(`Observe: count=${summary.observations?.count ?? "?"}, marker=${summary.observations?.markerFound ? "yes" : "no"}`);
    console.log(`Context: chars=${summary.context?.chars ?? "?"}, items=${summary.context?.items ?? "?"}`);
    console.log(`Closeout: ${summary.closeout?.success ? "ok" : "fail"}`);
    if (summary.warnings.length > 0) console.log(`Warnings: ${summary.warnings.join(", ")}`);
    if (summary.failures.length > 0) console.log(`Failures: ${summary.failures.join(", ")}`);
  }

  if (!summary.pass) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
