// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { TriggerAction, type ISdk } from "iii-sdk";
import type {
  RawObservation,
  CompressedObservation,
  CompressRetryEntry,
  ObservationType,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  COMPRESSION_SYSTEM,
  buildCompressionPrompt,
} from "../prompts/compression.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { getSearchIndex } from "./search.js";
import { CompressOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreCompression } from "../eval/quality.js";
import { compressWithRetry } from "../eval/self-correct.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";
import { getLlmWorkPauseReason } from "../health/write-gate.js";
import { upsertTurnCapsuleFromCompressed } from "./turn-capsules.js";
import { Semaphore } from "../state/semaphore.js";
import type { CompressionTracker } from "../state/compression-tracker.js";
import { indexCompressedObservation } from "../state/observation-indexing.js";
import { upsertObservationRetrievalBlock } from "./retrieval-blocks.js";
import { isAutoCompressEnabled } from "../config.js";

/** Cap concurrent LLM compression calls to avoid starving the engine. */
const compressSemaphore = new Semaphore(6);
const DEFAULT_COMPRESS_RETRY_SCAN_LIMIT = 25;
const DEFAULT_COMPRESS_RETRY_BATCH_SIZE = 5;
const DEFAULT_COMPRESS_RETRY_TIME_BUDGET_MS = 20_000;
const MIN_COMPRESS_RETRY_WORK_MS = 250;
const TIMEOUT = Symbol("timeout");

export function getCompressMetrics() {
  return { active: compressSemaphore.active, pending: compressSemaphore.pending };
}

const VALID_TYPES = new Set<string>([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "other",
]);

function isStateKvPressureError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("statekv") &&
    (normalized.includes("timed out") ||
      normalized.includes("temporarily unavailable"))
  );
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

function remainingBudgetMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function settleWithin<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (timeoutMs <= 0) return { timedOut: true };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  const result = await Promise.race([work, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (result === TIMEOUT) {
    work.catch((error) => {
      logger.warn(`${label} finished after retry time budget with error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { timedOut: true };
  }
  return { timedOut: false, value: result as T };
}

function isRawObservation(value: unknown): value is RawObservation {
  const row = value as Partial<RawObservation> & { title?: unknown };
  return (
    !!row &&
    typeof row.id === "string" &&
    typeof row.sessionId === "string" &&
    typeof row.hookType === "string" &&
    typeof row.title !== "string"
  );
}

export async function enqueueCompressionRetry(
  kv: StateKV,
  data: { observationId: string; sessionId: string; error?: string },
): Promise<void> {
  const existing = await kv
    .get<CompressRetryEntry>(KV.compressRetry, data.observationId)
    .catch(() => null);
  const failedAt = existing?.failedAt ?? new Date().toISOString();
  await kv
    .set(KV.compressRetry, data.observationId, {
      obsId: data.observationId,
      sessionId: data.sessionId,
      retries: existing?.retries ?? 0,
      failedAt,
      lastError: data.error,
    } satisfies CompressRetryEntry)
    .catch((err) => {
      logger.warn("Failed to queue compression retry", {
        obsId: data.observationId,
        sessionId: data.sessionId,
        error: err instanceof Error ? err.message : String(err),
        originalError: data.error,
      });
    });
}

async function enqueueRawCompressionBacklog(
  kv: StateKV,
  existingEntries: Map<string, CompressRetryEntry>,
  limit: number,
): Promise<{ queued: number; scanned: number }> {
  if (limit <= 0) return { queued: 0, scanned: 0 };
  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  let queued = 0;
  let scanned = 0;

  for (const session of sessions) {
    if (queued >= limit || scanned >= limit) break;
    const observations = await kv
      .list<unknown>(KV.observations(session.id))
      .catch(() => []);
    for (const observation of observations) {
      if (queued >= limit || scanned >= limit) break;
      scanned++;
      if (!isRawObservation(observation)) continue;
      if (existingEntries.has(observation.id)) continue;
      const entry: CompressRetryEntry = {
        obsId: observation.id,
        sessionId: observation.sessionId || session.id,
        retries: 0,
        failedAt: new Date().toISOString(),
        lastError: "raw_uncompressed_backlog_scan",
      };
      existingEntries.set(entry.obsId, entry);
      await kv.set(KV.compressRetry, entry.obsId, entry).catch((err) => {
        logger.warn("Failed to persist compression backlog entry", {
          obsId: entry.obsId,
          sessionId: entry.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      queued++;
    }
  }

  return { queued, scanned };
}

function parseCompressionXml(
  xml: string,
): Omit<CompressedObservation, "id" | "sessionId" | "timestamp"> | null {
  const rawType = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  if (!rawType || !title) return null;
  const type = VALID_TYPES.has(rawType) ? rawType : "other";

  return {
    type: type as ObservationType,
    title,
    subtitle: getXmlTag(xml, "subtitle") || undefined,
    facts: getXmlChildren(xml, "facts", "fact"),
    narrative: getXmlTag(xml, "narrative"),
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    importance: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "importance") || "5", 10) || 5),
    ),
  };
}

export function registerCompressFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
  tracker?: CompressionTracker,
  graphEnabled?: boolean,
): void {
  sdk.registerFunction("mem::compress",
    async (data: {
      observationId: string;
      sessionId: string;
      raw: RawObservation;
    }) => {
      try {
        return await compressSemaphore.run(async () => {
          const startMs = Date.now();
          const initialPauseReason = await getLlmWorkPauseReason(kv);
          if (initialPauseReason) {
            logger.warn("Compression deferred while health is unhealthy", {
              obsId: data.observationId,
              sessionId: data.sessionId,
              reason: initialPauseReason,
            });
            await enqueueCompressionRetry(kv, {
              observationId: data.observationId,
              sessionId: data.sessionId,
              error: initialPauseReason,
            });
            return {
              success: false,
              error: "health_unhealthy",
              deferred: true,
              reason: initialPauseReason,
            };
          }

          const prompt = buildCompressionPrompt({
            hookType: data.raw.hookType,
            toolName: data.raw.toolName,
            toolInput: data.raw.toolInput,
            toolOutput: data.raw.toolOutput,
            userPrompt: data.raw.userPrompt,
            assistantResponse: data.raw.assistantResponse,
            timestamp: data.raw.timestamp,
          });

          try {
            const validator = (response: string) => {
              const parsed = parseCompressionXml(response);
              if (!parsed) return { valid: false, errors: ["xml_parse_failed"] };
              const result = validateOutput(
                CompressOutputSchema,
                parsed,
                "mem::compress",
              );
              return result.valid
                ? { valid: true }
                : { valid: false, errors: result.result.errors };
            };

            const { response, retried } = await compressWithRetry(
              provider,
              COMPRESSION_SYSTEM,
              prompt,
              validator,
              1,
            );

            const parsed = parseCompressionXml(response);
            if (!parsed) {
              const latencyMs = Date.now() - startMs;
              if (metricsStore) {
                await metricsStore.record("mem::compress", latencyMs, false);
              }
              logger.warn("Failed to parse compression XML", {
                obsId: data.observationId,
                retried,
              });
              return { success: false, error: "parse_failed" };
            }

            const qualityScore = scoreCompression(parsed);

            const compressed: CompressedObservation = {
              id: data.observationId,
              sessionId: data.sessionId,
              timestamp: data.raw.timestamp,
              source: data.raw.source,
              payloadVersion: data.raw.payloadVersion,
              eventId: data.raw.eventId,
              sourceTimestamp: data.raw.sourceTimestamp,
              capabilities: data.raw.capabilities,
              persistenceClass: data.raw.persistenceClass,
              turnId: data.raw.turnId,
              ...parsed,
              confidence: qualityScore / 100,
            };

            await kv.set(
              KV.observations(data.sessionId),
              data.observationId,
              compressed,
            );

            await indexCompressedObservation(kv, getSearchIndex(), compressed, {
              syncEmbedding: false,
            });
            const sessionProject =
              (await kv.get<{ project?: string }>(KV.sessions, data.sessionId).catch(() => null))
                ?.project || "";
            if (sessionProject) {
              await upsertObservationRetrievalBlock(kv, compressed, sessionProject);
            }

            const streamResults = await Promise.allSettled([
              sdk.trigger({
                function_id: "stream::set",
                payload: {
                  stream_name: STREAM.name,
                  group_id: STREAM.group(data.sessionId),
                  item_id: data.observationId,
                  data: { type: "compressed", observation: compressed },
                },
              }),
              sdk.trigger({
                function_id: "stream::send",
                payload: {
                  stream_name: STREAM.name,
                  group_id: STREAM.viewerGroup,
                  id: `compressed-${data.observationId}`,
                  type: "compressed_observation",
                  data: {
                    type: "compressed",
                    observation: compressed,
                    sessionId: data.sessionId,
                  },
                },
                action: TriggerAction.Void(),
              }),
            ]);
            for (const result of streamResults) {
              if (result.status === "rejected") {
                logger.warn("Non-fatal stream publish failure after compress", {
                  sessionId: data.sessionId,
                  observationId: data.observationId,
                  error:
                    result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                });
              }
            }

            await upsertTurnCapsuleFromCompressed(kv, compressed);

            const latencyMs = Date.now() - startMs;
            if (metricsStore) {
              await metricsStore.record(
                "mem::compress",
                latencyMs,
                true,
                qualityScore,
              );
            }
            await kv.delete(KV.compressRetry, data.observationId).catch(() => {});

            if (graphEnabled) {
              void sdk.trigger({
                function_id: "mem::graph-extract",
                payload: {
                  observations: [compressed],
                },
              }).catch(() => {});
            }

            logger.info("Observation compressed", {
              obsId: data.observationId,
              type: compressed.type,
              importance: compressed.importance,
              qualityScore,
              retried,
            });

            return { success: true, compressed, qualityScore };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const latencyMs = Date.now() - startMs;
            if (metricsStore) {
              await metricsStore.record("mem::compress", latencyMs, false);
            }
            logger.error("Compression failed", {
              obsId: data.observationId,
              error: msg,
            });

            const pauseReason = await getLlmWorkPauseReason(kv);
            if (pauseReason || isStateKvPressureError(msg)) {
              await enqueueCompressionRetry(kv, {
                observationId: data.observationId,
                sessionId: data.sessionId,
                error: pauseReason || msg,
              });
            } else {
              await enqueueCompressionRetry(kv, {
                observationId: data.observationId,
                sessionId: data.sessionId,
                error: msg,
              });
            }

            return { success: false, error: "compression_failed" };
          }
        });
      } finally {
        tracker?.decrement(data.sessionId);
      }
    },
  );

  sdk.registerFunction(
    "mem::compress-retry",
    async (payload: unknown) => {
      const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const pauseReason = await getLlmWorkPauseReason(kv);
      if (pauseReason) {
        return {
          retried: 0,
          removed: 0,
          queued: 0,
          scanned: 0,
          skipped: true,
          reason: pauseReason,
        };
      }
      const entries = await kv.list<CompressRetryEntry>(KV.compressRetry);
      const entriesByObs = new Map(entries.map((entry) => [entry.obsId, entry] as const));
      const scanLimit = positiveInteger(
        data.scanLimit ?? process.env.COMPRESS_RETRY_SCAN_LIMIT,
        DEFAULT_COMPRESS_RETRY_SCAN_LIMIT,
      );
      const batchSize = positiveInteger(
        data.batchSize ?? process.env.COMPRESS_RETRY_BATCH_SIZE,
        DEFAULT_COMPRESS_RETRY_BATCH_SIZE,
      );
      const timeBudgetMs = positiveInteger(
        data.timeBudgetMs ?? process.env.COMPRESS_RETRY_TIME_BUDGET_MS,
        DEFAULT_COMPRESS_RETRY_TIME_BUDGET_MS,
      );
      const deadlineMs = Date.now() + timeBudgetMs;
      const scan =
        typeof data.scanRaw === "boolean" ? data.scanRaw : isAutoCompressEnabled();
      const backlog = scan
        ? await enqueueRawCompressionBacklog(kv, entriesByObs, scanLimit)
        : { queued: 0, scanned: 0 };
      const retryEntries = [...entriesByObs.values()];
      let retried = 0;
      let removed = 0;
      let succeeded = 0;
      let deferred = 0;
      let processed = 0;
      let timedOut = false;

      for (const entry of retryEntries) {
        if (processed >= batchSize) {
          deferred++;
          continue;
        }
        if (remainingBudgetMs(deadlineMs) <= MIN_COMPRESS_RETRY_WORK_MS) {
          timedOut = true;
          deferred++;
          continue;
        }
        processed++;
        if (entry.retries >= 3) {
          await kv.delete(KV.compressRetry, entry.obsId).catch(() => {});
          removed++;
          continue;
        }

        const raw = await kv
          .get(KV.observations(entry.sessionId), entry.obsId)
          .catch(() => null);
        if (!raw || (raw as any).title) {
          // Already compressed or missing
          await kv.delete(KV.compressRetry, entry.obsId).catch(() => {});
          removed++;
          continue;
        }

        const compressed = await settleWithin(
          sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: entry.obsId,
              sessionId: entry.sessionId,
              raw,
            },
          }).catch((err) => ({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          })),
          remainingBudgetMs(deadlineMs),
          "Compression retry",
        );
        if (compressed.timedOut) {
          timedOut = true;
          deferred++;
          continue;
        }
        const result = compressed.value;
        if ((result as { success?: boolean })?.success) {
          await kv.delete(KV.compressRetry, entry.obsId).catch(() => {});
          succeeded++;
        } else {
          await kv
            .set(KV.compressRetry, entry.obsId, {
              ...entry,
              retries: entry.retries + 1,
              lastError:
                (result as { error?: string })?.error || entry.lastError,
            })
            .catch(() => {});
          retried++;
        }
      }

      if (retried > 0 || removed > 0 || succeeded > 0 || backlog.queued > 0) {
        logger.info("Compress retry complete", {
          retried,
          removed,
          succeeded,
          deferred,
          processed,
          queued: backlog.queued,
          scanned: backlog.scanned,
          timedOut,
        });
      }
      return {
        retried,
        removed,
        succeeded,
        deferred,
        processed,
        queued: backlog.queued,
        scanned: backlog.scanned,
        ...(timedOut ? { timedOut: true, timeBudgetMs } : {}),
      };
    },
  );
}
