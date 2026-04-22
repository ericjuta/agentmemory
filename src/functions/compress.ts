// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { TriggerAction, type ISdk } from "iii-sdk";
import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
  MemoryProvider,
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
import { upsertTurnCapsuleFromCompressed } from "./turn-capsules.js";
import { Semaphore } from "../state/semaphore.js";
import type { CompressionTracker } from "../state/compression-tracker.js";
import { indexCompressedObservation } from "../state/observation-indexing.js";
import { upsertObservationRetrievalBlock } from "./retrieval-blocks.js";

/** Cap concurrent LLM compression calls to avoid starving the engine. */
const compressSemaphore = new Semaphore(6);

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

            await indexCompressedObservation(kv, getSearchIndex(), compressed);
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

            await kv.set(KV.compressRetry, data.observationId, {
              obsId: data.observationId,
              sessionId: data.sessionId,
              retries: 0,
              failedAt: new Date().toISOString(),
            }).catch(() => {});

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
    async () => {
      const entries = await kv.list<{
        obsId: string;
        sessionId: string;
        retries: number;
        failedAt: string;
      }>(KV.compressRetry);
      let retried = 0;
      let removed = 0;

      for (const entry of entries) {
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

        // Re-trigger compression (will go through semaphore)
        void sdk.trigger({
          function_id: "mem::compress",
          payload: {
            observationId: entry.obsId,
            sessionId: entry.sessionId,
            raw,
          },
        }).catch(() => {});

        // Update retry count
        await kv
          .set(KV.compressRetry, entry.obsId, {
            ...entry,
            retries: entry.retries + 1,
          })
          .catch(() => {});
        retried++;
      }

      if (retried > 0 || removed > 0) {
        logger.info("Compress retry complete", { retried, removed });
      }
      return { retried, removed };
    },
  );
}
