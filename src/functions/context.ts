import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  RetrievalIntent,
  Session,
} from "../types.js";
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
  degraded?: boolean;
  fallback?:
    | "memory-cache"
    | "last-known-good"
    | "current-session-observations"
    | "empty";
  pressure?: unknown;
  ageMs?: number;
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

type LastKnownGoodContext = {
  key: string;
  project: string;
  branch?: string;
  createdAt: string;
  value: ContextResponse;
};

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

function ignoresDeferredQueuePressure(
  data: ContextRequest,
  project: string,
): boolean {
  if (!isCodexProject(project)) return false;
  return process.env.AGENTMEMORY_CODEX_CONTEXT_QUEUE_BACKPRESSURE !== "true";
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

function lastKnownGoodKey(cacheKey: string): string {
  return `codex:last-known-good:${Buffer.from(cacheKey).toString("base64url")}`;
}

function projectLastKnownGoodKey(
  project: string,
  branch: string | undefined,
): string {
  return `codex:last-known-good-project:${Buffer.from(
    JSON.stringify({ project, branch }),
  ).toString("base64url")}`;
}

function degradedContextResponse(
  value: ContextResponse,
  fallback: "memory-cache" | "last-known-good",
  pressure: unknown,
  ageMs?: number,
): ContextResponse {
  return {
    ...structuredClone(value),
    degraded: true,
    fallback,
    pressure,
    ageMs,
  };
}

function observationText(observation: CompressedObservation): string {
  const parts = [
    observation.title,
    observation.subtitle,
    observation.narrative,
    ...observation.facts,
  ];
  return parts.filter(Boolean).join("\n");
}

async function currentSessionObservationContext(
  kv: StateKV,
  sessionId: string,
  pressure: unknown,
  maxObservations = 5,
): Promise<ContextResponse | null> {
  const observations = await kv
    .list<CompressedObservation>(KV.observations(sessionId))
    .catch(() => [] as CompressedObservation[]);
  const usable = observations
    .filter((observation) => observationText(observation).trim())
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, maxObservations);
  if (usable.length === 0) return null;

  const context = usable
    .map((observation) => {
      const files = observation.files.length
        ? `\nFiles: ${observation.files.join(", ")}`
        : "";
      return `<observation id="${observation.id}" type="${observation.type}" title="${observation.title}">\n${observationText(observation)}${files}\n</observation>`;
    })
    .join("\n\n");

  return {
    context,
    items: usable.map((observation) => ({
      id: observation.id,
      type: "observation",
      title: observation.title,
      why: "current session observation fallback under pressure",
      freshness: "current",
    })),
    blocks: usable.length,
    tokens: Math.ceil(context.length / 3),
    trace: {
      fallback: "current-session-observations",
      observationIds: usable.map((observation) => observation.id),
    },
    degraded: true,
    fallback: "current-session-observations",
    pressure,
  };
}

async function readLastKnownGoodContext(
  kv: StateKV,
  keys: string[],
  pressure: unknown,
): Promise<ContextResponse | null> {
  for (const key of keys) {
    const stored = await kv
      .get<LastKnownGoodContext>(KV.contextInjections, key)
      .catch(() => null);
    if (!stored?.value?.context) continue;
    const createdAt = Date.parse(stored.createdAt);
    return degradedContextResponse(
      stored.value,
      "last-known-good",
      pressure,
      Number.isFinite(createdAt) ? Date.now() - createdAt : undefined,
    );
  }
  return null;
}

async function writeLastKnownGoodContext(
  kv: StateKV,
  cacheKey: string,
  project: string,
  branch: string | undefined,
  value: ContextResponse,
): Promise<void> {
  if (!value.context || value.degraded) return;
  const stored: LastKnownGoodContext = {
    key: cacheKey,
    project,
    branch,
    createdAt: new Date().toISOString(),
    value: {
      ...structuredClone(value),
      cache: undefined,
    },
  };
  await Promise.all([
    kv.set(KV.contextInjections, lastKnownGoodKey(cacheKey), stored),
    kv.set(KV.contextInjections, projectLastKnownGoodKey(project, branch), stored),
  ]).catch((err) => {
      logger.warn("Failed to persist last-known-good Codex context", {
        project,
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction(
    "mem::context",
    async (data: ContextRequest) => {
      const budget = data.budget || tokenBudget;
      const session = await kv
        .get<Session>(KV.sessions, data.sessionId)
        .catch(() => null);
      const project = data.project || session?.project || "";
      const branch = await resolveSessionBranch(kv, session);
      const cacheable = cacheableCodexContext(data, project);
      const cacheKey = cacheable
        ? contextCacheKey(data, project, branch, budget)
        : undefined;
      const pressure = await getContextHotPathPressure(kv, {
        ignoreDeferredQueue: ignoresDeferredQueuePressure(data, project),
      });
      if (pressure) {
        logger.warn("Context skipped under hot-path pressure", {
          sessionId: data.sessionId,
          intent: data.intent,
          reason: pressure.reason,
        });
        if (cacheKey) {
          const cached = codexContextCache.get(cacheKey);
          if (cached && cached.value.context) {
            return degradedContextResponse(
              cached.value,
              "memory-cache",
              pressure,
              Date.now() - cached.createdAt,
            );
          }
          const lastKnownGood = await readLastKnownGoodContext(
            kv,
            [
              lastKnownGoodKey(cacheKey),
              projectLastKnownGoodKey(project, branch),
            ],
            pressure,
          );
          if (lastKnownGood) return lastKnownGood;
        }
        const currentObservations = await currentSessionObservationContext(
          kv,
          data.sessionId,
          pressure,
        );
        if (currentObservations) return currentObservations;
        return {
          ...emptyContextForPressure(pressure),
          degraded: true,
          fallback: "empty",
        };
      }

      const purpose = data.intent === "file_enrich" ? "enrich" : "context";

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
        await writeLastKnownGoodContext(kv, cacheKey, project, branch, value);
        return cloneContextResponse(value, { status: "miss" });
      } finally {
        codexContextInflight.delete(cacheKey);
      }
    },
  );
}
