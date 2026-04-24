import type { ISdk } from "iii-sdk";

import type {
  Memory,
  ProceduralMemory,
  RetrievalBlock,
  SemanticMemory,
  Session,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { recordAudit } from "./audit.js";
import {
  retrievalBlockId,
  upsertProceduralRetrievalBlock,
  upsertSemanticRetrievalBlock,
} from "./retrieval-blocks.js";

type BackfillKind = "semantic" | "procedural";

interface BackfillPayload {
  dryRun?: unknown;
  limit?: unknown;
  kinds?: unknown;
  reindex?: unknown;
  includeItems?: unknown;
}

interface BackfillItemReport {
  kind: BackfillKind;
  id: string;
  status: "updated" | "unchanged" | "ambiguous" | "missing_source" | "marked_global";
  project?: string;
  sourceProjects?: string[];
}

interface InferenceResult {
  projects: string[];
  missing: number;
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function selectedKinds(value: unknown): BackfillKind[] {
  if (!Array.isArray(value)) return ["semantic", "procedural"];
  const allowed = new Set<BackfillKind>(["semantic", "procedural"]);
  const kinds = value.filter(
    (item): item is BackfillKind =>
      typeof item === "string" && allowed.has(item as BackfillKind),
  );
  return kinds.length > 0 ? [...new Set(kinds)] : ["semantic", "procedural"];
}

async function projectFromSession(kv: StateKV, sessionId: string): Promise<string | null> {
  const session = await kv.get<Session>(KV.sessions, sessionId).catch(() => null);
  return session?.project || null;
}

async function projectsFromMemory(kv: StateKV, memoryId: string): Promise<InferenceResult> {
  const memory = await kv.get<Memory>(KV.memories, memoryId).catch(() => null);
  if (!memory) return { projects: [], missing: 1 };
  const projects = new Set<string>();
  if (memory.project) projects.add(memory.project);
  let missing = 0;
  for (const sessionId of memory.sessionIds || []) {
    const project = await projectFromSession(kv, sessionId);
    if (project) projects.add(project);
    else missing++;
  }
  return { projects: [...projects], missing };
}

async function projectsFromObservation(
  kv: StateKV,
  observationId: string,
): Promise<InferenceResult> {
  const block = await kv
    .get<RetrievalBlock>(
      KV.retrievalBlocks,
      retrievalBlockId("observation", observationId),
    )
    .catch(() => null);
  if (!block?.project || block.project === "global") {
    return { projects: [], missing: 1 };
  }
  return { projects: [block.project], missing: 0 };
}

async function inferProjects(
  kv: StateKV,
  item: {
    project?: string;
    sourceProjects?: string[];
    sourceSessionIds?: string[];
    sourceMemoryIds?: string[];
    sourceObservationIds?: string[];
  },
): Promise<InferenceResult> {
  const projects = new Set<string>();
  let missing = 0;
  if (item.project) projects.add(item.project);
  for (const project of item.sourceProjects || []) {
    if (project) projects.add(project);
  }
  for (const sessionId of item.sourceSessionIds || []) {
    const project = await projectFromSession(kv, sessionId);
    if (project) projects.add(project);
    else missing++;
  }
  for (const memoryId of item.sourceMemoryIds || []) {
    const result = await projectsFromMemory(kv, memoryId);
    for (const project of result.projects) projects.add(project);
    missing += result.missing;
  }
  for (const observationId of item.sourceObservationIds || []) {
    const result = await projectsFromObservation(kv, observationId);
    for (const project of result.projects) projects.add(project);
    missing += result.missing;
  }
  return { projects: [...projects].sort(), missing };
}

function needsProjectBackfill(item: {
  project?: string;
  sourceScope?: "project" | "global";
  sourceProjects?: string[];
}): boolean {
  if (!item.project) return true;
  if (item.sourceScope !== "project") return true;
  return item.sourceProjects?.length !== 1 || item.sourceProjects[0] !== item.project;
}

async function handleItem<T extends SemanticMemory | ProceduralMemory>(
  kv: StateKV,
  kind: BackfillKind,
  item: T,
  options: { dryRun: boolean; reindex: boolean },
): Promise<BackfillItemReport> {
  const inferred = await inferProjects(kv, {
    project: item.project,
    sourceProjects: item.sourceProjects,
    sourceSessionIds: item.sourceSessionIds,
    sourceMemoryIds: stringArray(item.sourceMemoryIds),
    sourceObservationIds: stringArray(item.sourceObservationIds),
  });

  if (inferred.projects.length === 1) {
    const project = inferred.projects[0];
    if (
      !needsProjectBackfill(item) &&
      item.project === project &&
      item.sourceProjects?.[0] === project
    ) {
      return { kind, id: item.id, status: "unchanged", project };
    }
    const next = {
      ...item,
      project,
      sourceScope: "project" as const,
      sourceProjects: [project],
      updatedAt: new Date().toISOString(),
    } satisfies T;
    if (!options.dryRun) {
      await kv.set(kind === "semantic" ? KV.semantic : KV.procedural, next.id, next);
      if (options.reindex) {
        if (kind === "semantic") {
          await upsertSemanticRetrievalBlock(kv, next as SemanticMemory);
        } else {
          await upsertProceduralRetrievalBlock(kv, next as ProceduralMemory);
        }
      }
    }
    return { kind, id: item.id, status: "updated", project };
  }

  const status = inferred.projects.length > 1 ? "ambiguous" : "missing_source";
  const sourceProjects = uniqueStrings(inferred.projects);
  const shouldMarkGlobal =
    item.sourceScope !== "global" ||
    JSON.stringify(item.sourceProjects || []) !== JSON.stringify(sourceProjects);
  if (!options.dryRun && shouldMarkGlobal) {
    const next = {
      ...item,
      project: undefined,
      sourceScope: "global" as const,
      sourceProjects,
      updatedAt: new Date().toISOString(),
    } satisfies T;
    await kv.set(kind === "semantic" ? KV.semantic : KV.procedural, next.id, next);
    if (options.reindex) {
      if (kind === "semantic") {
        await upsertSemanticRetrievalBlock(kv, next as SemanticMemory);
      } else {
        await upsertProceduralRetrievalBlock(kv, next as ProceduralMemory);
      }
    }
    return {
      kind,
      id: item.id,
      status: "marked_global",
      sourceProjects,
    };
  }
  return {
    kind,
    id: item.id,
    status,
    sourceProjects,
  };
}

export function registerConsolidatedMemoryBackfillFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::consolidated-memory-backfill", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object" ? (payload as BackfillPayload) : {};
    const dryRun = data.dryRun === true;
    const reindex = data.reindex !== false;
    const includeItems = data.includeItems === true;
    const limit = parseLimit(data.limit, 100);
    const kinds = selectedKinds(data.kinds);
    const itemReports: BackfillItemReport[] = [];
    const counts = {
      scanned: 0,
      updated: 0,
      unchanged: 0,
      ambiguous: 0,
      missingSource: 0,
      markedGlobal: 0,
    };

    if (kinds.includes("semantic")) {
      const semantic = await kv.list<SemanticMemory>(KV.semantic).catch(() => []);
      for (const item of semantic) {
        if (counts.scanned >= limit) break;
        counts.scanned++;
        const report = await handleItem(kv, "semantic", item, { dryRun, reindex });
        itemReports.push(report);
      }
    }

    if (kinds.includes("procedural") && counts.scanned < limit) {
      const procedural = await kv.list<ProceduralMemory>(KV.procedural).catch(() => []);
      for (const item of procedural) {
        if (counts.scanned >= limit) break;
        counts.scanned++;
        const report = await handleItem(kv, "procedural", item, { dryRun, reindex });
        itemReports.push(report);
      }
    }

    for (const item of itemReports) {
      if (item.status === "updated") counts.updated++;
      else if (item.status === "unchanged") counts.unchanged++;
      else if (item.status === "ambiguous") counts.ambiguous++;
      else if (item.status === "missing_source") counts.missingSource++;
      else if (item.status === "marked_global") {
        counts.markedGlobal++;
        if ((item.sourceProjects || []).length > 1) counts.ambiguous++;
        else counts.missingSource++;
      }
    }

    if (!dryRun && (counts.updated > 0 || counts.markedGlobal > 0)) {
      await recordAudit(kv, "consolidate", "mem::consolidated-memory-backfill", [], {
        counts,
        kinds,
        reindex,
      });
    }

    return {
      success: true,
      dryRun,
      reindex,
      limit,
      kinds,
      counts,
      items: includeItems ? itemReports : undefined,
    };
  });
}
