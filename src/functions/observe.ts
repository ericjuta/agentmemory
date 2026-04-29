// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";
import type {
  HookPayload,
  HookType,
  ObservationPersistenceClass,
  ObserveReceipt,
  ObservePressureState,
  RawObservation,
} from "../types.js";
import { KV, STREAM, fingerprintId, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex } from "./search.js";
import { logger } from "../logger.js";
import { getLlmWorkPauseReason } from "../health/write-gate.js";
import { enqueueCompressionRetry } from "./compress.js";
import {
  upsertTurnCapsuleFromCompressed,
  upsertTurnCapsuleFromRaw,
} from "./turn-capsules.js";
import type { CompressionTracker } from "../state/compression-tracker.js";
import { indexCompressedObservation } from "../state/observation-indexing.js";
import { upsertObservationRetrievalBlock } from "./retrieval-blocks.js";
import {
  getObserveHotPathPressure,
  type ObserveHotPathPressure,
} from "./hot-path-pressure.js";

const SUPPORTED_HOOK_TYPES = new Set<HookType>([
  "session_start",
  "prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "post_tool_failure",
  "assistant_result",
  "pre_compact",
  "subagent_start",
  "subagent_stop",
  "notification",
  "task_completed",
  "stop",
  "session_end",
]);

const NATIVE_SOURCE = "codex-native";
const SUPPORTED_NATIVE_PAYLOAD_VERSIONS = new Set(["1"]);
const NATIVE_REQUIRED_DATA_FIELDS: Partial<Record<HookType, readonly string[]>> =
  {
    session_start: ["session_id", "cwd", "model"],
    prompt_submit: ["session_id", "turn_id", "cwd", "model", "prompt"],
    pre_tool_use: [
      "session_id",
      "turn_id",
      "cwd",
      "model",
      "tool_name",
      "tool_use_id",
      "tool_input",
    ],
    post_tool_use: [
      "session_id",
      "turn_id",
      "cwd",
      "model",
      "tool_name",
      "tool_use_id",
      "tool_input",
      "tool_output",
    ],
    post_tool_failure: [
      "session_id",
      "turn_id",
      "cwd",
      "model",
      "tool_name",
      "tool_use_id",
      "tool_input",
      "error",
    ],
    assistant_result: [
      "session_id",
      "turn_id",
      "cwd",
      "model",
      "assistant_text",
      "is_final",
    ],
  };

type ObserveMetadata = {
  source?: string;
  payloadVersion?: string;
  eventId?: string;
  sourceTimestamp?: string;
  capabilities?: string[];
  persistenceClass: ObservationPersistenceClass;
};

const OPERATOR_DIAGNOSTIC_ENDPOINTS = [
  "/agentmemory/health",
  "/agentmemory/livez",
  "/agentmemory/retrieval-proof",
  "/agentmemory/retrieval-blocks/diagnostics",
  "/agentmemory/retrieval-index/verify",
  "/agentmemory/retrieval-vector/backfill",
  "/agentmemory/retrieval-blocks/retry",
  "/agentmemory/compress-retry",
];

const OPERATOR_DIAGNOSTIC_PATTERNS = [
  /docker\s+compose\s+(?:ps|logs)\b/i,
  /git\s+status\s+--short\s+--branch\b/i,
  /git\s+log\s+--oneline\b/i,
];

function bestEffortTrigger(
  sdk: ISdk,
  functionId: string,
  payload: unknown,
): void {
  void sdk.trigger({
    function_id: functionId,
    payload,
  }).catch(() => {});
}

const OBSERVE_PRESSURE_KEY = "latest";
let inProcessObservePressureState: ObservePressureState | null = null;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed: string[] = [];
  for (const entry of value) {
    const str = asNonEmptyString(entry);
    if (!str) return null;
    parsed.push(str);
  }
  return parsed;
}

function asPersistenceClass(
  value: unknown,
): ObservationPersistenceClass | undefined {
  if (
    value === "persistent" ||
    value === "ephemeral" ||
    value === "diagnostics_only"
  ) {
    return value;
  }
  return undefined;
}

function stringifyForDiagnosticScan(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isOperatorDiagnosticObservation(payload: HookPayload): boolean {
  if (
    payload.hookType !== "pre_tool_use" &&
    payload.hookType !== "post_tool_use" &&
    payload.hookType !== "post_tool_failure"
  ) {
    return false;
  }
  const data =
    typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : {};
  const toolName = asNonEmptyString(data["tool_name"])?.toLowerCase() || "";
  const toolInput = stringifyForDiagnosticScan(data["tool_input"]).slice(0, 20_000);
  const haystack = `${toolName}\n${toolInput}`.toLowerCase();
  if (!haystack.trim()) return false;
  if (OPERATOR_DIAGNOSTIC_ENDPOINTS.some((endpoint) => haystack.includes(endpoint))) {
    return true;
  }
  return OPERATOR_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(haystack));
}

function normalizeObserveMetadata(
  payload: HookPayload,
):
  | { ok: true; metadata: ObserveMetadata }
  | { ok: false; error: string } {
  const record = payload as HookPayload & Record<string, unknown>;
  const sourceRaw = payload.source ?? record["source"];
  const payloadVersionRaw =
    payload.payloadVersion ?? record["payloadVersion"] ?? record["payload_version"];
  const eventIdRaw = payload.eventId ?? record["eventId"] ?? record["event_id"];
  const sourceTimestampRaw =
    payload.sourceTimestamp ??
    record["sourceTimestamp"] ??
    record["source_timestamp"];
  const capabilitiesRaw = payload.capabilities ?? record["capabilities"];
  const persistenceClassRaw =
    payload.persistenceClass ??
    record["persistenceClass"] ??
    record["persistence_class"];

  const source =
    sourceRaw === undefined ? undefined : asNonEmptyString(sourceRaw);
  if (sourceRaw !== undefined && !source) {
    return {
      ok: false,
      error: "Invalid payload: source must be a non-empty string when provided",
    };
  }

  const payloadVersion =
    payloadVersionRaw === undefined
      ? undefined
      : asNonEmptyString(payloadVersionRaw);
  if (payloadVersionRaw !== undefined && !payloadVersion) {
    return {
      ok: false,
      error:
        "Invalid payload: payloadVersion must be a non-empty string when provided",
    };
  }

  const eventId =
    eventIdRaw === undefined ? undefined : asNonEmptyString(eventIdRaw);
  if (eventIdRaw !== undefined && !eventId) {
    return {
      ok: false,
      error: "Invalid payload: eventId must be a non-empty string when provided",
    };
  }

  const sourceTimestamp =
    sourceTimestampRaw === undefined
      ? undefined
      : asNonEmptyString(sourceTimestampRaw);
  if (sourceTimestampRaw !== undefined && !sourceTimestamp) {
    return {
      ok: false,
      error:
        "Invalid payload: sourceTimestamp must be a non-empty string when provided",
    };
  }

  const capabilities = asStringArray(capabilitiesRaw);
  if (capabilities === null) {
    return {
      ok: false,
      error:
        "Invalid payload: capabilities must be an array of non-empty strings when provided",
    };
  }

  let persistenceClass: ObservationPersistenceClass = "persistent";
  if (persistenceClassRaw !== undefined) {
    const parsed = asPersistenceClass(persistenceClassRaw);
    if (!parsed) {
      return {
        ok: false,
        error:
          "Invalid payload: persistenceClass must be persistent, ephemeral, or diagnostics_only when provided",
      };
    }
    persistenceClass = parsed;
  }
  if (isOperatorDiagnosticObservation(payload)) {
    persistenceClass = "diagnostics_only";
  }

  return {
    ok: true,
    metadata: {
      source,
      payloadVersion,
      eventId,
      sourceTimestamp,
      capabilities,
      persistenceClass,
    },
  };
}

function hasValidNativeField(field: string, value: unknown): boolean {
  if (field === "is_final") return typeof value === "boolean";
  if (
    field === "tool_input" ||
    field === "tool_output" ||
    field === "error"
  ) {
    return value !== undefined;
  }
  return !!asNonEmptyString(value);
}

function validateNativePayload(
  payload: HookPayload,
  metadata: ObserveMetadata,
): string | null {
  if (metadata.source !== NATIVE_SOURCE) return null;

  if (!SUPPORTED_HOOK_TYPES.has(payload.hookType)) {
    return `Unsupported hookType: ${payload.hookType}`;
  }
  if (!asNonEmptyString(payload.project) || !asNonEmptyString(payload.cwd)) {
    return "Invalid payload: project and cwd are required for codex-native events";
  }
  if (!metadata.payloadVersion) {
    return "Unsupported codex-native payload: payloadVersion is required";
  }
  if (!SUPPORTED_NATIVE_PAYLOAD_VERSIONS.has(metadata.payloadVersion)) {
    return `Unsupported codex-native payloadVersion: ${metadata.payloadVersion}`;
  }
  if (!metadata.eventId) {
    return "Unsupported codex-native payload: eventId is required";
  }

  const data =
    typeof payload.data === "object" &&
    payload.data !== null &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : null;
  if (!data) {
    return "Invalid codex-native payload: data must be an object";
  }

  if (asNonEmptyString(data["session_id"]) !== payload.sessionId) {
    return "Invalid codex-native payload: data.session_id must match sessionId";
  }
  if (asNonEmptyString(data["cwd"]) !== payload.cwd) {
    return "Invalid codex-native payload: data.cwd must match cwd";
  }

  const requiredFields = NATIVE_REQUIRED_DATA_FIELDS[payload.hookType] ?? [];
  for (const field of requiredFields) {
    if (!hasValidNativeField(field, data[field])) {
      return `Invalid codex-native payload: data.${field} is required for ${payload.hookType}`;
    }
  }

  return null;
}

function buildObservationId(
  sessionId: string,
  eventId: string | undefined,
): string {
  if (!eventId) return generateId("obs");
  return fingerprintId("obs_evt", `${sessionId}:${eventId}`);
}

function buildObserveReceipt(
  payload: HookPayload,
  metadata: ObserveMetadata,
  observationId: string,
): ObserveReceipt | null {
  if (!metadata.eventId) return null;
  return {
    eventId: metadata.eventId,
    observationId,
    sessionId: payload.sessionId,
    hookType: payload.hookType,
    persistenceClass: metadata.persistenceClass,
    storedAt: new Date().toISOString(),
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withObserveBudget<T>(
  work: Promise<T>,
  reason: string,
): Promise<T> {
  const budgetMs = readPositiveIntegerEnv(
    "AGENTMEMORY_OBSERVE_WRITE_BUDGET_MS",
    5_000,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(reason + " after " + budgetMs + "ms")),
          budgetMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readObservePressureState(
  kv: StateKV,
): Promise<ObservePressureState | null> {
  const stored = await kv
    .get<ObservePressureState>(KV.observePressureState, OBSERVE_PRESSURE_KEY)
    .catch(() => null);
  return stored ?? inProcessObservePressureState;
}

function observeStateStatus(
  state: ObservePressureState | null,
): ObservePressureState["status"] {
  if (!state?.cooldownUntil) return state?.status ?? "enabled";
  return Date.parse(state.cooldownUntil) > Date.now() ? "degraded" : "enabled";
}

async function writeObservePressureState(
  kv: StateKV,
  patch: Partial<ObservePressureState>,
): Promise<ObservePressureState | null> {
  const previous = await readObservePressureState(kv);
  const now = new Date().toISOString();
  const next: ObservePressureState = {
    status: previous?.status ?? "enabled",
    timeoutStreak: previous?.timeoutStreak ?? 0,
    degradedObserveCount: previous?.degradedObserveCount ?? 0,
    acceptedObserveCount: previous?.acceptedObserveCount ?? 0,
    lastTransitionAt: previous?.lastTransitionAt ?? now,
    ...previous,
    ...patch,
    updatedAt: now,
  };
  if (next.status !== previous?.status) next.lastTransitionAt = now;
  inProcessObservePressureState = next;
  return kv
    .set(KV.observePressureState, OBSERVE_PRESSURE_KEY, next)
    .catch(() => null);
}

async function recordObserveAccepted(kv: StateKV): Promise<void> {
  const previous = await readObservePressureState(kv);
  if (!previous || previous.status === "enabled") return;
  const status = observeStateStatus(previous);
  await writeObservePressureState(kv, {
    status,
    acceptedObserveCount: (previous.acceptedObserveCount ?? 0) + 1,
    timeoutStreak: status === "enabled" ? 0 : previous.timeoutStreak,
    cooldownUntil: status === "enabled" ? undefined : previous.cooldownUntil,
  });
}

async function recordObserveDegraded(
  kv: StateKV,
  reason: string,
): Promise<void> {
  const previous = await readObservePressureState(kv);
  const nowMs = Date.now();
  await writeObservePressureState(kv, {
    status: "degraded",
    lastTimeoutAt: new Date(nowMs).toISOString(),
    timeoutStreak: (previous?.timeoutStreak ?? 0) + 1,
    cooldownUntil: new Date(
      nowMs + readPositiveIntegerEnv("AGENTMEMORY_OBSERVE_COOLDOWN_MS", 60_000),
    ).toISOString(),
    lastShedReason: reason,
    degradedObserveCount: (previous?.degradedObserveCount ?? 0) + 1,
  });
}

async function currentObserveCooldown(
  kv: StateKV,
): Promise<ObservePressureState | null> {
  const state = await readObservePressureState(kv);
  return observeStateStatus(state) === "degraded" ? state : null;
}

function observeBudgetReason(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /statekv|state::|temporarily unavailable|timed out|observe_write_budget/i.test(
      message,
    )
  ) {
    return message;
  }
  return null;
}

function compressionTrackerPauseReason(
  tracker: CompressionTracker | undefined,
): string | null {
  if (!tracker) return null;
  const limit = readPositiveIntegerEnv(
    "AGENTMEMORY_OBSERVE_MAX_INFLIGHT_COMPRESSIONS",
    2,
  );
  const inflight = tracker.totalInflight();
  return inflight >= limit ? `compress_inflight_${inflight}_gte_${limit}` : null;
}

function shouldCompressInlineOnObserve(): boolean {
  return process.env["AGENTMEMORY_OBSERVE_INLINE_COMPRESS"] === "true";
}

function shouldSyncEmbeddingsOnObserve(): boolean {
  return process.env["AGENTMEMORY_OBSERVE_SYNC_EMBEDDINGS"] === "true";
}

function isQueuePressure(reason: string | undefined): boolean {
  return reason?.startsWith("deferred_queue_") ?? false;
}

async function storeSyntheticObservation(
  sdk: ISdk,
  kv: StateKV,
  payload: HookPayload,
  obsId: string,
  raw: RawObservation,
  options: { syncEmbedding?: boolean } = {},
): Promise<void> {
  const syncEmbedding =
    options.syncEmbedding ?? shouldSyncEmbeddingsOnObserve();
  const synthetic = buildSyntheticCompression(raw);
  const storedSynthetic = {
    ...synthetic,
    turnId: raw.turnId,
    userPrompt: raw.userPrompt,
    assistantResponse: raw.assistantResponse,
  };
  await kv.set(KV.observations(payload.sessionId), obsId, storedSynthetic);
  await indexCompressedObservation(kv, getSearchIndex(), storedSynthetic, {
    syncEmbedding,
  });
  await upsertObservationRetrievalBlock(kv, storedSynthetic, payload.project, {
    skipEmbedding: !syncEmbedding,
  });
  await upsertTurnCapsuleFromCompressed(kv, storedSynthetic);
  bestEffortTrigger(sdk, "stream::set", {
    stream_name: STREAM.name,
    group_id: STREAM.group(payload.sessionId),
    item_id: obsId,
    data: { type: "compressed", observation: synthetic },
  });
  bestEffortTrigger(sdk, "stream::set", {
    stream_name: STREAM.name,
    group_id: STREAM.viewerGroup,
    item_id: obsId,
    data: {
      type: "compressed",
      observation: synthetic,
      sessionId: payload.sessionId,
    },
  });
}

function shouldShedObservation(
  payload: HookPayload,
  metadata: ObserveMetadata,
  pressure: ObserveHotPathPressure,
): boolean {
  if (metadata.persistenceClass !== "persistent") return true;
  if (pressure.mode !== "shed") return false;
  return (
    payload.hookType === "pre_tool_use" ||
    payload.hookType === "notification" ||
    payload.hookType === "subagent_start" ||
    payload.hookType === "subagent_stop"
  );
}

function degradedObserveResult(
  payload: HookPayload,
  metadata: ObserveMetadata,
  obsId: string,
  reason: string,
  state?: ObservePressureState | null,
) {
  logger.warn("Observation degraded under observe pressure", {
    obsId,
    sessionId: payload.sessionId,
    hook: payload.hookType,
    persistenceClass: metadata.persistenceClass,
    reason,
  });
  return {
    observationId: obsId,
    persistenceClass: metadata.persistenceClass,
    persisted: false,
    skipped: true,
    deferred: true,
    reason: "observe_pressure",
    pressure: {
      reason,
      status: state?.status ?? "degraded",
      cooldownUntil: state?.cooldownUntil,
    },
  };
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
  tracker?: CompressionTracker,
): void {
  sdk.registerFunction("mem::observe", async (payload: HookPayload) => {
    if (
      !payload?.sessionId ||
      typeof payload.sessionId !== "string" ||
      !payload.hookType ||
      typeof payload.hookType !== "string" ||
      !payload.timestamp ||
      typeof payload.timestamp !== "string"
    ) {
      return {
        success: false,
        error:
          "Invalid payload: sessionId, hookType, and timestamp are required",
      };
    }

    if (!SUPPORTED_HOOK_TYPES.has(payload.hookType as HookType)) {
      return {
        success: false,
        error: `Unsupported hookType: ${payload.hookType}`,
      };
    }

    const metadataResult = normalizeObserveMetadata(payload);
    if (!metadataResult.ok) {
      return { success: false, error: metadataResult.error };
    }
    const metadata = metadataResult.metadata;

    const nativeValidationError = validateNativePayload(payload, metadata);
    if (nativeValidationError) {
      return { success: false, error: nativeValidationError };
    }

    const obsId = buildObservationId(payload.sessionId, metadata.eventId);

    let dedupHash: string | undefined;
    if (dedupMap) {
      const d =
        typeof payload.data === "object" && payload.data !== null
          ? (payload.data as Record<string, unknown>)
          : {};
      const toolName = (d["tool_name"] as string) || payload.hookType;
      dedupHash = dedupMap.computeHash(
        payload.sessionId,
        toolName,
        d["tool_input"],
      );
    }

    let sanitizedRaw: unknown = payload.data;
    try {
      const jsonStr = JSON.stringify(payload.data);
      const sanitized = stripPrivateData(jsonStr);
      sanitizedRaw = JSON.parse(sanitized);
    } catch {
      sanitizedRaw = stripPrivateData(String(payload.data));
    }

    const raw: RawObservation = {
      id: obsId,
      sessionId: payload.sessionId,
      timestamp: payload.timestamp,
      hookType: payload.hookType,
      source: metadata.source,
      payloadVersion: metadata.payloadVersion,
      eventId: metadata.eventId,
      sourceTimestamp: metadata.sourceTimestamp,
      capabilities: metadata.capabilities,
      persistenceClass: metadata.persistenceClass,
      raw: sanitizedRaw,
    };

    if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
      const d = sanitizedRaw as Record<string, unknown>;
      raw.turnId = d["turn_id"] as string | undefined;
      if (
        payload.hookType === "post_tool_use" ||
        payload.hookType === "post_tool_failure"
      ) {
        raw.toolName = d["tool_name"] as string | undefined;
        raw.toolInput = d["tool_input"];
        raw.toolOutput = d["tool_output"] || d["error"];
      }
      if (payload.hookType === "prompt_submit") {
        raw.userPrompt = d["prompt"] as string | undefined;
      }
      if (payload.hookType === "assistant_result") {
        raw.assistantResponse = d["assistant_text"] as string | undefined;
      }
      if (payload.hookType === "stop" || payload.hookType === "task_completed") {
        raw.assistantResponse =
          d["last_assistant_message"] as string | undefined;
      }
    }

    return withKeyedLock(`obs:${payload.sessionId}`, async () => {
      const observeCooldown = await currentObserveCooldown(kv);
      if (observeCooldown) {
        return degradedObserveResult(
          payload,
          metadata,
          obsId,
          observeCooldown.lastShedReason || "observe_cooldown_active",
          observeCooldown,
        );
      }

      if (metadata.eventId) {
        const existingReceipt = await kv
          .get<ObserveReceipt>(
            KV.observeReceipts(payload.sessionId),
            metadata.eventId,
          )
          .catch(() => null);
        if (existingReceipt) {
          return {
            deduplicated: true,
            sessionId: payload.sessionId,
            observationId: existingReceipt.observationId,
            persistenceClass: existingReceipt.persistenceClass,
          };
        }
      }

      if (dedupMap && dedupHash && dedupMap.isDuplicate(dedupHash)) {
        return {
          deduplicated: true,
          sessionId: payload.sessionId,
          observationId: obsId,
          persistenceClass: metadata.persistenceClass,
        };
      }

      const hotPathPressure = await getObserveHotPathPressure(kv);
      if (hotPathPressure && shouldShedObservation(payload, metadata, hotPathPressure)) {
        const receipt = buildObserveReceipt(payload, metadata, obsId);
        if (receipt) {
          await kv.set(
            KV.observeReceipts(payload.sessionId),
            receipt.eventId,
            receipt,
          );
        }
        logger.warn("Observation skipped under hot-path pressure", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          persistenceClass: metadata.persistenceClass,
          reason: hotPathPressure.reason,
        });
        return {
          observationId: obsId,
          persistenceClass: metadata.persistenceClass,
          persisted: false,
          skipped: true,
          reason: "hot_path_backpressure",
          pressure: hotPathPressure,
        };
      }

      if (
        metadata.persistenceClass === "persistent" &&
        maxObservationsPerSession &&
        maxObservationsPerSession > 0
      ) {
        const existing = await kv.list(KV.observations(payload.sessionId));
        if (existing.length >= maxObservationsPerSession) {
          return {
            success: false,
            error: `Session observation limit reached (${maxObservationsPerSession})`,
          };
        }
      }

      const deferDerivedWork = Boolean(hotPathPressure);
      let writePressureReason: string | undefined;
      if (metadata.persistenceClass !== "diagnostics_only" && !deferDerivedWork) {
        await withObserveBudget(
          upsertTurnCapsuleFromRaw(
            kv,
            payload.sessionId,
            payload.project,
            payload.cwd,
            raw,
          ),
          "observe_write_budget_exceeded_during_turn_capsule",
        ).catch((err) => {
          const reason = observeBudgetReason(err);
          if (!reason) throw err;
          writePressureReason = reason;
          logger.warn("Observe derived work deferred under write pressure", {
            obsId,
            sessionId: payload.sessionId,
            phase: "turn_capsule",
            reason,
          });
        });
      }

      let compressionMode: "llm" | "synthetic" | "deferred" = "synthetic";
      if (metadata.persistenceClass === "persistent") {
        try {
          await withObserveBudget(
            kv.set(KV.observations(payload.sessionId), obsId, raw),
            "observe_write_budget_exceeded_during_raw_observation",
          );
        } catch (err) {
          const reason = observeBudgetReason(err);
          if (!reason) throw err;
          logger.warn("Observation persistence failed fast under write pressure", {
            obsId,
            sessionId: payload.sessionId,
            reason,
          });
          await recordObserveDegraded(kv, reason);
          return degradedObserveResult(payload, metadata, obsId, reason);
        }

        bestEffortTrigger(sdk, "stream::set", {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: { type: "raw", observation: raw },
        });

        bestEffortTrigger(sdk, "stream::send", {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `raw-${obsId}`,
          type: "raw_observation",
          data: { type: "raw", observation: raw, sessionId: payload.sessionId },
        });

        const session = await kv.get<{ observationCount?: number }>(
          KV.sessions,
          payload.sessionId,
        );
        if (session) {
          const nextUpdatedAt = new Date().toISOString();
          if (typeof kv.update === "function") {
            await kv.update(KV.sessions, payload.sessionId, [
              { type: "set", path: "updatedAt", value: nextUpdatedAt },
              {
                type: "set",
                path: "observationCount",
                value: (session.observationCount || 0) + 1,
              },
            ]);
          } else {
            await kv.set(KV.sessions, payload.sessionId, {
              ...session,
              updatedAt: nextUpdatedAt,
              observationCount: (session.observationCount || 0) + 1,
            });
          }
        }

        if (isAutoCompressEnabled()) {
          const pauseReason =
            hotPathPressure?.reason ||
            writePressureReason ||
            compressionTrackerPauseReason(tracker) ||
            (await getLlmWorkPauseReason(kv));
          if (hotPathPressure && isQueuePressure(hotPathPressure.reason)) {
            compressionMode = "synthetic";
            await withObserveBudget(
              storeSyntheticObservation(sdk, kv, payload, obsId, raw, {
                syncEmbedding: false,
              }),
              "observe_write_budget_exceeded_during_synthetic_observation",
            ).catch((err) => {
              const reason = observeBudgetReason(err);
              if (!reason) throw err;
              writePressureReason = reason;
              compressionMode = "deferred";
              logger.warn("Synthetic compression deferred under write pressure", {
                obsId,
                sessionId: payload.sessionId,
                reason,
              });
            });
            logger.warn("Auto compression downgraded under hot-path pressure", {
              obsId,
              sessionId: payload.sessionId,
              reason: hotPathPressure.reason,
            });
          } else if (pauseReason || !shouldCompressInlineOnObserve()) {
            compressionMode = "deferred";
            await enqueueCompressionRetry(kv, {
              observationId: obsId,
              sessionId: payload.sessionId,
              error: pauseReason || "observe_inline_compress_deferred",
            });
            logger[pauseReason ? "warn" : "info"]("Auto compression queued", {
              obsId,
              sessionId: payload.sessionId,
              reason: pauseReason || "observe_inline_compress_deferred",
            });
          } else {
            compressionMode = "llm";
            tracker?.increment(payload.sessionId);
            void sdk
              .trigger({
                function_id: "mem::compress",
                payload: {
                  observationId: obsId,
                  sessionId: payload.sessionId,
                  raw,
                },
              })
              .catch(() => {
                tracker?.decrement(payload.sessionId);
              });
          }
        } else {
          if (hotPathPressure) {
            if (isQueuePressure(hotPathPressure.reason)) {
              compressionMode = "synthetic";
              await withObserveBudget(
                storeSyntheticObservation(sdk, kv, payload, obsId, raw, {
                  syncEmbedding: false,
                }),
                "observe_write_budget_exceeded_during_synthetic_observation",
              ).catch((err) => {
                const reason = observeBudgetReason(err);
                if (!reason) throw err;
                writePressureReason = reason;
                compressionMode = "deferred";
                logger.warn("Synthetic compression deferred under write pressure", {
                  obsId,
                  sessionId: payload.sessionId,
                  reason,
                });
              });
              logger.warn("Synthetic compression stored under hot-path pressure", {
                obsId,
                sessionId: payload.sessionId,
                reason: hotPathPressure.reason,
              });
            } else {
              compressionMode = "deferred";
              await enqueueCompressionRetry(kv, {
                observationId: obsId,
                sessionId: payload.sessionId,
                error: hotPathPressure.reason,
              });
              logger.warn("Synthetic compression deferred under hot-path pressure", {
                obsId,
                sessionId: payload.sessionId,
                reason: hotPathPressure.reason,
              });
            }
          } else {
            await withObserveBudget(
              storeSyntheticObservation(sdk, kv, payload, obsId, raw),
              "observe_write_budget_exceeded_during_synthetic_observation",
            ).catch((err) => {
              const reason = observeBudgetReason(err);
              if (!reason) throw err;
              writePressureReason = reason;
              compressionMode = "deferred";
              logger.warn("Synthetic compression deferred under write pressure", {
                obsId,
                sessionId: payload.sessionId,
                reason,
              });
            });
          }
        }
      }

      const receipt = buildObserveReceipt(payload, metadata, obsId);
      if (receipt) {
        await kv.set(
          KV.observeReceipts(payload.sessionId),
          receipt.eventId,
          receipt,
        );
      }

      if (dedupMap && dedupHash) {
        dedupMap.record(dedupHash);
      }

      logger.info("Observation captured", {
        obsId,
        sessionId: payload.sessionId,
        hook: payload.hookType,
        persistenceClass: metadata.persistenceClass,
        compress:
          metadata.persistenceClass === "persistent"
            ? compressionMode
            : "skipped",
      });
      if (writePressureReason) {
        await recordObserveDegraded(kv, writePressureReason);
      } else {
        await recordObserveAccepted(kv);
      }
      return {
        observationId: obsId,
        persistenceClass: metadata.persistenceClass,
        persisted: metadata.persistenceClass === "persistent",
        deferred: deferDerivedWork || Boolean(writePressureReason) || undefined,
        reason: writePressureReason
          ? "observe_write_pressure"
          : hotPathPressure
            ? "hot_path_backpressure"
            : undefined,
        pressure:
          hotPathPressure ||
          (writePressureReason
            ? { reason: writePressureReason, mode: "defer_derived" }
            : undefined),
      };
    });
  });
}
