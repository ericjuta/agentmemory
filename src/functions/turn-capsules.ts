// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type {
  CompressedObservation,
  RawObservation,
  TurnCapsule,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { updateSessionWorkingSet } from "./working-set.js";
import {
  extractObservationConcepts,
  extractObservationFiles,
} from "./observation-signals.js";
import { upsertTurnCapsuleRetrievalBlock } from "./retrieval-blocks.js";

function turnCapsuleKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function mergeStrings(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next])];
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cappedStrings(values: string[], fallbackLimit: number): string[] {
  return uniqueStrings(values).slice(
    0,
    readPositiveIntegerEnv("AGENTMEMORY_TURN_CAPSULE_SIGNAL_LIMIT", fallbackLimit),
  );
}

function buildDefaultCapsule(
  sessionId: string,
  turnId: string,
  project: string,
  cwd: string,
  now: string,
): TurnCapsule {
  return {
    id: turnCapsuleKey(sessionId, turnId),
    sessionId,
    turnId,
    project,
    cwd,
    createdAt: now,
    updatedAt: now,
    files: [],
    concepts: [],
    hadFailure: false,
    hadDecision: false,
    sourceObservationIds: [],
    importantObservationIds: [],
    maxImportance: 0,
  };
}

export async function upsertTurnCapsuleFromRaw(
  kv: StateKV,
  sessionId: string,
  project: string,
  cwd: string,
  raw: RawObservation,
): Promise<void> {
  if (!raw.turnId) return;

  const now = new Date().toISOString();
  const key = turnCapsuleKey(sessionId, raw.turnId);
  const existing =
    (await kv.get<TurnCapsule>(KV.turnCapsules, key).catch(() => null)) ||
    buildDefaultCapsule(sessionId, raw.turnId, project, cwd, now);

  const rawData = typeof raw.raw === "object" && raw.raw !== null ? raw.raw : {};
  const files = mergeStrings(
    existing.files,
    uniqueStrings([
      ...extractObservationFiles(
        raw.toolInput,
        raw.toolOutput,
        rawData,
      ),
    ]),
  );
  const concepts = mergeStrings(
    existing.concepts,
    uniqueStrings([
      ...extractObservationConcepts(
        raw.toolInput,
        raw.toolOutput,
        rawData,
        { prompt: raw.userPrompt, assistant_text: raw.assistantResponse },
      ),
    ]),
  );

  const importantObservationIds = [...existing.importantObservationIds];
  if (
    raw.hookType === "post_tool_failure" ||
    raw.hookType === "assistant_result" ||
    raw.hookType === "stop"
  ) {
    importantObservationIds.push(raw.id);
  }

  const next: TurnCapsule = {
    ...existing,
    project,
    cwd,
    updatedAt: now,
    userPrompt: raw.userPrompt || existing.userPrompt,
    assistantConclusion:
      raw.assistantResponse && raw.assistantResponse.trim()
        ? raw.assistantResponse
        : existing.assistantConclusion,
    files: cappedStrings(files, 64),
    concepts: cappedStrings(concepts, 96),
    hadFailure: existing.hadFailure || raw.hookType === "post_tool_failure",
    sourceObservationIds: cappedStrings([
      ...existing.sourceObservationIds,
      raw.id,
    ], 256),
    importantObservationIds: cappedStrings(importantObservationIds, 64),
  };

  await kv.set(KV.turnCapsules, key, next);
  await upsertTurnCapsuleRetrievalBlock(kv, next);
  await updateSessionWorkingSet(kv, next, raw.hookType);
}

export async function upsertTurnCapsuleFromCompressed(
  kv: StateKV,
  compressed: CompressedObservation,
): Promise<void> {
  if (!compressed.turnId) return;

  const now = new Date().toISOString();
  const key = turnCapsuleKey(compressed.sessionId, compressed.turnId);
  const existing = await kv.get<TurnCapsule>(KV.turnCapsules, key).catch(() => null);
  if (!existing) return;

  const importantObservationIds = [...existing.importantObservationIds];
  if (
    compressed.importance >= 5 ||
    compressed.type === "error" ||
    compressed.type === "decision"
  ) {
    importantObservationIds.push(compressed.id);
  }

  const next: TurnCapsule = {
    ...existing,
    updatedAt: now,
    files: cappedStrings(mergeStrings(existing.files, compressed.files || []), 64),
    concepts: cappedStrings(mergeStrings(existing.concepts, compressed.concepts || []), 96),
    hadFailure: existing.hadFailure || compressed.type === "error",
    hadDecision: existing.hadDecision || compressed.type === "decision",
    sourceObservationIds: cappedStrings([
      ...existing.sourceObservationIds,
      compressed.id,
    ], 256),
    importantObservationIds: cappedStrings(importantObservationIds, 64),
    maxImportance: Math.max(existing.maxImportance, compressed.importance || 0),
  };

  await kv.set(KV.turnCapsules, key, next);
  await upsertTurnCapsuleRetrievalBlock(kv, next);
  await updateSessionWorkingSet(kv, next, compressed.type);
}
