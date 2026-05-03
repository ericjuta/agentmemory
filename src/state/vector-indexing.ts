import type { CompressedObservation, EmbeddingProvider } from "../types.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { VectorIndex } from "./vector-index.js";
import { logger } from "../logger.js";

interface StoredEmbedding {
  dimensions?: number;
  embedding?: string;
  provider?: string;
  textHash?: string;
  updatedAt?: string;
}

interface IndexVectorOptions {
  generateMissing?: boolean;
}

interface PopulateVectorOptions extends IndexVectorOptions {
  concurrency?: number;
  maxGenerate?: number;
}

export function observationEmbeddingText(obs: CompressedObservation): string {
  return [
    obs.title,
    obs.subtitle || "",
    obs.type,
    obs.narrative,
    ...obs.facts,
    ...obs.concepts,
    ...obs.files,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 12000);
}

export async function indexObservationVector(
  obs: CompressedObservation,
  vector: VectorIndex,
  provider: EmbeddingProvider,
  kv: StateKV,
  options: IndexVectorOptions = {},
): Promise<"stored" | "generated" | "skipped"> {
  const stored = await kv
    .get<StoredEmbedding | { data?: StoredEmbedding }>(KV.embeddings(obs.id), "data")
    .catch(() => null);
  const restored = decodeStoredEmbedding(stored, provider.dimensions);
  if (restored) {
    vector.add(obs.id, obs.sessionId, restored);
    return "stored";
  }

  if (!options.generateMissing) return "skipped";
  const embedding = await provider.embed(observationEmbeddingText(obs));
  vector.add(obs.id, obs.sessionId, embedding);
  await kv
    .set(KV.embeddings(obs.id), "data", {
      dimensions: embedding.length,
      embedding: float32ToBase64(embedding),
      provider: provider.name,
      updatedAt: new Date().toISOString(),
    } satisfies StoredEmbedding)
    .catch((err) => {
      logger.warn("vector index: failed to persist generated embedding", {
        obsId: obs.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return "generated";
}

export async function populateVectorIndex(
  observations: CompressedObservation[],
  vector: VectorIndex,
  provider: EmbeddingProvider,
  kv: StateKV,
  options: PopulateVectorOptions = {},
): Promise<{ stored: number; generated: number; skipped: number; failed: number }> {
  const nextVector = new VectorIndex();
  const previousSize = vector.size;
  if (options.generateMissing === true && previousSize > 0) {
    nextVector.restoreFrom(vector);
  }
  let stored = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 32));
  let next = 0;
  const missing: CompressedObservation[] = [];

  async function worker(): Promise<void> {
    while (next < observations.length) {
      const obs = observations[next++];
      if (!obs) continue;
      try {
        if (options.generateMissing === true && nextVector.has(obs.id)) {
          stored++;
          continue;
        }
        if (options.generateMissing === true && previousSize > 0) {
          missing.push(obs);
          continue;
        }
        const result = await indexObservationVector(obs, nextVector, provider, kv);
        if (result === "stored") stored++;
        else missing.push(obs);
      } catch (err) {
        failed++;
        logger.warn("vector index: failed to index observation", {
          obsId: obs.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (options.generateMissing === true) {
    const limit = options.maxGenerate ?? missing.length;
    const toGenerate = missing.slice(0, Math.max(0, limit));
    skipped += missing.length - toGenerate.length;
    for (let i = 0; i < toGenerate.length; i += 100) {
      const batch = toGenerate.slice(i, i + 100);
      try {
        const embeddings = await provider.embedBatch(batch.map(observationEmbeddingText));
        const updatedAt = new Date().toISOString();
        await Promise.all(
          batch.map(async (obs, idx) => {
            const embedding = embeddings[idx];
            if (!embedding) {
              failed++;
              return;
            }
            nextVector.add(obs.id, obs.sessionId, embedding);
            generated++;
            await kv
              .set(KV.embeddings(obs.id), "data", {
                dimensions: embedding.length,
                embedding: float32ToBase64(embedding),
                provider: provider.name,
                updatedAt,
              } satisfies StoredEmbedding)
              .catch((err) => {
                logger.warn("vector index: failed to persist generated embedding", {
                  obsId: obs.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }),
        );
      } catch (err) {
        failed += batch.length;
        logger.warn("vector index: failed to generate embedding batch", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    skipped += missing.length;
  }
  if (failed === 0 || nextVector.size >= previousSize) {
    vector.restoreFrom(nextVector);
  }
  return { stored, generated, skipped, failed };
}

function decodeStoredEmbedding(
  raw: StoredEmbedding | { data?: StoredEmbedding } | null,
  expectedDimensions: number,
): Float32Array | null {
  const data = raw && "data" in raw && raw.data ? raw.data : raw;
  if (!data || typeof data.embedding !== "string") return null;
  const arr = base64ToFloat32(data.embedding);
  if (arr.length !== expectedDimensions) return null;
  return arr;
}

function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
