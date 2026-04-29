import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressRetryEntry, MaintenanceLaneState } from "../types.js";
import {
  observePressureFromQueued,
  type ObserveHotPathStatus,
} from "./hot-path-pressure.js";

export interface DeferredWorkStatus {
  generatedAt: string;
  compression: {
    queued: number;
    oldestFailedAt?: string;
    newestFailedAt?: string;
    oldestAgeMs?: number;
    newestAgeMs?: number;
    laneState?: MaintenanceLaneState;
    queuedDeltaSinceLastWake?: number;
    drainRatePerHour?: number;
    estimatedDrainEtaMs?: number | null;
    error?: string;
  };
  retrievalBlocks: {
    queued: number;
    error?: string;
  };
  graphExtraction: {
    queued: number;
    error?: string;
  };
  observeCapture: ObserveHotPathStatus | { error: string };
  totalQueued: number;
}

export interface DeferredWorkStatusOptions {
  refresh?: boolean;
  lightweight?: boolean;
}

const DEFAULT_DEFERRED_WORK_CACHE_MS = 5000;
let deferredWorkCache = new WeakMap<
  StateKV,
  { expiresAt: number; promise: Promise<DeferredWorkStatus> }
>();

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function compressionStatus(
  kv: StateKV,
  nowMs: number,
  options: DeferredWorkStatusOptions = {},
): Promise<DeferredWorkStatus["compression"]> {
  try {
    const laneState = await kv
      .get<MaintenanceLaneState>(KV.maintenanceLaneState, "compression")
      .catch(() => null);
    if (options.lightweight) {
      const queued =
        typeof laneState?.lastQueued === "number" &&
        Number.isFinite(laneState.lastQueued)
          ? Math.max(0, laneState.lastQueued)
          : 0;
      return {
        queued,
        ...(laneState
          ? {
              laneState,
              ...(typeof laneState.queuedDeltaSinceLastWake === "number"
                ? { queuedDeltaSinceLastWake: laneState.queuedDeltaSinceLastWake }
                : {}),
              ...(typeof laneState.drainRatePerHour === "number"
                ? { drainRatePerHour: laneState.drainRatePerHour }
                : {}),
              ...("estimatedDrainEtaMs" in laneState
                ? { estimatedDrainEtaMs: laneState.estimatedDrainEtaMs ?? null }
                : {}),
            }
          : {}),
      };
    }

    const entries = await kv.list<CompressRetryEntry>(KV.compressRetry);
    let oldestMs: number | null = null;
    let newestMs: number | null = null;
    let oldestFailedAt: string | undefined;
    let newestFailedAt: string | undefined;
    for (const entry of entries) {
      const failedAt = entry.firstFailedAt ?? entry.failedAt;
      const failedMs = parseTimestampMs(failedAt);
      if (failedMs === null) continue;
      if (oldestMs === null || failedMs < oldestMs) {
        oldestMs = failedMs;
        oldestFailedAt = failedAt;
      }
      const newestAt = entry.lastFailedAt ?? entry.failedAt;
      const newestEntryMs = parseTimestampMs(newestAt);
      if (
        newestEntryMs !== null &&
        (newestMs === null || newestEntryMs > newestMs)
      ) {
        newestMs = newestEntryMs;
        newestFailedAt = newestAt;
      }
    }
    return {
      queued: entries.length,
      ...(oldestFailedAt ? { oldestFailedAt, oldestAgeMs: Math.max(0, nowMs - (oldestMs ?? nowMs)) } : {}),
      ...(newestFailedAt ? { newestFailedAt, newestAgeMs: Math.max(0, nowMs - (newestMs ?? nowMs)) } : {}),
      ...(laneState
        ? {
            laneState,
            ...(typeof laneState.queuedDeltaSinceLastWake === "number"
              ? { queuedDeltaSinceLastWake: laneState.queuedDeltaSinceLastWake }
              : {}),
            ...(typeof laneState.drainRatePerHour === "number"
              ? { drainRatePerHour: laneState.drainRatePerHour }
              : {}),
            ...("estimatedDrainEtaMs" in laneState
              ? { estimatedDrainEtaMs: laneState.estimatedDrainEtaMs ?? null }
              : {}),
          }
        : {}),
    };
  } catch (err) {
    return {
      queued: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function countScope(
  kv: StateKV,
  scope: string,
  options: DeferredWorkStatusOptions = {},
): Promise<{ queued: number; error?: string }> {
  if (options.lightweight) return { queued: 0 };
  try {
    return { queued: (await kv.list(scope)).length };
  } catch (err) {
    return {
      queued: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readCacheMs(): number {
  const raw = process.env.AGENTMEMORY_DEFERRED_WORK_CACHE_MS;
  if (!raw) return DEFAULT_DEFERRED_WORK_CACHE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_DEFERRED_WORK_CACHE_MS;
}

async function buildDeferredWorkStatus(
  kv: StateKV,
  options: DeferredWorkStatusOptions = {},
): Promise<DeferredWorkStatus> {
  const nowMs = Date.now();
  const [compression, retrievalBlocks, graphExtraction] = await Promise.all([
    compressionStatus(kv, nowMs, options),
    countScope(kv, KV.retrievalBlockRetry, options),
    countScope(kv, KV.graphExtractionRetry, options),
  ]);
  const totalQueued =
    compression.queued + retrievalBlocks.queued + graphExtraction.queued;
  const includeCompressionQueue =
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"] === "1" ||
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"] === "true" ||
    process.env["AGENTMEMORY_OBSERVE_BACKPRESSURE_INCLUDE_COMPRESSION"] === "yes";
  const observeQueued = includeCompressionQueue
    ? totalQueued
    : retrievalBlocks.queued + graphExtraction.queued;
  const observePressure = observePressureFromQueued(observeQueued);
  const observeCapture: ObserveHotPathStatus = observePressure
    ? {
        status: observePressure.mode === "shed" ? "shedding" : "defer_derived",
        pressure: observePressure,
        derivedWorkDeferred: true,
        captureSkipped: observePressure.mode === "shed",
      }
    : {
        status: "capturing",
        pressure: null,
        derivedWorkDeferred: false,
        captureSkipped: false,
      };
  return {
    generatedAt: new Date().toISOString(),
    compression,
    retrievalBlocks,
    graphExtraction,
    observeCapture,
    totalQueued,
  };
}

export async function getDeferredWorkStatus(
  kv: StateKV,
  options: DeferredWorkStatusOptions = {},
): Promise<DeferredWorkStatus> {
  if (options.lightweight) return buildDeferredWorkStatus(kv, options);
  const cacheMs = readCacheMs();
  if (options.refresh || cacheMs <= 0) return buildDeferredWorkStatus(kv);

  const now = Date.now();
  const cached = deferredWorkCache.get(kv);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = buildDeferredWorkStatus(kv).catch((err) => {
    if (deferredWorkCache.get(kv)?.promise === promise) {
      deferredWorkCache.delete(kv);
    }
    throw err;
  });
  deferredWorkCache.set(kv, { expiresAt: now + cacheMs, promise });
  return promise;
}

export function clearDeferredWorkStatusCache(kv?: StateKV): void {
  if (kv) {
    deferredWorkCache.delete(kv);
    return;
  }
  deferredWorkCache = new WeakMap();
}

export function registerDeferredWorkFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::deferred-work-status", async () =>
    getDeferredWorkStatus(kv),
  );
}
