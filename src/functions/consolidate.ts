// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Memory,
  Session,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";

const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Given a set of related observations from coding sessions, synthesize them into a single long-term memory.

Output XML:
<memory>
  <type>pattern|preference|architecture|bug|workflow|fact</type>
  <title>Concise memory title (max 80 chars)</title>
  <content>2-4 sentence description of the learned insight</content>
  <concepts>
    <concept>key term</concept>
  </concepts>
  <files>
    <file>relevant/file/path</file>
  </files>
  <strength>1-10 how confident/important this memory is</strength>
</memory>`;

import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { logger } from "../logger.js";
import { Semaphore } from "../state/semaphore.js";
import { upsertMemoryRetrievalBlock } from "./retrieval-blocks.js";

const consolidateLock = new Semaphore(1);
const DEFAULT_MAX_SESSION_SCANS = 25;
const DEFAULT_MAX_CANDIDATE_OBSERVATIONS = 50;
const MAX_LLM_CALLS = 10;

function prioritizeSessionsForConsolidation(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    if (b.observationCount !== a.observationCount) {
      return b.observationCount - a.observationCount;
    }
    return (
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  });
}

function parseMemoryXml(
  xml: string,
  sessionIds: string[],
): Omit<Memory, "id" | "createdAt" | "updatedAt"> | null {
  const type = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  const content = getXmlTag(xml, "content");
  if (!type || !title || !content) return null;

  const validTypes = new Set([
    "pattern",
    "preference",
    "architecture",
    "bug",
    "workflow",
    "fact",
  ]);

  return {
    type: (validTypes.has(type) ? type : "fact") as Memory["type"],
    title,
    content,
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    sessionIds,
    strength: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "strength") || "5", 10) || 5),
    ),
    version: 1,
    isLatest: true,
  };
}

export function registerConsolidateFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate", 
    async (data: {
      project?: string;
      minObservations?: number;
      maxSessionsScanned?: number;
      maxCandidateObservations?: number;
    }) =>
      consolidateLock.run(async () => {
        const minObs = data.minObservations ?? 10;
      const maxSessionsScanned = Math.max(
        1,
        data.maxSessionsScanned ?? DEFAULT_MAX_SESSION_SCANS,
      );
      const maxCandidateObservations = Math.max(
        minObs,
        data.maxCandidateObservations ?? DEFAULT_MAX_CANDIDATE_OBSERVATIONS,
      );

      const sessions = await kv.list<Session>(KV.sessions);
      const filteredSessions = data.project
        ? sessions.filter((s) => s.project === data.project)
        : sessions;
      const sessionsToScan = prioritizeSessionsForConsolidation(
        filteredSessions.filter((s) => s.observationCount > 0),
      ).slice(0, maxSessionsScanned);

      const allObs: Array<CompressedObservation & { sid: string }> = [];
      let scannedSessions = 0;
      for (const session of sessionsToScan) {
        if (allObs.length >= maxCandidateObservations) break;

        scannedSessions++;
        const observations = await kv
          .list<CompressedObservation>(KV.observations(session.id))
          .catch(() => [] as CompressedObservation[]);
        const remainingBudget = maxCandidateObservations - allObs.length;
        const importantObservations = observations
          .filter((obs) => obs.title && obs.importance >= 5)
          .sort((a, b) => b.importance - a.importance)
          .slice(0, remainingBudget);

        for (const obs of importantObservations) {
          allObs.push({ ...obs, sid: session.id });
        }
      }

      if (allObs.length < minObs) {
        return {
          consolidated: 0,
          reason: "insufficient_observations",
          scannedSessions,
          totalObservations: allObs.length,
        };
      }

      const conceptGroups = new Map<string, typeof allObs>();
      for (const obs of allObs) {
        for (const concept of obs.concepts) {
          const key = concept.toLowerCase();
          if (!conceptGroups.has(key)) conceptGroups.set(key, []);
          conceptGroups.get(key)!.push(obs);
        }
      }

      let consolidated = 0;
      const existingMemories = await kv.list<Memory>(KV.memories);
      const existingTitles = new Set(
        existingMemories.map((m) => m.title.toLowerCase()),
      );

      let llmCallCount = 0;

      const sortedGroups = [...conceptGroups.entries()]
        .filter(([, g]) => g.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

      for (const [concept, obsGroup] of sortedGroups) {
        if (llmCallCount >= MAX_LLM_CALLS) break;

        const top = obsGroup
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 8);
        const sessionIds = [...new Set(top.map((o) => o.sid))];

        const prompt = top
          .map(
            (o) =>
              `[${o.type}] ${o.title}\n${o.narrative}\nFiles: ${o.files.join(", ")}\nImportance: ${o.importance}`,
          )
          .join("\n\n");

        try {
          const response = await Promise.race([
            provider.compress(
              CONSOLIDATION_SYSTEM,
              `Concept: "${concept}"\n\nObservations:\n${prompt}`,
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("compress timeout")), 30_000),
            ),
          ]);
          llmCallCount++;
          const parsed = parseMemoryXml(response, sessionIds);
          if (!parsed) continue;

          const existingMatch = existingMemories.find(
            (m) => m.title.toLowerCase() === parsed.title.toLowerCase(),
          );

          const now = new Date().toISOString();
          const obsIds = [...new Set(top.map((o) => o.id))];
          if (existingMatch) {
            existingMatch.isLatest = false;
            await kv.set(KV.memories, existingMatch.id, existingMatch);
            await recordAudit(kv, "evolve", "mem::consolidate", [existingMatch.id], {
              action: "mark_non_latest",
              concept,
            });

            const evolved: Memory = {
              id: generateId("mem"),
              createdAt: now,
              updatedAt: now,
              ...parsed,
              version: (existingMatch.version || 1) + 1,
              parentId: existingMatch.id,
              supersedes: [
                existingMatch.id,
                ...(existingMatch.supersedes || []),
              ],
              sourceObservationIds: obsIds,
              isLatest: true,
            };
            await kv.set(KV.memories, evolved.id, evolved);
            await upsertMemoryRetrievalBlock(kv, evolved);
            await recordAudit(kv, "evolve", "mem::consolidate", [evolved.id], {
              action: "evolve_memory",
              oldId: existingMatch.id,
              newId: evolved.id,
              concept,
            });
            existingTitles.add(evolved.title.toLowerCase());
            consolidated++;
          } else {
            const memory: Memory = {
              id: generateId("mem"),
              createdAt: now,
              updatedAt: now,
              ...parsed,
              sourceObservationIds: obsIds,
              version: 1,
              isLatest: true,
            };
            await kv.set(KV.memories, memory.id, memory);
            await upsertMemoryRetrievalBlock(kv, memory);
            await recordAudit(kv, "remember", "mem::consolidate", [memory.id], {
              action: "create_memory",
              concept,
            });
            existingTitles.add(memory.title.toLowerCase());
            consolidated++;
          }
        } catch (err) {
          logger.warn("Consolidation failed for concept", {
            concept,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("Consolidation complete", {
        consolidated,
        totalObs: allObs.length,
        scannedSessions,
        availableSessions: filteredSessions.length,
      });
      return {
        consolidated,
        totalObservations: allObs.length,
        scannedSessions,
      };
    }),
  );
}
