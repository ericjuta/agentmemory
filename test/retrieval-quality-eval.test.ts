import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  compactRetrievalQualitySummary,
  evaluateRetrievalQuality,
  evaluateRetrievalQualityCase,
  type RetrievalQualityEvalCase,
} from "../src/eval/retrieval-quality.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("retrieval quality eval harness", () => {
  it("passes a deterministic fixture with strong relevance and low duplication", () => {
    const fixturePath = join(__dirname, "fixtures", "retrieval-quality-cases.json");
    const fixtureCases = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as RetrievalQualityEvalCase[];
    const result = evaluateRetrievalQuality(
      fixtureCases,
      {
        minPrecisionAtK: 0.33,
        minRecallAtK: 0.9,
        minMrr: 1,
        maxDuplicateRate: 0,
        minTop1Precision: 0.7,
        minRecallAt3: 0.9,
      },
    );

    expect(result.passed).toBe(true);
    expect(result.grade).toBe("A+");
    expect(result.averages.precisionAtK).toBeGreaterThanOrEqual(0.6);
    expect(result.averages.recallAt3).toBeGreaterThanOrEqual(0.9);
    expect(result.averages.duplicateRate).toBe(0);
    expect(result.averages.leakageCount).toBe(0);
    expect(result.averages.p95LatencyMs).toBeLessThan(1000);
    expect(compactRetrievalQualitySummary(result)).toMatchObject({
      grade: "A+",
      recallAt3: result.averages.recallAt3,
      leakageCount: 0,
      passed: true,
    });
  });

  it("reports the specific gate failures for noisy results", () => {
    const metrics = evaluateRetrievalQualityCase(
      {
        id: "noisy",
        query: "branch-local retrieval contract",
        resultIds: ["noise", "duplicate_a", "duplicate_b", "forbidden"],
        relevantIds: ["relevant"],
        forbiddenIds: ["forbidden"],
        duplicateGroups: [["duplicate_a", "duplicate_b"]],
        k: 4,
      },
      {
        minPrecisionAtK: 0.5,
        minRecallAtK: 1,
        minMrr: 0.5,
        maxDuplicateRate: 0,
        maxForbiddenHits: 0,
      },
    );

    expect(metrics.passed).toBe(false);
    expect(metrics.failures).toEqual([
      "precision",
      "recall",
      "mrr",
      "duplicates",
      "forbidden",
    ]);
  });
});
