import { getEnvVar } from "../config.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { getRetrievalBlockIndexingRuntime } from "../state/retrieval-block-indexing.js";

export interface ConsolidationCursor {
  lastId?: string;
  updatedAt: string;
  cycles: number;
}

export interface ConsolidationBatch<T> {
  items: T[];
  cursor: ConsolidationCursor;
  key: string;
  exhausted: boolean;
}

export interface ConsolidationDeferral {
  reason: string;
  status: string;
  lastFailureAt?: string;
  error?: string;
  cooldownMs: number;
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export function readPositiveEnv(name: string, fallback: number): number {
  return parsePositiveInt(getEnvVar(name), fallback);
}

export function consolidationCursorKey(tier: string, project?: string): string {
  return `consolidation:cursor:${tier}:${encodeURIComponent(project || "global")}`;
}

export async function readConsolidationCursor(
  kv: StateKV,
  tier: string,
  project?: string,
): Promise<ConsolidationCursor | null> {
  const row = await kv
    .get<Partial<ConsolidationCursor>>(KV.config, consolidationCursorKey(tier, project))
    .catch(() => null);
  if (!row || typeof row !== "object") return null;
  return {
    lastId: typeof row.lastId === "string" ? row.lastId : undefined,
    updatedAt:
      typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
    cycles:
      typeof row.cycles === "number" && Number.isFinite(row.cycles)
        ? row.cycles
        : 0,
  };
}

export async function writeConsolidationCursor(
  kv: StateKV,
  tier: string,
  project: string | undefined,
  cursor: ConsolidationCursor,
): Promise<void> {
  await kv.set(KV.config, consolidationCursorKey(tier, project), cursor);
}

export async function selectConsolidationBatch<T>(
  kv: StateKV,
  tier: string,
  project: string | undefined,
  items: T[],
  limit: number,
  idOf: (item: T) => string,
): Promise<ConsolidationBatch<T>> {
  const key = consolidationCursorKey(tier, project);
  const cursor = await readConsolidationCursor(kv, tier, project);
  const safeLimit = Math.max(1, Math.floor(limit));
  const startIndex = cursor?.lastId
    ? items.findIndex((item) => idOf(item) === cursor.lastId) + 1
    : 0;
  const normalizedStart = startIndex > 0 ? startIndex : 0;
  const selected = items.slice(normalizedStart, normalizedStart + safeLimit);
  const wrapped = selected.length < safeLimit && items.length > selected.length;
  const itemsToUse = wrapped
    ? [...selected, ...items.slice(0, safeLimit - selected.length)]
    : selected;
  const lastItem = itemsToUse.at(-1);
  const exhausted =
    itemsToUse.length === 0 ||
    (wrapped
      ? itemsToUse.length >= items.length
      : normalizedStart + itemsToUse.length >= items.length);
  const nextCursor: ConsolidationCursor = {
    lastId: exhausted ? undefined : lastItem ? idOf(lastItem) : cursor?.lastId,
    updatedAt: new Date().toISOString(),
    cycles: (cursor?.cycles ?? 0) + (exhausted ? 1 : 0),
  };
  return { items: itemsToUse, cursor: nextCursor, key, exhausted };
}

export async function persistConsolidationBatchCursor<T>(
  kv: StateKV,
  batch: ConsolidationBatch<T>,
): Promise<void> {
  await kv.set(KV.config, batch.key, batch.cursor);
}

export function recentRetrievalIndexPersistenceFailure(
  force = false,
): ConsolidationDeferral | null {
  if (force) return null;
  const status = getRetrievalBlockIndexingRuntime().persistenceStatus?.();
  if (!status || status.status !== "error") return null;
  const cooldownMs = readPositiveEnv(
    "CONSOLIDATION_RETRIEVAL_INDEX_COOLDOWN_MS",
    600_000,
  );
  const failureMs = status.lastFailureAt
    ? new Date(status.lastFailureAt).getTime()
    : Date.now();
  if (Number.isFinite(failureMs) && Date.now() - failureMs > cooldownMs) {
    return null;
  }
  return {
    reason: "recent_retrieval_index_persistence_failure",
    status: status.status,
    lastFailureAt: status.lastFailureAt,
    error: status.error,
    cooldownMs,
  };
}
