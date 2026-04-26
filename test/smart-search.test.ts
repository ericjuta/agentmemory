import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { resetRetrievalEngineStateForTests } from "../src/functions/retrieval-engine.js";
import {
  buildRetrievalBlockLexicalText,
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
} from "../src/state/retrieval-block-indexing.js";
import { warmRetrievalBlockScopeMemberships } from "../src/functions/retrieval-block-scope-index.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  HybridSearchResult,
  CompactSearchResult,
  RetrievalBlock,
  Session,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-02-01T10:00:00Z",
    type: "file_edit",
    title: "Edit auth handler",
    facts: [],
    narrative: "Modified auth",
    concepts: ["auth"],
    files: ["src/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function makeRetrievalBlock(
  overrides: Partial<RetrievalBlock> = {},
): RetrievalBlock {
  return {
    id: "rblk_1",
    sourceType: "memory",
    sourceId: "mem_1",
    project: "/repo",
    scope: "project",
    freshnessLane: "warm",
    canonicalText: "Scoped search sentinel",
    title: "Scoped memory",
    files: [],
    concepts: ["scope"],
    entities: ["scope"],
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 7,
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-02-01T10:00:00Z",
    eventAt: "2026-02-01T10:00:00Z",
    ...overrides,
  };
}

async function storeRetrievalBlocks(
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

describe("Smart Search Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let searchResults: HybridSearchResult[];

  beforeEach(async () => {
    getRetrievalSearchIndex().clear();
    resetRetrievalEngineStateForTests();
    configureRetrievalBlockIndexingRuntime({
      embeddingProvider: null,
      vectorIndex: null,
      scheduleSave: undefined,
    });
    sdk = mockSdk();
    kv = mockKV();

    const obs1 = makeObs({ id: "obs_1", sessionId: "ses_1", title: "Auth handler" });
    const obs2 = makeObs({ id: "obs_2", sessionId: "ses_1", title: "Database setup" });

    searchResults = [
      {
        observation: obs1,
        bm25Score: 0.8,
        vectorScore: 0,
        combinedScore: 0.8,
        sessionId: "ses_1",
      },
      {
        observation: obs2,
        bm25Score: 0.3,
        vectorScore: 0,
        combinedScore: 0.3,
        sessionId: "ses_1",
      },
    ];

    const session: Session = {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set("mem:sessions", "ses_1", session);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const searchFn = async (_query: string, _limit: number) => searchResults;
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);
  });

  it("compact mode returns CompactSearchResult array", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty("obsId");
    expect(result.results[0]).toHaveProperty("title");
    expect(result.results[0]).toHaveProperty("type");
    expect(result.results[0]).toHaveProperty("score");
    expect(result.results[0]).toHaveProperty("timestamp");
    expect(result.results[0]).not.toHaveProperty("narrative");
  });

  it("expand mode returns full observations for given IDs", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
    })) as { mode: string; results: Array<{ obsId: string; observation: CompressedObservation }> };

    expect(result.mode).toBe("expanded");
    expect(result.results.length).toBe(1);
    expect(result.results[0].observation.title).toBe("Auth handler");
  });

  it("returns error when query is missing and no expandIds", async () => {
    const result = (await sdk.trigger("mem::smart-search", {})) as {
      mode: string;
      error: string;
    };

    expect(result.mode).toBe("compact");
    expect(result.error).toBe("query is required");
    expect((result as { results: unknown[] }).results).toEqual([]);
  });

  it("respects limit parameter in compact mode", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      limit: 1,
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("expand returns empty for nonexistent observation IDs", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_nonexistent_ses_xxx"],
    })) as { mode: string; results: unknown[] };

    expect(result.mode).toBe("expanded");
    expect(result.results.length).toBe(0);
  });

  it("compact mode records access for every returned observation id (#119)", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
    })) as { results: CompactSearchResult[] };
    // Access logging is deferred off the request path — allow one timer turn.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));

    for (const entry of result.results) {
      const log = (await kv.get("mem:access", entry.obsId)) as {
        count: number;
      } | null;
      expect(log?.count).toBe(1);
    }
  });

  it("expand mode records access for expanded observation ids (#119)", async () => {
    await sdk.trigger("mem::smart-search", { expandIds: ["obs_1"] });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));

    const log = (await kv.get("mem:access", "obs_1")) as {
      count: number;
    } | null;
    expect(log?.count).toBe(1);
  });

  it("falls back to live state without trying to repersist retrieval blocks", async () => {
    const sdk = mockSdk();
    const baseKv = mockKV();
    const session: Session = {
      id: "ses_fallback",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    };
    const obs = makeObs({
      id: "obs_fallback",
      sessionId: session.id,
      title: "Auth recovery",
      narrative: "Recovered search from raw state without persisted retrieval blocks.",
      importance: 9,
    });
    await baseKv.set(KV.sessions, session.id, session);
    await baseKv.set(KV.observations(session.id), obs.id, obs);

    let retrievalBlockWrites = 0;
    const kv = {
      ...baseKv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === KV.retrievalBlocks) {
          retrievalBlockWrites += 1;
          throw new Error("retrieval block persistence disabled");
        }
        return baseKv.set(scope, key, data);
      },
    };

    registerSmartSearchFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth recovery",
      project: "my-project",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results[0]?.obsId).toBe("obs_fallback");
    expect(result.results[0]?.title).toContain("Auth recovery");
    expect(retrievalBlockWrites).toBe(0);
  });

  it("uses cwd as project scope and passes branch scope into retrieval", async () => {
    const matchingBlock = makeRetrievalBlock({
      id: "rblk_repo_a_feature",
      sourceId: "mem_repo_a_feature",
      project: "/repo-a",
      branch: "feature/smart-search",
      scope: "branch",
      canonicalText: "Scoped branch sentinel authentication memory",
      title: "Repo A feature memory",
    });
    const otherProjectBlock = makeRetrievalBlock({
      id: "rblk_repo_b",
      sourceId: "mem_repo_b",
      project: "/repo-b",
      canonicalText: "Scoped branch sentinel authentication memory",
      title: "Repo B memory",
    });
    const otherBranchBlock = makeRetrievalBlock({
      id: "rblk_repo_a_other_branch",
      sourceId: "mem_repo_a_other_branch",
      project: "/repo-a",
      branch: "feature/other",
      scope: "branch",
      canonicalText: "Scoped branch sentinel authentication memory",
      title: "Repo A other branch memory",
    });
    await storeRetrievalBlocks(kv, [
      matchingBlock,
      otherProjectBlock,
      otherBranchBlock,
    ]);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "scoped branch sentinel authentication",
      cwd: "/repo-a",
      branch: "feature/smart-search",
      limit: 10,
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results.map((entry) => entry.blockId)).toEqual([
      matchingBlock.id,
    ]);
  });

  it("fails closed when scope is required and no scope was provided", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      scope_required: true,
    })) as { mode: string; results: CompactSearchResult[]; error: string };

    expect(result.mode).toBe("compact");
    expect(result.results).toEqual([]);
    expect(result.error).toBe("scope is required: provide project, cwd, or global");
  });

  it("uses explicit global scope without widening to all projects", async () => {
    const globalBlock = makeRetrievalBlock({
      id: "rblk_global_scope",
      sourceId: "mem_global_scope",
      project: "global",
      scope: "global",
      canonicalText: "Global scope sentinel memory",
      title: "Global memory",
    });
    const projectBlock = makeRetrievalBlock({
      id: "rblk_project_scope",
      sourceId: "mem_project_scope",
      project: "/repo-a",
      canonicalText: "Global scope sentinel memory",
      title: "Project memory",
    });
    await storeRetrievalBlocks(kv, [globalBlock, projectBlock]);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "global scope sentinel",
      global: true,
      scopeRequired: true,
      limit: 10,
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results.map((entry) => entry.blockId)).toEqual([
      globalBlock.id,
    ]);
  });
});
