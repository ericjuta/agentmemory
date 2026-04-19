import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  Belief,
  Memory,
  CompressedObservation,
  Session,
} from "../types.js";
import { beliefProjection, getBeliefDetails } from "./beliefs.js";

type Citation = {
  observationId: string;
  title: string;
  type: CompressedObservation["type"];
  confidence: number | undefined;
  timestamp: string;
  sessionId: string;
  sessionProject?: string;
  sessionStatus?: Session["status"];
};

function explainBeliefStatus(belief: Belief): string {
  if (belief.status === "superseded") {
    return belief.supersededByBeliefId
      ? `Superseded by ${belief.supersededByBeliefId}.`
      : "Superseded by newer evidence.";
  }
  if (belief.status === "contradicted") {
    return "Contradiction evidence currently outweighs direct support.";
  }
  if (belief.status === "uncertain") {
    return "The claim has mixed evidence or lacks strong latest support.";
  }
  return "Current support outweighs contradiction evidence.";
}

export function registerVerifyFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::verify", 
    async (data: { id: string }) => {
      if (!data.id || typeof data.id !== "string") {
        return { success: false, error: "id is required" };
      }

      const beliefDetails = await getBeliefDetails(kv, data.id);
      if (beliefDetails) {
        const supportingMemories = (
          await Promise.all(
            beliefDetails.belief.supportingMemoryIds.map((memoryId) =>
              kv.get<Memory>(KV.memories, memoryId),
            ),
          )
        ).filter((memory): memory is Memory => Boolean(memory));
        const contradictingMemories = (
          await Promise.all(
            beliefDetails.belief.contradictingMemoryIds.map((memoryId) =>
              kv.get<Memory>(KV.memories, memoryId),
            ),
          )
        ).filter((memory): memory is Memory => Boolean(memory));
        const citations = await collectCitations(kv, [
          ...supportingMemories,
          ...contradictingMemories,
        ]);

        return {
          success: true,
          type: "belief",
          belief: beliefDetails.belief,
          projection: beliefProjection(beliefDetails.belief),
          explanation: {
            status: beliefDetails.belief.status,
            reason: explainBeliefStatus(beliefDetails.belief),
            supportCount: supportingMemories.length,
            contradictionCount: contradictingMemories.length,
            supersededByBeliefId: beliefDetails.belief.supersededByBeliefId || null,
          },
          supportingMemories,
          contradictingMemories,
          evidence: beliefDetails.evidence,
          citations,
          citationCount: citations.length,
        };
      }

      const memory = await kv.get<Memory>(KV.memories, data.id);
      if (memory) {
        const observations = await collectCitations(kv, [memory]);

        return {
          success: true,
          type: "memory",
          memory: {
            id: memory.id,
            title: memory.title,
            type: memory.type,
            version: memory.version,
            strength: memory.strength,
            isLatest: memory.isLatest,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            supersedes: memory.supersedes,
            parentId: memory.parentId,
          },
          citations: observations,
          citationCount: observations.length,
        };
      }

      const obs = await findObservation(kv, data.id);
      if (obs) {
        const session = await kv.get<Session>(KV.sessions, obs.sessionId);
        return {
          success: true,
          type: "observation",
          observation: {
            id: obs.id,
            title: obs.title,
            type: obs.type,
            confidence: obs.confidence,
            importance: obs.importance,
            timestamp: obs.timestamp,
            sessionId: obs.sessionId,
          },
          session: session
            ? {
                id: session.id,
                project: session.project,
                status: session.status,
                startedAt: session.startedAt,
              }
            : null,
          citationCount: 0,
          citations: [],
        };
      }

      return { success: false, error: "not found" };
    },
  );
}

async function collectCitations(
  kv: StateKV,
  memories: Memory[],
): Promise<Citation[]> {
  const citations: Citation[] = [];
  for (const memory of memories) {
    const observationIds = memory.sourceObservationIds || [];
    for (const obsId of observationIds) {
      const obs = await findObservation(kv, obsId, memory.sessionIds);
      if (!obs) continue;
      const session = await kv.get<Session>(KV.sessions, obs.sessionId);
      citations.push({
        observationId: obs.id,
        title: obs.title,
        type: obs.type,
        confidence: obs.confidence,
        timestamp: obs.timestamp,
        sessionId: obs.sessionId,
        sessionProject: session?.project,
        sessionStatus: session?.status,
      });
    }
  }
  return citations;
}

async function findObservation(
  kv: StateKV,
  obsId: string,
  hintSessionIds?: string[],
): Promise<CompressedObservation | null> {
  if (hintSessionIds) {
    for (const sid of hintSessionIds) {
      const obs = await kv.get<CompressedObservation>(KV.observations(sid), obsId);
      if (obs) return obs;
    }
  }
  const sessions = await kv.list<Session>(KV.sessions);
  for (const session of sessions) {
    if (hintSessionIds?.includes(session.id)) continue;
    const obs = await kv.get<CompressedObservation>(
      KV.observations(session.id),
      obsId,
    );
    if (obs) return obs;
  }
  return null;
}
