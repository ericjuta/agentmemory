import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { getEnvVar } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_LIMIT = 25;

function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isIdleAfterStopEligible(session: Session): boolean {
  const stopAt = parseTimestamp(session.lastStopAt);
  if (stopAt === null) return false;
  const observedAt = parseTimestamp(session.lastObservedAt);
  return observedAt === null || observedAt <= stopAt;
}

function defaultIdleMs(): number {
  return parsePositiveInt(
    getEnvVar("AGENTMEMORY_SESSION_IDLE_CLOSEOUT_MS"),
    DEFAULT_IDLE_MS,
  );
}

async function summarizeSession(
  sdk: ISdk,
  session: Session,
): Promise<{ status: "success" | "skipped" | "failed"; error?: string }> {
  if ((session.observationCount || 0) <= 0) {
    return { status: "skipped", error: "no_observations" };
  }
  try {
    const result = await sdk.trigger<{ sessionId: string }, { success?: boolean; error?: string }>({
      function_id: "mem::summarize",
      payload: { sessionId: session.id },
    });
    if (result?.success) return { status: "success" };
    return { status: "failed", error: result?.error || "summarize_failed" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerSessionCloseoutFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::session-closeout",
    async (data?: { sessionId?: unknown; reason?: unknown; summarize?: unknown }) => {
      const sessionId = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
      if (!sessionId) return { success: false, error: "sessionId is required" };

      const reason = typeof data?.reason === "string" && data.reason.trim()
        ? data.reason.trim()
        : "manual";
      const shouldSummarize = data?.summarize !== false;
      const attemptedAt = new Date().toISOString();

      const closeoutState = await withKeyedLock("session-closeout:" + sessionId, async () => {
        const fresh = await kv.get<Session>(KV.sessions, sessionId);
        if (!fresh) return null;
        if (fresh.status !== "active") return { session: fresh };
        if (reason === "idle_after_stop" && !isIdleAfterStopEligible(fresh)) {
          fresh.closeoutStatus = undefined;
          fresh.closeoutReason = undefined;
          fresh.closeoutError = undefined;
          await kv.set(KV.sessions, sessionId, fresh);
          return { session: fresh, skipped: "post_stop_activity" };
        }
        fresh.closeoutStatus = "running";
        fresh.closeoutReason = reason;
        fresh.closeoutAttemptedAt = attemptedAt;
        fresh.closeoutError = undefined;
        await kv.set(KV.sessions, sessionId, fresh);
        return { session: fresh };
      });

      if (!closeoutState) return { success: false, error: "session_not_found" };
      if (closeoutState.skipped) {
        return {
          success: true,
          skipped: true,
          reason: closeoutState.skipped,
          session: closeoutState.session,
        };
      }

      const session = closeoutState.session;
      if (session.status !== "active") {
        return {
          success: true,
          skipped: true,
          reason: "session_already_closed",
          session,
        };
      }

      const summary = shouldSummarize
        ? await summarizeSession(sdk, session)
        : { status: "skipped" as const, error: "summarize_disabled" };
      const completedAt = new Date().toISOString();

      const closedState = await withKeyedLock("session-closeout:" + sessionId, async () => {
        const fresh = await kv.get<Session>(KV.sessions, sessionId);
        if (!fresh) return null;
        if (fresh.status !== "active") {
          return { session: fresh, skipped: "session_already_closed" };
        }
        if (reason === "idle_after_stop" && !isIdleAfterStopEligible(fresh)) {
          fresh.closeoutStatus = undefined;
          fresh.closeoutReason = undefined;
          fresh.closeoutError = undefined;
          await kv.set(KV.sessions, sessionId, fresh);
          return { session: fresh, skipped: "post_stop_activity" };
        }
        fresh.status = "completed";
        fresh.endedAt = completedAt;
        fresh.updatedAt = completedAt;
        fresh.closeoutStatus = "completed";
        fresh.closeoutReason = reason;
        fresh.closeoutCompletedAt = completedAt;
        fresh.closeoutSummaryStatus = summary.status;
        fresh.closeoutError = summary.status === "failed" ? summary.error : undefined;
        await kv.set(KV.sessions, sessionId, fresh);
        return { session: fresh };
      });

      if (!closedState) return { success: false, error: "session_not_found" };
      if (closedState.skipped) {
        return {
          success: true,
          skipped: true,
          reason: closedState.skipped,
          session: closedState.session,
          summary,
        };
      }

      const closed = closedState.session;

      await safeAudit(kv, "session_closeout", "mem::session-closeout", [sessionId], {
        reason,
        summaryStatus: summary.status,
        summaryError: summary.error,
      });

      logger.info("Session closeout completed", {
        sessionId,
        reason,
        summaryStatus: summary.status,
      });

      return { success: true, session: closed, summary };
    },
  );

  sdk.registerFunction("mem::session-idle-closeout",
    async (data: { idleMs?: unknown; limit?: unknown; summarize?: unknown } | undefined) => {
      const idleMs = parsePositiveInt(data?.idleMs, defaultIdleMs());
      const limit = parsePositiveInt(data?.limit, DEFAULT_SWEEP_LIMIT);
      const now = Date.now();
      const sessions = await kv.list<Session>(KV.sessions);
      const eligible = sessions
        .filter((session) => {
          if (session.status !== "active") return false;
          if (session.closeoutStatus === "running") return false;
          const stopAt = parseTimestamp(session.lastStopAt);
          if (stopAt === null || now - stopAt < idleMs) return false;
          return isIdleAfterStopEligible(session);
        })
        .sort((a, b) => (a.lastStopAt || "").localeCompare(b.lastStopAt || ""))
        .slice(0, limit);

      const results = [];
      for (const session of eligible) {
        const result = await sdk.trigger({
          function_id: "mem::session-closeout",
          payload: {
            sessionId: session.id,
            reason: "idle_after_stop",
            summarize: data?.summarize !== false,
          },
        });
        results.push(result);
      }

      return {
        success: true,
        checked: sessions.length,
        eligible: eligible.length,
        closed: results.filter((r) => {
          const item = r as { success?: boolean; skipped?: boolean };
          return item?.success && !item.skipped;
        }).length,
        idleMs,
        results,
      };
    },
  );
}
