import type { EmbeddingProvider, RetrievalBlock } from "../types.js";
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
  return [
    `Title: ${block.title}`,
    `Source: ${block.sourceType}`,
    `Scope: ${block.scope}`,
    `Lane: ${block.freshnessLane}`,
    block.files.length > 0 ? `Files: ${block.files.join(" | ")}` : "",
    block.concepts.length > 0 ? `Concepts: ${block.concepts.join(" | ")}` : "",
    block.entities.length > 0 ? `Entities: ${block.entities.join(" | ")}` : "",
    block.isResumeArtifact ? "Resume artifact: true" : "",
    block.hadFailure ? "Had failure: true" : "",
    block.hadDecision ? "Had decision: true" : "",
    block.hadAssistantConclusion ? "Had assistant conclusion: true" : "",
    `Importance: ${block.importance}`,
    block.canonicalText,
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
  options?: { scheduleSave?: boolean },
): Promise<void> {
  const bm25 = getRetrievalSearchIndex();
  bm25.addDocument(block.id, block.sessionId || block.project, buildRetrievalBlockLexicalText(block));
  try {
    await syncRetrievalBlockEmbedding(kv, block);
  } catch (err) {
    logger.warn("Failed to index retrieval block embedding", {
      blockId: block.id,
      sourceType: block.sourceType,
      error: err instanceof Error ? err.message : String(err),
    });
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
  await kv.delete(KV.retrievalBlockEmbeddings(blockId), "data").catch(() => {});
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
    await indexRetrievalBlock(kv, block, { scheduleSave: false });
  }
  return blocks.length;
}
