#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) {
    return trimmed;
  }
  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\(["\\])/g, "$1");
}

function parseAgentmemoryEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const loaded: Record<string, string> = {};
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

function envFilePath(): string | null {
  const explicit = process.env["AGENTMEMORY_ENV_FILE"];
  if (explicit) return explicit;
  const home = process.env["HOME"];
  if (!home) return null;
  return join(home, ".agentmemory", ".env");
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
  for (const [key, value] of Object.entries(loaded)) {
    if (env[key] === undefined) env[key] = value;
  }
}

const child = spawn(process.execPath, [targetScript, ...scriptArgs], {
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`agentmemory Codex hook wrapper failed: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
