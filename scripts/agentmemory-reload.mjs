import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111";
const logPath = "/tmp/agentmemory-cli.log";
const startupTimeoutMs = Number(process.env.AGENTMEMORY_RELOAD_TIMEOUT_MS || 180_000);
const skipBuild = process.argv.includes("--skip-build");
const runtimePatterns = [
  "^node dist/cli\\.mjs --verbose$",
  "^node dist/index\\.mjs$",
  "^/home/ericjuta/.local/bin/iii --config .*/agentmemory/dist/iii-config\\.yaml$",
];

function envSecret() {
  if (process.env.AGENTMEMORY_SECRET) return process.env.AGENTMEMORY_SECRET;
  const envPath = join(homedir(), ".agentmemory", ".env");
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith("AGENTMEMORY_SECRET="));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(command + " " + args.join(" ") + " exited " + String(code)));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new Error(command + " " + args.join(" ") + " exited " + String(code) + (stderr ? ": " + stderr : "")));
    });
  });
}

async function stopRuntime() {
  const pidFile = "/tmp/agentmemory-cli.pid";
  const pids = new Set();
  for (const pattern of runtimePatterns) {
    const output = await runCapture("pgrep", ["-f", pattern]);
    for (const rawPid of output.split(/\s+/)) {
      const pid = Number.parseInt(rawPid, 10);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.size === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function probe(path, secret) {
  const headers = secret ? { Authorization: "Bearer " + secret } : {};
  const res = await fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(2500) });
  const text = await res.text();
  if (!res.ok) throw new Error(path + " HTTP " + String(res.status) + (text ? ": " + text.slice(0, 240) : ""));
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function connectedWorkerState(health) {
  const snapshot = health && typeof health === "object" ? health.health : null;
  if (!snapshot || typeof snapshot !== "object") return false;
  if (snapshot.connectionState !== "connected") return false;
  const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
  return workers.length === 0 || workers.some((worker) => {
    if (!worker || typeof worker !== "object") return false;
    const values = Object.values(worker).map((value) => String(value).toLowerCase());
    return values.some((value) => value.includes("connected") || value.includes("running") || value.includes("ready"));
  });
}

function tailLog() {
  if (!existsSync(logPath)) return "";
  return readFileSync(logPath, "utf8").split(/\r?\n/).slice(-80).join("\n");
}

async function waitForReady() {
  const secret = envSecret();
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = "";
  let livezOk = false;
  while (Date.now() < deadline) {
    try {
      await probe("/agentmemory/livez", "");
      livezOk = true;
      const health = await probe("/agentmemory/health", secret);
      if (health.status === "healthy" && connectedWorkerState(health)) {
        console.log("agentmemory reload confirmed: /agentmemory/health healthy; worker-manager connection connected.");
        return;
      }
      const connection = health.health && typeof health.health === "object" ? health.health.connectionState : "missing";
      lastError = "health status=" + String(health.status) + " connectionState=" + String(connection);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, livezOk ? 1000 : 500));
  }
  throw new Error(
    "agentmemory reload timed out waiting for /agentmemory/health and connected worker state: " +
    lastError +
    "\nRecent startup log:\n" +
    tailLog(),
  );
}

if (!skipBuild) {
  await stopRuntime();
  await run("npm", ["run", "build"]);
}
await run("npm", ["run", "agentmemory:restart"]);
await waitForReady();
await run("npm", ["run", "agentmemory:status"]);
await run("npm", ["run", "agentmemory:verify"]);
