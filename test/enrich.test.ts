import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerEnrichFunction } from "../src/functions/enrich.js";
import { registerContextFunction } from "../src/functions/context.js";
import type { Memory, Session, TurnCapsule } from "../src/types.js";
import { KV } from "../src/state/schema.js";

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
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeSession(): Session {
  return {
    id: "ses_1",
    project: "/project",
    cwd: "/project",
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "bug",
    title: "Known bug",
    content: "Null pointer in handler",
    concepts: ["bug"],
    files: ["src/handler.ts"],
    sessionIds: ["ses_1"],
    strength: 7,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

describe("Enrich Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 1600);
    registerEnrichFunction(sdk as never, kv as never);
    const session = makeSession();
    await kv.set(KV.sessions, session.id, session);
  });

  it("reuses the unified retrieval engine with file and term focus", async () => {
    const capsule: TurnCapsule = {
      id: "ses_1:turn-1",
      sessionId: "ses_1",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T10:00:01.000Z",
      updatedAt: "2026-03-28T10:00:02.000Z",
      userPrompt: "Fix handler issue",
      assistantConclusion: "Handler retrieval is now unified.",
      files: ["src/handler.ts"],
      concepts: ["handler retrieval"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs-1"],
      importantObservationIds: ["obs-1"],
      maxImportance: 8,
    };
    await kv.set(KV.turnCapsules, capsule.id, capsule);

    const bugMemory = makeMemory({
      id: "bug_1",
      title: "Handler race",
      content: "Race condition in handler retry path",
      files: ["src/handler.ts"],
      concepts: ["handler retrieval"],
    });
    await kv.set(KV.memories, bugMemory.id, bugMemory);

    const result = (await sdk.trigger("mem::enrich", {
      sessionId: "ses_1",
      files: ["src/handler.ts"],
      terms: ["handleError"],
      toolName: "Grep",
    })) as {
      context: string;
      truncated: boolean;
      items: Array<{ sourceType: string; relevantFiles: string[] }>;
      blocks: number;
      trace: { queryTerms: string[] };
    };

    expect(result.context).toContain("## Current Turn");
    expect(result.context).toContain("Handler retrieval is now unified.");
    expect(result.context).toContain("## Bug Memory: Handler race");
    expect(result.blocks).toBeGreaterThanOrEqual(2);
    expect(result.items.some((item) => item.sourceType === "turn_capsule")).toBe(true);
    expect(
      result.items.some((item) => item.relevantFiles.includes("src/handler.ts")),
    ).toBe(true);
    expect(result.trace.queryTerms).toContain("handleerror");
    expect(result.truncated).toBe(false);
  });

  it("truncates the unified context payload at 4000 chars", async () => {
    const hugeMemory = makeMemory({
      id: "big_1",
      title: "Large memory",
      content: "x".repeat(3900),
      files: ["src/big.ts"],
      concepts: ["large memory"],
      strength: 10,
    });
    await kv.set(KV.memories, hugeMemory.id, hugeMemory);

    const result = (await sdk.trigger("mem::enrich", {
      sessionId: "ses_1",
      files: ["src/big.ts"],
      terms: ["large"],
    })) as { context: string; truncated: boolean };

    expect(result.context.length).toBe(4000);
    expect(result.truncated).toBe(true);
  });

  it("returns empty context when no retrieval blocks match", async () => {
    const result = (await sdk.trigger("mem::enrich", {
      sessionId: "ses_1",
      files: ["src/new-file.ts"],
    })) as { context: string; truncated: boolean; blocks: number };

    expect(result.context).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.blocks).toBe(0);
  });

  it("keeps overlapping bug memory and excludes unrelated memory", async () => {
    const matchingBug = makeMemory({
      id: "bug_match",
      title: "Race condition",
      content: "Race condition in worker pool",
      files: ["src/worker.ts"],
      isLatest: true,
    });
    const unrelated = makeMemory({
      id: "fact_1",
      type: "fact",
      title: "Unrelated fact",
      content: "UI note unrelated to this tool call",
      files: ["src/other.ts"],
      concepts: ["ui"],
      isLatest: true,
    });
    await kv.set(KV.memories, matchingBug.id, matchingBug);
    await kv.set(KV.memories, unrelated.id, unrelated);

    const result = (await sdk.trigger("mem::enrich", {
      sessionId: "ses_1",
      files: ["src/worker.ts"],
    })) as { context: string };

    expect(result.context).toContain("Race condition");
    expect(result.context).not.toContain("Unrelated fact");
  });
});
