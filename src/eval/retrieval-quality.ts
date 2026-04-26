export interface RetrievalQualityEvalCase {
  id: string;
  query: string;
  resultIds: string[];
  relevantIds: string[];
  k?: number;
  forbiddenIds?: string[];
  duplicateGroups?: string[][];
}

export interface RetrievalQualityGates {
  minPrecisionAtK?: number;
  minRecallAtK?: number;
  minMrr?: number;
  maxDuplicateRate?: number;
  maxForbiddenHits?: number;
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
  };
  passed: boolean;
}

export const DEFAULT_RETRIEVAL_QUALITY_GATES: Required<RetrievalQualityGates> = {
  minPrecisionAtK: 0.67,
  minRecallAtK: 0.67,
  minMrr: 0.5,
  maxDuplicateRate: 0.1,
  maxForbiddenHits: 0,
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reciprocalRank(resultIds: string[], relevantIds: Set<string>): number {
  const rank = resultIds.findIndex((id) => relevantIds.has(id));
  return rank >= 0 ? 1 / (rank + 1) : 0;
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
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateRetrievalQuality(
  cases: RetrievalQualityEvalCase[],
  gates: RetrievalQualityGates = {},
): RetrievalQualitySuiteResult {
  const results = cases.map((evalCase) =>
    evaluateRetrievalQualityCase(evalCase, gates),
  );
  return {
    cases: results,
    averages: {
      precisionAtK: average(results.map((result) => result.precisionAtK)),
      recallAtK: average(results.map((result) => result.recallAtK)),
      mrr: average(results.map((result) => result.mrr)),
      duplicateRate: average(results.map((result) => result.duplicateRate)),
    },
    passed: results.every((result) => result.passed),
  };
}
