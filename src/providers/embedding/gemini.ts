import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";

const BATCH_LIMIT = 100;
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "text-embedding-004";

function resolveRequestModel(rawModel: string | undefined): string {
  const configured = rawModel?.trim() || DEFAULT_MODEL;
  return configured.startsWith("models/") ? configured : `models/${configured}`;
}

function resolvePathModel(requestModel: string): string {
  return requestModel.replace(/^models\//, "");
}

function resolveDimensions(rawDimensions: string | undefined): number {
  if (rawDimensions === undefined) return 768;
  const parsed = parseInt(rawDimensions, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `GEMINI_EMBEDDING_DIMENSIONS must be a positive integer, got: ${rawDimensions}`,
    );
  }
  return parsed;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions: number;
  private requestModel: string;
  private pathModel: string;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("GEMINI_API_KEY") || "";
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is required");
    this.requestModel = resolveRequestModel(getEnvVar("GEMINI_EMBEDDING_MODEL"));
    this.pathModel = resolvePathModel(this.requestModel);
    this.dimensions = resolveDimensions(
      getEnvVar("GEMINI_EMBEDDING_DIMENSIONS"),
    );
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      const chunk = texts.slice(i, i + BATCH_LIMIT);
      const response = await fetch(
        `${API_BASE}/${this.pathModel}:batchEmbedContents?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: chunk.map((t) => ({
              model: this.requestModel,
              content: { parts: [{ text: t }] },
            })),
          }),
        },
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini embedding failed (${response.status}): ${err}`);
      }

      const data = (await response.json()) as {
        embeddings: Array<{ values: number[] }>;
      };

      for (const emb of data.embeddings) {
        results.push(new Float32Array(emb.values));
      }
    }

    return results;
  }
}
