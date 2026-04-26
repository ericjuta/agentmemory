import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadRetrievalQualitySummary,
  registerRetrievalQualitySummaryFunction,
  RETRIEVAL_QUALITY_SUMMARY_KEY,
  resetRetrievalQualitySummaryCacheForTests,
} from "../src/functions/retrieval-quality-summary.js";
import { registerRetrievalBlockDiagnosticsFunction } from "../src/functions/retrieval-block-diagnostics.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const summary = {
  grade: "A+" as const,
  evaluatedAt: "2026-04-26T12:00:00.000Z",
  top1Precision: 1,
  recallAt3: 1,
  mrr: 1,
  duplicateRate: 0,
  leakageCount: 0,
  p95LatencyMs: 180,
  passed: true,
};

describe("retrieval quality summary persistence", () => {
  beforeEach(() => {
    resetRetrievalQualitySummaryCacheForTests();
  });

  afterEach(() => {
    resetRetrievalQualitySummaryCacheForTests();
  });

  it("stores only the compact summary used by diagnostics", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalQualitySummaryFunction(sdk as never, kv as never);
    registerRetrievalBlockDiagnosticsFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::retrieval-quality-summary", {
      ...summary,
      cases: [{ id: "large-trace-should-not-persist" }],
    });
    const stored = await kv.get(KV.config, RETRIEVAL_QUALITY_SUMMARY_KEY);
    const diagnostics = (await sdk.trigger("mem::retrieval-blocks-diagnostics", {
      project: "/project",
    })) as {
      quality: {
        duplicateRate: number | null;
        lastEvalGrade: string | null;
        lastEvalRecallAt3: number | null;
        lastEvalLeakageCount: number | null;
        lastEvalSummarySource: string;
      };
    };

    expect(result).toMatchObject({ success: true, summary });
    expect(stored).toEqual(summary);
    expect(diagnostics.quality).toMatchObject({
      duplicateRate: 0,
      lastEvalGrade: "A+",
      lastEvalRecallAt3: 1,
      lastEvalLeakageCount: 0,
      lastEvalSummarySource: "kv",
    });
  });

  it("uses the cached summary when StateKV summary read fails", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalQualitySummaryFunction(sdk as never, kv as never);
    await sdk.trigger("mem::retrieval-quality-summary", summary);

    const failingKv = {
      ...kv,
      get: async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === KV.config && key === RETRIEVAL_QUALITY_SUMMARY_KEY) {
          throw new Error("StateKV cooldown");
        }
        return kv.get<T>(scope, key);
      },
    };

    await expect(loadRetrievalQualitySummary(failingKv as never)).resolves.toEqual({
      summary,
      source: "cache",
      error: "StateKV cooldown",
    });
  });

  it("rejects invalid summary payloads", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalQualitySummaryFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::retrieval-quality-summary", {
      ...summary,
      recallAt3: 2,
    });

    expect(result).toEqual({
      success: false,
      error: "recallAt3 must be a number between 0 and 1",
    });
    expect(await kv.get(KV.config, RETRIEVAL_QUALITY_SUMMARY_KEY)).toBeNull();
  });

  it("exposes a whitelisted REST writer for live eval summaries", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRetrievalQualitySummaryFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);

    const response = (await sdk.trigger("api::retrieval-quality-summary", {
      body: {
        ...summary,
        ignoredTrace: ["drop"],
      },
      headers: {},
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(await kv.get(KV.config, RETRIEVAL_QUALITY_SUMMARY_KEY)).toEqual(
      summary,
    );
  });
});
