import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: vi.fn(() => true),
  getEnvVar: (key: string) =>
    key === "CONSOLIDATION_DECAY_MAX_ITEMS" ? "2" : undefined,
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { isConsolidationEnabled } from "../src/config.js";
import { KV } from "../src/state/schema.js";
import type { SessionSummary, Memory, SemanticMemory, ProceduralMemory } from "../src/types.js";

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

function makeSummary(i: number): SessionSummary {
  return {
    sessionId: `ses_${i}`,
    project: "test-project",
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i} summary`,
    narrative: `Worked on feature ${i}`,
    keyDecisions: [`Decision ${i}`],
    filesModified: [`src/file${i}.ts`],
    concepts: ["typescript", "testing"],
    observationCount: 5,
  };
}

function makePattern(i: number): Memory {
  return {
    id: `mem_${i}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    type: "pattern",
    title: `Pattern ${i}`,
    content: `Always do thing ${i}`,
    concepts: ["testing"],
    files: [],
    sessionIds: ["ses_1", "ses_2"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

describe("Consolidation Pipeline", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  it("pipeline skips semantic when fewer than 5 summaries", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { skipped: boolean; reason: string };
    expect(semantic.skipped).toBe(true);
    expect(semantic.reason).toContain("fewer than 5");
    expect(provider.summarize).not.toHaveBeenCalled();
  });

  it("pipeline skips procedural when fewer than 2 patterns", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const mem: Memory = {
      ...makePattern(1),
      sessionIds: ["ses_1", "ses_2"],
    };
    await kv.set("mem:memories", "mem_1", mem);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { skipped: boolean; reason: string };
    expect(procedural.skipped).toBe(true);
    expect(procedural.reason).toContain("fewer than 2");
  });

  it("with enough summaries, creates semantic memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.9">TypeScript is the primary language</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `ses_${i}`, makeSummary(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const semantic = result.results.semantic as { newFacts: number };
    expect(semantic.newFacts).toBe(1);

    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored.length).toBe(1);
    expect(stored[0].fact).toBe("TypeScript is the primary language");
    expect(stored[0].confidence).toBe(0.9);
  });

  it("creates project-scoped semantic memories and retrieval blocks", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<facts><fact confidence="0.8">Project auth config uses RS256</fact></facts>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 6; i++) {
      await kv.set("mem:summaries", `project_ses_${i}`, {
        ...makeSummary(i),
        sessionId: `project_ses_${i}`,
        project: "/project-a",
      });
    }
    await kv.set("mem:summaries", "other_ses", {
      ...makeSummary(99),
      sessionId: "other_ses",
      project: "/project-b",
    });

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "/project-a",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const stored = await kv.list<SemanticMemory>("mem:semantic");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      project: "/project-a",
      sourceScope: "project",
      sourceProjects: ["/project-a"],
    });
    expect(stored[0].sourceSessionIds).not.toContain("other_ses");

    const blocks = await kv.list<{ project: string; scope: string; sourceId: string }>(
      KV.retrievalBlocks,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      project: "/project-a",
      scope: "project",
      sourceId: stored[0].id,
    });
  });

  it("with enough patterns, creates procedural memories from provider response", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Test Workflow" trigger="when writing tests"><step>Create test file</step><step>Write assertions</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, makePattern(i));
    }

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const procedural = result.results.procedural as { newProcedures: number };
    expect(procedural.newProcedures).toBe(1);

    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("Test Workflow");
    expect(stored[0].steps.length).toBe(2);
    expect(stored[0].triggerCondition).toBe("when writing tests");
  });

  it("creates project-scoped procedural memories and retrieval blocks", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        `<procedures><procedure name="Auth Review" trigger="when touching auth config"><step>Inspect auth config</step><step>Run auth tests</step></procedure></procedures>`,
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    for (let i = 0; i < 3; i++) {
      await kv.set("mem:memories", `mem_${i}`, {
        ...makePattern(i),
        id: `mem_${i}`,
        project: "/project-a",
      });
    }
    await kv.set("mem:memories", "mem_other", {
      ...makePattern(99),
      id: "mem_other",
      project: "/project-b",
    });

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "procedural",
      project: "/project-a",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    const stored = await kv.list<ProceduralMemory>("mem:procedural");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      project: "/project-a",
      sourceScope: "project",
      sourceProjects: ["/project-a"],
    });
    expect(stored[0].sourceMemoryIds).not.toContain("mem_other");

    const blocks = await kv.list<{ project: string; scope: string; sourceId: string }>(
      KV.retrievalBlocks,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      project: "/project-a",
      scope: "project",
      sourceId: stored[0].id,
    });
  });

  it("consolidation records an audit entry", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic" });

    const audits = await kv.list("mem:audit");
    expect(audits.length).toBe(1);
  });

  it("pipeline returns early when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {})) as {
      success: boolean;
      skipped?: boolean;
      reason?: string;
    };

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("CONSOLIDATION_ENABLED");
    expect(provider.summarize).not.toHaveBeenCalled();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("pipeline proceeds with force=true even when consolidation is disabled", async () => {
    vi.mocked(isConsolidationEnabled).mockReturnValue(false);
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      force: true,
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    vi.mocked(isConsolidationEnabled).mockReturnValue(true);
  });

  it("decay only persists changed items within the configured batch limit", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);

    const now = Date.now();
    const old = (days: number) => new Date(now - days * 86400000).toISOString();

    const semanticItems: SemanticMemory[] = [
      {
        id: "sem_1",
        fact: "oldest fact",
        confidence: 0.9,
        sourceSessionIds: [],
        sourceMemoryIds: [],
        accessCount: 1,
        lastAccessedAt: old(120),
        strength: 1,
        createdAt: old(150),
        updatedAt: old(120),
      },
      {
        id: "sem_2",
        fact: "second fact",
        confidence: 0.8,
        sourceSessionIds: [],
        sourceMemoryIds: [],
        accessCount: 1,
        lastAccessedAt: old(90),
        strength: 1,
        createdAt: old(120),
        updatedAt: old(90),
      },
      {
        id: "sem_3",
        fact: "recent fact",
        confidence: 0.7,
        sourceSessionIds: [],
        sourceMemoryIds: [],
        accessCount: 1,
        lastAccessedAt: old(5),
        strength: 1,
        createdAt: old(10),
        updatedAt: old(5),
      },
    ];

    const proceduralItems: ProceduralMemory[] = [
      {
        id: "proc_1",
        name: "oldest proc",
        steps: ["a"],
        triggerCondition: "old",
        frequency: 1,
        sourceSessionIds: [],
        strength: 1,
        createdAt: old(150),
        updatedAt: old(120),
      },
      {
        id: "proc_2",
        name: "recent proc",
        steps: ["b"],
        triggerCondition: "recent",
        frequency: 1,
        sourceSessionIds: [],
        strength: 1,
        createdAt: old(10),
        updatedAt: old(5),
      },
    ];

    for (const item of semanticItems) {
      await kv.set("mem:semantic", item.id, item);
    }
    for (const item of proceduralItems) {
      await kv.set("mem:procedural", item.id, item);
    }

    const beforeSemanticThird = await kv.get<SemanticMemory>("mem:semantic", "sem_3");
    const beforeRecentProc = await kv.get<ProceduralMemory>("mem:procedural", "proc_2");

    const result = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "decay",
    })) as { success: boolean; results: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.results.decay).toMatchObject({
      semanticProcessed: 2,
      semanticUpdated: 2,
      proceduralProcessed: 2,
      proceduralUpdated: 1,
      maxItemsPerRun: 2,
    });

    const sem1 = await kv.get<SemanticMemory>("mem:semantic", "sem_1");
    const sem2 = await kv.get<SemanticMemory>("mem:semantic", "sem_2");
    const sem3 = await kv.get<SemanticMemory>("mem:semantic", "sem_3");
    const proc1 = await kv.get<ProceduralMemory>("mem:procedural", "proc_1");
    const proc2 = await kv.get<ProceduralMemory>("mem:procedural", "proc_2");

    expect(sem1!.strength).toBeLessThan(1);
    expect(sem2!.strength).toBeLessThan(1);
    expect(sem3).toEqual(beforeSemanticThird);
    expect(proc1!.strength).toBeLessThan(1);
    expect(proc2).toEqual(beforeRecentProc);
  });
});
