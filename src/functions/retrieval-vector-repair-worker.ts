import type { ISdk } from "iii-sdk";

import { getMaintenancePauseReason } from "../health/maintenance-gate.js";
import { getWriteGatePauseReason } from "../health/write-gate.js";
import { getLatestHealth } from "../health/monitor.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

const LEASE_KEY = "retrieval-vector-repair-worker-lease";
const PROGRESS_KEY = "retrieval-vector-repair-worker-progress";
const DEFAULT_WORKER_ID = "agentmemory-maintenance";
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_CANDIDATE_SCAN_LIMIT = 2_500;
const DEFAULT_TIME_BUDGET_MS = 6_000;
const DEFAULT_COVERAGE_TARGET = 0.98;

interface RetrievalVectorRepairWorkerPayload {
  workerId?: unknown;
  leaseTtlMs?: unknown;
  maxBatchSize?: unknown;
  batchSize?: unknown;
  candidateScanLimit?: unknown;
  timeBudgetMs?: unknown;
  coverageTarget?: unknown;
  resetCursor?: unknown;
  dryRun?: unknown;
  scheduleSave?: unknown;
}

interface RetrievalVectorRepairLease {
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
}

interface RetrievalVectorRepairProgress {
  updatedAt: string;
  status: "completed" | "paused" | "running";
  workerId: string;
  source?: string;
  lastPauseReason?: string;
  attempted?: number;
  backfilled?: number;
  failed?: number;
  eligibleCount?: number;
  vectorPresentBefore?: number;
  vectorPresentAfter?: number;
  vectorMissingAfter?: number;
  vectorCoverageRatioBefore?: number;
  vectorCoverageRatioAfter?: number;
  complete?: boolean;
  runs: number;
  consecutiveNoProgress: number;
}

interface RetrievalVectorBackfillResult {
  success?: boolean;
  source?: string;
  eligibleCount?: number;
  vectorPresentBefore?: number;
  vectorMissingBefore?: number;
  vectorCoverageRatioBefore?: number;
  attempted?: number;
  backfilled?: number;
  failed?: number;
  vectorPresentAfter?: number;
  vectorMissingAfter?: number;
  vectorCoverageRatioAfter?: number;
  complete?: boolean;
  pauseReason?: string;
}

export interface RetrievalVectorRepairWorkerResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  workDone: number;
  batchSize?: number;
  candidateScanLimit?: number;
  timeBudgetMs?: number;
  coverageTarget?: number;
  progress?: RetrievalVectorRepairProgress;
  result?: RetrievalVectorBackfillResult;
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

function positiveRatio(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function cpuPercent(snapshot: Awaited<ReturnType<typeof getLatestHealth>>): number {
  return snapshot?.cpu?.percent ?? 0;
}

function adaptiveBatchSize(cpu: number, maxBatchSize: number): number {
  if (cpu < 30) return Math.min(maxBatchSize, 128);
  if (cpu < 55) return Math.min(maxBatchSize, 64);
  if (cpu < 70) return Math.min(maxBatchSize, 24);
  return Math.min(maxBatchSize, 8);
}

function activeLease(
  lease: RetrievalVectorRepairLease | null,
): RetrievalVectorRepairLease | null {
  if (!lease) return null;
  if (new Date(lease.expiresAt).getTime() <= Date.now()) return null;
  return lease;
}

function workDone(result: RetrievalVectorBackfillResult): number {
  return (result.backfilled ?? 0) + (result.failed ?? 0);
}

function nextProgress(
  previous: RetrievalVectorRepairProgress | null,
  workerId: string,
  result: RetrievalVectorBackfillResult,
): RetrievalVectorRepairProgress {
  const madeProgress = (result.backfilled ?? 0) > 0;
  const now = new Date().toISOString();
  return {
    updatedAt: now,
    status: result.complete ? "completed" : result.pauseReason ? "paused" : "running",
    workerId,
    source: result.source,
    lastPauseReason: result.pauseReason,
    attempted: result.attempted,
    backfilled: result.backfilled,
    failed: result.failed,
    eligibleCount: result.eligibleCount,
    vectorPresentBefore: result.vectorPresentBefore,
    vectorPresentAfter: result.vectorPresentAfter,
    vectorMissingAfter: result.vectorMissingAfter,
    vectorCoverageRatioBefore: result.vectorCoverageRatioBefore,
    vectorCoverageRatioAfter: result.vectorCoverageRatioAfter,
    complete: result.complete,
    runs: (previous?.runs ?? 0) + 1,
    consecutiveNoProgress: madeProgress
      ? 0
      : (previous?.consecutiveNoProgress ?? 0) + 1,
  };
}

async function markPaused(
  kv: StateKV,
  workerId: string,
  reason: string,
): Promise<RetrievalVectorRepairProgress | undefined> {
  const previous = await kv
    .get<RetrievalVectorRepairProgress>(KV.config, PROGRESS_KEY)
    .catch(() => null);
  const progress: RetrievalVectorRepairProgress = {
    ...(previous ?? {
      runs: 0,
      consecutiveNoProgress: 0,
    }),
    updatedAt: new Date().toISOString(),
    status: "paused",
    workerId,
    lastPauseReason: reason,
  };
  await kv.set(KV.config, PROGRESS_KEY, progress).catch(() => progress);
  return progress;
}

export function registerRetrievalVectorRepairWorkerFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::retrieval-vector-repair-worker",
    async (payload: unknown): Promise<RetrievalVectorRepairWorkerResult> => {
      const data =
        payload && typeof payload === "object"
          ? (payload as RetrievalVectorRepairWorkerPayload)
          : {};
      const workerId = stringValue(data.workerId, DEFAULT_WORKER_ID);
      return withKeyedLock("retrieval-vector-repair-worker", async () => {
        const now = Date.now();
        const leaseTtlMs = Math.min(
          positiveInteger(data.leaseTtlMs, DEFAULT_LEASE_TTL_MS),
          5 * 60_000,
        );
        const existingLease = activeLease(
          await kv
            .get<RetrievalVectorRepairLease>(KV.config, LEASE_KEY)
            .catch(() => null),
        );
        if (existingLease && existingLease.workerId !== workerId) {
          return {
            success: true,
            skipped: true,
            reason: "repair_worker_lease_held",
            workDone: 0,
          };
        }

        const health = await getLatestHealth(kv).catch(() => null);
        const pauseReason =
          getWriteGatePauseReason(health, "llm_work") ||
          getWriteGatePauseReason(health, "index_persistence") ||
          getMaintenancePauseReason(health);
        if (pauseReason) {
          const progress = await markPaused(kv, workerId, pauseReason);
          return {
            success: true,
            skipped: true,
            reason: pauseReason,
            workDone: 0,
            progress,
          };
        }

        const lease: RetrievalVectorRepairLease = {
          workerId,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + leaseTtlMs).toISOString(),
        };
        await kv.set(KV.config, LEASE_KEY, lease);

        try {
          const cpu = cpuPercent(health);
          const maxBatchSize = Math.min(
            256,
            positiveInteger(
              data.maxBatchSize ??
                data.batchSize ??
                process.env.RETRIEVAL_VECTOR_REPAIR_MAX_BATCH_SIZE,
              DEFAULT_MAX_BATCH_SIZE,
            ),
          );
          const batchSize = Math.min(
            positiveInteger(data.batchSize, adaptiveBatchSize(cpu, maxBatchSize)),
            maxBatchSize,
          );
          const candidateScanLimit = positiveInteger(
            data.candidateScanLimit ??
              process.env.RETRIEVAL_VECTOR_REPAIR_SCAN_LIMIT,
            Math.max(DEFAULT_CANDIDATE_SCAN_LIMIT, batchSize * 20),
          );
          const timeBudgetMs = positiveInteger(
            data.timeBudgetMs ??
              process.env.RETRIEVAL_VECTOR_REPAIR_TIME_BUDGET_MS,
            DEFAULT_TIME_BUDGET_MS,
          );
          const coverageTarget = positiveRatio(
            data.coverageTarget ??
              process.env.RETRIEVAL_VECTOR_REPAIR_COVERAGE_TARGET,
            DEFAULT_COVERAGE_TARGET,
          );
          const scheduleSave = booleanValue(data.scheduleSave, true);
          const result = (await sdk.trigger({
            function_id: "mem::retrieval-vector-backfill",
            payload: {
              batchSize,
              candidateScanLimit,
              timeBudgetMs,
              concurrency: 1,
              coverageTarget,
              scheduleSave,
              resetCursor: data.resetCursor === true,
              dryRun: data.dryRun === true,
            },
          })) as RetrievalVectorBackfillResult;

          const previous = await kv
            .get<RetrievalVectorRepairProgress>(KV.config, PROGRESS_KEY)
            .catch(() => null);
          const progress = nextProgress(previous, workerId, result);
          await kv.set(KV.config, PROGRESS_KEY, progress).catch(() => progress);
          return {
            success: true,
            skipped: result.pauseReason ? true : undefined,
            reason: result.pauseReason,
            workDone: workDone(result),
            batchSize,
            candidateScanLimit,
            timeBudgetMs,
            coverageTarget,
            progress,
            result,
          };
        } finally {
          const currentLease = await kv
            .get<RetrievalVectorRepairLease>(KV.config, LEASE_KEY)
            .catch(() => null);
          if (currentLease?.workerId === workerId) {
            await kv.delete(KV.config, LEASE_KEY).catch(() => {});
          }
        }
      });
    },
  );
}
