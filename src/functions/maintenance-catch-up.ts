import type { ISdk } from "iii-sdk";

import { shouldPauseMaintenance, getMaintenancePauseReason } from "../health/maintenance-gate.js";
import { getLatestHealth } from "../health/monitor.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { MaintenanceLaneState } from "../types.js";
import { getDeferredWorkStatus } from "./deferred-work.js";

type MaintenanceLane = "retrieval" | "compression" | "graph";

interface MaintenanceCatchUpPayload {
  lane?: unknown;
  maxBatchSize?: unknown;
  timeBudgetMs?: unknown;
}

interface MaintenanceCatchUpResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  lane?: MaintenanceLane;
  workDone: number;
  batchSize?: number;
  timeBudgetMs?: number;
  deferredWork?: Awaited<ReturnType<typeof getDeferredWorkStatus>>;
  result?: unknown;
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function parseLane(value: unknown): MaintenanceLane | undefined {
  if (value === "retrieval" || value === "compression" || value === "graph") {
    return value;
  }
  return undefined;
}

function envFlagDisabled(name: string): boolean {
  return process.env[name] === "false";
}

function laneEnabled(lane: MaintenanceLane): boolean {
  if (lane === "retrieval") {
    return !envFlagDisabled("RETRIEVAL_BLOCK_RETRY_ENABLED");
  }
  if (lane === "graph") {
    return !envFlagDisabled("GRAPH_CATCH_UP_ENABLED");
  }
  return !envFlagDisabled("COMPRESS_RETRY_ENABLED");
}

function cpuPercent(snapshot: Awaited<ReturnType<typeof getLatestHealth>>): number {
  return snapshot?.cpu?.percent ?? 0;
}

function adaptiveRetrievalBatch(cpu: number, maxBatchSize: number): number {
  if (cpu < 30) return Math.min(maxBatchSize, 40);
  if (cpu < 55) return Math.min(maxBatchSize, 25);
  if (cpu < 70) return Math.min(maxBatchSize, 10);
  return Math.min(maxBatchSize, 5);
}

function adaptiveCompressionBatch(
  snapshot: Awaited<ReturnType<typeof getLatestHealth>>,
  maxBatchSize: number,
): number {
  const cpu = cpuPercent(snapshot);
  const lag = snapshot?.eventLoopLagMs ?? 0;
  const kvLatency = snapshot?.kvConnectivity?.latencyMs ?? 0;
  if (cpu < 15 && lag < 10 && kvLatency < 20) return Math.min(maxBatchSize, 5);
  if (cpu < 25 && lag < 20 && kvLatency < 50) return Math.min(maxBatchSize, 3);
  return 1;
}

function defaultCompressionBatchFloor(): number {
  return positiveInteger(process.env.COMPRESS_RETRY_MIN_BATCH_SIZE, 1);
}

function defaultCompressionIntervalMs(): number {
  return positiveInteger(process.env.COMPRESS_RETRY_INTERVAL_MS, 60_000);
}

function maxCompressionIntervalMs(): number {
  return positiveInteger(process.env.COMPRESS_RETRY_MAX_INTERVAL_MS, 10 * 60_000);
}

function isStateKvPressure(reason: string | undefined): boolean {
  if (!reason) return false;
  return /statekv|state::|StateKV temporarily unavailable/i.test(reason);
}

async function readCompressionLaneState(kv: StateKV): Promise<MaintenanceLaneState | null> {
  return kv.get<MaintenanceLaneState>(KV.maintenanceLaneState, "compression").catch(() => null);
}

async function writeCompressionLaneState(
  kv: StateKV,
  previous: MaintenanceLaneState | null,
  patch: Partial<MaintenanceLaneState>,
): Promise<MaintenanceLaneState> {
  const now = new Date().toISOString();
  const next: MaintenanceLaneState = {
    successStreak: previous?.successStreak ?? 0,
    pressureStreak: previous?.pressureStreak ?? 0,
    currentIntervalMs: previous?.currentIntervalMs ?? defaultCompressionIntervalMs(),
    currentBatchSize: previous?.currentBatchSize ?? defaultCompressionBatchFloor(),
    ...previous,
    ...patch,
    lane: "compression",
    updatedAt: now,
  };
  await kv.set(KV.maintenanceLaneState, "compression", next);
  return next;
}

async function recordCompressionSkip(
  kv: StateKV,
  reason: string,
  queued?: number,
): Promise<MaintenanceLaneState | null> {
  const previous = await readCompressionLaneState(kv);
  const pressure = isStateKvPressure(reason);
  const currentBatchSize = previous?.currentBatchSize ?? defaultCompressionBatchFloor();
  const currentIntervalMs = previous?.currentIntervalMs ?? defaultCompressionIntervalMs();
  const now = new Date().toISOString();
  return writeCompressionLaneState(kv, previous, {
    lastWakeAt: now,
    lastWorkDone: 0,
    lastSkippedReason: reason,
    currentBatchSize: pressure
      ? Math.max(defaultCompressionBatchFloor(), Math.floor(currentBatchSize / 2))
      : currentBatchSize,
    currentIntervalMs: pressure
      ? Math.min(maxCompressionIntervalMs(), Math.max(currentIntervalMs * 2, defaultCompressionIntervalMs()))
      : currentIntervalMs,
    successStreak: pressure ? 0 : previous?.successStreak ?? 0,
    pressureStreak: pressure ? (previous?.pressureStreak ?? 0) + 1 : previous?.pressureStreak ?? 0,
    ...(typeof queued === "number" ? { lastQueued: queued } : {}),
  }).catch(() => null);
}

function compressionBatchFromState(
  health: Awaited<ReturnType<typeof getLatestHealth>>,
  maxBatchSize: number,
  laneState: MaintenanceLaneState | null,
): number {
  const adaptive = adaptiveCompressionBatch(health, maxBatchSize);
  const stateBatch = laneState?.currentBatchSize;
  if (typeof stateBatch !== "number" || stateBatch <= 0) return adaptive;
  return Math.min(adaptive, maxBatchSize, Math.max(defaultCompressionBatchFloor(), stateBatch));
}

function stateAfterCompressionWake(input: {
  previous: MaintenanceLaneState | null;
  queuedBefore: number;
  queuedAfter: number;
  workDone: number;
  durationMs: number;
  batchSize: number;
  errorReason?: string;
}): Partial<MaintenanceLaneState> {
  const now = new Date().toISOString();
  const queuedDelta = input.queuedAfter - input.queuedBefore;
  const drained = Math.max(0, input.queuedBefore - input.queuedAfter);
  const drainRatePerHour =
    input.durationMs > 0 && drained > 0
      ? Math.round((drained * 3_600_000) / input.durationMs)
      : input.previous?.drainRatePerHour;
  const estimatedDrainEtaMs =
    drainRatePerHour && drainRatePerHour > 0
      ? Math.ceil((input.queuedAfter / drainRatePerHour) * 3_600_000)
      : null;
  const pressure = isStateKvPressure(input.errorReason);
  const floor = defaultCompressionBatchFloor();
  const currentIntervalMs = input.previous?.currentIntervalMs ?? defaultCompressionIntervalMs();
  const nextBatchSize = pressure
    ? Math.max(floor, Math.floor(input.batchSize / 2))
    : input.workDone > 0 && (input.previous?.successStreak ?? 0) >= 2
      ? Math.min(input.batchSize + 1, positiveInteger(process.env.COMPRESS_RETRY_MAX_BATCH_SIZE, 40))
      : input.batchSize;
  const nextIntervalMs = pressure
    ? Math.min(maxCompressionIntervalMs(), Math.max(currentIntervalMs * 2, defaultCompressionIntervalMs()))
    : defaultCompressionIntervalMs();
  return {
    lastWakeAt: now,
    ...(input.workDone > 0 && !pressure ? { lastSuccessAt: now } : {}),
    lastWorkDone: input.workDone,
    lastDurationMs: input.durationMs,
    lastSkippedReason: undefined,
    lastErrorReason: input.errorReason,
    currentBatchSize: nextBatchSize,
    currentIntervalMs: nextIntervalMs,
    successStreak: input.workDone > 0 && !pressure ? (input.previous?.successStreak ?? 0) + 1 : 0,
    pressureStreak: pressure ? (input.previous?.pressureStreak ?? 0) + 1 : 0,
    lastQueued: input.queuedAfter,
    queuedDeltaSinceLastWake: queuedDelta,
    ...(typeof drainRatePerHour === "number" ? { drainRatePerHour } : {}),
    estimatedDrainEtaMs,
  };
}

function compressionIdlePauseReason(
  snapshot: Awaited<ReturnType<typeof getLatestHealth>>,
): string | null {
  const cpu = cpuPercent(snapshot);
  const consecutiveHighCpuSamples = snapshot?.cpu?.consecutiveHighSamples ?? 0;
  const lag = snapshot?.eventLoopLagMs ?? 0;
  const kvLatency = snapshot?.kvConnectivity?.latencyMs ?? 0;
  const maxCpu = positiveInteger(
    process.env.COMPRESS_RETRY_IDLE_MAX_CPU_PERCENT,
    25,
  );
  const maxLag = positiveInteger(
    process.env.COMPRESS_RETRY_IDLE_MAX_EVENT_LOOP_LAG_MS,
    40,
  );
  const maxKvLatency = positiveInteger(
    process.env.COMPRESS_RETRY_IDLE_MAX_KV_LATENCY_MS,
    200,
  );
  if (cpu >= maxCpu && consecutiveHighCpuSamples >= 2) {
    return `idle_required_cpu_${Math.round(cpu)}_gte_${maxCpu}`;
  }
  if (lag >= maxLag) {
    return `idle_required_event_loop_lag_${Math.round(lag)}_gte_${maxLag}`;
  }
  if (kvLatency >= maxKvLatency) {
    return `idle_required_kv_latency_${Math.round(kvLatency)}_gte_${maxKvLatency}`;
  }
  return null;
}

function chooseLane(
  requested: MaintenanceLane | undefined,
  status: Awaited<ReturnType<typeof getDeferredWorkStatus>>,
): MaintenanceLane | undefined {
  if (requested) return requested;
  if (status.retrievalBlocks.queued > 0 && laneEnabled("retrieval")) {
    return "retrieval";
  }
  if (status.graphExtraction.queued > 0 && laneEnabled("graph")) {
    return "graph";
  }
  if (status.compression.queued > 0 && laneEnabled("compression")) {
    return "compression";
  }
  return undefined;
}

function workDoneFromResult(lane: MaintenanceLane, result: unknown): number {
  const record =
    result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const numberField = (field: string): number =>
    typeof record[field] === "number" ? record[field] : 0;
  if (lane === "retrieval") {
    return (
      numberField("succeeded") +
      numberField("removed") +
      numberField("retried") +
      numberField("diagnosticsRemoved") +
      numberField("refreshed") +
      numberField("refreshIndexed")
    );
  }
  if (lane === "compression") {
    return (
      numberField("succeeded") +
      numberField("removed") +
      numberField("retried") +
      numberField("queued")
    );
  }
  return numberField("extracted") + numberField("removed");
}

export function registerMaintenanceCatchUpFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::maintenance-catch-up",
    async (payload: unknown): Promise<MaintenanceCatchUpResult> => {
      const data =
        payload && typeof payload === "object"
          ? (payload as MaintenanceCatchUpPayload)
          : {};
      const requestedLane = parseLane(data.lane);
      const health = await getLatestHealth(kv).catch(() => null);
      const pauseReason = getMaintenancePauseReason(health);
      if (shouldPauseMaintenance(health) || pauseReason) {
        return {
          success: true,
          skipped: true,
          reason: pauseReason || "maintenance_paused",
          workDone: 0,
        };
      }

      const deferredWork = await getDeferredWorkStatus(kv);
      const lane = chooseLane(requestedLane, deferredWork);
      if (!lane) {
        return { success: true, skipped: true, reason: "no_deferred_work", workDone: 0, deferredWork };
      }

      const cpu = cpuPercent(health);
      const maxBatchSize = positiveInteger(data.maxBatchSize, 40);
      const requestedBudgetMs = positiveInteger(data.timeBudgetMs, 8_000);
      if (lane === "compression") {
        const idlePauseReason = compressionIdlePauseReason(health);
        if (idlePauseReason) {
          const laneState = await recordCompressionSkip(kv, idlePauseReason, deferredWork.compression.queued);
          return {
            success: true,
            skipped: true,
            lane,
            reason: idlePauseReason,
            workDone: 0,
            result: laneState ? { laneState } : undefined,
            deferredWork,
          };
        }
      }
      if (lane !== "retrieval" && cpu >= 35) {
        if (lane === "compression") {
          await recordCompressionSkip(kv, `idle_required_cpu_${Math.round(cpu)}%`, deferredWork.compression.queued);
        }
        return {
          success: true,
          skipped: true,
          lane,
          reason: `idle_required_cpu_${Math.round(cpu)}%`,
          workDone: 0,
          deferredWork,
        };
      }

      const batchSize =
        lane === "retrieval"
          ? adaptiveRetrievalBatch(cpu, maxBatchSize)
          : lane === "compression"
            ? compressionBatchFromState(
                health,
                maxBatchSize,
                await readCompressionLaneState(kv),
              )
            : Math.min(positiveInteger(data.maxBatchSize, 1), 1);
      const timeBudgetMs =
        lane === "retrieval"
          ? Math.min(requestedBudgetMs, 8_000)
          : Math.min(requestedBudgetMs, 5_000);

      const startedAt = Date.now();
      let result: unknown;
      try {
        result =
          lane === "retrieval"
            ? await sdk.trigger({
                function_id: "mem::retrieval-block-retry",
                payload: {
                  batchSize,
                  timeBudgetMs,
                  ignoreBackoff: true,
                  refreshFromState: false,
                },
              })
            : lane === "compression"
              ? await sdk.trigger({
                  function_id: "mem::compress-retry",
                  payload: {
                    batchSize,
                    timeBudgetMs,
                    scanRaw: false,
                  },
                })
              : await sdk.trigger({
                  function_id: "mem::graph-catch-up",
                  payload: {
                    batchSize,
                    scanLimit: batchSize,
                    scanObservations: false,
                  },
                });
      } catch (err) {
        if (lane === "compression") {
          const errorReason = err instanceof Error ? err.message : String(err);
          const previous = await readCompressionLaneState(kv);
          await writeCompressionLaneState(
            kv,
            previous,
            stateAfterCompressionWake({
              previous,
              queuedBefore: deferredWork.compression.queued,
              queuedAfter: deferredWork.compression.queued,
              workDone: 0,
              durationMs: Math.max(1, Date.now() - startedAt),
              batchSize,
              errorReason,
            }),
          ).catch(() => null);
        }
        throw err;
      }

      const workDone = workDoneFromResult(lane, result);
      let laneState: MaintenanceLaneState | undefined;
      if (lane === "compression") {
        const afterWork = await getDeferredWorkStatus(kv, { refresh: true }).catch(
          () => deferredWork,
        );
        const previous = await readCompressionLaneState(kv);
        laneState = await writeCompressionLaneState(
          kv,
          previous,
          stateAfterCompressionWake({
            previous,
            queuedBefore: deferredWork.compression.queued,
            queuedAfter: afterWork.compression.queued,
            workDone,
            durationMs: Math.max(1, Date.now() - startedAt),
            batchSize,
          }),
        ).catch(() => undefined);
      }

      return {
        success: true,
        lane,
        workDone,
        batchSize,
        timeBudgetMs,
        deferredWork,
        result: laneState ? { result, laneState } : result,
      };
    },
  );
}
