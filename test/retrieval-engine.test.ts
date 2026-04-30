import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  collectRetrievalBlocksFromStateMock,
  collectLightweightRetrievalBlocksFromStateMock,
} = vi.hoisted(() => ({
  collectRetrievalBlocksFromStateMock: vi.fn(async () => []),
  collectLightweightRetrievalBlocksFromStateMock: vi.fn(async () => []),
}));

vi.mock("../src/functions/retrieval-blocks.js", async () => {
  const actual = await vi.importActual<typeof import("../src/functions/retrieval-blocks.js")>(
    "../src/functions/retrieval-blocks.js",
  );
  return {
    ...actual,
    collectRetrievalBlocksFromState: collectRetrievalBlocksFromStateMock,
    collectLightweightRetrievalBlocksFromState:
      collectLightweightRetrievalBlocksFromStateMock,
  };
});

import {
  resetRetrievalEngineStateForTests,
  retrieveRelevantBlocks,
} from "../src/functions/retrieval-engine.js";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import {
  buildRetrievalBlockLexicalText,
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { resetContextResultCacheForTests } from "../src/functions/context-result-cache.js";
import { warmRetrievalBlockScopeMemberships } from "../src/functions/retrieval-block-scope-index.js";
import type { EmbeddingProvider, RetrievalBlock } from "../src/types.js";

function makeRetrievalBlock(
  overrides: Partial<RetrievalBlock> & { id: string; canonicalText: string },
): RetrievalBlock {
  const timestamp = overrides.eventAt ?? "2026-01-01T00:00:00Z";
  return {
    id: overrides.id,
    sourceType: "memory",
    sourceId: overrides.sourceId ?? overrides.id,
    project: "/project",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: overrides.canonicalText,
    title: overrides.title ?? overrides.id,
    files: [],
    concepts: [],
    entities: [],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 7,
    createdAt: timestamp,
    updatedAt: timestamp,
    eventAt: timestamp,
    ...overrides,
  };
}

async function storeIndexedBlocks(
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

describe("retrieveRelevantBlocks", () => {
  beforeEach(() => {
    collectRetrievalBlocksFromStateMock.mockReset();
    collectRetrievalBlocksFromStateMock.mockResolvedValue([]);
    collectLightweightRetrievalBlocksFromStateMock.mockReset();
    collectLightweightRetrievalBlocksFromStateMock.mockResolvedValue([]);
    getRetrievalSearchIndex().clear();
    resetContextResultCacheForTests();
    resetRetrievalEngineStateForTests();
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
    });
  });

  it("stores retrieval scope memberships outside the parent index scope", async () => {
    const kv = mockKV();
    const block = makeRetrievalBlock({
      id: "rblk_scope_storage",
      canonicalText: "scope storage migration",
    });

    await warmRetrievalBlockScopeMemberships(kv as never, [block]);

    expect(await kv.get(KV.retrievalBlockScopeIndex, "scope:index-ready")).toMatchObject({
      ready: true,
    });
    expect(
      await kv.get(KV.retrievalBlockScopeIndex, "scope:project:%2Fproject"),
    ).toMatchObject({ ids: ["rblk_scope_storage"] });
    expect(await kv.get(KV.retrievalBlockIndex, "scope:index-ready")).toBeNull();
    expect(await kv.get(KV.retrievalBlockIndex, "scope:project:%2Fproject")).toBeNull();
  });

  it("does not rebuild retrieval blocks when project is omitted and stored blocks exist", async () => {
    const kv = mockKV();
    const block: RetrievalBlock = {
      id: "rblk_auth",
      sourceType: "memory",
      sourceId: "mem_auth",
      project: "/project",
      scope: "project",
      freshnessLane: "warm",
      canonicalText: "Authentication guidance and auth middleware notes",
      title: "Auth memory",
      files: ["src/auth.ts"],
      concepts: ["auth"],
      entities: ["auth"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: true,
      hadAssistantConclusion: false,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    await kv.set(KV.retrievalBlocks, block.id, block);
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      buildRetrievalBlockLexicalText(block),
    );

    const result = await retrieveRelevantBlocks(kv as never, {
      query: "auth",
      budget: 300,
      purpose: "smart-search",
    });

    expect(collectRetrievalBlocksFromStateMock).not.toHaveBeenCalled();
    expect(result.searchResults).toHaveLength(1);
    expect(result.searchResults[0]?.block.id).toBe(block.id);
  });

  it("uses scoped retrieval block membership before falling back to the full block scope", async () => {
    const kv = mockKV();
    const block: RetrievalBlock = {
      id: "rblk_scoped",
      sourceType: "memory",
      sourceId: "mem_scoped",
      project: "/project",
      scope: "project",
      freshnessLane: "warm",
      canonicalText: "Scoped retrieval membership keeps context reads narrow",
      title: "Scoped memory",
      files: ["src/context.ts"],
      concepts: ["context"],
      entities: ["context"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: true,
      hadAssistantConclusion: false,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    await kv.set(KV.retrievalBlocks, block.id, block);
    await warmRetrievalBlockScopeMemberships(kv as never, [block]);
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      buildRetrievalBlockLexicalText(block),
    );

    const rawList = kv.list.bind(kv);
    const listSpy = vi.fn(rawList);
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.retrievalBlocks) {
        throw new Error("full retrieval block scan should not run");
      }
      return listSpy(scope);
    }) as typeof kv.list;

    const result = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      query: "context",
      budget: 300,
      purpose: "smart-search",
    });

    expect(result.searchResults).toHaveLength(1);
    expect(result.searchResults[0]?.block.id).toBe(block.id);
  });

  it("reuses cached no-query context results", async () => {
    const kv = mockKV();
    const block: RetrievalBlock = {
      id: "rblk_cached",
      sourceType: "turn_capsule",
      sourceId: "turn_1",
      project: "/project",
      sessionId: "session-1",
      turnId: "turn-1",
      scope: "session",
      freshnessLane: "hot",
      canonicalText: "## Current Turn\nUser: optimize context\nConclusion: cached context result",
      title: "Current turn",
      files: ["src/context.ts"],
      concepts: ["context"],
      entities: ["context"],
      sourceObservationIds: ["obs-1"],
      hadFailure: false,
      hadDecision: true,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 8,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    await kv.set(KV.retrievalBlocks, block.id, block);
    await warmRetrievalBlockScopeMemberships(kv as never, [block]);

    const first = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      sessionId: "session-1",
      budget: 300,
      purpose: "context",
    });

    const rawGet = kv.get.bind(kv);
    const rawList = kv.list.bind(kv);
    let getCount = 0;
    let listCount = 0;
    kv.get = (async <T>(scope: string, key: string): Promise<T | null> => {
      getCount += 1;
      return rawGet(scope, key);
    }) as typeof kv.get;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      listCount += 1;
      return rawList(scope);
    }) as typeof kv.list;

    const second = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      sessionId: "session-1",
      budget: 300,
      purpose: "context",
    });

    expect(second.context).toBe(first.context);
    expect(getCount).toBe(0);
    expect(listCount).toBe(0);
  });

  it("falls back to lightweight state collection when the retrieval block scope is unavailable", async () => {
    const kv = mockKV();
    const staleBlock: RetrievalBlock = {
      id: "rblk_stale",
      sourceType: "semantic_memory",
      sourceId: "sem_stale",
      project: "global",
      scope: "global",
      freshnessLane: "cold",
      canonicalText: "Unrelated stale retrieval memory",
      title: "Stale memory",
      files: [],
      concepts: ["stale"],
      entities: ["stale"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };
    const block: RetrievalBlock = {
      id: "rblk_theta",
      sourceType: "memory",
      sourceId: "mem_theta",
      project: "global",
      scope: "global",
      freshnessLane: "cold",
      canonicalText: "Codex durable retrieval probe theta retrieval memory",
      title: "Theta memory",
      files: ["/tmp/codex-theta.txt"],
      concepts: ["theta sentinel"],
      entities: ["theta", "sentinel"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    getRetrievalSearchIndex().addDocument(
      staleBlock.id,
      staleBlock.project,
      buildRetrievalBlockLexicalText(staleBlock),
    );

    const listError = new Error("retrieval block scope timeout");
    const rawList = kv.list.bind(kv);
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.retrievalBlocks) throw listError;
      return rawList(scope);
    }) as typeof kv.list;

    collectLightweightRetrievalBlocksFromStateMock.mockResolvedValue([block]);

    const result = await retrieveRelevantBlocks(kv as never, {
      query: "theta sentinel",
      budget: 300,
      purpose: "smart-search",
    });

    expect(collectLightweightRetrievalBlocksFromStateMock).toHaveBeenCalled();
    expect(collectRetrievalBlocksFromStateMock).not.toHaveBeenCalled();
    expect(result.searchResults).toHaveLength(1);
    expect(result.searchResults[0]?.block.id).toBe(block.id);
  });

  it("does not fan out scoped retrieval block loads past the configured limit", async () => {
    const previousLimit = process.env["AGENTMEMORY_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT"];
    process.env["AGENTMEMORY_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT"] = "2";
    const kv = mockKV();
    try {
      await kv.set(KV.retrievalBlockScopeIndex, "scope:index-ready", {
        ready: true,
        updatedAt: "2026-04-30T00:00:00.000Z",
      });
      await kv.set(KV.retrievalBlockScopeIndex, "scope:global", {
        ids: [],
        updatedAt: "2026-04-30T00:00:00.000Z",
      });
      await kv.set(KV.retrievalBlockScopeIndex, "scope:project:%2Fproject", {
        ids: ["rblk_1", "rblk_2", "rblk_3"],
        updatedAt: "2026-04-30T00:00:00.000Z",
      });
      collectLightweightRetrievalBlocksFromStateMock.mockResolvedValue([
        makeRetrievalBlock({
          id: "rblk_lightweight",
          canonicalText: "Lightweight retrieval survives oversized scoped fanout",
        }),
      ]);

      const rawGet = kv.get.bind(kv);
      const requestedBlockIds: string[] = [];
      kv.get = (async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === KV.retrievalBlocks) requestedBlockIds.push(key);
        return rawGet(scope, key);
      }) as typeof kv.get;

      const result = await retrieveRelevantBlocks(kv as never, {
        project: "/project",
        query: "lightweight retrieval",
        budget: 300,
        purpose: "context",
      });

      expect(requestedBlockIds).toEqual([]);
      expect(collectLightweightRetrievalBlocksFromStateMock).toHaveBeenCalled();
      expect(collectRetrievalBlocksFromStateMock).not.toHaveBeenCalled();
      expect(result.blocks.map((block) => block.id)).toContain("rblk_lightweight");
    } finally {
      if (previousLimit === undefined) {
        delete process.env["AGENTMEMORY_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT"];
      } else {
        process.env["AGENTMEMORY_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT"] = previousLimit;
      }
    }
  });

  it("prefers explicit query matches over unrelated hot session continuity for targeted context", async () => {
    const kv = mockKV();
    const hotBlock: RetrievalBlock = {
      id: "rblk_hot_unrelated",
      sourceType: "turn_capsule",
      sourceId: "turn-hot",
      project: "/project",
      sessionId: "session-1",
      turnId: "turn-hot",
      scope: "session",
      freshnessLane: "hot",
      canonicalText:
        "## Current Turn\nUser: inspect worker health\nConclusion: service health looks stable",
      title: "Current turn",
      files: ["/project/src/health.ts"],
      concepts: ["worker health"],
      entities: ["worker", "health"],
      sourceObservationIds: ["obs-hot"],
      hadFailure: false,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 8,
      createdAt: "2026-01-01T00:00:01Z",
      updatedAt: "2026-01-01T00:00:01Z",
      eventAt: "2026-01-01T00:00:01Z",
    };
    const warmMatch: RetrievalBlock = {
      id: "rblk_guardrail_auth",
      sourceType: "guardrail",
      sourceId: "grd-auth",
      project: "/project",
      scope: "project",
      freshnessLane: "warm",
      canonicalText:
        "## Guardrail\nExplanation: Production auth changes require approval\nFiles: /project/src/auth.ts",
      title: "Auth approval guardrail",
      files: ["/project/src/auth.ts"],
      concepts: ["auth", "approval"],
      entities: ["auth", "approval"],
      sourceObservationIds: [],
      hadFailure: true,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 9,
      createdAt: "2026-01-01T00:00:02Z",
      updatedAt: "2026-01-01T00:00:02Z",
      eventAt: "2026-01-01T00:00:02Z",
    };

    await kv.set(KV.retrievalBlocks, hotBlock.id, hotBlock);
    await kv.set(KV.retrievalBlocks, warmMatch.id, warmMatch);
    await warmRetrievalBlockScopeMemberships(kv as never, [hotBlock, warmMatch]);
    getRetrievalSearchIndex().addDocument(
      hotBlock.id,
      hotBlock.sessionId || hotBlock.project,
      buildRetrievalBlockLexicalText(hotBlock),
    );
    getRetrievalSearchIndex().addDocument(
      warmMatch.id,
      warmMatch.project,
      buildRetrievalBlockLexicalText(warmMatch),
    );

    const result = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      sessionId: "session-1",
      query: "auth approval",
      budget: 120,
      purpose: "context",
      intent: "user_turn",
    });

    expect(result.blocks.map((block) => block.id)).toContain(warmMatch.id);
    expect(result.blocks.map((block) => block.id)).not.toContain(hotBlock.id);
  });

  it("treats missing scoped membership as degraded instead of scanning every stored block", async () => {
    const kv = mockKV();
    const block: RetrievalBlock = {
      id: "rblk_incomplete_scope",
      sourceType: "memory",
      sourceId: "mem_incomplete_scope",
      project: "/project",
      scope: "project",
      freshnessLane: "warm",
      canonicalText: "Incomplete scope fallback should still find alpha context",
      title: "Alpha memory",
      files: ["src/alpha.ts"],
      concepts: ["alpha"],
      entities: ["alpha"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    await kv.set(KV.retrievalBlocks, block.id, block);
    await kv.set(KV.retrievalBlockIndex, "scope:index-ready", {
      ready: true,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await kv.set(KV.retrievalBlockIndex, "scope:project:%2Fproject", {
      ids: [block.id],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    getRetrievalSearchIndex().addDocument(
      block.id,
      block.project,
      buildRetrievalBlockLexicalText(block),
    );

    const rawList = kv.list.bind(kv);
    const listSpy = vi.fn(rawList);
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      return listSpy(scope);
    }) as typeof kv.list;

    const result = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      query: "alpha context",
      budget: 300,
      purpose: "smart-search",
    });

    expect(listSpy.mock.calls.some(([scope]) => scope === KV.retrievalBlocks)).toBe(false);
    expect(collectLightweightRetrievalBlocksFromStateMock).toHaveBeenCalled();
    expect(collectRetrievalBlocksFromStateMock).not.toHaveBeenCalled();
    expect(result.searchResults).toHaveLength(0);
    expect(result.trace.degradedFreshness).toBe(true);
  });

  it("excludes branch-specific blocks when branch is unknown", async () => {
    const kv = mockKV();
    const branchBlock: RetrievalBlock = {
      id: "rblk_branch_only",
      sourceType: "memory",
      sourceId: "mem_branch_only",
      project: "/project",
      branch: "feature/retrieval",
      scope: "project",
      freshnessLane: "warm",
      canonicalText: "Branch-only beta sentinel memory",
      title: "Branch beta memory",
      files: ["src/beta.ts"],
      concepts: ["beta"],
      entities: ["beta"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    await kv.set(KV.retrievalBlocks, branchBlock.id, branchBlock);
    await warmRetrievalBlockScopeMemberships(kv as never, [branchBlock]);
    getRetrievalSearchIndex().addDocument(
      branchBlock.id,
      branchBlock.project,
      buildRetrievalBlockLexicalText(branchBlock),
    );

    const unknownBranch = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      query: "beta sentinel",
      budget: 300,
      purpose: "smart-search",
    });
    const knownBranch = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      branch: "feature/retrieval",
      query: "beta sentinel",
      budget: 300,
      purpose: "smart-search",
    });

    expect(unknownBranch.searchResults).toHaveLength(0);
    expect(knownBranch.searchResults.map((entry) => entry.block.id)).toEqual([
      branchBlock.id,
    ]);
  });

  it("excludes legacy global consolidated memories from project-scoped search", async () => {
    const kv = mockKV();
    const semanticBlock: RetrievalBlock = {
      id: "rblk_global_semantic",
      sourceType: "semantic_memory",
      sourceId: "sem_global",
      project: "global",
      scope: "global",
      freshnessLane: "cold",
      canonicalText: "Global legacy retrieval scope sentinel",
      title: "Global semantic",
      files: [],
      concepts: ["scope"],
      entities: ["scope", "sentinel"],
      sourceObservationIds: [],
      hadFailure: false,
      hadDecision: false,
      hadAssistantConclusion: true,
      isResumeArtifact: false,
      importance: 7,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      eventAt: "2026-01-01T00:00:00Z",
    };

    await kv.set(KV.retrievalBlocks, semanticBlock.id, semanticBlock);
    await warmRetrievalBlockScopeMemberships(kv as never, [semanticBlock]);
    getRetrievalSearchIndex().addDocument(
      semanticBlock.id,
      semanticBlock.project,
      buildRetrievalBlockLexicalText(semanticBlock),
    );

    const scoped = await retrieveRelevantBlocks(kv as never, {
      project: "/project-a",
      query: "legacy retrieval scope sentinel",
      budget: 300,
      purpose: "smart-search",
    });
    const unscoped = await retrieveRelevantBlocks(kv as never, {
      query: "legacy retrieval scope sentinel",
      budget: 300,
      purpose: "smart-search",
    });

    expect(scoped.searchResults).toHaveLength(0);
    expect(unscoped.searchResults.map((entry) => entry.block.id)).toEqual([
      semanticBlock.id,
    ]);
  });

  it("prefers specific query coverage and exposes ranking diagnostics", async () => {
    const kv = mockKV();
    const broadBlock = makeRetrievalBlock({
      id: "rblk_broad_vector",
      sourceId: "mem_broad_vector",
      title: "General vector notes",
      canonicalText:
        "Vector retrieval vector retrieval vector retrieval scheduler notes without timeout repair coverage",
      concepts: ["vector"],
      entities: ["vector"],
      eventAt: "2026-01-03T00:00:00Z",
      importance: 10,
    });
    const specificBlock = makeRetrievalBlock({
      id: "rblk_vector_backfill_timeout",
      sourceId: "mem_vector_backfill_timeout",
      title: "Vector backfill timeout repair",
      canonicalText:
        "Bounded vector backfill timeout repair fixes missing retrieval vectors without full rebuilds",
      concepts: ["vector", "backfill", "timeout"],
      entities: ["vector", "backfill", "timeout"],
      eventAt: "2026-01-01T00:00:00Z",
      importance: 3,
    });
    await storeIndexedBlocks(kv, [broadBlock, specificBlock]);

    const result = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      query: "vector backfill timeout",
      budget: 600,
      purpose: "smart-search",
      maxBlocks: 2,
    });

    expect(result.searchResults[0]?.block.id).toBe(specificBlock.id);
    expect(result.searchResults[0]?.specificityScore).toBeGreaterThan(0.9);
    expect(result.searchResults[0]?.rankingMetadata?.sources.specificity).toBe(true);
    expect(result.searchResults[0]?.rankingMetadata?.freshness.eventAt).toBe(
      specificBlock.eventAt,
    );
    expect(
      Number.isFinite(result.searchResults[0]?.rankingMetadata?.freshness.ageHours),
    ).toBe(true);

    const traceCandidate = result.trace.selected.find(
      (candidate) => candidate.id === "memory:mem_vector_backfill_timeout",
    );
    expect(traceCandidate?.sources?.lexical).toBe(true);
    expect(traceCandidate?.sources?.specificity).toBe(true);
    expect(traceCandidate?.score.specificity).toBeGreaterThan(0.9);
    expect(traceCandidate?.score.combined).toBeGreaterThan(0);
  });

  it("suppresses near-duplicate retrieval blocks and records the collapsed cluster", async () => {
    const kv = mockKV();
    const primary = makeRetrievalBlock({
      id: "rblk_vector_backfill_primary",
      sourceId: "mem_vector_backfill_primary",
      title: "Vector backfill timeout repair",
      canonicalText:
        "Retrieval vector backfill timeout repair keeps missing vectors bounded and avoids full rebuilds",
      concepts: ["retrieval", "vector", "backfill", "timeout", "repair"],
      entities: ["retrieval", "vector", "backfill", "timeout", "repair"],
      eventAt: "2026-01-03T00:00:00Z",
    });
    const nearDuplicate = makeRetrievalBlock({
      id: "rblk_vector_backfill_duplicate",
      sourceId: "mem_vector_backfill_duplicate",
      title: "Timeout vector backfill repair",
      canonicalText:
        "Missing vector timeout repair keeps retrieval backfill bounded and avoids full rebuilds",
      concepts: ["retrieval", "vector", "backfill", "timeout", "repair"],
      entities: ["retrieval", "vector", "backfill", "timeout", "repair"],
      eventAt: "2026-01-02T00:00:00Z",
    });
    const distinct = makeRetrievalBlock({
      id: "rblk_vector_index_persistence",
      sourceId: "mem_vector_index_persistence",
      title: "Vector index persistence gate",
      canonicalText:
        "Retrieval vector persistence diagnostics expose deferred saves and maintenance gates",
      concepts: ["retrieval", "vector", "persistence"],
      entities: ["retrieval", "vector", "persistence"],
      eventAt: "2026-01-01T00:00:00Z",
    });
    await storeIndexedBlocks(kv, [primary, nearDuplicate, distinct]);

    const result = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      query: "retrieval vector backfill timeout repair",
      budget: 900,
      purpose: "smart-search",
      maxBlocks: 4,
    });

    const duplicateBlockIds = [primary.id, nearDuplicate.id];
    const selectedDuplicateIds = result.searchResults
      .map((entry) => entry.block.id)
      .filter((id) => duplicateBlockIds.includes(id));
    expect(selectedDuplicateIds).toHaveLength(1);

    const duplicateTraceIds = [
      "memory:mem_vector_backfill_primary",
      "memory:mem_vector_backfill_duplicate",
    ];
    const selectedTrace = result.trace.selected.find((candidate) =>
      duplicateTraceIds.includes(candidate.id),
    );
    const skippedTrace = result.trace.skipped.find((candidate) =>
      duplicateTraceIds.includes(candidate.id),
    );
    expect(skippedTrace?.decision).toBe("skipped_duplicate_fingerprint");
    expect(skippedTrace?.duplicateOf).toBe(selectedTrace?.id);
    expect(selectedTrace?.collapsedDuplicateCount).toBe(1);
    expect(selectedTrace?.collapsedDuplicateIds).toContain(skippedTrace?.id);

    const selectedSearchResult = result.searchResults.find(
      (entry) => entry.block.id === selectedDuplicateIds[0],
    );
    expect(selectedSearchResult?.rankingMetadata?.collapsedDuplicateCount).toBe(1);
  });

  it("surfaces vector-source diagnostics for semantic-only candidates", async () => {
    const kv = mockKV();
    const vectorBlock = makeRetrievalBlock({
      id: "rblk_vector_only",
      sourceId: "mem_vector_only",
      title: "Latent operator recovery",
      canonicalText: "Scheduler recovery note carried only by embedding similarity",
      concepts: ["scheduler", "recovery"],
      entities: ["scheduler", "recovery"],
    });
    await storeIndexedBlocks(kv, [vectorBlock]);
    const vectorIndex = new VectorIndex();
    vectorIndex.add(vectorBlock.id, vectorBlock.project, new Float32Array([1, 0]));
    const embeddingProvider: EmbeddingProvider = {
      name: "test-embedding",
      dimensions: 2,
      embed: async () => new Float32Array([1, 0]),
      embedBatch: async (texts) => texts.map(() => new Float32Array([1, 0])),
    };
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider,
      vectorIndex,
      scheduleSave: undefined,
    });

    const result = await retrieveRelevantBlocks(kv as never, {
      project: "/project",
      query: "quartz semantic probe",
      budget: 300,
      purpose: "smart-search",
    });

    expect(result.searchResults.map((entry) => entry.block.id)).toEqual([
      vectorBlock.id,
    ]);
    expect(result.searchResults[0]?.vectorScore).toBe(1);
    expect(result.searchResults[0]?.rankingMetadata?.sources.vector).toBe(true);
    expect(result.searchResults[0]?.rankingMetadata?.sources.lexical).toBe(false);
    expect(result.trace.selected[0]?.sources?.vector).toBe(true);
  });
});
