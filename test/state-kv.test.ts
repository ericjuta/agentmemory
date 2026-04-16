import { afterEach, describe, expect, it, vi } from "vitest";

import { StateKV } from "../src/state/kv.js";

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
});
