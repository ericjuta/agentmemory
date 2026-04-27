import { afterEach, describe, expect, it, vi } from "vitest";

import { StateKV } from "../src/state/kv.js";
import { KV, retrievalBlockShardScope } from "../src/state/schema.js";

describe("StateKV", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out slow trigger calls before the SDK-level timeout", async () => {
    vi.useFakeTimers();

    const sdk = {
      trigger: vi.fn(() => new Promise(() => {})),
    };

    const kv = new StateKV(sdk as never, {
      timeoutMs: 25,
      failureThreshold: 2,
      cooldownMs: 100,
      failureWindowMs: 100,
    });

    const pending = kv.get("mem:test", "key");
    const assertion = expect(pending).rejects.toThrow(
      "StateKV state::get timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(sdk.trigger).toHaveBeenCalledTimes(1);
    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "state::get",
      payload: {
        scope: "mem:test",
        key: "key",
      },
    });
  });

  it("enters a short cooldown after repeated failures and stops issuing new calls", async () => {
    vi.useFakeTimers();

    const sdk = {
      trigger: vi.fn(() => new Promise(() => {})),
    };

    const kv = new StateKV(sdk as never, {
      timeoutMs: 25,
      failureThreshold: 2,
      cooldownMs: 100,
      failureWindowMs: 100,
    });

    const first = kv.get("mem:test", "one");
    const firstAssertion = expect(first).rejects.toThrow(
      "StateKV state::get timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await firstAssertion;

    const second = kv.set("mem:test", "two", { ok: true });
    const secondAssertion = expect(second).rejects.toThrow(
      "StateKV state::set timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await secondAssertion;

    await expect(kv.list("mem:test")).rejects.toThrow(
      "StateKV temporarily unavailable for state::list; retry in 100ms; last error: StateKV state::set timed out after 25ms",
    );
    expect(sdk.trigger).toHaveBeenCalledTimes(2);
  });

  it("allows calls again after the cooldown window and resets the failure streak on success", async () => {
    vi.useFakeTimers();

    const sdk = {
      trigger: vi
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(() => Promise.resolve(["ok"]))
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(() => Promise.resolve(["healthy"])),
    };

    const kv = new StateKV(sdk as never, {
      timeoutMs: 25,
      failureThreshold: 1,
      cooldownMs: 100,
      failureWindowMs: 100,
    });

    const first = kv.list("mem:test");
    const firstAssertion = expect(first).rejects.toThrow(
      "StateKV state::list timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await firstAssertion;

    await expect(kv.list("mem:test")).rejects.toThrow(
      "StateKV temporarily unavailable for state::list; retry in 100ms; last error: StateKV state::list timed out after 25ms",
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(kv.list("mem:test")).resolves.toEqual(["ok"]);

    const third = kv.list("mem:test");
    const thirdAssertion = expect(third).rejects.toThrow(
      "StateKV state::list timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await thirdAssertion;

    await vi.advanceTimersByTimeAsync(100);
    await expect(kv.list("mem:test")).resolves.toEqual(["healthy"]);
    expect(sdk.trigger).toHaveBeenCalledTimes(4);
  });

  it("stores retrieval blocks in deterministic physical shard scopes with legacy fallback", async () => {
    const store = new Map<string, Map<string, unknown>>();
    const ensureScope = (scope: string) => {
      let scopeStore = store.get(scope);
      if (!scopeStore) {
        scopeStore = new Map();
        store.set(scope, scopeStore);
      }
      return scopeStore;
    };
    const sdk = {
      trigger: vi.fn(async ({ function_id, payload }) => {
        const data = payload as { scope: string; key?: string; value?: unknown };
        if (function_id === "state::get") {
          return ensureScope(data.scope).get(data.key!) ?? null;
        }
        if (function_id === "state::set") {
          ensureScope(data.scope).set(data.key!, data.value);
          return data.value;
        }
        if (function_id === "state::delete") {
          ensureScope(data.scope).delete(data.key!);
          return undefined;
        }
        if (function_id === "state::list") {
          return Array.from(ensureScope(data.scope).values());
        }
        throw new Error("unexpected function");
      }),
    };
    const kv = new StateKV(sdk as never);
    const legacy = { id: "rblk_legacy", sourceType: "memory", sourceId: "mem_1" };
    const current = { id: "rblk_current", sourceType: "memory", sourceId: "mem_2" };
    ensureScope(KV.retrievalBlocks).set(legacy.id, legacy);

    await kv.set(KV.retrievalBlocks, current.id, current);

    expect(ensureScope(KV.retrievalBlocks).get(current.id)).toBeUndefined();
    expect(ensureScope(retrievalBlockShardScope(current.id)).get(current.id)).toEqual(
      current,
    );
    await expect(kv.get(KV.retrievalBlocks, legacy.id)).resolves.toEqual(legacy);
    await expect(kv.list(KV.retrievalBlocks)).resolves.toEqual(
      expect.arrayContaining([legacy, current]),
    );

    await kv.delete(KV.retrievalBlocks, legacy.id);
    expect(ensureScope(KV.retrievalBlocks).get(legacy.id)).toBeUndefined();
  });
});
