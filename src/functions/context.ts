import type { ISdk } from "iii-sdk";
import type {
  Session,
  CompressedObservation,
  SessionSummary,
  ContextBlock,
  ProjectProfile,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";

interface ContextDebugBlockTrace {
  type: "summary" | "observation" | "memory" | "fallback";
  sourceObservationIds: string[];
  sessionIds: string[];
  tokens: number;
  status: "selected" | "skipped";
  skipReason?: string;
  degraded?: boolean;
  fallbackReason?: string;
}

interface ContextDebugTrace {
  requested: true;
  degraded: boolean;
  fallbackReason?: string;
  blocks: ContextDebugBlockTrace[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction("mem::context", 
    async (data: {
      sessionId: string;
      project: string;
      budget?: number;
      includeRetrievalIds?: boolean;
      includeDebugTrace?: boolean;
    }) => {
      const budget = data.budget || tokenBudget;
      const includeRetrievalIds =
        data.includeRetrievalIds === true ||
        process.env["AGENTMEMORY_CONTEXT_DEBUG_IDS"] === "true";
      const includeDebugTrace =
        data.includeDebugTrace === true ||
        process.env["AGENTMEMORY_CONTEXT_DEBUG_TRACE"] === "true";
      const blocks: ContextBlock[] = [];
      const debugBlocks: ContextDebugBlockTrace[] = [];
      const degradedReasons: string[] = [];

      const profile = await kv
        .get<ProjectProfile>(KV.profiles, data.project)
        .catch(() => {
          degradedReasons.push("profile_lookup_failed");
          return null;
        });
      if (profile) {
        const profileParts = [];
        if (profile.topConcepts.length > 0) {
          profileParts.push(
            `Concepts: ${profile.topConcepts
              .slice(0, 8)
              .map((c) => c.concept)
              .join(", ")}`,
          );
        }
        if (profile.topFiles.length > 0) {
          profileParts.push(
            `Key files: ${profile.topFiles
              .slice(0, 5)
              .map((f) => f.file)
              .join(", ")}`,
          );
        }
        if (profile.conventions.length > 0) {
          profileParts.push(`Conventions: ${profile.conventions.join("; ")}`);
        }
        if (profile.commonErrors.length > 0) {
          profileParts.push(
            `Common errors: ${profile.commonErrors.slice(0, 3).join("; ")}`,
          );
        }
        if (profileParts.length > 0) {
          const profileContent = `## Project Profile\n${profileParts.join("\n")}`;
          blocks.push({
            type: "memory",
            content: profileContent,
            tokens: estimateTokens(profileContent),
            recency: new Date(profile.updatedAt).getTime(),
            sessionIds: [],
          });
        }
      }

      const allSessions = await kv
        .list<Session>(KV.sessions)
        .catch(() => {
          degradedReasons.push("session_list_failed");
          return [];
        });
      const sessions = allSessions
        .filter((s) => (
          s.project === data.project
          && (s.id !== data.sessionId || typeof s.lastStopAt === "string")
        ))
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .slice(0, 10);

      const summariesPerSession = await Promise.all(
        sessions.map((s) =>
          kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null),
        ),
      );

      const sessionsNeedingObs: number[] = [];
      const sessionsNeedingSummarySourceIds: number[] = [];
      const summaryBlocksByIndex = new Map<number, ContextBlock>();
      for (let i = 0; i < sessions.length; i++) {
        const summary = summariesPerSession[i];
        if (summary) {
          if (!summary.sourceObservationIds) sessionsNeedingSummarySourceIds.push(i);
          const content = `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
          const block: ContextBlock = {
            type: "summary",
            content,
            tokens: estimateTokens(content),
            recency: new Date(summary.createdAt).getTime(),
            sourceIds: summary.sourceObservationIds,
            sessionIds: [summary.sessionId || sessions[i].id],
          };
          blocks.push(block);
          summaryBlocksByIndex.set(i, block);
        } else {
          sessionsNeedingObs.push(i);
        }
      }

      const summarySourceIds = new Map<number, string[]>();
      if (sessionsNeedingSummarySourceIds.length > 0) {
        const summaryObsResults = await Promise.all(
          sessionsNeedingSummarySourceIds.map((i) =>
            kv
              .list<CompressedObservation>(KV.observations(sessions[i].id))
              .catch(() => {
                degradedReasons.push("summary_source_observations_lookup_failed");
                return [];
              }),
          ),
        );
        for (let j = 0; j < sessionsNeedingSummarySourceIds.length; j++) {
          const sessionIndex = sessionsNeedingSummarySourceIds[j];
          const observations = summaryObsResults[j];
          if (sessionIndex !== undefined && observations) {
            summarySourceIds.set(sessionIndex, observations.map((o) => o.id));
          }
        }
      }

      for (const [index, sourceIds] of summarySourceIds) {
        const block = summaryBlocksByIndex.get(index);
        if (block && sourceIds.length > 0) block.sourceIds = sourceIds;
      }

      const obsResults = await Promise.all(
        sessionsNeedingObs.map((i) =>
          kv
            .list<CompressedObservation>(KV.observations(sessions[i].id))
            .catch(() => {
              degradedReasons.push("session_observations_lookup_failed");
              return [];
            }),
        ),
      );

      for (let j = 0; j < sessionsNeedingObs.length; j++) {
        const i = sessionsNeedingObs[j];
        const observations = obsResults[j];
        const important = observations.filter(
          (o) => o.title && o.importance >= 5,
        );

        if (important.length > 0) {
          const top = important
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 5);
          const items = top
            .map((o) => `- [${o.type}] ${o.title}: ${o.narrative}`)
            .join("\n");
          const content = `## Session ${sessions[i].id.slice(0, 8)} (${sessions[i].startedAt})\n${items}`;
          blocks.push({
            type: "observation",
            content,
            tokens: estimateTokens(content),
            recency: new Date(sessions[i].startedAt).getTime(),
            sourceIds: top.map((o) => o.id),
            sessionIds: [sessions[i].id],
          });
        }
      }

      blocks.sort((a, b) => b.recency - a.recency);

      let usedTokens = 0;
      const selected: string[] = [];
      const accessedIds: string[] = [];
      const header = `<agentmemory-context project="${escapeXmlAttr(data.project)}">`;
      const footer = `</agentmemory-context>`;
      usedTokens += estimateTokens(header) + estimateTokens(footer);

      let budgetClosed = false;
      for (const block of blocks) {
        if (budgetClosed || usedTokens + block.tokens > budget) {
          if (includeDebugTrace) {
            debugBlocks.push({
              type: block.type,
              sourceObservationIds: block.sourceIds || [],
              sessionIds: block.sessionIds || [],
              tokens: block.tokens,
              status: "skipped",
              skipReason: budgetClosed ? "budget_exhausted" : "budget_exceeded",
            });
          }
          budgetClosed = true;
          continue;
        }
        selected.push(block.content);
        usedTokens += block.tokens;
        if (block.sourceIds && block.sourceIds.length > 0) {
          accessedIds.push(...block.sourceIds);
        }
        if (includeDebugTrace) {
          debugBlocks.push({
            type: block.type,
            sourceObservationIds: block.sourceIds || [],
            sessionIds: block.sessionIds || [],
            tokens: block.tokens,
            status: "selected",
          });
        }
      }

      if (accessedIds.length > 0) {
        void recordAccessBatch(kv, accessedIds);
      }

      if (selected.length === 0) {
        logger.info("No context available", { project: data.project });
        const fallbackReason = degradedReasons[0] || "no_context_available";
        return {
          context: "",
          blocks: 0,
          tokens: 0,
          ...(includeDebugTrace
            ? {
              debugTrace: {
                requested: true,
                degraded: true,
                fallbackReason,
                blocks: [
                  ...debugBlocks,
                  {
                    type: "fallback",
                    sourceObservationIds: [],
                    sessionIds: [],
                    tokens: 0,
                    status: "selected",
                    degraded: true,
                    fallbackReason,
                  },
                ],
              } satisfies ContextDebugTrace,
            }
            : {}),
        };
      }

      const result = `${header}\n${selected.join("\n\n")}\n${footer}`;
      logger.info("Context generated", {
        blocks: selected.length,
        tokens: usedTokens,
      });
      return {
        context: result,
        blocks: selected.length,
        tokens: usedTokens,
        ...(includeRetrievalIds ? { selectedObservationIds: accessedIds } : {}),
        ...(includeDebugTrace
          ? {
            debugTrace: {
              requested: true,
              degraded: degradedReasons.length > 0,
              ...(degradedReasons[0] ? { fallbackReason: degradedReasons[0] } : {}),
              blocks: debugBlocks,
            } satisfies ContextDebugTrace,
          }
          : {}),
      };
    },
  );
}
