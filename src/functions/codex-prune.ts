// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";

import { safeAudit } from "./audit.js";
import {
  deleteStoredRetrievalBlock,
  retrievalBlockId,
} from "./retrieval-blocks.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type {
  CompressedObservation,
  Session,
  SessionWorkingSet,
  TurnCapsule,
} from "../types.js";

type PrunableScope = "turnCapsules" | "workingSets" | "observations";

type Payload = {
  dryRun?: unknown;
  force?: unknown;
  archive?: unknown;
  staleAfterDays?: unknown;
  batchSize?: unknown;
  timeBudgetMs?: unknown;
  allowProjects?: unknown;
  projectAllowlist?: unknown;
  includeScopes?: unknown;
  includeSamples?: unknown;
};

type Candidate = {
  scope: PrunableScope;
  scopeKey: string;
  id: string;
  project: string;
  sessionId?: string;
  updatedAt?: string;
  estimatedBytes: number;
  retrievalBlockId?: string;
  value: unknown;
};

type ScopeSummary = {
  scanned: number;
  candidates: number;
  deleted: number;
  archived: number;
  estimatedBytes: number;
  deletedBytes: number;
  archivedBytes: number;
};

type CollectorState = {
  selected: Candidate[];
  projectTotals: Map<string, { candidates: number; estimatedBytes: number }>;
  candidates: number;
  estimatedBytes: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_DAYS = 14;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const DEFAULT_TIME_BUDGET_MS = 20_000;
const MAX_TIME_BUDGET_MS = 120_000;
const ARCHIVE_SCOPE = "mem:codex-prune-archive";

const DEFAULT_ALLOW_PROJECTS = [
  "/home/ericjuta/.openclaw/workspace/repos/codex",
  "/home/ericjuta/.openclaw/workspace/repos/agentmemory",
  "/home/ericjuta/.openclaw/workspace/repos/codex-lb",
];

function positiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, max);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, max);
  }
  return fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : fallback;
}

function scopeArray(value: unknown): PrunableScope[] {
  const fallback: PrunableScope[] = ["turnCapsules", "workingSets", "observations"];
  if (!Array.isArray(value)) return fallback;
  const allowed = new Set<PrunableScope>(fallback);
  const items = value.filter((item): item is PrunableScope => allowed.has(item));
  return items.length > 0 ? [...new Set(items)] : fallback;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimatedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function projectAllowed(project: unknown, allowProjects: string[]): boolean {
  if (typeof project !== "string" || !project.trim()) return false;
  if (allowProjects.some((allowed) => allowed === "*")) return false;
  return allowProjects.some((allowed) => {
    if (project === allowed) return true;
    return project.startsWith(allowed.endsWith("/") ? allowed : allowed + "/");
  });
}

function makeSummary(): ScopeSummary {
  return {
    scanned: 0,
    candidates: 0,
    deleted: 0,
    archived: 0,
    estimatedBytes: 0,
    deletedBytes: 0,
    archivedBytes: 0,
  };
}

function addCandidate(
  summaries: Record<PrunableScope, ScopeSummary>,
  state: CollectorState,
  maxSelected: number,
  candidate: Candidate,
): void {
  const summary = summaries[candidate.scope];
  summary.candidates += 1;
  summary.estimatedBytes += candidate.estimatedBytes;
  state.candidates += 1;
  state.estimatedBytes += candidate.estimatedBytes;
  const project = state.projectTotals.get(candidate.project) || {
    candidates: 0,
    estimatedBytes: 0,
  };
  project.candidates += 1;
  project.estimatedBytes += candidate.estimatedBytes;
  state.projectTotals.set(candidate.project, project);
  if (state.selected.length < maxSelected) {
    state.selected.push(candidate);
  }
}

function sortCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.sort((a, b) => {
    const aMs = timestampMs(a.updatedAt) ?? 0;
    const bMs = timestampMs(b.updatedAt) ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    return b.estimatedBytes - a.estimatedBytes;
  });
}

async function collectCandidates(
  kv: StateKV,
  includeScopes: PrunableScope[],
  allowProjects: string[],
  staleCutoffMs: number,
  summaries: Record<PrunableScope, ScopeSummary>,
  maxSelected: number,
): Promise<CollectorState> {
  const state: CollectorState = {
    selected: [],
    projectTotals: new Map(),
    candidates: 0,
    estimatedBytes: 0,
  };

  if (includeScopes.includes("turnCapsules")) {
    const items = await kv.list<TurnCapsule>(KV.turnCapsules).catch(() => []);
    summaries.turnCapsules.scanned = items.length;
    for (const item of items) {
      const updatedMs = timestampMs(item.updatedAt);
      if (updatedMs === null || updatedMs > staleCutoffMs) continue;
      if (projectAllowed(item.project, allowProjects)) continue;
      const candidate: Candidate = {
        scope: "turnCapsules",
        scopeKey: KV.turnCapsules,
        id: item.id,
        project: item.project || "(unknown)",
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        estimatedBytes: estimatedBytes(item),
        retrievalBlockId: retrievalBlockId("turn_capsule", item.id),
        value: item,
      };
      addCandidate(summaries, state, maxSelected, candidate);
    }
  }

  if (includeScopes.includes("workingSets")) {
    const items = await kv.list<SessionWorkingSet>(KV.workingSets).catch(() => []);
    summaries.workingSets.scanned = items.length;
    for (const item of items) {
      const updatedMs = timestampMs(item.updatedAt);
      if (updatedMs === null || updatedMs > staleCutoffMs) continue;
      if (projectAllowed(item.project, allowProjects)) continue;
      const candidate: Candidate = {
        scope: "workingSets",
        scopeKey: KV.workingSets,
        id: item.sessionId,
        project: item.project || "(unknown)",
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        estimatedBytes: estimatedBytes(item),
        retrievalBlockId: retrievalBlockId("working_set", item.sessionId),
        value: item,
      };
      addCandidate(summaries, state, maxSelected, candidate);
    }
  }

  if (includeScopes.includes("observations")) {
    const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
    for (const session of sessions) {
      if (projectAllowed(session.project, allowProjects)) continue;
      const observations = await kv
        .list<CompressedObservation>(KV.observations(session.id))
        .catch(() => []);
      summaries.observations.scanned += observations.length;
      for (const observation of observations) {
        const updatedAt = observation.timestamp;
        const updatedMs = timestampMs(updatedAt);
        if (updatedMs === null || updatedMs > staleCutoffMs) continue;
        const candidate: Candidate = {
          scope: "observations",
          scopeKey: KV.observations(session.id),
          id: observation.id,
          project: session.project || "(unknown)",
          sessionId: session.id,
          updatedAt,
          estimatedBytes: estimatedBytes(observation),
          retrievalBlockId: retrievalBlockId("observation", observation.id),
          value: observation,
        };
        addCandidate(summaries, state, maxSelected, candidate);
      }
    }
  }

  state.selected = sortCandidates(state.selected);
  return state;
}

function projectSummary(projectTotals: CollectorState["projectTotals"]): Array<{
  project: string;
  candidates: number;
  estimatedBytes: number;
}> {
  return [...projectTotals.entries()]
    .map(([project, summary]) => ({ project, ...summary }))
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
    .slice(0, 30);
}

async function archiveCandidate(
  kv: StateKV,
  runId: string,
  candidate: Candidate,
): Promise<void> {
  await kv.set(ARCHIVE_SCOPE, runId + ":" + candidate.scope + ":" + candidate.id, {
    archivedAt: new Date().toISOString(),
    sourceScope: candidate.scope,
    sourceScopeKey: candidate.scopeKey,
    id: candidate.id,
    project: candidate.project,
    sessionId: candidate.sessionId,
    updatedAt: candidate.updatedAt,
    estimatedBytes: candidate.estimatedBytes,
    value: candidate.value,
  });
}

async function deleteCandidate(kv: StateKV, candidate: Candidate): Promise<void> {
  await kv.delete(candidate.scopeKey, candidate.id);
  if (candidate.retrievalBlockId) {
    await deleteStoredRetrievalBlock(kv, candidate.retrievalBlockId).catch(() => {});
  }
}

export function registerCodexPruneFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::codex-prune", async (payload: Payload = {}) => {
    const dryRun = payload.dryRun !== false;
    const force = payload.force === true;
    const archive = payload.archive !== false;
    const staleAfterDays = positiveInteger(
      payload.staleAfterDays,
      DEFAULT_STALE_AFTER_DAYS,
      3650,
    );
    const batchSize = positiveInteger(payload.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
    const timeBudgetMs = positiveInteger(
      payload.timeBudgetMs,
      DEFAULT_TIME_BUDGET_MS,
      MAX_TIME_BUDGET_MS,
    );
    const allowProjects = stringArray(
      payload.allowProjects ?? payload.projectAllowlist,
      DEFAULT_ALLOW_PROJECTS,
    );
    const includeScopes = scopeArray(payload.includeScopes);
    const includeSamples = payload.includeSamples === true;
    const runId = generateId("prune");
    const startedAt = Date.now();
    const staleCutoffMs = startedAt - staleAfterDays * DAY_MS;
    const summaries: Record<PrunableScope, ScopeSummary> = {
      turnCapsules: makeSummary(),
      workingSets: makeSummary(),
      observations: makeSummary(),
    };
    let collector: CollectorState;
    try {
      collector = await collectCandidates(
        kv,
        includeScopes,
        allowProjects,
        staleCutoffMs,
        summaries,
        batchSize,
      );
    } catch (err) {
      return {
        success: false,
        error:
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : JSON.stringify(err),
        dryRun,
        allowProjects,
        includeScopes,
      };
    }

    const selected = collector.selected;
    let timedOut = false;
    const errors: Array<{ id: string; scope: PrunableScope; error: string }> = [];

    if (!dryRun) {
      if (!force) {
        return {
          success: false,
          error: "force must be true when dryRun is false",
          dryRun,
          candidates: collector.candidates,
          estimatedBytes: collector.estimatedBytes,
        };
      }

      for (const candidate of selected) {
        if (Date.now() - startedAt >= timeBudgetMs) {
          timedOut = true;
          break;
        }
        try {
          if (archive) {
            await archiveCandidate(kv, runId, candidate);
            summaries[candidate.scope].archived += 1;
            summaries[candidate.scope].archivedBytes += candidate.estimatedBytes;
          }
          await deleteCandidate(kv, candidate);
          summaries[candidate.scope].deleted += 1;
          summaries[candidate.scope].deletedBytes += candidate.estimatedBytes;
        } catch (err) {
          errors.push({
            id: candidate.id,
            scope: candidate.scope,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await safeAudit(
        kv,
        "delete",
        "mem::codex-prune",
        selected.map((candidate) => candidate.id).slice(0, 100),
        {
          runId,
          archive,
          staleAfterDays,
          allowProjects,
          includeScopes,
          candidates: collector.candidates,
          selected: selected.length,
          deleted: Object.values(summaries).reduce((sum, scope) => sum + scope.deleted, 0),
          deletedBytes: Object.values(summaries).reduce(
            (sum, scope) => sum + scope.deletedBytes,
            0,
          ),
          timedOut,
          errors: errors.length,
        },
      );
    }

    const totalDeleted = Object.values(summaries).reduce(
      (sum, scope) => sum + scope.deleted,
      0,
    );
    const totalDeletedBytes = Object.values(summaries).reduce(
      (sum, scope) => sum + scope.deletedBytes,
      0,
    );

    return {
      success: errors.length === 0,
      runId,
      dryRun,
      force,
      archive,
      staleAfterDays,
      staleCutoff: new Date(staleCutoffMs).toISOString(),
      batchSize,
      timeBudgetMs,
      allowProjects,
      includeScopes,
      candidates: collector.candidates,
      selected: selected.length,
      remainingAfterBatch: Math.max(0, collector.candidates - selected.length),
      estimatedBytes: collector.estimatedBytes,
      deleted: totalDeleted,
      deletedBytes: totalDeletedBytes,
      timedOut,
      scopes: summaries,
      projects: projectSummary(collector.projectTotals),
      errors,
      ...(includeSamples
        ? {
            samples: selected.slice(0, 25).map((candidate) => ({
              scope: candidate.scope,
              id: candidate.id,
              project: candidate.project,
              sessionId: candidate.sessionId,
              updatedAt: candidate.updatedAt,
              estimatedBytes: candidate.estimatedBytes,
            })),
          }
        : {}),
    };
  });
}
