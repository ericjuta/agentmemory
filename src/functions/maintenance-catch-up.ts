import type { ISdk } from "iii-sdk";

import { shouldPauseMaintenance, getMaintenancePauseReason } from "../health/maintenance-gate.js";
import { getLatestHealth } from "../health/monitor.js";
import type { StateKV } from "../state/kv.js";
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

function cpuPercent(snapshot: Awaited<ReturnType<typeof getLatestHealth>>): number {
  return snapshot?.cpu?.percent ?? 0;
}

function adaptiveRetrievalBatch(cpu: number, maxBatchSize: number): number {
  if (cpu < 30) return Math.min(maxBatchSize, 40);
  if (cpu < 55) return Math.min(maxBatchSize, 25);
  if (cpu < 70) return Math.min(maxBatchSize, 10);
  return Math.min(maxBatchSize, 5);
}

function chooseLane(
  requested: MaintenanceLane | undefined,
  status: Awaited<ReturnType<typeof getDeferredWorkStatus>>,
): MaintenanceLane | undefined {
  if (requested) return requested;
  if (status.retrievalBlocks.queued > 0) return "retrieval";
  if (status.compression.queued > 0) return "compression";
  if (status.graphExtraction.queued > 0) return "graph";
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

      if (lane !== "retrieval" && deferredWork.retrievalBlocks.queued > 0) {
        return {
          success: true,
          skipped: true,
          lane,
          reason: "retrieval_backlog_priority",
          workDone: 0,
          deferredWork,
        };
      }
      if (lane !== "retrieval" && cpu >= 35) {
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
          : Math.min(positiveInteger(data.maxBatchSize, lane === "graph" ? 1 : 5), lane === "graph" ? 1 : 5);
      const timeBudgetMs =
        lane === "retrieval"
          ? Math.min(requestedBudgetMs, 8_000)
          : Math.min(requestedBudgetMs, 5_000);

      const result =
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

      return {
        success: true,
        lane,
        workDone: workDoneFromResult(lane, result),
        batchSize,
        timeBudgetMs,
        deferredWork,
        result,
      };
    },
  );
}
