// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type {
  CompressedObservation,
  RawObservation,
  TurnCapsule,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { updateSessionWorkingSet } from "./working-set.js";

function turnCapsuleKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function mergeStrings(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next])];
}

function extractFiles(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const data = value as Record<string, unknown>;
  const files: string[] = [];

  for (const key of ["file_path", "path", "dir_path"]) {
    if (typeof data[key] === "string" && data[key]) {
      files.push(data[key] as string);
    }
  }
  if (Array.isArray(data.paths)) {
    for (const entry of data.paths) {
      if (typeof entry === "string" && entry) files.push(entry);
    }
  }
  if (Array.isArray(data.files)) {
    for (const entry of data.files) {
      if (typeof entry === "string" && entry) files.push(entry);
    }
  }
  return uniqueStrings(files);
}

function extractConcepts(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const data = value as Record<string, unknown>;
  const concepts: string[] = [];

  for (const key of ["query", "pattern", "glob"]) {
    if (typeof data[key] === "string" && data[key]) {
      concepts.push(data[key] as string);
    }
  }
  if (Array.isArray(data.search_terms)) {
    for (const entry of data.search_terms) {
      if (typeof entry === "string" && entry) concepts.push(entry);
    }
  }
  return uniqueStrings(concepts);
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
      ...extractFiles(raw.toolInput),
      ...extractFiles(rawData),
    ]),
  );
  const concepts = mergeStrings(
    existing.concepts,
    uniqueStrings([
      ...extractConcepts(raw.toolInput),
      ...extractConcepts(rawData),
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
    files,
    concepts,
    hadFailure: existing.hadFailure || raw.hookType === "post_tool_failure",
    sourceObservationIds: uniqueStrings([
      ...existing.sourceObservationIds,
      raw.id,
    ]),
    importantObservationIds: uniqueStrings(importantObservationIds),
  };

  await kv.set(KV.turnCapsules, key, next);
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
    files: mergeStrings(existing.files, compressed.files || []),
    concepts: mergeStrings(existing.concepts, compressed.concepts || []),
    hadFailure: existing.hadFailure || compressed.type === "error",
    hadDecision: existing.hadDecision || compressed.type === "decision",
    sourceObservationIds: uniqueStrings([
      ...existing.sourceObservationIds,
      compressed.id,
    ]),
    importantObservationIds: uniqueStrings(importantObservationIds),
    maxImportance: Math.max(existing.maxImportance, compressed.importance || 0),
  };

  await kv.set(KV.turnCapsules, key, next);
  await updateSessionWorkingSet(kv, next, compressed.type);
}
