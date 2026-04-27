import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { KV, retrievalBlockShardScope } from "../state/schema.js";
import type { RetrievalBlock } from "../types.js";

type MigrationPayload = {
  batchSize?: unknown;
  timeBudgetMs?: unknown;
  dryRun?: unknown;
  deleteLegacy?: unknown;
};

type RawStateKV = StateKV & {
  getRaw?: <T = unknown>(scope: string, key: string) => Promise<T | null>;
  setRaw?: <T = unknown>(scope: string, key: string, value: T) => Promise<T>;
  deleteRaw?: (scope: string, key: string) => Promise<void>;
  listRaw?: <T = unknown>(scope: string) => Promise<T[]>;
};

type MigrationOptions = {
  candidateIds?: () => string[];
};

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIME_BUDGET_MS = 10_000;

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRetrievalBlock(value: unknown): value is RetrievalBlock {
  const row = value as RetrievalBlock;
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.id === "string" &&
    typeof row.sourceType === "string" &&
    typeof row.sourceId === "string"
  );
}

async function rawListLegacyBlocks(kv: RawStateKV): Promise<RetrievalBlock[]> {
  const rows = kv.listRaw
    ? await kv.listRaw<unknown>(KV.retrievalBlocks)
    : await kv.list<unknown>(KV.retrievalBlocks);
  return rows.filter(isRetrievalBlock);
}

async function rawGetLegacyBlock(
  kv: RawStateKV,
  blockId: string,
): Promise<RetrievalBlock | null> {
  const row = kv.getRaw
    ? await kv.getRaw<unknown>(KV.retrievalBlocks, blockId)
    : await kv.get<unknown>(KV.retrievalBlocks, blockId);
  return isRetrievalBlock(row) ? row : null;
}

async function writeShard(kv: RawStateKV, block: RetrievalBlock): Promise<void> {
  const scope = retrievalBlockShardScope(block.id);
  if (kv.setRaw) {
    await kv.setRaw(scope, block.id, block);
  } else {
    await kv.set(scope, block.id, block);
  }
}

async function verifyShard(kv: RawStateKV, block: RetrievalBlock): Promise<boolean> {
  const scope = retrievalBlockShardScope(block.id);
  const stored = kv.getRaw
    ? await kv.getRaw<RetrievalBlock>(scope, block.id)
    : await kv.get<RetrievalBlock>(scope, block.id);
  return stored?.id === block.id;
}

async function deleteLegacy(kv: RawStateKV, blockId: string): Promise<void> {
  if (kv.deleteRaw) {
    await kv.deleteRaw(KV.retrievalBlocks, blockId);
    return;
  }
  await kv.delete(KV.retrievalBlocks, blockId);
}

export function registerRetrievalBlockStorageMigrationFunction(
  sdk: ISdk,
  kv: StateKV,
  options: MigrationOptions = {},
): void {
  sdk.registerFunction(
    "mem::retrieval-blocks-migrate-shards",
    async (payload: unknown) => {
      const data =
        payload && typeof payload === "object"
          ? (payload as MigrationPayload)
          : {};
      const batchSize = parsePositiveInteger(data.batchSize, DEFAULT_BATCH_SIZE);
      const timeBudgetMs = parsePositiveInteger(
        data.timeBudgetMs,
        DEFAULT_TIME_BUDGET_MS,
      );
      const dryRun = data.dryRun === true;
      const shouldDeleteLegacy = data.deleteLegacy !== false;
      const startedAt = Date.now();
      const rawKv = kv as RawStateKV;
      let migrated = 0;
      let deletedLegacy = 0;
      let failed = 0;
      let inspected = 0;
      let legacyCount = 0;
      const errors: Array<{ blockId: string; error: string }> = [];
      const indexedCandidateIds = uniqueStrings(options.candidateIds?.() ?? []);
      const source =
        indexedCandidateIds.length > 0 ? "index-candidates" : "legacy-list";

      const processBlock = async (block: RetrievalBlock): Promise<void> => {
        if (dryRun) {
          migrated++;
          return;
        }
        try {
          await writeShard(rawKv, block);
          const verified = await verifyShard(rawKv, block);
          if (!verified) throw new Error("shard verification failed");
          migrated++;
          if (shouldDeleteLegacy) {
            await deleteLegacy(rawKv, block.id);
            deletedLegacy++;
          }
        } catch (error) {
          failed++;
          errors.push({ blockId: block.id, error: errorMessage(error) });
        }
      };

      if (indexedCandidateIds.length > 0) {
        for (const blockId of indexedCandidateIds) {
          if (Date.now() - startedAt >= timeBudgetMs) break;
          const block = await rawGetLegacyBlock(rawKv, blockId).catch((error) => {
            failed++;
            errors.push({ blockId, error: errorMessage(error) });
            return null;
          });
          inspected++;
          if (!block) continue;
          legacyCount++;
          await processBlock(block);
          if (migrated + failed >= batchSize) break;
        }
      } else {
        const legacyBlocks = await rawListLegacyBlocks(rawKv);
        legacyCount = legacyBlocks.length;
        const selected = legacyBlocks.slice(0, batchSize);
        for (const block of selected) {
          if (Date.now() - startedAt >= timeBudgetMs) break;
          inspected++;
          await processBlock(block);
          if (migrated + failed >= batchSize) break;
        }
      }

      const scanComplete =
        source === "index-candidates"
          ? inspected >= indexedCandidateIds.length
          : inspected >= legacyCount;
      const uninspectedEstimate =
        source === "index-candidates" && !scanComplete
          ? indexedCandidateIds.length - inspected
          : 0;
      const processed = migrated + failed;
      const remainingEstimate =
        dryRun || !shouldDeleteLegacy
          ? legacyCount + uninspectedEstimate
          : Math.max(0, legacyCount - deletedLegacy) + uninspectedEstimate;
      const completed = dryRun
        ? failed === 0 && scanComplete
        : failed === 0 && scanComplete && remainingEstimate === 0;

      return {
        success: failed === 0,
        source,
        dryRun,
        deleteLegacy: shouldDeleteLegacy,
        candidateCount:
          source === "index-candidates" ? indexedCandidateIds.length : legacyCount,
        legacyCount,
        selected: legacyCount,
        inspected,
        scanComplete,
        processed,
        migrated,
        deletedLegacy,
        failed,
        remainingEstimate,
        completed,
        errors,
        durationMs: Date.now() - startedAt,
      };
    },
  );
}
