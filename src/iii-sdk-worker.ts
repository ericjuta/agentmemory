import { registerWorker as baseRegisterWorker, type ISdk } from "iii-sdk";

const MESSAGE_TYPES = {
  invokeFunction: "invokefunction",
  registerFunction: "registerfunction",
  registerService: "registerservice",
  registerTrigger: "registertrigger",
  registerTriggerType: "registertriggertype",
} as const;

const REPLAYED_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.registerFunction,
  MESSAGE_TYPES.registerService,
  MESSAGE_TYPES.registerTrigger,
  MESSAGE_TYPES.registerTriggerType,
]);
const UNBOUNDED_WS_MAX_PAYLOAD = 0;

function shouldRegisterWorkerMetadata(): boolean {
  return process.env["AGENTMEMORY_III_REGISTER_METADATA"] !== "false";
}

type WorkerMessage = {
  invocation_id?: string;
  type?: string;
};

type PatchableWebSocket = {
  _receiver?: { _maxPayload?: number };
  constructor?: new (
    address: string,
    options?: { headers?: Record<string, string>; maxPayload?: number },
  ) => PatchableWebSocket;
  on: (event: string, listener: (message: unknown) => void) => void;
};

type PatchableWorkerSdk = ISdk & {
  address?: string;
  clearReconnectTimeout?: () => void;
  connect?: () => void;
  functions?: Map<string, { message: unknown }>;
  invocations?: Map<string, unknown>;
  isShuttingDown?: boolean;
  messagesToSend?: WorkerMessage[];
  onMessage?: (message: unknown) => void;
  onSocketClose?: () => void;
  onSocketError?: (error: unknown) => void;
  onSocketOpen?: () => void;
  options?: { headers?: Record<string, string> };
  reconnectAttempt?: number;
  registerWorkerMetadata?: () => void;
  sendMessage?: (messageType: string, message: unknown, skipQueue?: boolean) => void;
  sendMessageRaw?: (data: string) => void;
  services?: Map<string, unknown>;
  setConnectionState?: (state: string) => void;
  triggerTypes?: Map<string, { message: unknown }>;
  triggers?: Map<string, unknown>;
  ws?: PatchableWebSocket;
  __agentmemorySocketConnectPatched?: boolean;
  __agentmemorySocketOrderPatched?: boolean;
};

function removeSocketPayloadCap(ws: PatchableWebSocket | undefined): void {
  if (ws?._receiver) {
    ws._receiver._maxPayload = UNBOUNDED_WS_MAX_PAYLOAD;
  }
}

function patchWorkerSocketPayloadLimit<T extends ISdk>(sdk: T): T {
  const patchable = sdk as T & PatchableWorkerSdk;
  removeSocketPayloadCap(patchable.ws);

  if (
    patchable.__agentmemorySocketConnectPatched ||
    typeof patchable.connect !== "function" ||
    typeof patchable.onSocketClose !== "function" ||
    typeof patchable.onSocketError !== "function" ||
    typeof patchable.onSocketOpen !== "function" ||
    typeof patchable.address !== "string"
  ) {
    return sdk;
  }

  const WebSocketCtor = patchable.ws?.constructor;
  if (typeof WebSocketCtor !== "function") {
    return sdk;
  }

  patchable.connect = function patchedConnect(): void {
    if (patchable.isShuttingDown) return;
    patchable.setConnectionState?.("connecting");
    patchable.ws = new WebSocketCtor(patchable.address!, {
      headers: patchable.options?.headers,
      maxPayload: UNBOUNDED_WS_MAX_PAYLOAD,
    });
    removeSocketPayloadCap(patchable.ws);
    patchable.ws.on("open", patchable.onSocketOpen!.bind(patchable));
    patchable.ws.on("close", patchable.onSocketClose!.bind(patchable));
    patchable.ws.on("error", patchable.onSocketError!.bind(patchable));
  };

  patchable.ws?.on("open", () => removeSocketPayloadCap(patchable.ws));
  patchable.__agentmemorySocketConnectPatched = true;
  return sdk;
}

function replayRegistrations(sdk: PatchableWorkerSdk): void {
  sdk.triggerTypes?.forEach(({ message }) => {
    sdk.sendMessage?.(MESSAGE_TYPES.registerTriggerType, message, true);
  });
  sdk.services?.forEach((message) => {
    sdk.sendMessage?.(MESSAGE_TYPES.registerService, message, true);
  });
  sdk.functions?.forEach(({ message }) => {
    sdk.sendMessage?.(MESSAGE_TYPES.registerFunction, message, true);
  });
  sdk.triggers?.forEach((message) => {
    sdk.sendMessage?.(MESSAGE_TYPES.registerTrigger, message, true);
  });
}

function flushPendingMessages(sdk: PatchableWorkerSdk): void {
  const pending = sdk.messagesToSend ?? [];
  sdk.messagesToSend = [];
  for (const message of pending) {
    if (message.type && REPLAYED_MESSAGE_TYPES.has(message.type)) {
      continue;
    }
    if (
      message.type === MESSAGE_TYPES.invokeFunction &&
      typeof message.invocation_id === "string" &&
      !sdk.invocations?.has(message.invocation_id)
    ) {
      continue;
    }
    sdk.sendMessageRaw?.(JSON.stringify(message));
  }
}

export function patchWorkerRegistrationOrder<T extends ISdk>(sdk: T): T {
  patchWorkerSocketPayloadLimit(sdk);

  const patchable = sdk as T & PatchableWorkerSdk;
  if (
    patchable.__agentmemorySocketOrderPatched ||
    typeof patchable.onSocketOpen !== "function"
  ) {
    return sdk;
  }

  const originalOnSocketOpen = patchable.onSocketOpen.bind(patchable);
  patchable.onSocketOpen = function patchedOnSocketOpen(): void {
    if (
      typeof patchable.clearReconnectTimeout !== "function" ||
      typeof patchable.registerWorkerMetadata !== "function" ||
      typeof patchable.sendMessageRaw !== "function"
    ) {
      originalOnSocketOpen();
      return;
    }

    removeSocketPayloadCap(patchable.ws);
    patchable.clearReconnectTimeout();
    patchable.reconnectAttempt = 0;
    patchable.setConnectionState?.("connected");

    if (patchable.ws && typeof patchable.onMessage === "function") {
      patchable.ws.on("message", patchable.onMessage.bind(patchable));
    }

    if (shouldRegisterWorkerMetadata()) {
      patchable.registerWorkerMetadata();
    }
    replayRegistrations(patchable);
    flushPendingMessages(patchable);
  };
  patchable.__agentmemorySocketOrderPatched = true;
  return sdk;
}

export function registerWorker(
  ...args: Parameters<typeof baseRegisterWorker>
): ReturnType<typeof baseRegisterWorker> {
  return patchWorkerRegistrationOrder(baseRegisterWorker(...args));
}
