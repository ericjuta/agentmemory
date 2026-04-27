import type { StateKV } from "../state/kv.js";
import { getMaintenancePauseReason } from "../health/maintenance-gate.js";
import { getLatestHealth } from "../health/monitor.js";
import { getDeferredWorkStatus } from "./deferred-work.js";

export interface HotPathPressure {
  reason: string;
  runtimeStatus?: string;
  deferredWorkTotal?: number;
  queueThreshold?: number;
}

export interface ObserveHotPathPressure extends HotPathPressure {
  mode: "defer_derived" | "shed";
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

export async function getContextHotPathPressure(
  kv: StateKV,
): Promise<HotPathPressure | null> {
  return cachedPressure(kv, "context", async () => {
    const health = await getLatestHealth(kv).catch(() => null);
    const pauseReason = getMaintenancePauseReason(health);
    if (pauseReason) {
      return { reason: pauseReason, runtimeStatus: health?.status };
    }

    const deferredWork = await getDeferredWorkStatus(kv).catch(() => null);
    if (!deferredWork) return null;
    return queuePressure(
      deferredWork.totalQueued,
      readPositiveIntegerEnv(
        "AGENTMEMORY_CONTEXT_BACKPRESSURE_QUEUE_HIGH",
        DEFAULT_CONTEXT_QUEUE_THRESHOLD,
      ),
    );
  });
}

export async function getObserveHotPathPressure(
  kv: StateKV,
): Promise<ObserveHotPathPressure | null> {
  return cachedPressure(kv, "observe", async () => {
    const health = await getLatestHealth(kv).catch(() => null);
    const pauseReason = getMaintenancePauseReason(health);
    if (pauseReason) {
      return {
        reason: pauseReason,
        runtimeStatus: health?.status,
        mode: health?.status === "critical" ? "shed" : "defer_derived",
      };
    }

    const deferredWork = await getDeferredWorkStatus(kv).catch(() => null);
    if (!deferredWork) return null;

    const shedThreshold = readPositiveIntegerEnv(
      "AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_CRITICAL",
      DEFAULT_OBSERVE_SHED_QUEUE_THRESHOLD,
    );
    const shedPressure = queuePressure(deferredWork.totalQueued, shedThreshold);
    if (shedPressure) return { ...shedPressure, mode: "shed" };

    const derivedThreshold = readPositiveIntegerEnv(
      "AGENTMEMORY_OBSERVE_BACKPRESSURE_QUEUE_HIGH",
      DEFAULT_OBSERVE_DERIVED_QUEUE_THRESHOLD,
    );
    const derivedPressure = queuePressure(deferredWork.totalQueued, derivedThreshold);
    if (derivedPressure) return { ...derivedPressure, mode: "defer_derived" };

    return null;
  });
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
