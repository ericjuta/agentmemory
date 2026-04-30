import type { StateKV } from "../state/kv.js";
import { getMaintenancePauseReason } from "../health/maintenance-gate.js";
import { getLatestHealth } from "../health/monitor.js";
import { getDeferredWorkStatus } from "./deferred-work.js";
import { KV } from "../state/schema.js";
import type { ObservePressureState } from "../types.js";

export interface HotPathPressure {
  reason: string;
  runtimeStatus?: string;
  deferredWorkTotal?: number;
  queueThreshold?: number;
}

export interface ObserveHotPathPressure extends HotPathPressure {
  mode: "defer_derived" | "shed";
}

export interface ObserveHotPathStatus {
  status: "capturing" | "defer_derived" | "shedding" | "degraded" | "emergency_disabled";
  pressure: ObserveHotPathPressure | null;
  derivedWorkDeferred: boolean;
  captureSkipped: boolean;
  cooldownUntil?: string;
  lastShedReason?: string;
  state?: ObservePressureState | null;
}

export interface ContextHotPathPressureOptions {
  ignoreDeferredQueue?: boolean;
  includeCompressionQueue?: boolean;
}

export interface ObserveHotPathPressureOptions {
  lightweight?: boolean;
}

const DEFAULT_CONTEXT_QUEUE_THRESHOLD = 300;
const DEFAULT_OBSERVE_DERIVED_QUEUE_THRESHOLD = 300;
const DEFAULT_OBSERVE_SHED_QUEUE_THRESHOLD = 1000;
const DEFAULT_PRESSURE_CACHE_MS = 2000;

const pressureCache = new WeakMap<
  StateKV,
  Map<string, { expiresAt: number; value: HotPathPressure | ObserveHotPathPressure | null }>
>();

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cacheTtlMs(): number {
  return readPositiveIntegerEnv(
    "AGENTMEMORY_HOT_PATH_PRESSURE_CACHE_MS",
    DEFAULT_PRESSURE_CACHE_MS,
  );
}

async function cachedPressure<T extends HotPathPressure | null>(
  kv: StateKV,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const ttlMs = cacheTtlMs();
  if (ttlMs <= 0) return compute();

  const now = Date.now();
  let kvCache = pressureCache.get(kv);
  if (!kvCache) {
    kvCache = new Map();
    pressureCache.set(kv, kvCache);
  }
  const cached = kvCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;

  const value = await compute();
  kvCache.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

function queuePressure(
  totalQueued: number,
  threshold: number,
): HotPathPressure | null {
  if (totalQueued < threshold) return null;
  return {
    reason: `deferred_queue_${totalQueued}_gte_${threshold}`,
    deferredWorkTotal: totalQueued,
    queueThreshold: threshold,
  };
}

function envFlagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true" || raw === "yes";
}

function retrievalContextQueued(
  deferredWork: Awaited<ReturnType<typeof getDeferredWorkStatus>>,
  includeCompressionQueue: boolean,
): number {
  return includeCompressionQueue
    ? deferredWork.totalQueued
    : deferredWork.retrievalBlocks.queued + deferredWork.graphExtraction.queued;
}

export function observePressureFromQueued(
  observeQueued: number,
): ObserveHotPathPressure | null {
  const shedThreshold = readPositiveIntegerEnv(
    "AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL",
    DEFAULT_OBSERVE_SHED_QUEUE_THRESHOLD,
  );
  const shedPressure = queuePressure(observeQueued, shedThreshold);
  if (shedPressure) return { ...shedPressure, mode: "shed" };

  const derivedThreshold = readPositiveIntegerEnv(
    "AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH",
    DEFAULT_OBSERVE_DERIVED_QUEUE_THRESHOLD,
  );
  const derivedPressure = queuePressure(observeQueued, derivedThreshold);
  if (derivedPressure) return { ...derivedPressure, mode: "defer_derived" };

  return null;
}

export async function getContextHotPathPressure(
  kv: StateKV,
  options: ContextHotPathPressureOptions = {},
): Promise<HotPathPressure | null> {
  const includeCompressionQueue =
    options.includeCompressionQueue ||
    envFlagEnabled("AGENTMEMORY_CONTEXT_BACKPRESSURE_INCLUDE_COMPRESSION");
  const pressureKey = [
    "context",
    options.ignoreDeferredQueue ? "ignore-deferred" : "deferred",
    includeCompressionQueue ? "include-compression" : "default",
  ].join(":");
  return cachedPressure(kv, pressureKey, async () => {
    const health = await getLatestHealth(kv).catch(() => null);
    const pauseReason = getMaintenancePauseReason(health);
    if (pauseReason) {
      return { reason: pauseReason, runtimeStatus: health?.status };
    }

    const deferredWork = await getDeferredWorkStatus(kv, {
      lightweight: true,
    }).catch(() => null);
    if (!deferredWork) return null;
    if (options.ignoreDeferredQueue) return null;
    const contextQueued = retrievalContextQueued(
      deferredWork,
      includeCompressionQueue,
    );
    return queuePressure(
      contextQueued,
      readPositiveIntegerEnv(
        "AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH",
        DEFAULT_CONTEXT_QUEUE_THRESHOLD,
      ),
    );
  });
}

export async function getObserveHotPathPressure(
  kv: StateKV,
  options: ObserveHotPathPressureOptions = {},
): Promise<ObserveHotPathPressure | null> {
  const pressureKey = [
    "observe",
    options.lightweight ? "lightweight" : "full",
  ].join(":");
  return cachedPressure(kv, pressureKey, async () => {
    const health = await getLatestHealth(kv).catch(() => null);
    const pauseReason = getMaintenancePauseReason(health);
    if (pauseReason) {
      return {
        reason: pauseReason,
        runtimeStatus: health?.status,
        mode: health?.status === "critical" ? "shed" : "defer_derived",
      };
    }

    const deferredWork = await getDeferredWorkStatus(kv, {
      lightweight: options.lightweight,
    }).catch(() => null);
    if (!deferredWork) return null;
    const observeQueued = retrievalContextQueued(
      deferredWork,
      envFlagEnabled("AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"),
    );

    return observePressureFromQueued(observeQueued);
  });
}

export async function getObserveHotPathStatus(
  kv: StateKV,
  pressure?: ObserveHotPathPressure | null,
  options: ObserveHotPathPressureOptions = {},
): Promise<ObserveHotPathStatus> {
  if (process.env["AGENTMEMORY_INGEST_ENABLED"] === "false") {
    return {
      status: "emergency_disabled",
      pressure: null,
      derivedWorkDeferred: true,
      captureSkipped: true,
      lastShedReason: "ingest_disabled",
    };
  }
  const state = await kv
    .get<ObservePressureState>(KV.observePressureState, "latest")
    .catch(() => null);
  if (state?.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now()) {
    return {
      status: "degraded",
      pressure: null,
      derivedWorkDeferred: true,
      captureSkipped: true,
      cooldownUntil: state.cooldownUntil,
      lastShedReason: state.lastShedReason,
      state,
    };
  }
  pressure ??= await getObserveHotPathPressure(kv, options);
  if (!pressure) {
    return {
      status: "capturing",
      pressure: null,
      derivedWorkDeferred: false,
      captureSkipped: false,
      state,
    };
  }
  const captureSkipped = pressure.mode === "shed";
  return {
    status: pressure.mode === "shed" ? "shedding" : "defer_derived",
    pressure,
    derivedWorkDeferred: true,
    captureSkipped,
    state,
  };
}

export function emptyContextForPressure(pressure: HotPathPressure) {
  return {
    context: "",
    items: [],
    blocks: 0,
    tokens: 0,
    trace: undefined,
    skipped: true,
    reason: "hot_path_backpressure",
    pressure,
  };
}

export function clearHotPathPressureCache(kv?: StateKV): void {
  if (kv) {
    pressureCache.delete(kv);
  }
}
