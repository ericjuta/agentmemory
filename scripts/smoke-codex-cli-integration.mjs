#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";

const DEFAULT_BASE_URL = "http://127.0.0.1:3111";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_POLL_MS = 2500;
const DEFAULT_SEARCH_ATTEMPTS = 12;

function usage() {
  return `Usage:
  node scripts/smoke-codex-cli-integration.mjs [options] [-- codex args...]

Options:
  --base-url <url>          AgentMemory origin, without /agentmemory (default: ${DEFAULT_BASE_URL})
  --codex-bin <path>        Codex binary to run (default: codex)
  --mode <exec|prompt>      Run "codex exec" or top-level "codex [PROMPT]" (default: exec)
  --project <path>          Project/cwd scope to verify in AgentMemory (default: cwd)
  --branch <name>           Branch scope to query (default: current git branch when available, else main)
  --marker <text>           Unique marker to ask Codex to print and later search
  --timeout-ms <n>          Codex command timeout (default: ${DEFAULT_TIMEOUT_MS})
  --search-attempts <n>     Poll attempts for smart-search proof (default: ${DEFAULT_SEARCH_ATTEMPTS})
  --poll-ms <n>             Delay between search attempts (default: ${DEFAULT_POLL_MS})
  --skip-health             Do not check /agentmemory/health before running Codex
  --skip-search             Only prove Codex command completed and marker appeared in output
  --keep-going              Continue to AgentMemory search even if Codex output lacks marker
  --json                    Print a machine-readable JSON summary
  --no-default-codex-flags  Do not add "-a never --sandbox read-only"
  --help                    Show this help

Examples:
  node scripts/smoke-codex-cli-integration.mjs
  node scripts/smoke-codex-cli-integration.mjs --mode prompt --codex-bin /home/me/.local/bin/codex
  node scripts/smoke-codex-cli-integration.mjs -- --sandbox read-only -a never
`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readArgValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.AGENTMEMORY_SMOKE_BASE_URL || DEFAULT_BASE_URL,
    codexBin: process.env.CODEX_BIN || "codex",
    mode: "exec",
    project: process.cwd(),
    branch: undefined,
    marker: `agentmemory-codex-smoke-${randomUUID()}`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    searchAttempts: DEFAULT_SEARCH_ATTEMPTS,
    pollMs: DEFAULT_POLL_MS,
    health: true,
    search: true,
    keepGoing: false,
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
      case "--mode":
        options.mode = readArgValue(args, i, arg);
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
        options.timeoutMs = parsePositiveInt(readArgValue(args, i, arg), arg);
        i++;
        break;
      case "--search-attempts":
        options.searchAttempts = parsePositiveInt(readArgValue(args, i, arg), arg);
        i++;
        break;
      case "--poll-ms":
        options.pollMs = parsePositiveInt(readArgValue(args, i, arg), arg);
        i++;
        break;
      case "--skip-health":
        options.health = false;
        break;
      case "--skip-search":
        options.search = false;
        break;
      case "--keep-going":
        options.keepGoing = true;
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

  if (!["exec", "prompt"].includes(options.mode)) {
    throw new Error("--mode must be exec or prompt");
  }
  return options;
}

function log(options, message) {
  if (!options.json) console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(method, url, body, timeoutMs = 10000) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  return { ok: response.ok, status: response.status, body: parsed };
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

function codexCommand(options) {
  const prompt = [
    "You are running a smoke test for AgentMemory integration.",
    "Reply with exactly this marker on its own line and do not edit files:",
    options.marker,
  ].join("\n");

  const defaultFlags = options.defaultCodexFlags
    ? ["-a", "never", "--sandbox", "read-only"]
    : [];

  if (options.mode === "exec") {
    return {
      args: [...defaultFlags, "exec", ...options.codexArgs, prompt],
      prompt,
    };
  }
  return {
    args: [...defaultFlags, ...options.codexArgs, prompt],
    prompt,
  };
}

function resultSnippet(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.branch ||= await gitBranch(options.project);

  await assertExecutable(options.codexBin);

  const agentmemoryBase = `${options.baseUrl}/agentmemory`;
  const summary = {
    pass: false,
    mode: options.mode,
    project: options.project,
    branch: options.branch,
    marker: options.marker,
    baseUrl: options.baseUrl,
    health: null,
    codex: null,
    markerInOutput: false,
    search: null,
  };

  if (options.health) {
    log(options, `Checking ${agentmemoryBase}/health`);
    const health = await requestJson("GET", `${agentmemoryBase}/health`, undefined, 10000);
    summary.health = {
      status: health.status,
      ok: health.ok,
      runtimeStatus: health.body?.runtimeStatus ?? health.body?.status ?? null,
    };
    if (!health.ok) {
      throw Object.assign(new Error(`AgentMemory health failed with HTTP ${health.status}`), { summary });
    }
  }

  const command = codexCommand(options);
  log(options, `Running ${options.codexBin} ${command.args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`);
  const codex = await runProcess(options.codexBin, command.args, options);
  summary.codex = {
    code: codex.code,
    signal: codex.signal,
    timedOut: codex.timedOut,
    ms: codex.ms,
    error: codex.error,
    stdoutSnippet: resultSnippet(codex.stdout),
    stderrSnippet: resultSnippet(codex.stderr),
  };
  summary.markerInOutput = codex.stdout.includes(options.marker) || codex.stderr.includes(options.marker);

  if (codex.code !== 0 || codex.timedOut || codex.error) {
    throw Object.assign(new Error(`Codex command failed: code=${codex.code} timedOut=${codex.timedOut} error=${codex.error ?? "none"}`), { summary });
  }
  if (!summary.markerInOutput && !options.keepGoing) {
    throw Object.assign(new Error("Codex completed but the marker was not found in output"), { summary });
  }

  if (options.search) {
    log(options, "Polling AgentMemory smart-search for the marker");
    for (let attempt = 1; attempt <= options.searchAttempts; attempt++) {
      const response = await requestJson(
        "POST",
        `${agentmemoryBase}/smart-search`,
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
      const results = Array.isArray(response.body?.results) ? response.body.results : [];
      const serialized = JSON.stringify(response.body ?? {});
      const found = response.ok && serialized.includes(options.marker);
      summary.search = {
        status: response.status,
        ok: response.ok,
        attempt,
        results: results.length,
        found,
        topTitle: results[0]?.title ?? null,
      };
      if (found) break;
      if (attempt < options.searchAttempts) await sleep(options.pollMs);
    }
    if (!summary.search?.found) {
      throw Object.assign(new Error("AgentMemory smart-search did not return the marker"), { summary });
    }
  }

  summary.pass = true;
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("");
    console.log("AgentMemory Codex CLI smoke: pass");
    console.log(`Marker: ${options.marker}`);
    console.log(`Codex:  ${summary.codex.ms}ms, output marker=${summary.markerInOutput ? "yes" : "no"}`);
    if (summary.search) {
      console.log(`Search:  attempt ${summary.search.attempt}, results=${summary.search.results}, found=yes`);
    }
  }
}

main().catch((error) => {
  const summary = error?.summary;
  if (summary?.json) {
    console.error(JSON.stringify(summary, null, 2));
  } else if (summary) {
    console.error("");
    console.error("AgentMemory Codex CLI smoke: fail");
    console.error(error instanceof Error ? error.message : String(error));
    console.error(JSON.stringify(summary, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
