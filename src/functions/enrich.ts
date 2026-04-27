import type { ISdk } from "iii-sdk";
import type { RetrievalContextItem, Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

const MAX_CONTEXT_LENGTH = 4000;

export function registerEnrichFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::enrich",
    async (data: {
      sessionId: string;
      files: string[];
      terms?: string[];
      toolName?: string;
      }) => {
      const session = await kv.get<Session>(KV.sessions, data.sessionId).catch(() => null);
      const result = (await sdk.trigger({
        function_id: "mem::context",
        payload: {
        sessionId: data.sessionId,
        project: session?.project,
        intent: "file_enrich",
        files: data.files || [],
        terms: data.terms || [],
        budget: Math.max(1, Math.floor(MAX_CONTEXT_LENGTH / 3)),
        maxBlocks: 8,
        },
      })) as {
        context: string;
        items?: RetrievalContextItem[];
        blocks: number;
        skipped?: boolean;
        reason?: string;
        pressure?: unknown;
        trace: unknown;
      };

      let context = result.context;
      let truncated = false;
      if (context.length > MAX_CONTEXT_LENGTH) {
        context = context.slice(0, MAX_CONTEXT_LENGTH);
        truncated = true;
      }

      logger.info("Enrichment completed", {
        sessionId: data.sessionId,
        toolName: data.toolName,
        fileCount: data.files.length,
        contextLength: context.length,
        truncated,
      });

      return {
        context,
        truncated,
        items: result.items || [],
        blocks: result.blocks,
        skipped: result.skipped,
        reason: result.reason,
        pressure: result.pressure,
        trace: result.trace,
      };
    },
  );
}
