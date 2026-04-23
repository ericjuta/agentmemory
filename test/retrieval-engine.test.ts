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

import { retrieveRelevantBlocks } from "../src/functions/retrieval-engine.js";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import {
  buildRetrievalBlockLexicalText,
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import type { RetrievalBlock } from "../src/types.js";

describe("retrieveRelevantBlocks", () => {
  beforeEach(() => {
    collectRetrievalBlocksFromStateMock.mockClear();
    collectLightweightRetrievalBlocksFromStateMock.mockClear();
    getRetrievalSearchIndex().clear();
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
});
