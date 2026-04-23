import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";
import { resolveSessionBranch } from "./session-branch.js";

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
      const project = session?.project || "";
      const branch = await resolveSessionBranch(kv, session);
      const query = [...(data.files || []), ...(data.terms || [])].filter(Boolean).join(" ");

      const result = await retrieveRelevantBlocks(kv, {
        project,
        sessionId: data.sessionId,
        branch,
        query,
        focusFiles: data.files || [],
        focusConcepts: data.terms || [],
        budget: Math.max(1, Math.floor(MAX_CONTEXT_LENGTH / 3)),
        purpose: "enrich",
        maxBlocks: 8,
      });

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
        blocks: result.blocks.length,
        trace: result.trace,
      };
    },
  );
}
