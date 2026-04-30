import type { ISdk } from "iii-sdk";

import { getLatestHealth } from "../health/monitor.js";
import type { StateKV } from "../state/kv.js";

type Payload = {
  project?: unknown;
  cwd?: unknown;
  branch?: unknown;
  query?: unknown;
  sessionId?: unknown;
  contextBudget?: unknown;
  searchLimit?: unknown;
  latencyTargetsMs?: unknown;
};

type CheckStatus = "pass" | "warn" | "fail";

type StepResult = {
  status: CheckStatus;
  httpStatus?: number;
  latencyMs: number;
  error?: string;
  details: Record<string, unknown>;
};

type ContextStatus = "full" | "degraded" | "empty";

const DEFAULT_CODEX_PROJECT = "/home/ericjuta/.openclaw/workspace/repos/codex";
const DEFAULT_QUERY =
  "Codex agentmemory integration startup context handoff recall current project state";

const DEFAULT_TARGETS = {
  sessionStart: 1000,
  context: 2000,
  smartSearch: 1500,
};

const DEFAULT_STEP_TIMEOUT_MS = 4000;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), max);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, max);
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latencyTargets(value: unknown): typeof DEFAULT_TARGETS {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TARGETS;
  }
  const record = value as Record<string, unknown>;
  return {
    sessionStart: positiveInteger(
      record.sessionStart,
      DEFAULT_TARGETS.sessionStart,
      60000,
    ),
    context: positiveInteger(record.context, DEFAULT_TARGETS.context, 60000),
    smartSearch: positiveInteger(
      record.smartSearch,
      DEFAULT_TARGETS.smartSearch,
      60000,
    ),
  };
}

function statusFor(success: boolean, latencyMs: number, targetMs: number): CheckStatus {
  if (!success) return "fail";
  return latencyMs > targetMs ? "warn" : "pass";
}

async function timed<T>(fn: () => Promise<T>): Promise<{ latencyMs: number; value?: T; error?: string }> {
  const started = Date.now();
  try {
    const value = await fn();
    return { latencyMs: Date.now() - started, value };
  } catch (error) {
    return { latencyMs: Date.now() - started, error: errorMessage(error) };
  }
}

async function timedBounded<T>(
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
): Promise<{ latencyMs: number; value?: T; error?: string }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return timed(() =>
    Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`step_timeout_after_${timeoutMs}ms`)),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function textLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

function stringDetail(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stepFromTrigger(
  result: { latencyMs: number; value?: unknown; error?: string },
  targetMs: number,
  success: (value: Record<string, unknown>) => boolean,
  details: (value: Record<string, unknown>) => Record<string, unknown>,
): StepResult {
  if (result.error) {
    return {
      status: "fail",
      latencyMs: result.latencyMs,
      error: result.error,
      details: {},
    };
  }
  const value = isRecord(result.value) ? result.value : {};
  const ok = success(value);
  return {
    status: statusFor(ok, result.latencyMs, targetMs),
    latencyMs: result.latencyMs,
    details: details(value),
  };
}

function passFromSteps(steps: Record<string, StepResult>): boolean {
  return Object.values(steps).every((step) => step.status !== "fail");
}

function sessionStarted(step: StepResult): boolean {
  return step.status !== "fail" || step.error?.startsWith("step_timeout_after_");
}

function latencyWarnings(steps: Record<string, StepResult>): string[] {
  return Object.entries(steps)
    .filter(([, step]) => step.status === "warn")
    .map(([name]) => name);
}

function blockCount(value: Record<string, unknown>): number | undefined {
  return typeof value.blocks === "number"
    ? value.blocks
    : arrayLength(value.blocks) ?? arrayLength(value.items);
}

function contextStatus(value: Record<string, unknown>): ContextStatus {
  const chars = textLength(value.context) ?? 0;
  if (chars <= 0) return "empty";
  return value.degraded === true || typeof value.fallback === "string"
    ? "degraded"
    : "full";
}

function contextDataAvailable(value: Record<string, unknown>): boolean {
  return (
    (textLength(value.context) ?? 0) > 0 ||
    (blockCount(value) ?? 0) > 0 ||
    (numberValue(value.tokens) ?? 0) > 0
  );
}

function pressureReason(value: Record<string, unknown>): string | undefined {
  const pressure = isRecord(value.pressure) ? value.pressure : {};
  return stringDetail(pressure.reason) ?? stringDetail(value.reason);
}

function contextDetails(
  value: Record<string, unknown>,
  healthRecord: { status?: string; observeCapture?: unknown } | null,
): Record<string, unknown> {
  const pressure = isRecord(value.pressure) ? value.pressure : {};
  const observeCapture = isRecord(value.observeCapture)
    ? value.observeCapture
    : isRecord(pressure.observeCapture)
      ? pressure.observeCapture
      : healthRecord?.observeCapture;
  return {
    chars: textLength(value.context),
    tokens: numberValue(value.tokens),
    blocks: blockCount(value),
    tracePresent: Boolean(value.trace),
    contextStatus: contextStatus(value),
    fallback: stringDetail(value.fallback),
    degraded: value.degraded === true,
    pressureReason: pressureReason(value),
    pressure,
    runtimeStatus:
      stringDetail(value.runtimeStatus) ??
      stringDetail(pressure.runtimeStatus) ??
      healthRecord?.status,
    observeCapture,
    observeCaptureStatus: isRecord(observeCapture)
      ? stringDetail(observeCapture.status)
      : undefined,
    ageMs: numberValue(value.ageMs),
  };
}

export function registerCodexIntegrationProofFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::codex-integration-proof", async (payload: Payload = {}) => {
    const project = stringValue(payload.project) || stringValue(payload.cwd) || DEFAULT_CODEX_PROJECT;
    const cwd = stringValue(payload.cwd) || project;
    const branch = stringValue(payload.branch);
    const query = stringValue(payload.query) || DEFAULT_QUERY;
    const sessionId =
      stringValue(payload.sessionId) || `codex-integration-proof-${Date.now()}`;
    const contextBudget = positiveInteger(payload.contextBudget, 8000, 50000);
    const searchLimit = positiveInteger(payload.searchLimit, 5, 10);
    const targets = latencyTargets(payload.latencyTargetsMs);
    const generatedAt = new Date().toISOString();

    const health = await getLatestHealth(kv).catch(() => null);
    const healthRecord = health as
      | {
          status?: string;
          alerts?: unknown[];
          eventLoopLagMs?: number;
          kvConnectivity?: { status?: string; latencyMs?: number };
          observeCapture?: { status?: string };
        }
      | null;

    const sessionStart = stepFromTrigger(
      await timedBounded(() =>
        sdk.trigger("api::session::start", {
          body: { sessionId, project, cwd, ...(branch ? { branch } : {}) },
          headers: {},
        }),
      ),
      targets.sessionStart,
      (value) => {
        const body = isRecord(value.body) ? value.body : value;
        return (
          (value.status_code === 200 || value.status === 200 || value.status_code === undefined) &&
          isRecord(body.session) &&
          typeof body.context === "string" &&
          isRecord(body.bootstrap)
        );
      },
      (value) => {
        const body = isRecord(value.body) ? value.body : value;
        const bootstrap = isRecord(body.bootstrap) ? body.bootstrap : {};
        return {
          envelope: Object.keys(body).filter((key) =>
            ["bootstrap", "context", "session"].includes(key),
          ),
          contextChars: textLength(body.context),
          bootstrapKeys: Object.keys(bootstrap),
          latestHandoffPresent: Boolean(bootstrap.latestHandoff),
          warnings: Array.isArray(bootstrap.warnings) ? bootstrap.warnings : [],
        };
      },
    );

    const context = stepFromTrigger(
      await timedBounded(() =>
        sdk.trigger({
          function_id: "mem::context",
          payload: {
            sessionId,
            project,
            ...(branch ? { branch } : {}),
            query,
            budget: contextBudget,
            intent: "manual_recall",
          },
        }),
      ),
      targets.context,
      (value) => contextStatus(value) !== "empty" && contextDataAvailable(value),
      (value) => contextDetails(value, healthRecord),
    );
    if (
      context.status === "pass" &&
      context.details.contextStatus === "degraded"
    ) {
      context.status = "warn";
    }

    const smartSearch = stepFromTrigger(
      await timedBounded(() =>
        sdk.trigger({
          function_id: "mem::smart-search",
          payload: {
            project,
            ...(branch ? { branch } : {}),
            query,
            limit: searchLimit,
          },
        }),
      ),
      targets.smartSearch,
      (value) => Array.isArray(value.results) && value.results.length > 0,
      (value) => ({
        results: arrayLength(value.results),
        mode: typeof value.mode === "string" ? value.mode : undefined,
      }),
    );

    const retrievalProof = await timedBounded(() =>
      sdk.trigger({
        function_id: "mem::retrieval-proof",
        payload: {
          project,
          ...(branch ? { branch } : {}),
          query,
          limit: searchLimit,
          includeSearch: false,
        },
      }),
    );
    const retrievalRecord = isRecord(retrievalProof.value) ? retrievalProof.value : {};
    const retrievalMaintenance = isRecord(retrievalRecord.maintenance)
      ? retrievalRecord.maintenance
      : {};
    const retrievalStep: StepResult = retrievalProof.error
      ? {
          status: "fail",
          latencyMs: retrievalProof.latencyMs,
          error: retrievalProof.error,
          details: {},
        }
      : {
          status: retrievalRecord.pass === false ? "warn" : "pass",
          latencyMs: retrievalProof.latencyMs,
          details: {
            pass: retrievalRecord.pass,
            maintenanceStatus: retrievalMaintenance.status,
            queuedCount: retrievalMaintenance.queuedCount,
            blockingQueuedCount: retrievalMaintenance.blockingQueuedCount,
          },
        };

    const steps = { sessionStart, context, smartSearch, retrievalProof: retrievalStep };
    const warnings = [
      ...latencyWarnings(steps).map((name) => `latency_${name}`),
      ...(context.details.contextStatus === "degraded" ? ["context_degraded"] : []),
      ...(retrievalStep.status === "warn" ? ["retrieval_proof_warning"] : []),
    ];

    return {
      success: true,
      generatedAt,
      project,
      branch,
      sessionId,
      targetsMs: targets,
      pass: passFromSteps(steps),
      contractPass: sessionStarted(sessionStart),
      qualityPass: context.status !== "fail" && smartSearch.status !== "fail",
      latencyWarnings: latencyWarnings(steps),
      warnings,
      health: {
        status: healthRecord?.status ?? "unknown",
        alerts: healthRecord?.alerts ?? [],
        eventLoopLagMs: healthRecord?.eventLoopLagMs,
        kvStatus: healthRecord?.kvConnectivity?.status,
        kvLatencyMs: healthRecord?.kvConnectivity?.latencyMs,
        observeCaptureStatus: healthRecord?.observeCapture?.status,
      },
      steps,
    };
  });
}
