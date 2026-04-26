import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  compactRetrievalQualitySummary,
  evaluateRetrievalQuality,
  evaluateRetrievalQualityCase,
  type RetrievalQualityEvalCase,
} from "../src/eval/retrieval-quality.js";
import { retrieveRelevantBlocks, resetRetrievalEngineStateForTests } from "../src/functions/retrieval-engine.js";
import { warmRetrievalBlockScopeMemberships } from "../src/functions/retrieval-block-scope-index.js";
import {
  buildRetrievalBlockLexicalText,
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import { KV } from "../src/state/schema.js";
import type { RetrievalBlock } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeBlock(overrides: Partial<RetrievalBlock>): RetrievalBlock {
  return {
    id: "rblk_default",
    sourceType: "memory",
    sourceId: "mem_default",
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: "Retrieval quality default block",
    title: "Retrieval quality default block",
    files: [],
    concepts: ["retrieval"],
    entities: [],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 7,
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    eventAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

async function storeBlocks(
  kv: ReturnType<typeof mockKV>,
  blocks: RetrievalBlock[],
): Promise<void> {
  for (const block of blocks) {
    await kv.set(KV.retrievalBlocks, block.id, block);
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.sessionId || block.project,
      buildRetrievalBlockLexicalText(block),
    );
  }
  await warmRetrievalBlockScopeMemberships(kv as never, blocks);
}

describe("retrieval quality eval harness", () => {
  afterEach(() => {
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
      persistenceStatus: undefined,
    });
    getRetrievalSearchIndex().clear();
    resetRetrievalEngineStateForTests();
  });

  it("passes a deterministic fixture with strong relevance and low duplication", () => {
    const fixturePath = join(__dirname, "fixtures", "retrieval-quality-cases.json");
    const fixtureCases = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as RetrievalQualityEvalCase[];
    const result = evaluateRetrievalQuality(fixtureCases);

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

  it("can score actual retrieveRelevantBlocks output from a seeded store", async () => {
    const kv = mockKV();
    const gold = makeBlock({
      id: "rblk_vector_oom_fix",
      sourceId: "mem_vector_oom_fix",
      title: "Vector backfill OOM persistence spike fix",
      canonicalText:
        "Fixed vector backfill OOM persistence spike by disabling scheduleSave and using bounded active-scope vector repair.",
      files: ["src/functions/retrieval-vector-backfill.ts"],
      concepts: ["vector backfill", "oom", "persistence"],
      importance: 10,
    });
    const support = makeBlock({
      id: "rblk_vector_backfill_worker",
      sourceId: "mem_vector_backfill_worker",
      title: "Retrieval vector backfill worker",
      canonicalText:
        "Dedicated retrieval vector backfill worker scans active scope IDs and respects health gates.",
      files: ["src/functions/retrieval-vector-backfill.ts"],
      concepts: ["vector backfill", "health gate"],
      importance: 8,
    });
    const noise = makeBlock({
      id: "rblk_other_project_noise",
      sourceId: "mem_other_project_noise",
      project: "/other",
      title: "Other project vector note",
      canonicalText: "Other project vector backfill note that must not leak.",
      concepts: ["vector backfill"],
    });
    await storeBlocks(kv, [gold, support, noise]);

    const retrieval = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      branch: "main",
      query: "vector backfill OOM persistence spike",
      purpose: "smart-search",
      budget: 2000,
      maxBlocks: 5,
    });
    const resultIds = retrieval.searchResults.map((item) => item.block.id);
    const result = evaluateRetrievalQuality([
      {
        id: "seeded-vector-backfill",
        query: "vector backfill OOM persistence spike",
        resultIds,
        relevantIds: [gold.id, support.id],
        forbiddenIds: [noise.id],
        latencyMs: 50,
        k: 3,
      },
    ]);

    expect(result.passed).toBe(true);
    expect(result.grade).toBe("A+");
    expect(resultIds.slice(0, 2)).toEqual([gold.id, support.id]);
  });
});
