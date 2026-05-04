import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { HookDiagnostics } from "../types.js";

type HookDiagnosticStatus = "success" | "failure" | "timeout";

interface HookDiagnosticRecordInput {
  hookName: string;
  status: HookDiagnosticStatus;
  source?: string;
  latencyMs?: number;
  error?: string;
  exitCode?: number | null;
  signal?: string | null;
  timestamp?: string;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function cleanLatency(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function cleanExitCode(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value;
}

function cleanTimestamp(value: unknown): string {
  if (typeof value !== "string") return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function emptyRecord(input: {
  hookName: string;
  source?: string;
  now: string;
}): HookDiagnostics {
  return {
    hookName: input.hookName,
    source: input.source,
    attempts: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    firstSeenAt: input.now,
    lastAttemptAt: input.now,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    updatedAt: input.now,
  };
}

function applyRecord(
  existing: HookDiagnostics | null,
  input: Required<Pick<HookDiagnosticRecordInput, "hookName" | "status">> &
    Omit<HookDiagnosticRecordInput, "hookName" | "status"> & { timestamp: string },
): HookDiagnostics {
  const current = existing ?? emptyRecord({
    hookName: input.hookName,
    source: input.source,
    now: input.timestamp,
  });
  current.hookName = input.hookName;
  if (input.source) current.source = input.source;
  current.attempts += 1;
  current.lastAttemptAt = input.timestamp;
  current.updatedAt = input.timestamp;

  if (input.latencyMs !== undefined) {
    current.lastLatencyMs = input.latencyMs;
    current.totalLatencyMs += input.latencyMs;
    current.maxLatencyMs = Math.max(current.maxLatencyMs, input.latencyMs);
  }

  current.lastError = input.error;
  current.lastExitCode = input.exitCode;
  current.lastSignal = input.signal;

  if (input.status === "success") {
    current.successes += 1;
    current.lastSuccessAt = input.timestamp;
  } else if (input.status === "timeout") {
    current.timeouts += 1;
    current.lastTimeoutAt = input.timestamp;
    if (!current.lastError) current.lastError = "hook command timed out";
  } else {
    current.failures += 1;
    current.lastFailureAt = input.timestamp;
  }

  return current;
}

export function registerHookDiagnosticsFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::hook-diagnostics-record", async (data: HookDiagnosticRecordInput) => {
    const hookName = cleanString(data?.hookName, 120);
    const source = cleanString(data?.source, 120);
    const error = cleanString(data?.error, 1000);
    const latencyMs = cleanLatency(data?.latencyMs);
    const exitCode = cleanExitCode(data?.exitCode);
    const signal = data?.signal === null ? null : cleanString(data?.signal, 80);
    const timestamp = cleanTimestamp(data?.timestamp);

    if (!hookName) {
      return { success: false, error: "hookName is required" };
    }
    if (!["success", "failure", "timeout"].includes(data?.status)) {
      return { success: false, error: "status must be success, failure, or timeout" };
    }

    const diagnostic = await withKeyedLock(`hook-diagnostics:${hookName}`, async () => {
      const existing = await kv.get<HookDiagnostics>(KV.hookDiagnostics, hookName);
      const next = applyRecord(existing, {
        hookName,
        status: data.status,
        source,
        latencyMs,
        error,
        exitCode,
        signal,
        timestamp,
      });
      await kv.set(KV.hookDiagnostics, hookName, next);
      return next;
    });

    return { success: true, diagnostic };
  });

  sdk.registerFunction("mem::hook-diagnostics-list", async (data?: { hookName?: string }) => {
    const hookName = cleanString(data?.hookName, 120);
    const diagnostic = hookName
      ? await kv.get<HookDiagnostics>(KV.hookDiagnostics, hookName)
      : null;
    const diagnostics = hookName
      ? diagnostic
        ? [diagnostic]
        : []
      : await kv.list<HookDiagnostics>(KV.hookDiagnostics);
    const hooks = diagnostics
      .filter((d): d is HookDiagnostics => Boolean(d))
      .sort((a, b) => b.lastAttemptAt.localeCompare(a.lastAttemptAt));
    const summary = hooks.reduce(
      (acc, hook) => {
        acc.attempts += hook.attempts;
        acc.successes += hook.successes;
        acc.failures += hook.failures;
        acc.timeouts += hook.timeouts;
        return acc;
      },
      { attempts: 0, successes: 0, failures: 0, timeouts: 0 },
    );
    return { success: true, hooks, summary };
  });
}
