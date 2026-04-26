import type {
  EmbeddingProvider,
  RetrievalBlock,
  RetrievalBlockRetryEntry,
} from "../types.js";
import { KV, fingerprintId } from "./schema.js";
import type { StateKV } from "./kv.js";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { IndexPersistenceStatus } from "./index-persistence.js";
import { logger } from "../logger.js";

export interface StoredRetrievalBlockEmbedding {
  provider: string;
  dimensions: number;
  textFingerprint: string;
  embedding: string;
  updatedAt: string;
}

export interface RetrievalBlockIndexResult {
  success: boolean;
  retriable: boolean;
  error?: string;
}

export interface RetrievalBlockIndexVerificationResult {
  blockCount: number;
  bm25Size: number;
  vectorSize: number;
  expectedVectorCount: number;
  vectorEligibleCount: number;
  vectorIndexedCount: number;
  vectorPresentCount: number;
  vectorMissingCount: number;
  vectorCoverageRatio: number;
  oldestMissingVectorAt?: string;
  bm25Drift: number;
  vectorDrift: number;
  rebuilt: number;
  vectorBackfilled: number;
  vectorBackfillDeferred: number;
  vectorBackfillFailures: number;
  repaired: boolean;
  persistence?: IndexPersistenceStatus;
  partial?: boolean;
  scanSource?: "scope-index" | "retrieval-block-scan" | "manifest";
  inspectedBlockCount?: number;
  timeBudgetMs?: number;
  error?: string;
}

export interface RebuildRetrievalBlockIndexOptions {
  embeddingBatchSize?: number;
  skipEmbeddingBackfill?: boolean;
}

export interface VerifyRetrievalBlockIndexOptions {
  bm25DriftRatio?: number;
  vectorDriftRatio?: number;
  minAbsoluteDrift?: number;
  rebuild?: (kv: StateKV) => Promise<number>;
  scheduleSave?: boolean;
  repair?: boolean;
  scanBlocks?: boolean;
  vectorBackfill?: boolean;
  vectorBackfillLimit?: number;
  timeBudgetMs?: number;
}

type RetrievalIndexingRuntime = {
  embeddingProvider: EmbeddingProvider | null;
  vectorIndex: VectorIndex | null;
  scheduleSave?: (() => void) | undefined;
  persistenceStatus?: (() => IndexPersistenceStatus) | undefined;
};

type RetrievalBlockScopeEntry = {
  ids?: unknown;
};

type ActiveRetrievalBlockLoadResult = {
  blocks: RetrievalBlock[];
  partial: boolean;
  source: "scope-index" | "retrieval-block-scan" | "manifest";
  inspectedBlockCount: number;
};

const runtime: RetrievalIndexingRuntime = {
  embeddingProvider: null,
  vectorIndex: null,
  scheduleSave: undefined,
  persistenceStatus: undefined,
};

let index: SearchIndex | null = null;

const DEFAULT_RETRIEVAL_BLOCK_REBUILD_EMBEDDING_BATCH_SIZE = 32;
const DEFAULT_RETRIEVAL_VECTOR_BACKFILL_LIMIT = 32;
const DEFAULT_RETRIEVAL_BLOCK_RETRY_DELAY_MS = 300_000;
const MAX_RETRIEVAL_BLOCK_RETRY_DELAY_MS = 3_600_000;
const RETRIEVAL_BLOCK_RETRY_JITTER_MS = 30_000;

function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function stableJitterMs(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % RETRIEVAL_BLOCK_RETRY_JITTER_MS;
}

function vectorCoverageRatio(present: number, eligible: number): number {
  if (eligible <= 0) return 1;
  return Math.max(0, Math.min(1, present / eligible));
}

function olderIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function blockVectorAgeTimestamp(block: RetrievalBlock): string {
  return block.updatedAt || block.eventAt || block.createdAt;
}

function isRetrievalBlock(value: unknown): value is RetrievalBlock {
  const block = value as RetrievalBlock;
  return (
    !!block &&
    typeof block.id === "string" &&
    typeof block.sourceType === "string" &&
    typeof block.sourceId === "string" &&
    typeof block.project === "string" &&
    typeof block.scope === "string" &&
    typeof block.freshnessLane === "string" &&
    typeof block.canonicalText === "string" &&
    typeof block.title === "string" &&
    Array.isArray(block.files) &&
    Array.isArray(block.concepts) &&
    Array.isArray(block.entities) &&
    Array.isArray(block.sourceObservationIds)
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function loadActiveRetrievalBlocks(kv: StateKV): Promise<RetrievalBlock[]> {
  return (await loadActiveRetrievalBlockSet(kv)).blocks;
}

function timeBudgetExceeded(startedAt: number, timeBudgetMs?: number): boolean {
  return timeBudgetMs !== undefined && Date.now() - startedAt >= timeBudgetMs;
}

async function loadActiveRetrievalBlockSet(
  kv: StateKV,
  options: { startedAt?: number; timeBudgetMs?: number } = {},
): Promise<ActiveRetrievalBlockLoadResult> {
  const startedAt = options.startedAt ?? Date.now();
  const scopeEntries = await kv
    .list<RetrievalBlockScopeEntry>(KV.retrievalBlockIndex)
    .catch(() => []);
  const activeIds = uniqueStrings(
    scopeEntries.flatMap((entry) =>
      Array.isArray(entry?.ids)
        ? entry.ids.filter((id): id is string => typeof id === "string")
        : [],
    ),
  );
  if (activeIds.length > 0) {
    const loaded: RetrievalBlock[] = [];
    let inspectedBlockCount = 0;
    for (const id of activeIds) {
      if (timeBudgetExceeded(startedAt, options.timeBudgetMs)) {
        return {
          blocks: loaded,
          partial: true,
          source: "scope-index",
          inspectedBlockCount,
        };
      }
      const block = await kv
        .get<RetrievalBlock>(KV.retrievalBlocks, id)
        .catch(() => null);
      inspectedBlockCount += 1;
      if (isRetrievalBlock(block)) loaded.push(block);
    }
    return {
      blocks: loaded,
      partial: false,
      source: "scope-index",
      inspectedBlockCount,
    };
  }
  if (options.timeBudgetMs !== undefined) {
    return {
      blocks: [],
      partial: true,
      source: "manifest",
      inspectedBlockCount: 0,
    };
  }
  const blocks = await kv.list<unknown>(KV.retrievalBlocks);
  const activeBlocks = blocks.filter(isRetrievalBlock);
  return {
    blocks: activeBlocks,
    partial: false,
    source: "retrieval-block-scan",
    inspectedBlockCount: blocks.length,
  };
}

export function nextRetrievalBlockRetryAttemptAt(
  blockId: string,
  retries: number,
  now = new Date(),
): string {
  const backoff = Math.min(
    DEFAULT_RETRIEVAL_BLOCK_RETRY_DELAY_MS * 2 ** Math.max(0, retries),
    MAX_RETRIEVAL_BLOCK_RETRY_DELAY_MS,
  );
  return new Date(
    now.getTime() + backoff + stableJitterMs(`${blockId}:${retries}`),
  ).toISOString();
}

function isRetriableRetrievalBlockIndexingError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("gemini embedding failed (429)") ||
    normalized.includes("resource_exhausted")
  ) {
    return true;
  }
  if (
    normalized.includes("statekv") &&
    (normalized.includes("timed out") || normalized.includes("temporarily unavailable"))
  ) {
    return true;
  }
  return (
    normalized.includes("invocation timeout") &&
    /state::(set|list|get|update|delete)/.test(normalized)
  );
}

async function queueRetrievalBlockRetry(
  kv: StateKV,
  block: RetrievalBlock,
  lastError: string,
): Promise<void> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const existing = await kv
    .get<RetrievalBlockRetryEntry>(KV.retrievalBlockRetry, block.id)
    .catch(() => null);
  const retries = existing?.retries ?? 0;
  const entry: RetrievalBlockRetryEntry = {
    blockId: block.id,
    sourceType: block.sourceType,
    retries,
    firstFailedAt: existing?.firstFailedAt ?? now,
    lastFailedAt: now,
    nextAttemptAt: nextRetrievalBlockRetryAttemptAt(block.id, retries, nowDate),
    lastError,
  };
  await kv.set(KV.retrievalBlockRetry, block.id, entry).catch((queueError) => {
    logger.warn("Failed to queue retrieval block retry", {
      blockId: block.id,
      sourceType: block.sourceType,
      error: errorMessage(queueError),
      originalError: lastError,
    });
  });
}

export function configureRetrievalBlockIndexingRuntime(
  next: RetrievalIndexingRuntime,
): void {
  runtime.embeddingProvider = next.embeddingProvider;
  runtime.vectorIndex = next.vectorIndex;
  runtime.scheduleSave = next.scheduleSave;
  runtime.persistenceStatus = next.persistenceStatus;
}

export function getRetrievalBlockIndexingRuntime(): Readonly<RetrievalIndexingRuntime> {
  return runtime;
}

export function getRetrievalSearchIndex(): SearchIndex {
  if (!index) index = new SearchIndex();
  return index;
}

export function getRetrievalVectorIndex(): VectorIndex | null {
  return runtime.vectorIndex;
}

export function buildRetrievalBlockLexicalText(block: RetrievalBlock): string {
  return [
    block.title,
    block.canonicalText,
    ...block.files,
    ...block.concepts,
    ...block.entities,
    block.sourceType,
    block.freshnessLane,
  ].join("\n");
}

export function buildRetrievalBlockEmbeddingText(block: RetrievalBlock): string {
  const focus = block.canonicalText.replace(/\s+/g, " ").trim().slice(0, 1200);
  return [
    `Title: ${block.title}`,
    `Source: ${block.sourceType}`,
    `Scope: ${block.scope}`,
    `Lane: ${block.freshnessLane}`,
    block.branch ? `Branch: ${block.branch}` : "",
    block.sessionId ? `Session: ${block.sessionId}` : "",
    block.files.length > 0 ? `Files: ${block.files.join(" | ")}` : "",
    block.concepts.length > 0 ? `Concepts: ${block.concepts.join(" | ")}` : "",
    block.entities.length > 0 ? `Entities: ${block.entities.join(" | ")}` : "",
    block.isResumeArtifact ? "Resume artifact: true" : "",
    block.hadFailure ? "Had failure: true" : "",
    block.hadDecision ? "Had decision: true" : "",
    block.hadAssistantConclusion ? "Had assistant conclusion: true" : "",
    `Importance: ${block.importance}`,
    focus ? `Focus: ${focus}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function syncRetrievalBlockEmbedding(
  kv: StateKV,
  block: RetrievalBlock,
): Promise<void> {
  const { embeddingProvider, vectorIndex } = runtime;
  if (!embeddingProvider || !vectorIndex) return;

  const text = buildRetrievalBlockEmbeddingText(block);
  const textFingerprint = fingerprintId(
    "rblkemb",
    `${embeddingProvider.name}:${text}`,
  );
  const cached = await kv
    .get<StoredRetrievalBlockEmbedding>(KV.retrievalBlockEmbeddings(block.id), "data")
    .catch(() => null);

  if (
    cached &&
    cached.provider === embeddingProvider.name &&
    cached.dimensions === embeddingProvider.dimensions &&
    cached.textFingerprint === textFingerprint &&
    typeof cached.embedding === "string"
  ) {
    vectorIndex.add(block.id, block.sessionId || block.project, base64ToFloat32(cached.embedding));
    return;
  }

  const embedding = await embeddingProvider.embed(text);
  vectorIndex.add(block.id, block.sessionId || block.project, embedding);
  await kv.set(KV.retrievalBlockEmbeddings(block.id), "data", {
    provider: embeddingProvider.name,
    dimensions: embeddingProvider.dimensions,
    textFingerprint,
    embedding: float32ToBase64(embedding),
    updatedAt: new Date().toISOString(),
  } satisfies StoredRetrievalBlockEmbedding);
}

export async function indexRetrievalBlock(
  kv: StateKV,
  block: RetrievalBlock,
  options?: { scheduleSave?: boolean; queueRetry?: boolean },
): Promise<RetrievalBlockIndexResult> {
  const bm25 = getRetrievalSearchIndex();
  bm25.addDocument(block.id, block.sessionId || block.project, buildRetrievalBlockLexicalText(block));
  try {
    await syncRetrievalBlockEmbedding(kv, block);
    await Promise.resolve(kv.delete(KV.retrievalBlockRetry, block.id)).catch(() => {});
    return { success: true, retriable: false };
  } catch (err) {
    const message = errorMessage(err);
    const retriable = isRetriableRetrievalBlockIndexingError(message);
    if (retriable && options?.queueRetry !== false) {
      await queueRetrievalBlockRetry(kv, block, message);
    } else {
      await Promise.resolve(kv.delete(KV.retrievalBlockRetry, block.id)).catch(() => {});
    }
    logger.warn("Failed to index retrieval block embedding", {
      blockId: block.id,
      sourceType: block.sourceType,
      error: message,
      retriable,
      queuedRetry: retriable && options?.queueRetry !== false,
    });
    return {
      success: false,
      retriable,
      error: message,
    };
  } finally {
    if (options?.scheduleSave !== false) {
      runtime.scheduleSave?.();
    }
  }
}

export async function removeRetrievalBlock(
  kv: StateKV,
  blockId: string,
  options?: { scheduleSave?: boolean },
): Promise<void> {
  getRetrievalSearchIndex().remove(blockId);
  runtime.vectorIndex?.remove(blockId);
  await Promise.resolve(kv.delete(KV.retrievalBlockEmbeddings(blockId), "data")).catch(() => {});
  await Promise.resolve(kv.delete(KV.retrievalBlockRetry, blockId)).catch(() => {});
  if (options?.scheduleSave !== false) {
    runtime.scheduleSave?.();
  }
}

export async function rebuildRetrievalBlockIndex(
  kv: StateKV,
  options: RebuildRetrievalBlockIndexOptions = {},
): Promise<number> {
  const bm25 = getRetrievalSearchIndex();
  const nextBm25 = new SearchIndex();
  const nextVectorIndex = runtime.vectorIndex ? new VectorIndex() : null;
  const blocks = await loadActiveRetrievalBlocks(kv);
  for (const block of blocks) {
    nextBm25.addDocument(
      block.id,
      block.sessionId || block.project,
      buildRetrievalBlockLexicalText(block),
    );
  }
  const { embeddingProvider, vectorIndex } = runtime;
  if (embeddingProvider && nextVectorIndex && blocks.length > 0) {
    const prepared = await Promise.all(
      blocks.map(async (block) => {
        const text = buildRetrievalBlockEmbeddingText(block);
        const textFingerprint = fingerprintId(
          "rblkemb",
          `${embeddingProvider.name}:${text}`,
        );
        const cached = await kv
          .get<StoredRetrievalBlockEmbedding>(
            KV.retrievalBlockEmbeddings(block.id),
            "data",
          )
          .catch(() => null);
        return { block, text, textFingerprint, cached };
      }),
    );

    const stale: Array<{
      block: RetrievalBlock;
      text: string;
      textFingerprint: string;
    }> = [];

    for (const item of prepared) {
      if (
        item.cached &&
        item.cached.provider === embeddingProvider.name &&
        item.cached.dimensions === embeddingProvider.dimensions &&
        item.cached.textFingerprint === item.textFingerprint &&
        typeof item.cached.embedding === "string"
      ) {
        nextVectorIndex.add(
          item.block.id,
          item.block.sessionId || item.block.project,
          base64ToFloat32(item.cached.embedding),
        );
        continue;
      }
      stale.push({
        block: item.block,
        text: item.text,
        textFingerprint: item.textFingerprint,
      });
    }

    if (stale.length > 0 && options.skipEmbeddingBackfill !== true) {
      const batchSize = positiveInteger(
        options.embeddingBatchSize ??
          process.env.RETRIEVAL_BLOCK_REBUILD_EMBEDDING_BATCH_SIZE,
        DEFAULT_RETRIEVAL_BLOCK_REBUILD_EMBEDDING_BATCH_SIZE,
      );
      for (let offset = 0; offset < stale.length; offset += batchSize) {
        const batch = stale.slice(offset, offset + batchSize);
        const embeddings = await embeddingProvider.embedBatch(
          batch.map((item) => item.text),
        );
        const updatedAt = new Date().toISOString();
        await Promise.all(
          batch.map(async (item, index) => {
            const embedding = embeddings[index];
            nextVectorIndex.add(
              item.block.id,
              item.block.sessionId || item.block.project,
              embedding,
            );
            await kv.set(KV.retrievalBlockEmbeddings(item.block.id), "data", {
              provider: embeddingProvider.name,
              dimensions: embeddingProvider.dimensions,
              textFingerprint: item.textFingerprint,
              embedding: float32ToBase64(embedding),
              updatedAt,
            } satisfies StoredRetrievalBlockEmbedding);
          }),
        );
      }
    }
  }
  bm25.restoreFrom(nextBm25);
  if (vectorIndex && nextVectorIndex) {
    vectorIndex.restoreFrom(nextVectorIndex);
  }
  return blocks.length;
}

export async function verifyRetrievalBlockIndex(
  kv: StateKV,
  options: VerifyRetrievalBlockIndexOptions = {},
): Promise<RetrievalBlockIndexVerificationResult> {
  const startedAt = Date.now();
  const bm25 = getRetrievalSearchIndex();
  const vectorIndex = runtime.vectorIndex;
  const bm25Size = bm25.size;
  const vectorSize = vectorIndex?.size ?? 0;
  const persistence = runtime.persistenceStatus?.();
  const emptyVectorRepair = {
    vectorBackfilled: 0,
    vectorBackfillDeferred: 0,
    vectorBackfillFailures: 0,
  };

  try {
    if (options.scanBlocks === false) {
      const blockCount = persistence?.manifest?.documentCount ?? bm25Size;
      const expectedVectorCount =
        runtime.embeddingProvider && vectorIndex ? blockCount : 0;
      const vectorPresentCount = Math.min(vectorSize, expectedVectorCount);
      const vectorMissingCount = Math.max(
        0,
        expectedVectorCount - vectorPresentCount,
      );
      const coverageRatio = vectorCoverageRatio(
        vectorPresentCount,
        expectedVectorCount,
      );
      return {
        blockCount,
        bm25Size,
        vectorSize,
        expectedVectorCount,
        vectorEligibleCount: expectedVectorCount,
        vectorIndexedCount: vectorPresentCount,
        vectorPresentCount,
        vectorMissingCount,
        vectorCoverageRatio: coverageRatio,
        bm25Drift: Math.abs(bm25Size - blockCount),
        vectorDrift: Math.abs(vectorSize - expectedVectorCount),
        rebuilt: 0,
        ...emptyVectorRepair,
        repaired: false,
        persistence,
      };
    }

    const blockLoad = await loadActiveRetrievalBlockSet(kv, {
      startedAt,
      timeBudgetMs: options.timeBudgetMs,
    });
    const blocks = blockLoad.blocks;
    const blockCount = blocks.length;
    const vectorEligibleBlocks =
      runtime.embeddingProvider && vectorIndex ? blocks : [];
    const vectorMissingBlocks = vectorIndex
      ? vectorEligibleBlocks.filter((block) => !vectorIndex.has(block.id))
      : [];
    const vectorEligibleCount = vectorEligibleBlocks.length;
    const vectorMissingCount = vectorMissingBlocks.length;
    const vectorPresentCount = Math.max(
      0,
      vectorEligibleCount - vectorMissingCount,
    );
    const coverageRatio = vectorCoverageRatio(
      vectorPresentCount,
      vectorEligibleCount,
    );
    const oldestMissingVectorAt = vectorMissingBlocks.reduce<string | undefined>(
      (oldest, block) => olderIso(oldest, blockVectorAgeTimestamp(block)),
      undefined,
    );
    const expectedVectorCount =
      runtime.embeddingProvider && vectorIndex ? vectorEligibleCount : 0;
    const bm25Drift = Math.abs(bm25Size - blockCount);
    const vectorDrift = Math.abs(vectorSize - expectedVectorCount);
    const bm25DriftRatio = blockCount > 0 ? bm25Drift / blockCount : 0;
    const minAbsoluteDrift = options.minAbsoluteDrift ?? 50;

    const bm25NeedsRebuild =
      !blockLoad.partial &&
      blockCount > 0 &&
      (bm25Size === 0 ||
        (bm25Drift > minAbsoluteDrift &&
          bm25DriftRatio > (options.bm25DriftRatio ?? 0.1)));

    const scanState = {
      ...(blockLoad.partial ? { partial: true } : {}),
      scanSource: blockLoad.source,
      inspectedBlockCount: blockLoad.inspectedBlockCount,
      ...(options.timeBudgetMs !== undefined
        ? { timeBudgetMs: options.timeBudgetMs }
        : {}),
    };

    if (blockLoad.partial || options.repair === false) {
      return {
        blockCount,
        bm25Size,
        vectorSize,
        expectedVectorCount,
        vectorEligibleCount,
        vectorIndexedCount: vectorPresentCount,
        vectorPresentCount,
        vectorMissingCount,
        vectorCoverageRatio: coverageRatio,
        oldestMissingVectorAt,
        bm25Drift,
        vectorDrift,
        rebuilt: 0,
        vectorBackfilled: 0,
        vectorBackfillDeferred: vectorMissingCount,
        vectorBackfillFailures: 0,
        repaired: false,
        persistence,
        ...scanState,
      };
    }

    if (bm25NeedsRebuild) {
      const rebuilt = await (options.rebuild
        ? options.rebuild(kv)
        : rebuildRetrievalBlockIndex(kv, { skipEmbeddingBackfill: true }));
      if (rebuilt > 0 && options.scheduleSave !== false) {
        runtime.scheduleSave?.();
      }
      return {
        blockCount,
        bm25Size,
        vectorSize,
        expectedVectorCount,
        vectorEligibleCount,
        vectorIndexedCount: vectorPresentCount,
        vectorPresentCount,
        vectorMissingCount,
        vectorCoverageRatio: coverageRatio,
        oldestMissingVectorAt,
        bm25Drift,
        vectorDrift,
        rebuilt,
        ...emptyVectorRepair,
        repaired: rebuilt > 0,
        persistence: runtime.persistenceStatus?.() ?? persistence,
        ...scanState,
      };
    }

    let vectorBackfilled = 0;
    let vectorBackfillFailures = 0;
    let vectorBackfillDeferred = 0;
    if (vectorMissingCount > 0) {
      if (options.vectorBackfill === false) {
        vectorBackfillDeferred = vectorMissingCount;
      } else {
        const vectorBackfillLimit = positiveInteger(
          options.vectorBackfillLimit ??
            process.env.RETRIEVAL_VECTOR_BACKFILL_LIMIT,
          DEFAULT_RETRIEVAL_VECTOR_BACKFILL_LIMIT,
        );
        const backfillTargets = vectorMissingBlocks.slice(0, vectorBackfillLimit);
        vectorBackfillDeferred = Math.max(
          0,
          vectorMissingCount - backfillTargets.length,
        );
        for (const block of backfillTargets) {
          const result = await indexRetrievalBlock(kv, block, {
            scheduleSave: false,
          });
          if (result.success) {
            vectorBackfilled += 1;
          } else {
            vectorBackfillFailures += 1;
          }
        }
        if (vectorBackfilled > 0 && options.scheduleSave === true) {
          runtime.scheduleSave?.();
        }
      }
    }

    return {
      blockCount,
      bm25Size,
      vectorSize,
      expectedVectorCount,
      vectorEligibleCount,
      vectorIndexedCount: vectorPresentCount,
      vectorPresentCount,
      vectorMissingCount,
      vectorCoverageRatio: coverageRatio,
      oldestMissingVectorAt,
      bm25Drift,
      vectorDrift,
      rebuilt: 0,
      vectorBackfilled,
      vectorBackfillDeferred,
      vectorBackfillFailures,
      repaired: vectorBackfilled > 0,
      persistence: runtime.persistenceStatus?.() ?? persistence,
      ...scanState,
    };
  } catch (err) {
    return {
      blockCount: 0,
      bm25Size,
      vectorSize,
      expectedVectorCount:
        runtime.embeddingProvider && vectorIndex ? vectorSize : 0,
      vectorEligibleCount:
        runtime.embeddingProvider && vectorIndex ? vectorSize : 0,
      vectorIndexedCount:
        runtime.embeddingProvider && vectorIndex ? vectorSize : 0,
      vectorPresentCount:
        runtime.embeddingProvider && vectorIndex ? vectorSize : 0,
      vectorMissingCount: 0,
      vectorCoverageRatio: 1,
      bm25Drift: 0,
      vectorDrift: 0,
      rebuilt: 0,
      ...emptyVectorRepair,
      repaired: false,
      persistence,
      error: errorMessage(err),
    };
  }
}
