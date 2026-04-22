// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { SUMMARY_SYSTEM, buildSummaryPrompt } from "../prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";
import { upsertSummaryRetrievalBlock } from "./retrieval-blocks.js";

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const title = getXmlTag(xml, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(xml, "narrative"),
    keyDecisions: getXmlChildren(xml, "decisions", "decision"),
    filesModified: getXmlChildren(xml, "files", "file"),
    concepts: getXmlChildren(xml, "concepts", "concept"),
    observationCount: obsCount,
  };
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::summarize", 
    async (data: { sessionId: string } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      try {
        const prompt = buildSummaryPrompt(compressed);
        const response = await provider.summarize(SUMMARY_SYSTEM, prompt);
        const summary = parseSummaryXml(
          response,
          sessionId,
          session.project,
          compressed.length,
        );

        if (!summary) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Failed to parse summary XML", {
            sessionId,
          });
          return { success: false, error: "parse_failed" };
        }

        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return { success: false, error: "validation_failed" };
        }

        const qualityScore = scoreSummary(summaryForValidation);

        await kv.set(KV.summaries, sessionId, summary);
        await upsertSummaryRetrievalBlock(kv, summary);
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
        });

        // Memory usefulness feedback loop
        const injections = await kv.get<{
          sessionId: string;
          memoryIds: string[];
          timestamp: string;
        }>(KV.contextInjections, data.sessionId).catch(() => null);

        if (injections && injections.memoryIds.length > 0) {
          const sessionQuality = compressed.length >= 3 ? "good" : "low";
          const strengthDelta = sessionQuality === "good" ? 0.2 : -0.1;

          for (const memId of injections.memoryIds) {
            // Try Memory store
            const mem = await kv.get<any>(KV.memories, memId).catch(() => null);
            if (mem && typeof mem.strength === "number") {
              mem.strength = Math.max(1, Math.min(10, mem.strength + strengthDelta));
              mem.lastAccessedAt = new Date().toISOString();
              await kv.set(KV.memories, memId, mem).catch(() => {});
              continue;
            }
            // Try Semantic store
            const sem = await kv.get<any>(KV.semantic, memId).catch(() => null);
            if (sem && typeof sem.strength === "number") {
              sem.strength = Math.max(0.1, Math.min(1, sem.strength + strengthDelta / 10));
              sem.accessCount = (sem.accessCount || 0) + 1;
              sem.lastAccessedAt = new Date().toISOString();
              await kv.set(KV.semantic, memId, sem).catch(() => {});
              continue;
            }
            // Try Procedural store
            const proc = await kv.get<any>(KV.procedural, memId).catch(() => null);
            if (proc && typeof proc.strength === "number") {
              proc.strength = Math.max(0.1, Math.min(1, proc.strength + strengthDelta / 10));
              proc.frequency = (proc.frequency || 0) + 1;
              await kv.set(KV.procedural, memId, proc).catch(() => {});
            }
          }

          // Cleanup injection record
          await kv.delete(KV.contextInjections, data.sessionId).catch(() => {});

          ctx.logger.info("Memory feedback applied", {
            sessionId: data.sessionId,
            memoriesAdjusted: injections.memoryIds.length,
            sessionQuality,
            strengthDelta,
          });
        }

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
        });

        return { success: true, summary, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return { success: false, error: msg };
      }
    },
  );
}
