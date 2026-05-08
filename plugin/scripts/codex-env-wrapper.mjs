#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

//#region src/hooks/codex-env-wrapper.ts
const __dirname = dirname(fileURLToPath(import.meta.url));
function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const quote = trimmed[0];
	if (quote !== "\"" && quote !== "'" || trimmed.at(-1) !== quote) return trimmed;
	const inner = trimmed.slice(1, -1);
	if (quote === "'") return inner;
	return inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	").replace(/\\(["\\])/g, "$1");
}
function parseAgentmemoryEnv(path) {
	if (!existsSync(path)) return {};
	const loaded = {};
	const contents = readFileSync(path, "utf8");
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
		const eq = normalized.indexOf("=");
		if (eq <= 0) continue;
		const key = normalized.slice(0, eq).trim();
		if (!/^AGENTMEMORY_[A-Z0-9_]+$/.test(key)) continue;
		loaded[key] = unquote(normalized.slice(eq + 1));
	}
	return loaded;
}
function envFilePath() {
	const explicit = process.env["AGENTMEMORY_ENV_FILE"];
	if (explicit) return explicit;
	const home = process.env["HOME"];
	if (!home) return null;
	return join(home, ".agentmemory", ".env");
}
function hookNameFromScript(path) {
	const name = basename(path).replace(/\.mjs$/, "").replace(/\.js$/, "");
	return {
		"session-start": "SessionStart",
		"prompt-submit": "UserPromptSubmit",
		"pre-tool-use": "PreToolUse",
		"post-tool-use": "PostToolUse",
		"post-tool-failure": "PostToolUseFailure",
		"pre-compact": "PreCompact",
		"subagent-start": "SubagentStart",
		"subagent-stop": "SubagentStop",
		notification: "PermissionRequest",
		"task-completed": "TaskCompleted",
		stop: "Stop",
		"session-end": "SessionEnd"
	}[name] || name;
}
function parsePositiveInt(value) {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
const [scriptArg, ...scriptArgs] = process.argv.slice(2);
if (!scriptArg) {
	process.stderr.write("agentmemory Codex hook wrapper missing script argument\n");
	process.exit(1);
}
const targetScript = isAbsolute(scriptArg) ? scriptArg : join(__dirname, scriptArg);
const env = { ...process.env };
const filePath = envFilePath();
if (filePath) {
	const loaded = parseAgentmemoryEnv(filePath);
	for (const [key, value] of Object.entries(loaded)) env[key] = value;
}
const hookName = hookNameFromScript(targetScript);
const startedAt = Date.now();
let timedOut = false;
let diagnosticRecorded = false;
async function recordHookDiagnostic(status, details = {}) {
	if (diagnosticRecorded) return;
	diagnosticRecorded = true;
	const restUrl = env["AGENTMEMORY_URL"] || "http://localhost:3111";
	const headers = { "Content-Type": "application/json" };
	if (env["AGENTMEMORY_SECRET"]) headers["Authorization"] = `Bearer ${env["AGENTMEMORY_SECRET"]}`;
	try {
		await fetch(`${restUrl}/agentmemory/hooks/diagnostics`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				hookName,
				source: "codex-env-wrapper",
				status,
				latencyMs: Date.now() - startedAt,
				error: details.error,
				exitCode: details.exitCode,
				signal: details.signal,
				timestamp: (/* @__PURE__ */ new Date()).toISOString()
			}),
			signal: AbortSignal.timeout(750)
		});
	} catch {}
}
const child = spawn(process.execPath, [targetScript, ...scriptArgs], {
	env,
	stdio: "inherit"
});
const hookTimeoutMs = parsePositiveInt(env["AGENTMEMORY_HOOK_PROCESS_TIMEOUT_MS"]);
const timeout = hookTimeoutMs === null ? null : setTimeout(() => {
	timedOut = true;
	child.kill("SIGTERM");
}, hookTimeoutMs);
timeout?.unref();
child.on("error", async (error) => {
	if (timeout) clearTimeout(timeout);
	await recordHookDiagnostic("failure", { error: error.message });
	process.stderr.write(`agentmemory Codex hook wrapper failed: ${error.message}\n`);
	process.exit(1);
});
child.on("exit", async (code, signal) => {
	if (timeout) clearTimeout(timeout);
	await recordHookDiagnostic(timedOut ? "timeout" : code === 0 && !signal ? "success" : "failure", {
		error: signal ? `hook exited via ${signal}` : void 0,
		exitCode: code,
		signal
	});
	if (timedOut) process.exit(124);
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});

//#endregion
export {  };
//# sourceMappingURL=codex-env-wrapper.mjs.map