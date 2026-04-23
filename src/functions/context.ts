import type { ISdk } from "iii-sdk";
import type { RetrievalIntent, Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";
import { resolveSessionBranch } from "./session-branch.js";

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction(
    "mem::context",
    async (data: {
      sessionId: string;
      project?: string;
      budget?: number;
      query?: string;
      intent?: RetrievalIntent;
      files?: string[];
      terms?: string[];
      maxBlocks?: number;
    }) => {
      const budget = data.budget || tokenBudget;
      const session = await kv.get<Session>(KV.sessions, data.sessionId).catch(() => null);
      const project = data.project || session?.project || "";
      const branch = await resolveSessionBranch(kv, session);
      const purpose = data.intent === "file_enrich" ? "enrich" : "context";

      const result = await retrieveRelevantBlocks(kv, {
        project,
        sessionId: data.sessionId,
        branch,
        query: data.query,
        intent: data.intent,
        focusFiles: data.files || [],
        focusConcepts: data.terms || [],
        budget,
        purpose,
        maxBlocks: data.maxBlocks,
      });

      if (!result.context) {
        logger.info("No context available", { project });
        return {
          context: "",
          items: [],
          blocks: 0,
          tokens: 0,
          trace: result.trace,
        };
      }

      logger.info("Context generated", {
        blocks: result.blocks.length,
        tokens: result.tokens,
      });
      return {
        context: result.context,
        items: result.items,
        blocks: result.blocks.length,
        tokens: result.tokens,
        trace: result.trace,
      };
    },
  );
}
