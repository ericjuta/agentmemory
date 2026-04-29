// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { SessionWorkingSet, TurnCapsule } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { upsertWorkingSetRetrievalBlock } from "./retrieval-blocks.js";

function summarizeCapsule(capsule: TurnCapsule): SessionWorkingSet["latestCompletedCapsule"] {
  return {
    id: capsule.id,
    sessionId: capsule.sessionId,
    turnId: capsule.turnId,
    project: capsule.project,
    cwd: capsule.cwd,
    createdAt: capsule.createdAt,
    updatedAt: capsule.updatedAt,
    userPrompt: capsule.userPrompt,
    assistantConclusion: capsule.assistantConclusion,
    maxImportance: capsule.maxImportance,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isCompletionEvent(hookType: string): boolean {
  return hookType === "assistant_result" || hookType === "stop";
}

export async function updateSessionWorkingSet(
  kv: StateKV,
  capsule: TurnCapsule,
  hookType: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing =
    (await kv
      .get<SessionWorkingSet>(KV.workingSets, capsule.sessionId)
      .catch(() => null)) || null;

  const next: SessionWorkingSet = {
    sessionId: capsule.sessionId,
    project: capsule.project,
    cwd: capsule.cwd,
    updatedAt: now,
    latestTurnId: capsule.turnId,
    latestCompletedTurnId:
      isCompletionEvent(hookType)
        ? capsule.turnId
        : existing?.latestCompletedTurnId,
    latestCompletedCapsule:
      isCompletionEvent(hookType)
        ? summarizeCapsule(capsule)
        : existing?.latestCompletedCapsule,
    latestAssistantConclusion:
      capsule.assistantConclusion ||
      existing?.latestAssistantConclusion,
    latestImportantFiles: uniqueStrings(
      capsule.files.slice(0, 8).concat(existing?.latestImportantFiles || []),
    ).slice(0, 8),
    latestImportantConcepts: uniqueStrings(
      capsule.concepts.slice(0, 10).concat(existing?.latestImportantConcepts || []),
    ).slice(0, 10),
    latestImportantObservationIds: uniqueStrings(
      capsule.importantObservationIds.concat(existing?.latestImportantObservationIds || []),
    ).slice(0, 12),
    latestHadFailure: capsule.hadFailure,
    latestHadDecision: capsule.hadDecision,
  };

  await kv.set(KV.workingSets, capsule.sessionId, next);
  await upsertWorkingSetRetrievalBlock(kv, next);
}
