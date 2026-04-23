import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
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
      project: string;
      budget?: number;
      query?: string;
    }) => {
      const budget = data.budget || tokenBudget;
      const session = await kv.get<Session>(KV.sessions, data.sessionId).catch(() => null);
      const branch = await resolveSessionBranch(kv, session);

      const result = await retrieveRelevantBlocks(kv, {
        project: data.project,
        sessionId: data.sessionId,
        branch,
        query: data.query,
        budget,
        purpose: "context",
      });

      if (!result.context) {
        logger.info("No context available", { project: data.project });
        return { context: "", blocks: 0, tokens: 0, trace: result.trace };
      }

      logger.info("Context generated", {
        blocks: result.blocks.length,
        tokens: result.tokens,
      });
      return {
        context: result.context,
        blocks: result.blocks.length,
        tokens: result.tokens,
        trace: result.trace,
      };
    },
  );
}
