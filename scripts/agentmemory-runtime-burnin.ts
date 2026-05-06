import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface BurninConfig {
  url: string;
  secret?: string;
  samples: number;
  intervalMs: number;
  warnRssGrowthMb: number;
  failRssGrowthMb: number;
  warnKvLatencyMs: number;
  failKvLatencyMs: number;
  failHookErrors: number;
  json: boolean;
}

export interface BurninSample {
  index: number;
  timestamp: string;
  healthStatus: string;
  healthHttpMs: number;
  diagnosticsHttpMs: number;
  rssMb: number;
  heapUsedMb: number;
  eventLoopLagMs: number;
  cpuPercent: number;
  kvStatus: string;
  kvLatencyMs: number | null;
  activeInvocations: number;
  workerCount: number;
  functionMetricCalls: number;
  hookAttempts: number;
  hookFailures: number;
  hookTimeouts: number;
  hookMaxLatencyMs: number;
  alerts: string[];
  notes: string[];
}

export interface BurninSummary {
  passed: boolean;
  warnings: string[];
  failures: string[];
  sampleCount: number;
  rssStartMb: number;
  rssEndMb: number;
  rssPeakMb: number;
  rssGrowthMb: number;
  maxKvLatencyMs: number;
  maxActiveInvocations: number;
  hookFailureDelta: number;
  hookTimeoutDelta: number;
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
    loaded[key] = normalized.slice(eq + 1).trim().replace(/^[\"']|[\"']$/g, "");
  }
  return loaded;
}

function numberOption(args: string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw) throw new Error(name + " requires a value");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(name + " must be a finite number");
  return parsed;
}

function stringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw) throw new Error(name + " requires a value");
  return raw;
}

export function parseBurninArgs(
  args = process.argv.slice(2),
  env = process.env,
): BurninConfig {
  const loaded = readAgentmemoryEnv();
  const samples = numberOption(args, "--samples") ?? 12;
  const intervalMs = numberOption(args, "--interval-ms") ?? 5000;
  const warnRssGrowthMb = numberOption(args, "--warn-rss-growth-mb") ?? 128;
  const failRssGrowthMb = numberOption(args, "--fail-rss-growth-mb") ?? 256;
  const warnKvLatencyMs = numberOption(args, "--warn-kv-latency-ms") ?? 250;
  const failKvLatencyMs = numberOption(args, "--fail-kv-latency-ms") ?? 1000;
  const failHookErrors = numberOption(args, "--fail-hook-errors") ?? 0;
  if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("--interval-ms must be a non-negative integer");
  if (failRssGrowthMb < warnRssGrowthMb) throw new Error("--fail-rss-growth-mb must be >= --warn-rss-growth-mb");
  if (failKvLatencyMs < warnKvLatencyMs) throw new Error("--fail-kv-latency-ms must be >= --warn-kv-latency-ms");
  if (!Number.isInteger(failHookErrors) || failHookErrors < 0) throw new Error("--fail-hook-errors must be a non-negative integer");
  return {
    url: stringOption(args, "--url") || env["AGENTMEMORY_URL"] || loaded.AGENTMEMORY_URL || "http://127.0.0.1:3111",
    secret: stringOption(args, "--secret") || env["AGENTMEMORY_SECRET"] || loaded.AGENTMEMORY_SECRET,
    samples,
    intervalMs,
    warnRssGrowthMb,
    failRssGrowthMb,
    warnKvLatencyMs,
    failKvLatencyMs,
    failHookErrors,
    json: args.includes("--json"),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numericValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function activeInvocationCount(workers: unknown): number {
  if (!Array.isArray(workers)) return 0;
  return workers.reduce((sum, worker) => {
    const activeInvocations = objectValue(worker).active_invocations;
    if (typeof activeInvocations === "number" && Number.isFinite(activeInvocations)) {
      return sum + Math.max(0, Math.trunc(activeInvocations));
    }
    const status = objectValue(worker).status;
    return sum + (
      typeof status === "string" && ["active", "running", "busy", "executing"].includes(status.toLowerCase())
        ? 1
        : 0
    );
  }, 0);
}

function totalFunctionMetricCalls(metrics: unknown): number {
  if (!Array.isArray(metrics)) return 0;
  return metrics.reduce((sum, metric) => sum + numericValue(objectValue(metric).totalCalls), 0);
}

async function timedJson(
  url: string,
  path: string,
  headers: Record<string, string>,
  allowHttpErrorBody = false,
): Promise<{ json: Record<string, unknown>; tookMs: number }> {
  const started = Date.now();
  const res = await fetch(url + path, { headers, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  const tookMs = Date.now() - started;
  if (!res.ok && !allowHttpErrorBody) {
    throw new Error(path + " failed with HTTP " + String(res.status) + ": " + text.slice(0, 400));
  }
  return { json: text ? JSON.parse(text) as Record<string, unknown> : {}, tookMs };
}

async function collectSample(config: BurninConfig, index: number): Promise<BurninSample> {
  const headers: Record<string, string> = {};
  if (config.secret) headers.Authorization = "Bearer " + config.secret;
  const [healthResult, diagnosticsResult] = await Promise.all([
    timedJson(config.url, "/agentmemory/health", headers, true),
    timedJson(config.url, "/agentmemory/hooks/diagnostics", headers),
  ]);
  const health = objectValue(healthResult.json.health);
  const memory = objectValue(health.memory);
  const cpu = objectValue(health.cpu);
  const kv = objectValue(health.kvConnectivity);
  const diagnosticsSummary = objectValue(diagnosticsResult.json.summary);
  const hooks = Array.isArray(diagnosticsResult.json.hooks) ? diagnosticsResult.json.hooks : [];
  const hookMaxLatencyMs = hooks.reduce((max, hook) => Math.max(max, numericValue(objectValue(hook).maxLatencyMs)), 0);
  return {
    index,
    timestamp: new Date().toISOString(),
    healthStatus: typeof healthResult.json.status === "string" ? healthResult.json.status : "unknown",
    healthHttpMs: healthResult.tookMs,
    diagnosticsHttpMs: diagnosticsResult.tookMs,
    rssMb: Math.round((numericValue(memory.rss) / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((numericValue(memory.heapUsed) / 1024 / 1024) * 10) / 10,
    eventLoopLagMs: Math.round(numericValue(health.eventLoopLagMs) * 100) / 100,
    cpuPercent: Math.round(numericValue(cpu.percent) * 100) / 100,
    kvStatus: typeof kv.status === "string" ? kv.status : "unknown",
    kvLatencyMs: typeof kv.latencyMs === "number" && Number.isFinite(kv.latencyMs) ? kv.latencyMs : null,
    activeInvocations: activeInvocationCount(health.workers),
    workerCount: Array.isArray(health.workers) ? health.workers.length : 0,
    functionMetricCalls: totalFunctionMetricCalls(healthResult.json.functionMetrics),
    hookAttempts: numericValue(diagnosticsSummary.attempts),
    hookFailures: numericValue(diagnosticsSummary.failures),
    hookTimeouts: numericValue(diagnosticsSummary.timeouts),
    hookMaxLatencyMs,
    alerts: stringArray(health.alerts),
    notes: stringArray(health.notes),
  };
}

export function summarizeBurnin(samples: BurninSample[], config: BurninConfig): BurninSummary {
  if (samples.length === 0) throw new Error("at least one sample is required");
  const first = samples[0];
  const last = samples[samples.length - 1];
  const rssPeakMb = Math.max(...samples.map((sample) => sample.rssMb));
  const rssGrowthMb = Math.round((last.rssMb - first.rssMb) * 10) / 10;
  const maxKvLatencyMs = Math.max(...samples.map((sample) => sample.kvLatencyMs ?? 0));
  const maxActiveInvocations = Math.max(...samples.map((sample) => sample.activeInvocations));
  const rawHookFailureDelta = last.hookFailures - first.hookFailures;
  const rawHookTimeoutDelta = last.hookTimeouts - first.hookTimeouts;
  const hookFailureDelta = Math.max(0, rawHookFailureDelta);
  const hookTimeoutDelta = Math.max(0, rawHookTimeoutDelta);
  const warnings: string[] = [];
  const failures: string[] = [];

  for (const sample of samples) {
    if (sample.healthStatus === "critical") failures.push("sample " + String(sample.index) + " health status critical");
    else if (sample.healthStatus !== "healthy") warnings.push("sample " + String(sample.index) + " health status " + sample.healthStatus);
    if (sample.kvStatus !== "ok") failures.push("sample " + String(sample.index) + " kv status " + sample.kvStatus);
    for (const alert of sample.alerts) warnings.push("sample " + String(sample.index) + " alert " + alert);
  }

  if (rssGrowthMb > config.failRssGrowthMb) failures.push("rss_growth_mb " + rssGrowthMb.toFixed(1) + " exceeds fail " + config.failRssGrowthMb.toFixed(1));
  else if (rssGrowthMb > config.warnRssGrowthMb) warnings.push("rss_growth_mb " + rssGrowthMb.toFixed(1) + " exceeds warn " + config.warnRssGrowthMb.toFixed(1));
  if (maxKvLatencyMs > config.failKvLatencyMs) failures.push("kv_latency_ms " + maxKvLatencyMs.toFixed(1) + " exceeds fail " + config.failKvLatencyMs.toFixed(1));
  else if (maxKvLatencyMs > config.warnKvLatencyMs) warnings.push("kv_latency_ms " + maxKvLatencyMs.toFixed(1) + " exceeds warn " + config.warnKvLatencyMs.toFixed(1));
  if (rawHookFailureDelta < 0 || rawHookTimeoutDelta < 0) {
    warnings.push("hook diagnostics counters decreased during burn-in; runtime likely restarted");
  }
  if (hookFailureDelta + hookTimeoutDelta > config.failHookErrors) {
    failures.push("hook_error_delta " + String(hookFailureDelta + hookTimeoutDelta) + " exceeds fail " + String(config.failHookErrors));
  }

  return {
    passed: failures.length === 0,
    warnings,
    failures,
    sampleCount: samples.length,
    rssStartMb: first.rssMb,
    rssEndMb: last.rssMb,
    rssPeakMb,
    rssGrowthMb,
    maxKvLatencyMs,
    maxActiveInvocations,
    hookFailureDelta,
    hookTimeoutDelta,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSummary(config: BurninConfig, samples: BurninSample[], summary: BurninSummary): string {
  return [
    "agentmemory runtime burn-in: " + (summary.passed ? "PASS" : "FAIL"),
    "mode: live-readonly",
    "label: samples GET /agentmemory/health and GET /agentmemory/hooks/diagnostics only",
    "base_url: " + config.url,
    "samples: " + String(summary.sampleCount) + " interval_ms: " + String(config.intervalMs),
    "rss_mb: start " + summary.rssStartMb.toFixed(1) + " end " + summary.rssEndMb.toFixed(1) + " peak " + summary.rssPeakMb.toFixed(1) + " growth " + summary.rssGrowthMb.toFixed(1),
    "kv_latency_ms_max: " + summary.maxKvLatencyMs.toFixed(1),
    "active_invocations_max: " + String(summary.maxActiveInvocations),
    "hook_delta: failures " + String(summary.hookFailureDelta) + " timeouts " + String(summary.hookTimeoutDelta),
    "warnings:",
    ...(summary.warnings.length ? summary.warnings.map((warning) => "- " + warning) : ["- none"]),
    "failures:",
    ...(summary.failures.length ? summary.failures.map((failure) => "- " + failure) : ["- none"]),
    "sample_table:",
    "| # | status | rss MB | kv ms | active | hooks fail/timeout | health ms | diag ms |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...samples.map((sample) => "| " + String(sample.index) + " | " + sample.healthStatus + " | " + sample.rssMb.toFixed(1) + " | " + (sample.kvLatencyMs === null ? "-" : sample.kvLatencyMs.toFixed(1)) + " | " + String(sample.activeInvocations) + " | " + String(sample.hookFailures) + "/" + String(sample.hookTimeouts) + " | " + String(sample.healthHttpMs) + " | " + String(sample.diagnosticsHttpMs) + " |"),
    "",
  ].join("\n");
}

export async function runBurnin(config: BurninConfig): Promise<{ samples: BurninSample[]; summary: BurninSummary }> {
  const samples: BurninSample[] = [];
  for (let index = 1; index <= config.samples; index += 1) {
    samples.push(await collectSample(config, index));
    if (index < config.samples && config.intervalMs > 0) await sleep(config.intervalMs);
  }
  return { samples, summary: summarizeBurnin(samples, config) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const config = parseBurninArgs();
  runBurnin(config).then(({ samples, summary }) => {
    if (config.json) {
      process.stdout.write(JSON.stringify({ config: { ...config, secret: config.secret ? "[redacted]" : undefined }, summary, samples }, null, 2) + "\n");
    } else {
      process.stdout.write(formatSummary(config, samples, summary));
    }
    if (!summary.passed) process.exit(1);
  }).catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\n");
    process.exit(1);
  });
}
