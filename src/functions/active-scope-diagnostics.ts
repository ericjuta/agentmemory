import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { SessionWorkingSet, TurnCapsule } from "../types.js";

type ScopeName = "turnCapsules" | "workingSets";

type Payload = {
  staleAfterDays?: unknown;
  sampleLimit?: unknown;
};

type AgeBucket = "lt7d" | "d7to30" | "d30to90" | "gte90d" | "unknown";

type ScopeDiagnostics = {
  count: number;
  estimatedBytes: number;
  oldestUpdatedAt?: string;
  newestUpdatedAt?: string;
  ageBuckets: Record<AgeBucket, number>;
  staleCandidates: number;
  projects: Array<{ project: string; count: number; estimatedBytes: number }>;
  sessions: Array<{ sessionId: string; count: number; estimatedBytes: number }>;
  samples: Array<Record<string, unknown>>;
  error?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, max);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, max);
  }
  return fallback;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimatedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function ageBucket(updatedAt: unknown, nowMs: number): AgeBucket {
  const updatedMs = timestampMs(updatedAt);
  if (updatedMs === null) return "unknown";
  const ageDays = Math.max(0, (nowMs - updatedMs) / DAY_MS);
  if (ageDays < 7) return "lt7d";
  if (ageDays < 30) return "d7to30";
  if (ageDays < 90) return "d30to90";
  return "gte90d";
}

function distribution<T>(
  items: T[],
  keyFor: (item: T) => string,
  label: "project" | "sessionId",
): Array<{ project: string; count: number; estimatedBytes: number }> | Array<{ sessionId: string; count: number; estimatedBytes: number }> {
  const counts = new Map<string, { count: number; estimatedBytes: number }>();
  for (const item of items) {
    const key = keyFor(item) || "(unknown)";
    const current = counts.get(key) || { count: 0, estimatedBytes: 0 };
    current.count += 1;
    current.estimatedBytes += estimatedBytes(item);
    counts.set(key, current);
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ [label]: key, ...value }))
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
    .slice(0, 20) as never;
}

function summarizeItems<T extends { updatedAt?: string; project?: string; sessionId?: string }>(
  items: T[],
  staleAfterDays: number,
  sampleLimit: number,
  sample: (item: T) => Record<string, unknown>,
): ScopeDiagnostics {
  const nowMs = Date.now();
  const buckets: Record<AgeBucket, number> = {
    lt7d: 0,
    d7to30: 0,
    d30to90: 0,
    gte90d: 0,
    unknown: 0,
  };
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  let oldestUpdatedAt: string | undefined;
  let newestUpdatedAt: string | undefined;
  let staleCandidates = 0;
  let totalEstimatedBytes = 0;
  const staleCutoffMs = nowMs - staleAfterDays * DAY_MS;

  for (const item of items) {
    totalEstimatedBytes += estimatedBytes(item);
    buckets[ageBucket(item.updatedAt, nowMs)]++;
    const updatedMs = timestampMs(item.updatedAt);
    if (updatedMs === null) continue;
    if (oldestMs === null || updatedMs < oldestMs) {
      oldestMs = updatedMs;
      oldestUpdatedAt = item.updatedAt;
    }
    if (newestMs === null || updatedMs > newestMs) {
      newestMs = updatedMs;
      newestUpdatedAt = item.updatedAt;
    }
    if (updatedMs <= staleCutoffMs) staleCandidates++;
  }

  return {
    count: items.length,
    estimatedBytes: totalEstimatedBytes,
    ...(oldestUpdatedAt ? { oldestUpdatedAt } : {}),
    ...(newestUpdatedAt ? { newestUpdatedAt } : {}),
    ageBuckets: buckets,
    staleCandidates,
    projects: distribution(items, (item) => item.project || "(unknown)", "project"),
    sessions: distribution(items, (item) => item.sessionId || "(unknown)", "sessionId"),
    samples: [...items]
      .sort(
        (a, b) =>
          (timestampMs(a.updatedAt) ?? Number.MAX_SAFE_INTEGER) -
          (timestampMs(b.updatedAt) ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, sampleLimit)
      .map(sample),
  };
}

function capsuleSample(item: TurnCapsule): Record<string, unknown> {
  return {
    id: item.id,
    sessionId: item.sessionId,
    turnId: item.turnId,
    project: item.project,
    updatedAt: item.updatedAt,
    files: item.files.length,
    concepts: item.concepts.length,
    observations: item.sourceObservationIds.length,
    importantObservations: item.importantObservationIds.length,
    hadFailure: item.hadFailure,
    hadDecision: item.hadDecision,
    maxImportance: item.maxImportance,
  };
}

function workingSetSample(item: SessionWorkingSet): Record<string, unknown> {
  return {
    sessionId: item.sessionId,
    project: item.project,
    updatedAt: item.updatedAt,
    latestTurnId: item.latestTurnId,
    latestCompletedTurnId: item.latestCompletedTurnId,
    files: item.latestImportantFiles.length,
    concepts: item.latestImportantConcepts.length,
    observations: item.latestImportantObservationIds.length,
    latestHadFailure: item.latestHadFailure,
    latestHadDecision: item.latestHadDecision,
  };
}

async function diagnoseScope<T extends { updatedAt?: string; project?: string }>(
  kv: StateKV,
  scope: string,
  staleAfterDays: number,
  sampleLimit: number,
  sample: (item: T) => Record<string, unknown>,
): Promise<ScopeDiagnostics> {
  try {
    return summarizeItems(
      await kv.list<T>(scope),
      staleAfterDays,
      sampleLimit,
      sample,
    );
  } catch (err) {
    return {
      count: 0,
      estimatedBytes: 0,
      ageBuckets: { lt7d: 0, d7to30: 0, d30to90: 0, gte90d: 0, unknown: 0 },
      staleCandidates: 0,
      projects: [],
      sessions: [],
      samples: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerActiveScopeDiagnosticsFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::active-scope-diagnostics", async (payload: Payload = {}) => {
    const staleAfterDays = parsePositiveInteger(payload.staleAfterDays, 30, 3650);
    const sampleLimit = parsePositiveInteger(payload.sampleLimit, 10, 100);
    const [turnCapsules, workingSets] = await Promise.all([
      diagnoseScope<TurnCapsule>(
        kv,
        KV.turnCapsules,
        staleAfterDays,
        sampleLimit,
        capsuleSample,
      ),
      diagnoseScope<SessionWorkingSet>(
        kv,
        KV.workingSets,
        staleAfterDays,
        sampleLimit,
        workingSetSample,
      ),
    ]);
    const scopes: Record<ScopeName, ScopeDiagnostics> = {
      turnCapsules,
      workingSets,
    };
    return {
      success: true,
      staleAfterDays,
      sampleLimit,
      scopes,
      totalItems: turnCapsules.count + workingSets.count,
      totalEstimatedBytes:
        turnCapsules.estimatedBytes + workingSets.estimatedBytes,
      totalStaleCandidates:
        turnCapsules.staleCandidates + workingSets.staleCandidates,
    };
  });
}
