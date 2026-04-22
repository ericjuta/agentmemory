import type { CompressedObservation, EmbeddingProvider } from "../types.js";
import { KV, fingerprintId } from "./schema.js";
import type { StateKV } from "./kv.js";
import type { SearchIndex } from "./search-index.js";
import type { VectorIndex } from "./vector-index.js";
import { logger } from "../logger.js";

export interface StoredObservationEmbedding {
  sessionId: string;
  provider: string;
  dimensions: number;
  textFingerprint: string;
  embedding: string;
  updatedAt: string;
}

type ObservationIndexingRuntime = {
  embeddingProvider: EmbeddingProvider | null;
  vectorIndex: VectorIndex | null;
  scheduleSave?: (() => void) | undefined;
};

const runtime: ObservationIndexingRuntime = {
  embeddingProvider: null,
  vectorIndex: null,
  scheduleSave: undefined,
};

function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(bytes);
}

export function configureObservationIndexingRuntime(
  next: ObservationIndexingRuntime,
): void {
  runtime.embeddingProvider = next.embeddingProvider;
  runtime.vectorIndex = next.vectorIndex;
  runtime.scheduleSave = next.scheduleSave;
}

export function resetObservationIndexingRuntime(): void {
  runtime.embeddingProvider = null;
  runtime.vectorIndex = null;
  runtime.scheduleSave = undefined;
}

export function getObservationIndexingRuntime(): Readonly<ObservationIndexingRuntime> {
  return runtime;
}

export function buildObservationEmbeddingText(
  observation: CompressedObservation,
): string {
  const sections = [
    `Title: ${observation.title}`,
    observation.subtitle ? `Subtitle: ${observation.subtitle}` : "",
    observation.narrative ? `Narrative: ${observation.narrative}` : "",
    observation.facts.length > 0 ? `Facts: ${observation.facts.join(" | ")}` : "",
    observation.concepts.length > 0
      ? `Concepts: ${observation.concepts.join(" | ")}`
      : "",
    observation.files.length > 0 ? `Files: ${observation.files.join(" | ")}` : "",
    `Type: ${observation.type}`,
    `Importance: ${observation.importance}`,
  ].filter(Boolean);
  return sections.join("\n");
}

async function syncObservationEmbedding(
  kv: StateKV,
  observation: CompressedObservation,
): Promise<void> {
  const { embeddingProvider, vectorIndex } = runtime;
  if (!embeddingProvider || !vectorIndex) return;

  const text = buildObservationEmbeddingText(observation);
  const textFingerprint = fingerprintId("embtxt", text);
  const cached = await kv
    .get<StoredObservationEmbedding>(KV.embeddings(observation.id), "data")
    .catch(() => null);

  if (
    cached &&
    cached.sessionId === observation.sessionId &&
    cached.provider === embeddingProvider.name &&
    cached.dimensions === embeddingProvider.dimensions &&
    cached.textFingerprint === textFingerprint &&
    typeof cached.embedding === "string"
  ) {
    vectorIndex.add(
      observation.id,
      observation.sessionId,
      base64ToFloat32(cached.embedding),
    );
    return;
  }

  const embedding = await embeddingProvider.embed(text);
  vectorIndex.add(observation.id, observation.sessionId, embedding);
  await kv.set(KV.embeddings(observation.id), "data", {
    sessionId: observation.sessionId,
    provider: embeddingProvider.name,
    dimensions: embeddingProvider.dimensions,
    textFingerprint,
    embedding: float32ToBase64(embedding),
    updatedAt: new Date().toISOString(),
  } satisfies StoredObservationEmbedding);
}

export async function indexCompressedObservation(
  kv: StateKV,
  bm25: SearchIndex,
  observation: CompressedObservation,
  options?: { scheduleSave?: boolean },
): Promise<void> {
  bm25.add(observation);
  try {
    await syncObservationEmbedding(kv, observation);
  } catch (err) {
    logger.warn("Failed to index observation embedding", {
      obsId: observation.id,
      sessionId: observation.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (options?.scheduleSave !== false) {
      runtime.scheduleSave?.();
    }
  }
}
