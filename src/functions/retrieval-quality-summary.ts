import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { RetrievalQualitySuiteResult } from "../eval/retrieval-quality.js";
import { recordAudit } from "./audit.js";

export const RETRIEVAL_QUALITY_SUMMARY_KEY =
  "retrieval-quality:last-summary";

export type RetrievalQualitySummary = {
  grade: RetrievalQualitySuiteResult["grade"];
  evaluatedAt: string;
  top1Precision: number;
  recallAt3: number;
  mrr: number;
  duplicateRate: number;
  leakageCount: number;
  p95LatencyMs: number;
  passed: boolean;
};

let cachedRetrievalQualitySummary: RetrievalQualitySummary | null = null;

function isGrade(value: unknown): value is RetrievalQualitySummary["grade"] {
  return value === "A+" || value === "A" || value === "B" || value === "C";
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function ratio(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
}

export function parseRetrievalQualitySummary(
  payload: unknown,
): { summary?: RetrievalQualitySummary; error?: string } {
  const data =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (!data) return { error: "summary payload must be an object" };

  const grade = data.grade;
  const evaluatedAt = validIso(data.evaluatedAt);
  const top1Precision = ratio(data.top1Precision);
  const recallAt3 = ratio(data.recallAt3);
  const mrr = ratio(data.mrr);
  const duplicateRate = ratio(data.duplicateRate);
  const leakageCount = finiteNumber(data.leakageCount);
  const p95LatencyMs = finiteNumber(data.p95LatencyMs);
  const passed = data.passed;

  if (!isGrade(grade)) return { error: "grade must be A+, A, B, or C" };
  if (!evaluatedAt) return { error: "evaluatedAt must be a valid ISO timestamp" };
  if (top1Precision === undefined) {
    return { error: "top1Precision must be a number between 0 and 1" };
  }
  if (recallAt3 === undefined) {
    return { error: "recallAt3 must be a number between 0 and 1" };
  }
  if (mrr === undefined) return { error: "mrr must be a number between 0 and 1" };
  if (duplicateRate === undefined) {
    return { error: "duplicateRate must be a number between 0 and 1" };
  }
  if (leakageCount === undefined || leakageCount < 0) {
    return { error: "leakageCount must be a non-negative number" };
  }
  if (p95LatencyMs === undefined || p95LatencyMs < 0) {
    return { error: "p95LatencyMs must be a non-negative number" };
  }
  if (typeof passed !== "boolean") return { error: "passed must be a boolean" };

  return {
    summary: {
      grade,
      evaluatedAt,
      top1Precision,
      recallAt3,
      mrr,
      duplicateRate,
      leakageCount,
      p95LatencyMs,
      passed,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStoredRetrievalQualitySummary(
  payload: unknown,
): { summary?: RetrievalQualitySummary; error?: string } {
  const parsed = parseRetrievalQualitySummary(payload);
  if (parsed.summary) return parsed;
  const data =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (!data) return parsed;
  const grade = data.grade;
  const evaluatedAt = validIso(data.evaluatedAt);
  const duplicateRate = ratio(data.duplicateRate);
  const recallAt3 = ratio(data.recallAt3);
  const leakageCount = finiteNumber(data.leakageCount);
  if (
    !isGrade(grade) ||
    !evaluatedAt ||
    duplicateRate === undefined ||
    recallAt3 === undefined ||
    leakageCount === undefined ||
    leakageCount < 0
  ) {
    return parsed;
  }
  return {
    summary: {
      grade,
      evaluatedAt,
      top1Precision: ratio(data.top1Precision) ?? 0,
      recallAt3,
      mrr: ratio(data.mrr) ?? 0,
      duplicateRate,
      leakageCount,
      p95LatencyMs: finiteNumber(data.p95LatencyMs) ?? 0,
      passed: data.passed === true,
    },
  };
}

export function getCachedRetrievalQualitySummary(): RetrievalQualitySummary | null {
  return cachedRetrievalQualitySummary;
}

export function resetRetrievalQualitySummaryCacheForTests(): void {
  cachedRetrievalQualitySummary = null;
}

export async function loadRetrievalQualitySummary(
  kv: StateKV,
): Promise<{
  summary: RetrievalQualitySummary | null;
  source: "kv" | "cache" | "none";
  error?: string;
}> {
  try {
    const stored = await kv.get<RetrievalQualitySummary>(
      KV.config,
      RETRIEVAL_QUALITY_SUMMARY_KEY,
    );
    if (!stored) {
      return cachedRetrievalQualitySummary
        ? { summary: cachedRetrievalQualitySummary, source: "cache" }
        : { summary: null, source: "none" };
    }
    const parsed = parseStoredRetrievalQualitySummary(stored);
    if (parsed.summary) {
      cachedRetrievalQualitySummary = parsed.summary;
      return { summary: parsed.summary, source: "kv" };
    }
    return cachedRetrievalQualitySummary
      ? { summary: cachedRetrievalQualitySummary, source: "cache", error: parsed.error }
      : { summary: null, source: "none", error: parsed.error };
  } catch (error) {
    return cachedRetrievalQualitySummary
      ? { summary: cachedRetrievalQualitySummary, source: "cache", error: errorMessage(error) }
      : { summary: null, source: "none", error: errorMessage(error) };
  }
}

export function registerRetrievalQualitySummaryFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-quality-summary", async (payload: unknown) => {
    const parsed = parseRetrievalQualitySummary(payload);
    if (parsed.error) {
      return { success: false, error: parsed.error };
    }
    await kv.set(
      KV.config,
      RETRIEVAL_QUALITY_SUMMARY_KEY,
      parsed.summary!,
    );
    cachedRetrievalQualitySummary = parsed.summary!;
    await recordAudit(
      kv,
      "retrieval_quality_summary",
      "mem::retrieval-quality-summary",
      [RETRIEVAL_QUALITY_SUMMARY_KEY],
      {
        grade: parsed.summary!.grade,
        passed: parsed.summary!.passed,
        recallAt3: parsed.summary!.recallAt3,
        leakageCount: parsed.summary!.leakageCount,
      },
    );
    return { success: true, summary: parsed.summary };
  });
}
