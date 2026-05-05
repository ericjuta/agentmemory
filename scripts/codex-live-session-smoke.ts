import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  runHook,
  startLocalService,
  type HookRun,
} from "../benchmark/codex-session-eval.js";

interface Service {
  url: string;
  secret: string;
}

function authHeaders(service: Service): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + service.secret,
  };
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

async function timedJson(
  service: Service,
  path: string,
  init: RequestInit = {},
): Promise<{ json: Record<string, unknown>; tookMs: number }> {
  const started = Date.now();
  const res = await fetch(service.url + path, {
    ...init,
    headers: { ...authHeaders(service), ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!res.ok) {
    throw new Error(path + " failed with HTTP " + String(res.status) + ": " + text.slice(0, 500));
  }
  return { json, tookMs: Date.now() - started };
}

function codexPayload(
  event: string,
  sessionId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd, ...extra });
}

function hookEnv(service: Service): Record<string, string> {
  return {
    AGENTMEMORY_ENV_FILE: join(process.cwd(), "does-not-exist.env"),
    AGENTMEMORY_INJECT_CONTEXT: "true",
    AGENTMEMORY_PROMPT_CONTEXT_BUDGET: "900",
    AGENTMEMORY_URL: service.url,
    AGENTMEMORY_SECRET: service.secret,
    AGENTMEMORY_HOOK_PROCESS_TIMEOUT_MS: "5000",
  };
}

function assertCodexContextJson(run: HookRun, eventName: string): string {
  if (!run.stdout.trim()) throw new Error(eventName + " did not emit context JSON");
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown };
    selectedObservationIds?: unknown;
    debugTrace?: unknown;
  };
  if (parsed.hookSpecificOutput?.hookEventName !== eventName) {
    throw new Error(eventName + " emitted wrong hookEventName");
  }
  if (typeof parsed.hookSpecificOutput.additionalContext !== "string") {
    throw new Error(eventName + " additionalContext is not a string");
  }
  if ("selectedObservationIds" in parsed || "debugTrace" in parsed) {
    throw new Error(eventName + " leaked debug/source fields into hook stdout");
  }
  return parsed.hookSpecificOutput.additionalContext;
}

function assertQuiet(run: HookRun, eventName: string): void {
  if (run.exitCode !== 0) throw new Error(eventName + " exited " + String(run.exitCode));
  if (run.stderr !== "") throw new Error(eventName + " wrote stderr: " + run.stderr.slice(0, 200));
  if (run.stdout !== "") throw new Error(eventName + " unexpectedly wrote stdout");
}

async function runIsolatedSmoke(): Promise<void> {
  const liveAgentmemory = join(homedir(), ".agentmemory");
  const liveBefore = existsSync(liveAgentmemory) ? statSync(liveAgentmemory).mtimeMs : null;
  const service = await startLocalService({ contextDebugIds: false });
  const project = join(service.home, "workspace", "codex-smoke-project");
  const env = hookEnv(service);
  const timings: Array<{ name: string; tookMs: number }> = [];
  try {
    if (service.home === homedir() || !service.statePath.startsWith(service.home + "/")) {
      throw new Error("isolated service did not use a temp HOME/state path");
    }

    await runHook("session-start.mjs", codexPayload("SessionStart", "codex_smoke_seed", project), env);
    await runHook("post-tool-use.mjs", codexPayload("PostToolUse", "codex_smoke_seed", project, {
      tool_name: "Bash",
      tool_input: { command: "printf codex-live-smoke-source" },
      tool_response: { output: "codex live smoke source id proof from native tool_response", exit_code: 0 },
    }), env);

    const startRun = await runHook("session-start.mjs", codexPayload("SessionStart", "codex_smoke_current", project), env);
    timings.push({ name: "SessionStart hook", tookMs: startRun.tookMs });
    const startContext = assertCodexContextJson(startRun, "SessionStart");
    if (!startContext.includes("codex live smoke source id proof")) {
      throw new Error("SessionStart context did not include seeded source fact");
    }

    const promptRun = await runHook("prompt-submit.mjs", codexPayload("UserPromptSubmit", "codex_smoke_current", project, {
      prompt: "Recall the codex live smoke source id proof.",
    }), env);
    timings.push({ name: "UserPromptSubmit hook", tookMs: promptRun.tookMs });
    assertCodexContextJson(promptRun, "UserPromptSubmit");

    const toolRun = await runHook("post-tool-use.mjs", codexPayload("PostToolUse", "codex_smoke_current", project, {
      tool_name: "Bash",
      tool_input: { command: "printf post-tool" },
      tool_response: { output: "post tool native response captured", exit_code: 0 },
    }), env);
    timings.push({ name: "PostToolUse hook", tookMs: toolRun.tookMs });
    assertQuiet(toolRun, "PostToolUse");

    const stopRun = await runHook("stop.mjs", codexPayload("Stop", "codex_smoke_current", project, {
      turn_id: "turn_smoke",
      model: "gpt-smoke",
      permission_mode: "default",
      stop_hook_active: false,
      last_assistant_message: "Smoke complete.",
    }), env);
    timings.push({ name: "Stop hook", tookMs: stopRun.tookMs });
    assertQuiet(stopRun, "Stop");

    const endpointStart = await timedJson(service, "/agentmemory/session/start", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "codex_smoke_timing",
        project,
        cwd: project,
      }),
    });
    timings.push({ name: "/session/start endpoint", tookMs: endpointStart.tookMs });

    const normalContext = await timedJson(service, "/agentmemory/context", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "codex_smoke_current",
        project,
        budget: 900,
      }),
    });
    timings.push({ name: "/context endpoint", tookMs: normalContext.tookMs });
    if ("debugTrace" in normalContext.json || "selectedObservationIds" in normalContext.json) {
      throw new Error("default /context leaked debug/source fields");
    }

    const debugContext = await timedJson(service, "/agentmemory/context", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "codex_smoke_current",
        project,
        budget: 900,
        includeRetrievalIds: true,
        debugTrace: true,
      }),
    });
    timings.push({ name: "/context debug endpoint", tookMs: debugContext.tookMs });
    const selectedIds = Array.isArray(debugContext.json.selectedObservationIds)
      ? debugContext.json.selectedObservationIds.filter((id): id is string => typeof id === "string")
      : [];
    const trace = debugContext.json.debugTrace as { blocks?: unknown } | undefined;
    const traceBlocks = Array.isArray(trace?.blocks) ? trace.blocks as Array<Record<string, unknown>> : [];
    if (selectedIds.length === 0) throw new Error("debug /context did not return selectedObservationIds");
    if (!traceBlocks.some((block) => (
      block.status === "selected" &&
      Array.isArray(block.sourceObservationIds) &&
      block.sourceObservationIds.length > 0
    ))) {
      throw new Error("debug trace did not include selected source observation IDs");
    }

    const replay = await timedJson(service, "/agentmemory/replay/load?sessionId=codex_smoke_current", { method: "GET" });
    const session = replay.json.session && typeof replay.json.session === "object"
      ? replay.json.session as { observationCount?: unknown; status?: unknown }
      : {};
    if (typeof session.observationCount !== "number" || session.observationCount < 3) {
      throw new Error("smoke session did not capture prompt/tool/stop observations");
    }
    if (session.status === "completed") {
      throw new Error("Stop incorrectly completed the live session");
    }

    const liveAfter = existsSync(liveAgentmemory) ? statSync(liveAgentmemory).mtimeMs : null;
    if (liveBefore !== liveAfter) {
      throw new Error("default smoke changed live ~/.agentmemory mtime");
    }

    process.stdout.write([
      "Codex live-session smoke: PASS",
      "mode: isolated",
      "temp_home: " + service.home,
      "temp_state: " + service.statePath,
      "project_cwd: " + project,
      "live_agentmemory_path_hash: " + hashPath(liveAgentmemory),
      "session_start_stdout_shape: hookSpecificOutput.additionalContext string",
      "normal_context_debug_trace: absent",
      "debug_selected_source_ids: " + String(selectedIds.length),
      "debug_trace_blocks: " + String(traceBlocks.length),
      "current_session_observations: " + String(session.observationCount),
      "timings:",
      ...timings.map((timing) => "- " + timing.name + ": " + String(timing.tookMs) + "ms"),
      "",
    ].join("\n"));
  } finally {
    await service.close();
  }
}

function readAgentmemoryEnv(): Record<string, string> {
  const envPath = process.env["AGENTMEMORY_ENV_FILE"] || join(homedir(), ".agentmemory", ".env");
  if (!existsSync(envPath)) return {};
  const loaded: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^AGENTMEMORY_[A-Z0-9_]+$/.test(key)) continue;
    loaded[key] = normalized.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return loaded;
}

async function runLiveReadonly(): Promise<void> {
  const loaded = readAgentmemoryEnv();
  const url = process.env["AGENTMEMORY_URL"] || loaded.AGENTMEMORY_URL || "http://127.0.0.1:3111";
  const secret = process.env["AGENTMEMORY_SECRET"] || loaded.AGENTMEMORY_SECRET || "";
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = "Bearer " + secret;
  const touched: string[] = [];
  const readFiles = [
    join(homedir(), ".agentmemory", ".env"),
    join(homedir(), ".codex", "hooks.json"),
  ].filter((path) => existsSync(path));
  for (const path of readFiles) touched.push("read file: " + path);
  const endpoints = ["/agentmemory/livez", "/agentmemory/health", "/agentmemory/hooks/diagnostics"];
  const results: string[] = [];
  for (const endpoint of endpoints) {
    const started = Date.now();
    try {
      const res = await fetch(url + endpoint, { headers, signal: AbortSignal.timeout(4000) });
      touched.push("GET " + url + endpoint);
      results.push(endpoint + ": HTTP " + String(res.status) + " in " + String(Date.now() - started) + "ms");
      await res.arrayBuffer();
    } catch (error) {
      results.push(endpoint + ": failed in " + String(Date.now() - started) + "ms: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  let hookConfig = "not found";
  const hooksPath = join(homedir(), ".codex", "hooks.json");
  if (existsSync(hooksPath)) {
    const raw = readFileSync(hooksPath, "utf8");
    const nativeEvents = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"];
    hookConfig = nativeEvents.filter((event) => raw.includes(event)).join(", ") || "no native event names found";
  }
  process.stdout.write([
    "Codex live-readonly diagnostic: PASS",
    "mode: live-readonly",
    "label: reads live host state only; does not execute hooks or POST write endpoints",
    "base_url: " + url,
    "hook_config_native_events: " + hookConfig,
    "results:",
    ...results.map((line) => "- " + line),
    "touched/read:",
    ...touched.map((line) => "- " + line),
    "",
  ].join("\n"));
}

if (process.argv.includes("--live-readonly")) {
  runLiveReadonly().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\n");
    process.exit(1);
  });
} else {
  runIsolatedSmoke().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\n");
    process.exit(1);
  });
}
