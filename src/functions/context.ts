import type { ISdk } from "iii-sdk";
import type { RetrievalIntent, Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";
import { resolveSessionBranch } from "./session-branch.js";
import {
  emptyContextForPressure,
  getContextHotPathPressure,
} from "./hot-path-pressure.js";

type ContextResponse = {
  context: string;
  items: unknown[];
  blocks: number;
  tokens: number;
  trace: unknown;
  cache?: {
    status: "hit" | "miss" | "coalesced";
    ageMs?: number;
  };
};

type ContextRequest = {
  sessionId: string;
  project?: string;
  budget?: number;
  query?: string;
  intent?: RetrievalIntent;
  files?: string[];
  terms?: string[];
  maxBlocks?: number;
};

const CODEX_PROJECT_SUFFIX = "/workspace/repos/codex";
const CODEX_CONTEXT_CACHE_TTL_MS = 2_000;
const codexContextCache = new Map<
  string,
  { createdAt: number; value: ContextResponse }
>();
const codexContextInflight = new Map<string, Promise<ContextResponse>>();

function isCodexProject(project: string): boolean {
  return project.endsWith(CODEX_PROJECT_SUFFIX);
}

function cacheableCodexContext(data: ContextRequest, project: string): boolean {
  return (
    isCodexProject(project) &&
    data.intent !== "file_enrich" &&
    !data.files?.length &&
    !data.terms?.length
  );
}

function contextCacheKey(
  data: ContextRequest,
  project: string,
  branch: string | undefined,
  budget: number,
): string {
  return JSON.stringify({
    project,
    branch,
    query: data.query || "",
    intent: data.intent || "",
    budget,
    maxBlocks: data.maxBlocks || null,
  });
}

function cloneContextResponse(
  value: ContextResponse,
  cache: ContextResponse["cache"],
): ContextResponse {
  return {
    ...structuredClone(value),
    cache,
  };
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction(
    "mem::context",
    async (data: ContextRequest) => {
      const pressure = await getContextHotPathPressure(kv, {
        ignoreDeferredQueue: data.intent === "manual_recall",
      });
      if (pressure) {
        logger.warn("Context skipped under hot-path pressure", {
          sessionId: data.sessionId,
          intent: data.intent,
          reason: pressure.reason,
        });
        return emptyContextForPressure(pressure);
      }

      const budget = data.budget || tokenBudget;
      const session = await kv.get<Session>(KV.sessions, data.sessionId).catch(() => null);
      const project = data.project || session?.project || "";
      const branch = await resolveSessionBranch(kv, session);
      const purpose = data.intent === "file_enrich" ? "enrich" : "context";
      const cacheable = cacheableCodexContext(data, project);
      const cacheKey = cacheable
        ? contextCacheKey(data, project, branch, budget)
        : undefined;

      if (cacheKey) {
        const cached = codexContextCache.get(cacheKey);
        if (cached && Date.now() - cached.createdAt <= CODEX_CONTEXT_CACHE_TTL_MS) {
          return cloneContextResponse(cached.value, {
            status: "hit",
            ageMs: Date.now() - cached.createdAt,
          });
        }
        const inflight = codexContextInflight.get(cacheKey);
        if (inflight) {
          const value = await inflight;
          return cloneContextResponse(value, { status: "coalesced" });
        }
      }

      const buildContext = async (): Promise<ContextResponse> => {
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
      };

      if (!cacheKey) return buildContext();
      const pending = buildContext();
      codexContextInflight.set(cacheKey, pending);
      try {
        const value = await pending;
        codexContextCache.set(cacheKey, {
          createdAt: Date.now(),
          value,
        });
        return cloneContextResponse(value, { status: "miss" });
      } finally {
        codexContextInflight.delete(cacheKey);
      }
    },
  );
}
