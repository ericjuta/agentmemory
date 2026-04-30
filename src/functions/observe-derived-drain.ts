import type { ISdk } from "iii-sdk";

import { logger } from "../logger.js";
import { getLatestHealth } from "../health/monitor.js";
import {
  getMaintenancePauseReason,
  shouldPauseMaintenance,
} from "../health/maintenance-gate.js";
import { getDerivedKvWritePauseReason } from "../health/write-gate.js";
import type { StateKV } from "../state/kv.js";
import { indexCompressedObservation } from "../state/observation-indexing.js";
import { KV } from "../state/schema.js";
import type {
  CompressedObservation,
  ObserveDerivedRetryEntry,
} from "../types.js";
import { getSearchIndex } from "./search.js";
import { upsertObservationRetrievalBlock } from "./retrieval-blocks.js";
import {
  upsertTurnCapsuleFromCompressed,
  upsertTurnCapsuleFromRaw,
} from "./turn-capsules.js";

interface ObserveDerivedDrainPayload {
  batchSize?: unknown;
  timeBudgetMs?: unknown;
  ignoreBackoff?: unknown;
}

interface ObserveDerivedDrainResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  queued: number;
  processed: number;
  indexedObservations: number;
  upsertedRetrievalBlocks: number;
  upsertedCapsules: number;
  removed: number;
  deferred: number;
  timedOut: boolean;
  batchSize: number;
  timeBudgetMs: number;
}

const MAX_BATCH_SIZE = 25;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_TIME_BUDGET_MS = 2_000;
const MAX_TIME_BUDGET_MS = 10_000;
const MIN_WORK_MS = 100;
const MAX_RETRIES = 5;

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

function isDue(entry: ObserveDerivedRetryEntry, nowMs: number): boolean {
  const nextAttemptAt = entry.nextAttemptAt;
  if (typeof nextAttemptAt !== "string") return true;
  const parsed = Date.parse(nextAttemptAt);
  return Number.isNaN(parsed) || parsed <= nowMs;
}

function nextAttemptAt(retries: number): string {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, retries - 1));
  return new Date(Date.now() + delayMs).toISOString();
}

function isCompressedObservation(
  value: unknown,
): value is CompressedObservation {
  const row = value as Partial<CompressedObservation>;
  return (
    !!row &&
    typeof row.id === "string" &&
    typeof row.sessionId === "string" &&
    typeof row.timestamp === "string" &&
    typeof row.title === "string" &&
    typeof row.narrative === "string" &&
    Array.isArray(row.facts) &&
    Array.isArray(row.concepts) &&
    Array.isArray(row.files)
  );
}

function emptyResult(
  reason: string,
  batchSize: number,
  timeBudgetMs: number,
): ObserveDerivedDrainResult {
  return {
    success: true,
    skipped: true,
    reason,
    queued: 0,
    processed: 0,
    indexedObservations: 0,
    upsertedRetrievalBlocks: 0,
    upsertedCapsules: 0,
    removed: 0,
    deferred: 0,
    timedOut: false,
    batchSize,
    timeBudgetMs,
  };
}

async function markFailed(
  kv: StateKV,
  entry: ObserveDerivedRetryEntry,
  error: unknown,
): Promise<void> {
  const retries = entry.retries + 1;
  const message = error instanceof Error ? error.message : String(error);
  if (retries >= MAX_RETRIES) {
    await kv
      .delete(KV.observeDerivedRetry, entry.observationId)
      .catch(() => {});
    logger.warn("Observe derived drain dropped exhausted entry", {
      observationId: entry.observationId,
      sessionId: entry.sessionId,
      retries,
      error: message,
    });
    return;
  }
  await kv.set(KV.observeDerivedRetry, entry.observationId, {
    ...entry,
    retries,
    lastDeferredAt: new Date().toISOString(),
    lastError: message,
    nextAttemptAt: nextAttemptAt(retries),
  });
}

export function registerObserveDerivedDrainFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::observe-derived-drain",
    async (payload: unknown): Promise<ObserveDerivedDrainResult> => {
      const data =
        payload && typeof payload === "object"
          ? (payload as ObserveDerivedDrainPayload)
          : {};
      const batchSize = Math.min(
        positiveInteger(
          data.batchSize ??
            process.env.AGENTMEMORY_OBSERVE_DERIVED_DRAIN_BATCH_SIZE,
          DEFAULT_BATCH_SIZE,
        ),
        MAX_BATCH_SIZE,
      );
      const timeBudgetMs = Math.min(
        positiveInteger(
          data.timeBudgetMs ??
            process.env.AGENTMEMORY_OBSERVE_DERIVED_DRAIN_TIME_BUDGET_MS,
          DEFAULT_TIME_BUDGET_MS,
        ),
        MAX_TIME_BUDGET_MS,
      );
      const health = await getLatestHealth(kv).catch(() => null);
      const maintenancePauseReason = getMaintenancePauseReason(health);
      if (shouldPauseMaintenance(health) || maintenancePauseReason) {
        return emptyResult(
          maintenancePauseReason || "maintenance_paused",
          batchSize,
          timeBudgetMs,
        );
      }
      const writePauseReason = await getDerivedKvWritePauseReason(kv);
      if (writePauseReason) {
        return emptyResult(writePauseReason, batchSize, timeBudgetMs);
      }

      const entries = await kv.list<ObserveDerivedRetryEntry>(
        KV.observeDerivedRetry,
      );
      const deadlineMs = Date.now() + timeBudgetMs;
      const nowMs = Date.now();
      let processed = 0;
      let indexedObservations = 0;
      let upsertedRetrievalBlocks = 0;
      let upsertedCapsules = 0;
      let removed = 0;
      let deferred = 0;
      let timedOut = false;

      for (const entry of entries) {
        if (data.ignoreBackoff !== true && !isDue(entry, nowMs)) {
          deferred++;
          continue;
        }
        if (processed >= batchSize) {
          deferred++;
          continue;
        }
        if (deadlineMs - Date.now() <= MIN_WORK_MS) {
          timedOut = true;
          deferred++;
          continue;
        }
        processed++;
        const observation = await kv
          .get<CompressedObservation>(
            KV.observations(entry.sessionId),
            entry.observationId,
          )
          .catch(() => null);
        if (!isCompressedObservation(observation)) {
          await kv
            .delete(KV.observeDerivedRetry, entry.observationId)
            .catch(() => {});
          removed++;
          continue;
        }

        try {
          await indexCompressedObservation(kv, getSearchIndex(), observation, {
            syncEmbedding: false,
          });
          indexedObservations++;
          const block = await upsertObservationRetrievalBlock(
            kv,
            observation,
            entry.project,
            { skipEmbedding: true },
          );
          if (block) upsertedRetrievalBlocks++;
          await upsertTurnCapsuleFromRaw(
            kv,
            entry.sessionId,
            entry.project,
            entry.cwd,
            entry.raw,
          );
          await upsertTurnCapsuleFromCompressed(kv, observation);
          upsertedCapsules++;
          await kv.delete(KV.observeDerivedRetry, entry.observationId);
        } catch (error) {
          await markFailed(kv, entry, error);
          deferred++;
        }
      }

      return {
        success: true,
        queued: entries.length,
        processed,
        indexedObservations,
        upsertedRetrievalBlocks,
        upsertedCapsules,
        removed,
        deferred,
        timedOut,
        batchSize,
        timeBudgetMs,
      };
    },
  );
}
