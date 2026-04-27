import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

export interface DeferredWorkStatus {
  generatedAt: string;
  compression: {
    queued: number;
    error?: string;
  };
  retrievalBlocks: {
    queued: number;
    error?: string;
  };
  graphExtraction: {
    queued: number;
    error?: string;
  };
  totalQueued: number;
}

async function countScope(
  kv: StateKV,
  scope: string,
): Promise<{ queued: number; error?: string }> {
  try {
    return { queued: (await kv.list(scope)).length };
  } catch (err) {
    return {
      queued: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDeferredWorkStatus(
  kv: StateKV,
): Promise<DeferredWorkStatus> {
  const [compression, retrievalBlocks, graphExtraction] = await Promise.all([
    countScope(kv, KV.compressRetry),
    countScope(kv, KV.retrievalBlockRetry),
    countScope(kv, KV.graphExtractionRetry),
  ]);
  const totalQueued =
    compression.queued + retrievalBlocks.queued + graphExtraction.queued;
  return {
    generatedAt: new Date().toISOString(),
    compression,
    retrievalBlocks,
    graphExtraction,
    totalQueued,
  };
}

export function registerDeferredWorkFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::deferred-work-status", async () =>
    getDeferredWorkStatus(kv),
  );
}
