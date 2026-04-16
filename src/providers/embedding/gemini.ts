// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";

const BATCH_LIMIT = 100;
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-embedding-2-preview";
const DEFAULT_DIMENSIONS = 768;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimensions: number;
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("GEMINI_API_KEY") || "";
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is required");
    this.model = getEnvVar("GEMINI_EMBEDDING_MODEL") || DEFAULT_MODEL;
    this.dimensions = parsePositiveInt(
      getEnvVar("GEMINI_EMBEDDING_DIMENSIONS"),
      DEFAULT_DIMENSIONS,
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
      for (const text of chunk) {
        const response = await fetch(
          `${API_BASE}/models/${this.model}:embedContent?key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: `models/${this.model}`,
              content: { parts: [{ text }] },
              output_dimensionality: this.dimensions,
            }),
          },
        );

        if (!response.ok) {
          const err = await response.text();
          throw new Error(
            `Gemini embedding failed (${response.status}): ${err}`,
          );
        }

        const data = (await response.json()) as {
          embedding?: { values: number[] };
        };
        const values = data.embedding?.values;
        if (!Array.isArray(values)) {
          throw new Error(
            `Gemini embedding returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
          );
        }
        results.push(new Float32Array(values));
      }
    }

    return results;
  }
}
