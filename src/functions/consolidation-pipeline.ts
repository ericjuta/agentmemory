// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import { getConsolidationDecayDays, isConsolidationEnabled, getEnvVar } from "../config.js";
import { logger } from "../logger.js";
import { Semaphore } from "../state/semaphore.js";
import {
  upsertProceduralRetrievalBlock,
  upsertSemanticRetrievalBlock,
} from "./retrieval-blocks.js";

const consolidationSemaphore = new Semaphore(2);

function applyDecay(
  items: Array<{
    id: string;
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): string[] {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return [];
  const now = Date.now();
  const changed: string[] = [];
  for (const item of items) {
    const originalStrength = item.strength;
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
      if (item.strength !== originalStrength) {
        changed.push(item.id);
      }
    }
  }
  return changed;
}

function getDecayMaxItemsPerRun(): number {
  const raw = parseInt(getEnvVar("CONSOLIDATION_DECAY_MAX_ITEMS") || "100", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return raw;
}

function selectDecayBatch<T extends {
  lastAccessedAt?: string;
  updatedAt: string;
}>(items: T[], maxItems: number): T[] {
  return [...items]
    .sort((a, b) => {
      const aTime = new Date(a.lastAccessedAt || a.updatedAt).getTime();
      const bTime = new Date(b.lastAccessedAt || b.updatedAt).getTime();
      return aTime - bTime;
    })
    .slice(0, maxItems);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function singleProject(values: Array<string | undefined>): string | undefined {
  const projects = uniqueStrings(values);
  return projects.length === 1 ? projects[0] : undefined;
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "CONSOLIDATION_ENABLED is not set to true" };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const decayMaxItems = getDecayMaxItemsPerRun();
      const results: Record<string, unknown> = {};

      if (tier === "all" || tier === "semantic") {
        const summaries = (await kv.list<SessionSummary>(KV.summaries))
          .filter((summary) => !data?.project || summary.project === data.project);
        const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 20);

          const prompt = buildSemanticMergePrompt(
            recentSummaries.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              concepts: s.concepts,
            })),
          );

          try {
            const response = await consolidationSemaphore.run(() =>
              provider.summarize(SEMANTIC_MERGE_SYSTEM, prompt),
            );

            const factRegex = /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
            let match;
            let newFacts = 0;
            const now = new Date().toISOString();

            while ((match = factRegex.exec(response)) !== null) {
              const parsedConf = parseFloat(match[1]);
              const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
              const fact = match[2].trim();
              const sourceProjects = uniqueStrings(recentSummaries.map((s) => s.project));
              const project = data?.project || singleProject(sourceProjects);

              const existing = existingSemantic.find(
                (s) =>
                  s.fact.toLowerCase() === fact.toLowerCase() &&
                  (s.project || undefined) === project,
              );
              if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = now;
                existing.updatedAt = now;
                existing.confidence = Math.max(existing.confidence, confidence);
                existing.project = project;
                existing.sourceScope = project ? "project" : "global";
                existing.sourceProjects = project ? sourceProjects : [];
                existing.sourceSessionIds = uniqueStrings([
                  ...existing.sourceSessionIds,
                  ...recentSummaries.map((s) => s.sessionId),
                ]);
                await kv.set(KV.semantic, existing.id, existing);
                await upsertSemanticRetrievalBlock(kv, existing);
              } else {
                const sem: SemanticMemory = {
                  id: generateId("sem"),
                  fact,
                  confidence,
                  sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                  sourceMemoryIds: [],
                  project,
                  sourceScope: project ? "project" : "global",
                  sourceProjects: project ? sourceProjects : [],
                  accessCount: 1,
                  lastAccessedAt: now,
                  strength: confidence,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.semantic, sem.id, sem);
                await upsertSemanticRetrievalBlock(kv, sem);
                newFacts++;
              }
            }
            results.semantic = { newFacts, totalSummaries: summaries.length };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Semantic consolidation failed", { error: msg });
            results.semantic = { error: msg };
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project: data?.project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = (await kv.list<Memory>(KV.memories))
          .filter((memory) => !data?.project || memory.project === data.project);
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .map((m) => ({
            id: m.id,
            project: m.project,
            content: m.content,
            frequency: m.sessionIds.length || 1,
          }))
          .filter((p) => p.frequency >= 2);

        if (patterns.length >= 2) {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await consolidationSemaphore.run(() =>
              provider.summarize(PROCEDURAL_EXTRACTION_SYSTEM, prompt),
            );

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            const existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];
              const sourceProjects = uniqueStrings(patterns.map((p) => p.project));
              const project = data?.project || singleProject(sourceProjects);
              const sourceMemoryIds = patterns.map((p) => p.id);

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = existingProcs.find(
                (p) =>
                  p.name.toLowerCase() === name.toLowerCase() &&
                  (p.project || undefined) === project,
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                existing.project = project;
                existing.sourceScope = project ? "project" : "global";
                existing.sourceProjects = project ? sourceProjects : [];
                existing.sourceMemoryIds = uniqueStrings([
                  ...(existing.sourceMemoryIds || []),
                  ...sourceMemoryIds,
                ]);
                await kv.set(KV.procedural, existing.id, existing);
                await upsertProceduralRetrievalBlock(kv, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds: [],
                  sourceMemoryIds,
                  project,
                  sourceScope: project ? "project" : "global",
                  sourceProjects: project ? sourceProjects : [],
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                await upsertProceduralRetrievalBlock(kv, proc);
                newProcs++;
              }
            }
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = selectDecayBatch(
          await kv.list<SemanticMemory>(KV.semantic),
          decayMaxItems,
        );
        const changedSemanticIds = new Set(applyDecay(semantic, decayDays));
        for (const s of semantic) {
          if (!changedSemanticIds.has(s.id)) continue;
          await kv.set(KV.semantic, s.id, s);
          await upsertSemanticRetrievalBlock(kv, s);
        }

        const procedural = selectDecayBatch(
          await kv.list<ProceduralMemory>(KV.procedural),
          decayMaxItems,
        );
        const changedProceduralIds = new Set(
          applyDecay(procedural, decayDays),
        );
        for (const p of procedural) {
          if (!changedProceduralIds.has(p.id)) continue;
          await kv.set(KV.procedural, p.id, p);
          await upsertProceduralRetrievalBlock(kv, p);
        }

        results.decay = {
          semanticProcessed: semantic.length,
          semanticUpdated: changedSemanticIds.size,
          proceduralProcessed: procedural.length,
          proceduralUpdated: changedProceduralIds.size,
          maxItemsPerRun: decayMaxItems,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
    },
  );
}
