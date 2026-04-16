import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("iii-sdk", () => ({
  getContext: () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }),
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  MemoryProvider,
  Session,
} from "../src/types.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (
      opts: string | { id: string },
      handler: Function,
    ) => {
      functions.set(typeof opts === "string" ? opts : opts.id, handler);
    },
    registerTrigger: () => {},
    trigger: async (id: string, data: unknown) => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(data);
    },
  };
}

function makeSession(
  id: string,
  observationCount: number,
  startedAt: string,
): Session {
  return {
    id,
    project: "proj",
    cwd: "/tmp/proj",
    startedAt,
    status: "completed",
    observationCount,
  };
}

function makeObservation(
  id: string,
  sessionId: string,
  concept: string,
  importance: number,
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-03-31T12:00:00Z",
    type: "decision",
    title: `Observation ${id}`,
    facts: [],
    narrative: `Narrative for ${id}`,
    concepts: [concept],
    files: ["src/file.ts"],
    importance,
  };
}

describe("Consolidate Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let provider: MemoryProvider;

  beforeEach(() => {
    sdk = mockSdk();
    provider = {
      name: "test",
      compress: vi.fn().mockResolvedValue(`
        <memory>
          <type>pattern</type>
          <title>Shared concept memory</title>
          <content>Consolidated content</content>
          <concepts><concept>shared</concept></concepts>
          <files><file>src/file.ts</file></files>
          <strength>7</strength>
        </memory>
      `),
      summarize: vi.fn(),
    };
  });

  it("stops scanning sessions once the candidate budget is filled", async () => {
    const sessions = [
      makeSession("ses_small", 2, "2026-03-30T10:00:00Z"),
      makeSession("ses_big", 8, "2026-03-31T10:00:00Z"),
      makeSession("ses_other", 4, "2026-03-29T10:00:00Z"),
    ];
    const list = vi.fn(async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.sessions) return sessions as T[];
      if (scope === KV.memories) return [] as T[];
      if (scope === KV.observations("ses_big")) {
        return [
          makeObservation("obs_1", "ses_big", "shared", 9),
          makeObservation("obs_2", "ses_big", "shared", 8),
          makeObservation("obs_3", "ses_big", "shared", 7),
        ] as T[];
      }
      if (scope === KV.observations("ses_small")) {
        return [makeObservation("obs_4", "ses_small", "shared", 6)] as T[];
      }
      if (scope === KV.observations("ses_other")) {
        return [makeObservation("obs_5", "ses_other", "shared", 6)] as T[];
      }
      return [] as T[];
    });
    const kv = {
      list,
      set: vi.fn(async <T>(_scope: string, _key: string, data: T): Promise<T> => data),
    };

    registerConsolidateFunction(sdk as never, kv as never, provider);

    const result = (await sdk.trigger("mem::consolidate", {
      minObservations: 2,
      maxCandidateObservations: 3,
      maxSessionsScanned: 10,
    })) as {
      consolidated: number;
      scannedSessions: number;
      totalObservations: number;
    };

    expect(result.consolidated).toBe(1);
    expect(result.scannedSessions).toBe(1);
    expect(result.totalObservations).toBe(3);
    expect(list).toHaveBeenCalledWith(KV.observations("ses_big"));
    expect(list).not.toHaveBeenCalledWith(KV.observations("ses_small"));
    expect(list).not.toHaveBeenCalledWith(KV.observations("ses_other"));
    expect(provider.compress).toHaveBeenCalledTimes(1);
  });

  it("caps the number of sessions scanned per run", async () => {
    const sessions = [
      makeSession("ses_1", 5, "2026-03-31T10:00:00Z"),
      makeSession("ses_2", 4, "2026-03-30T10:00:00Z"),
      makeSession("ses_3", 3, "2026-03-29T10:00:00Z"),
    ];
    const list = vi.fn(async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.sessions) return sessions as T[];
      if (scope === KV.memories) return [] as T[];
      if (scope === KV.observations("ses_1")) {
        return [makeObservation("obs_1", "ses_1", "shared", 7)] as T[];
      }
      if (scope === KV.observations("ses_2")) {
        return [makeObservation("obs_2", "ses_2", "shared", 7)] as T[];
      }
      if (scope === KV.observations("ses_3")) {
        return [makeObservation("obs_3", "ses_3", "shared", 7)] as T[];
      }
      return [] as T[];
    });
    const kv = {
      list,
      set: vi.fn(async <T>(_scope: string, _key: string, data: T): Promise<T> => data),
    };

    registerConsolidateFunction(sdk as never, kv as never, provider);

    const result = (await sdk.trigger("mem::consolidate", {
      minObservations: 3,
      maxCandidateObservations: 10,
      maxSessionsScanned: 2,
    })) as {
      consolidated: number;
      reason: string;
      scannedSessions: number;
      totalObservations: number;
    };

    expect(result.consolidated).toBe(0);
    expect(result.reason).toBe("insufficient_observations");
    expect(result.scannedSessions).toBe(2);
    expect(result.totalObservations).toBe(2);
    expect(list).toHaveBeenCalledWith(KV.observations("ses_1"));
    expect(list).toHaveBeenCalledWith(KV.observations("ses_2"));
    expect(list).not.toHaveBeenCalledWith(KV.observations("ses_3"));
    expect(provider.compress).not.toHaveBeenCalled();
  });
});
