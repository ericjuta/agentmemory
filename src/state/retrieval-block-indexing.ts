import type {
  EmbeddingProvider,
  RetrievalBlock,
  RetrievalBlockRetryEntry,
} from "../types.js";
import { KV, fingerprintId } from "./schema.js";
import type { StateKV } from "./kv.js";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
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

type RetrievalIndexingRuntime = {
  embeddingProvider: EmbeddingProvider | null;
  vectorIndex: VectorIndex | null;
  scheduleSave?: (() => void) | undefined;
};

const runtime: RetrievalIndexingRuntime = {
  embeddingProvider: null,
  vectorIndex: null,
  scheduleSave: undefined,
};

let index: SearchIndex | null = null;

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
  const now = new Date().toISOString();
  const existing = await kv
    .get<RetrievalBlockRetryEntry>(KV.retrievalBlockRetry, block.id)
    .catch(() => null);
  const entry: RetrievalBlockRetryEntry = {
    blockId: block.id,
    sourceType: block.sourceType,
    retries: existing?.retries ?? 0,
    firstFailedAt: existing?.firstFailedAt ?? now,
    lastFailedAt: now,
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

export async function rebuildRetrievalBlockIndex(kv: StateKV): Promise<number> {
  const bm25 = getRetrievalSearchIndex();
  bm25.clear();
  runtime.vectorIndex?.clear();
  const blocks = await kv.list<RetrievalBlock>(KV.retrievalBlocks).catch(() => []);
  for (const block of blocks) {
    bm25.addDocument(
      block.id,
      block.sessionId || block.project,
      buildRetrievalBlockLexicalText(block),
    );
  }
  const { embeddingProvider, vectorIndex } = runtime;
  if (embeddingProvider && vectorIndex && blocks.length > 0) {
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
        vectorIndex.add(
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

    if (stale.length > 0) {
      const embeddings = await embeddingProvider.embedBatch(
        stale.map((item) => item.text),
      );
      await Promise.all(
        stale.map(async (item, index) => {
          const embedding = embeddings[index];
          vectorIndex.add(
            item.block.id,
            item.block.sessionId || item.block.project,
            embedding,
          );
          await kv.set(KV.retrievalBlockEmbeddings(item.block.id), "data", {
            provider: embeddingProvider.name,
            dimensions: embeddingProvider.dimensions,
            textFingerprint: item.textFingerprint,
            embedding: float32ToBase64(embedding),
            updatedAt: new Date().toISOString(),
          } satisfies StoredRetrievalBlockEmbedding);
        }),
      );
    }
  }
  return blocks.length;
}
