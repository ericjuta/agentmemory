// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiEmbeddingProvider } from "../src/providers/embedding/gemini.js";

describe("GeminiEmbeddingProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["GEMINI_EMBEDDING_MODEL"];
    delete process.env["GEMINI_EMBEDDING_DIMENSIONS"];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses gemini-embedding-2-preview with a sane default dimension floor", async () => {
    process.env["GEMINI_API_KEY"] = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: [0.1, 0.2] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiEmbeddingProvider();
    expect(provider.dimensions).toBeGreaterThanOrEqual(768);

    const [embedding] = await provider.embedBatch(["hello"]);

    expect(embedding).toBeInstanceOf(Float32Array);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent?key=test-key",
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe("models/gemini-embedding-2-preview");
    expect(body.output_dimensionality).toBe(provider.dimensions);
  });

  it("respects explicit model and dimension overrides", async () => {
    process.env["GEMINI_API_KEY"] = "test-key";
    process.env["GEMINI_EMBEDDING_MODEL"] = "custom-gemini-model";
    process.env["GEMINI_EMBEDDING_DIMENSIONS"] = "512";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: [0.3, 0.4] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiEmbeddingProvider();
    expect(provider.dimensions).toBe(512);

    await provider.embedBatch(["hello"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/custom-gemini-model:embedContent?key=test-key",
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe("models/custom-gemini-model");
    expect(body.output_dimensionality).toBe(512);
  });
});
