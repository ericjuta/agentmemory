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
import { resetContextResultCacheForTests } from "../src/functions/context-result-cache.js";
import { warmRetrievalBlockScopeMemberships } from "../src/functions/retrieval-block-scope-index.js";
import type { RetrievalBlock } from "../src/types.js";

describe("retrieveRelevantBlocks", () => {
  beforeEach(() => {
    collectRetrievalBlocksFromStateMock.mockClear();
    collectLightweightRetrievalBlocksFromStateMock.mockClear();
    getRetrievalSearchIndex().clear();
    resetContextResultCacheForTests();
    resetRetrievalEngineStateForTests();
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
    });
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
});
