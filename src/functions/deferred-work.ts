import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressRetryEntry, MaintenanceLaneState } from "../types.js";

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
  totalQueued: number;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function compressionStatus(
  kv: StateKV,
  nowMs: number,
): Promise<DeferredWorkStatus["compression"]> {
  try {
    const [entries, laneState] = await Promise.all([
      kv.list<CompressRetryEntry>(KV.compressRetry),
      kv.get<MaintenanceLaneState>(KV.maintenanceLaneState, "compression").catch(() => null),
    ]);
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
): Promise<{ queued: number; error?: string }> {
  try {
    return { queued: (await kv.list(scope)).length };
  } catch (err) {
    return {
      queued: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDeferredWorkStatus(
  kv: StateKV,
): Promise<DeferredWorkStatus> {
  const nowMs = Date.now();
  const [compression, retrievalBlocks, graphExtraction] = await Promise.all([
    compressionStatus(kv, nowMs),
    countScope(kv, KV.retrievalBlockRetry),
    countScope(kv, KV.graphExtractionRetry),
  ]);
  const totalQueued =
    compression.queued + retrievalBlocks.queued + graphExtraction.queued;
  return {
    generatedAt: new Date().toISOString(),
    compression,
    retrievalBlocks,
    graphExtraction,
    totalQueued,
  };
}

export function registerDeferredWorkFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::deferred-work-status", async () =>
    getDeferredWorkStatus(kv),
  );
}
