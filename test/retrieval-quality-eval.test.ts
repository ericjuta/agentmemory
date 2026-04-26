import { describe, expect, it } from "vitest";
import {
  evaluateRetrievalQuality,
  evaluateRetrievalQualityCase,
} from "../src/eval/retrieval-quality.js";

describe("retrieval quality eval harness", () => {
  it("passes a deterministic fixture with strong relevance and low duplication", () => {
    const result = evaluateRetrievalQuality(
      [
        {
          id: "vector-backfill-specificity",
          query: "vector backfill timeout repair",
          resultIds: [
            "rblk_vector_backfill_timeout",
            "rblk_vector_retry_queue",
            "rblk_index_persistence",
          ],
          relevantIds: [
            "rblk_vector_backfill_timeout",
            "rblk_vector_retry_queue",
          ],
          forbiddenIds: ["rblk_working_set_noise"],
          duplicateGroups: [
            ["rblk_vector_backfill_timeout", "rblk_vector_backfill_copy"],
          ],
          k: 3,
        },
        {
          id: "scope-contract",
          query: "smart search cwd branch scope_required",
          resultIds: [
            "rblk_smart_search_scope",
            "rblk_api_scope_validation",
            "rblk_global_legacy_noise",
          ],
          relevantIds: [
            "rblk_smart_search_scope",
            "rblk_api_scope_validation",
          ],
          forbiddenIds: ["rblk_other_project_memory"],
          k: 3,
        },
      ],
      {
        minPrecisionAtK: 0.66,
        minRecallAtK: 1,
        minMrr: 1,
        maxDuplicateRate: 0,
      },
    );

    expect(result.passed).toBe(true);
    expect(result.averages.precisionAtK).toBeGreaterThanOrEqual(0.66);
    expect(result.averages.recallAtK).toBe(1);
    expect(result.averages.duplicateRate).toBe(0);
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
