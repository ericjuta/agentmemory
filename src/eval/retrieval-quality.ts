export interface RetrievalQualityEvalCase {
  id: string;
  query: string;
  resultIds: string[];
  relevantIds: string[];
  k?: number;
  forbiddenIds?: string[];
  duplicateGroups?: string[][];
  latencyMs?: number;
  project?: string;
  branch?: string;
  intent?: string;
  traceReasons?: string[];
}

export interface RetrievalQualityGates {
  minPrecisionAtK?: number;
  minRecallAtK?: number;
  minMrr?: number;
  maxDuplicateRate?: number;
  maxForbiddenHits?: number;
  minTop1Precision?: number;
  minRecallAt3?: number;
  minContextGoldCoverage?: number;
  maxP95LatencyMs?: number;
}

export interface RetrievalQualityCaseMetrics {
  id: string;
  query: string;
  k: number;
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  duplicateRate: number;
  forbiddenHitCount: number;
  top1Precision: number;
  recallAt3: number;
  latencyMs?: number;
  passed: boolean;
  failures: string[];
}

export interface RetrievalQualitySuiteResult {
  cases: RetrievalQualityCaseMetrics[];
  averages: {
    precisionAtK: number;
    recallAtK: number;
    mrr: number;
    duplicateRate: number;
    top1Precision: number;
    recallAt3: number;
    p95LatencyMs: number;
    leakageCount: number;
    contextGoldCoverage: number;
  };
  grade: "A+" | "A" | "B" | "C";
  evaluatedAt: string;
  passed: boolean;
}

export const DEFAULT_RETRIEVAL_QUALITY_GATES: Required<RetrievalQualityGates> = {
  minPrecisionAtK: 0.67,
  minRecallAtK: 0.67,
  minMrr: 0.5,
  maxDuplicateRate: 0.1,
  maxForbiddenHits: 0,
  minTop1Precision: 0.7,
  minRecallAt3: 0.9,
  minContextGoldCoverage: 0.95,
  maxP95LatencyMs: 1000,
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reciprocalRank(resultIds: string[], relevantIds: Set<string>): number {
  const rank = resultIds.findIndex((id) => relevantIds.has(id));
  return rank >= 0 ? 1 / (rank + 1) : 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function duplicateRate(resultIds: string[], duplicateGroups: string[][]): number {
  if (resultIds.length === 0 || duplicateGroups.length === 0) return 0;
  const groupById = new Map<string, string>();
  for (const [index, group] of duplicateGroups.entries()) {
    for (const id of group) groupById.set(id, `group:${index}`);
  }

  const seenGroups = new Set<string>();
  let duplicates = 0;
  for (const id of resultIds) {
    const group = groupById.get(id);
    if (!group) continue;
    if (seenGroups.has(group)) {
      duplicates += 1;
    } else {
      seenGroups.add(group);
    }
  }
  return duplicates / resultIds.length;
}

export function evaluateRetrievalQualityCase(
  evalCase: RetrievalQualityEvalCase,
  gates: RetrievalQualityGates = {},
): RetrievalQualityCaseMetrics {
  const resolvedGates = { ...DEFAULT_RETRIEVAL_QUALITY_GATES, ...gates };
  const relevantIds = new Set(evalCase.relevantIds);
  const forbiddenIds = new Set(evalCase.forbiddenIds ?? []);
  const k = Math.max(1, evalCase.k ?? evalCase.relevantIds.length);
  const topK = evalCase.resultIds.slice(0, k);
  const relevantHits = topK.filter((id) => relevantIds.has(id)).length;
  const forbiddenHitCount = topK.filter((id) => forbiddenIds.has(id)).length;
  const precisionAtK = relevantHits / Math.max(1, topK.length);
  const recallAtK =
    relevantIds.size === 0 ? 1 : relevantHits / Math.max(1, relevantIds.size);
  const top1Precision =
    evalCase.resultIds[0] && relevantIds.has(evalCase.resultIds[0]) ? 1 : 0;
  const top3 = evalCase.resultIds.slice(0, 3);
  const recallAt3 =
    relevantIds.size === 0
      ? 1
      : top3.filter((id) => relevantIds.has(id)).length /
        Math.max(1, relevantIds.size);
  const mrr = reciprocalRank(topK, relevantIds);
  const duplicates = duplicateRate(topK, evalCase.duplicateGroups ?? []);
  const failures: string[] = [];

  if (precisionAtK < resolvedGates.minPrecisionAtK) {
    failures.push("precision");
  }
  if (recallAtK < resolvedGates.minRecallAtK) {
    failures.push("recall");
  }
  if (mrr < resolvedGates.minMrr) {
    failures.push("mrr");
  }
  if (duplicates > resolvedGates.maxDuplicateRate) {
    failures.push("duplicates");
  }
  if (forbiddenHitCount > resolvedGates.maxForbiddenHits) {
    failures.push("forbidden");
  }

  return {
    id: evalCase.id,
    query: evalCase.query,
    k,
    precisionAtK,
    recallAtK,
    mrr,
    duplicateRate: duplicates,
    forbiddenHitCount,
    top1Precision,
    recallAt3,
    latencyMs: evalCase.latencyMs,
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateRetrievalQuality(
  cases: RetrievalQualityEvalCase[],
  gates: RetrievalQualityGates = {},
): RetrievalQualitySuiteResult {
  const resolvedGates = { ...DEFAULT_RETRIEVAL_QUALITY_GATES, ...gates };
  const results = cases.map((evalCase) =>
    evaluateRetrievalQualityCase(evalCase, gates),
  );
  const averages = {
    precisionAtK: average(results.map((result) => result.precisionAtK)),
    recallAtK: average(results.map((result) => result.recallAtK)),
    mrr: average(results.map((result) => result.mrr)),
    duplicateRate: average(results.map((result) => result.duplicateRate)),
    top1Precision: average(results.map((result) => result.top1Precision)),
    recallAt3: average(results.map((result) => result.recallAt3)),
    p95LatencyMs: percentile(
      results
        .map((result) => result.latencyMs)
        .filter((value): value is number => typeof value === "number"),
      95,
    ),
    leakageCount: results.reduce(
      (sum, result) => sum + result.forbiddenHitCount,
      0,
    ),
    contextGoldCoverage: average(
      results.map((result) => (result.recallAt3 > 0 ? 1 : 0)),
    ),
  };
  const gatePassed =
    averages.top1Precision >= resolvedGates.minTop1Precision &&
    averages.recallAt3 >= resolvedGates.minRecallAt3 &&
    averages.contextGoldCoverage >= resolvedGates.minContextGoldCoverage &&
    averages.p95LatencyMs <= resolvedGates.maxP95LatencyMs &&
    averages.leakageCount <= resolvedGates.maxForbiddenHits;
  const passed = results.every((result) => result.passed) && gatePassed;
  const grade =
    passed &&
    averages.top1Precision >= 0.85 &&
    averages.recallAt3 >= 0.95 &&
    averages.mrr >= 0.8 &&
    averages.duplicateRate <= 0.1
      ? "A+"
      : averages.top1Precision >= 0.7 &&
          averages.recallAt3 >= 0.9 &&
          averages.mrr >= 0.75
        ? "A"
        : averages.top1Precision >= 0.5 && averages.recallAt3 >= 0.67
          ? "B"
          : "C";
  return {
    cases: results,
    averages,
    grade,
    evaluatedAt: new Date().toISOString(),
    passed,
  };
}

export function compactRetrievalQualitySummary(
  result: RetrievalQualitySuiteResult,
): {
  grade: RetrievalQualitySuiteResult["grade"];
  evaluatedAt: string;
  top1Precision: number;
  recallAt3: number;
  mrr: number;
  duplicateRate: number;
  leakageCount: number;
  p95LatencyMs: number;
  passed: boolean;
} {
  return {
    grade: result.grade,
    evaluatedAt: result.evaluatedAt,
    top1Precision: result.averages.top1Precision,
    recallAt3: result.averages.recallAt3,
    mrr: result.averages.mrr,
    duplicateRate: result.averages.duplicateRate,
    leakageCount: result.averages.leakageCount,
    p95LatencyMs: result.averages.p95LatencyMs,
    passed: result.passed,
  };
}
