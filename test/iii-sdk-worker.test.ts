import { describe, expect, it, vi } from "vitest";
import { patchWorkerRegistrationOrder } from "../src/iii-sdk-worker.js";

describe("patchWorkerRegistrationOrder", () => {
  it("removes the websocket payload cap on the active socket and reconnects", () => {
    const wsOn = vi.fn();
    const createdWs = { on: vi.fn() };
    const existingWs = {
      _receiver: { _maxPayload: 100 * 1024 * 1024 },
      constructor: vi.fn().mockImplementation(() => createdWs),
      on: wsOn,
    };
    const sdk = {
      address: "ws://iii-engine:49134",
      connect: vi.fn(),
      onSocketClose: vi.fn(),
      onSocketError: vi.fn(),
      onSocketOpen: vi.fn(),
      options: {
        headers: { authorization: "Bearer test" },
      },
      setConnectionState: vi.fn(),
      ws: existingWs,
    };

    patchWorkerRegistrationOrder(sdk as never);

    expect(existingWs._receiver._maxPayload).toBe(0);
    expect(wsOn).toHaveBeenCalledWith("open", expect.any(Function));

    sdk.connect();

    expect(sdk.setConnectionState).toHaveBeenCalledWith("connecting");
    expect(existingWs.constructor).toHaveBeenCalledWith(
      "ws://iii-engine:49134",
      {
        headers: { authorization: "Bearer test" },
        maxPayload: 0,
      },
    );
  });

  it("registers worker metadata before replaying functions and triggers", () => {
    const order: string[] = [];
    const messageHandler = vi.fn();
    const originalOnSocketOpen = vi.fn(() => {
      order.push("original");
    });
    const sdk = {
      address: "ws://iii-engine:49134",
      clearReconnectTimeout: vi.fn(() => {
        order.push("clearReconnectTimeout");
      }),
      connect: vi.fn(),
      functions: new Map([
        [
          "fn",
          {
            message: {
              id: "fn",
              message_type: "registerfunction",
            },
          },
        ],
      ]),
      invocations: new Map(),
      messagesToSend: [{ type: "other" }],
      onMessage: messageHandler,
      onSocketClose: vi.fn(),
      onSocketError: vi.fn(),
      onSocketOpen: originalOnSocketOpen,
      options: {},
      reconnectAttempt: 3,
      registerWorkerMetadata: vi.fn(() => {
        order.push("registerWorkerMetadata");
      }),
      sendMessage: vi.fn((messageType: string) => {
        order.push(messageType);
      }),
      sendMessageRaw: vi.fn(() => {
        order.push("sendMessageRaw");
      }),
      services: new Map(),
      setConnectionState: vi.fn((state: string) => {
        order.push(`setConnectionState:${state}`);
      }),
      triggerTypes: new Map(),
      triggers: new Map([
        [
          "trigger",
          {
            id: "trigger",
            message_type: "registertrigger",
          },
        ],
      ]),
      ws: {
        on: vi.fn((event: string) => {
          order.push(`ws.on:${event}`);
        }),
      },
    };

    patchWorkerRegistrationOrder(sdk as never);
    sdk.onSocketOpen();

    expect(order).toEqual([
      "ws.on:open",
      "clearReconnectTimeout",
      "setConnectionState:connected",
      "ws.on:message",
      "registerWorkerMetadata",
      "registerfunction",
      "registertrigger",
      "sendMessageRaw",
    ]);
    expect(sdk.reconnectAttempt).toBe(0);
    expect(messageHandler).not.toHaveBeenCalled();
    expect(sdk.messagesToSend).toEqual([]);
    expect(sdk.onSocketOpen).not.toBe(originalOnSocketOpen);
    expect(originalOnSocketOpen).not.toHaveBeenCalled();
  });

  it("does not flush queued registration messages after replay", () => {
    const sendMessageRaw = vi.fn();
    const sdk = {
      address: "ws://iii-engine:49134",
      clearReconnectTimeout: vi.fn(),
      connect: vi.fn(),
      functions: new Map(),
      invocations: new Map(),
      messagesToSend: [
        { type: "registerfunction", id: "dup" },
        { type: "registertrigger", id: "dup-trigger" },
        { type: "other" },
      ],
      onMessage: vi.fn(),
      onSocketClose: vi.fn(),
      onSocketError: vi.fn(),
      onSocketOpen: vi.fn(),
      options: {},
      registerWorkerMetadata: vi.fn(),
      sendMessage: vi.fn(),
      sendMessageRaw,
      services: new Map(),
      setConnectionState: vi.fn(),
      triggerTypes: new Map(),
      triggers: new Map(),
      ws: { on: vi.fn() },
    };

    patchWorkerRegistrationOrder(sdk as never);
    sdk.onSocketOpen();

    expect(sendMessageRaw).toHaveBeenCalledTimes(1);
    expect(sendMessageRaw).toHaveBeenCalledWith(
      JSON.stringify({ type: "other" }),
    );
  });

  it("falls back to the original handler when internals are missing", () => {
    const original = vi.fn();
    const sdk = {
      onSocketOpen: original,
    };

    patchWorkerRegistrationOrder(sdk as never);
    sdk.onSocketOpen();

    expect(original).toHaveBeenCalledTimes(1);
  });
});
