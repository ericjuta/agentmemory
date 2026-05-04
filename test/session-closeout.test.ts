import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSessionCloseoutFunctions } from "../src/functions/session-closeout.js";
import { KV } from "../src/state/schema.js";
import type { AuditEntry, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_test",
    project: "agentmemory",
    cwd: "/repo",
    startedAt: "2026-05-04T00:00:00.000Z",
    status: "active",
    observationCount: 1,
    ...overrides,
  };
}

describe("session closeout", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let summarized: string[];

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    summarized = [];
    sdk.registerFunction("mem::summarize", async (data) => {
      summarized.push((data as { sessionId: string }).sessionId);
      return { success: true };
    });
    registerSessionCloseoutFunctions(sdk as any, kv as any);
  });

  it("closes an active session, summarizes it, and records audit", async () => {
    await kv.set(KV.sessions, "ses_test", makeSession());

    const result = await sdk.trigger({
      function_id: "mem::session-closeout",
      payload: { sessionId: "ses_test", reason: "manual" },
    }) as { success: boolean; session: Session; summary: { status: string } };

    expect(result.success).toBe(true);
    expect(result.summary.status).toBe("success");
    expect(result.session.status).toBe("completed");
    expect(result.session.closeoutReason).toBe("manual");
    expect(result.session.closeoutSummaryStatus).toBe("success");
    expect(summarized).toEqual(["ses_test"]);

    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation: "session_closeout",
      functionId: "mem::session-closeout",
      targetIds: ["ses_test"],
    });
  });

  it("sweeps sessions that stayed idle after a Stop observation", async () => {
    await kv.set(KV.sessions, "ses_idle", makeSession({
      id: "ses_idle",
      observationCount: 0,
      lastObservedAt: "2026-05-04T00:00:00.000Z",
      lastStopAt: "2026-05-04T00:00:00.000Z",
      closeoutStatus: "pending",
      closeoutReason: "idle_after_stop",
    }));

    const result = await sdk.trigger({
      function_id: "mem::session-idle-closeout",
      payload: { idleMs: 1, summarize: false },
    }) as { success: boolean; eligible: number; closed: number };

    expect(result).toMatchObject({ success: true, eligible: 1, closed: 1 });
    const session = await kv.get<Session>(KV.sessions, "ses_idle");
    expect(session?.status).toBe("completed");
    expect(session?.closeoutReason).toBe("idle_after_stop");
    expect(session?.closeoutSummaryStatus).toBe("skipped");
  });

  it("keeps sessions active when activity arrives after Stop", async () => {
    await kv.set(KV.sessions, "ses_active_again", makeSession({
      id: "ses_active_again",
      lastObservedAt: "2026-05-04T00:02:00.000Z",
      lastStopAt: "2026-05-04T00:00:00.000Z",
      closeoutStatus: "pending",
      closeoutReason: "idle_after_stop",
    }));

    const result = await sdk.trigger({
      function_id: "mem::session-closeout",
      payload: {
        sessionId: "ses_active_again",
        reason: "idle_after_stop",
        summarize: false,
      },
    }) as { success: boolean; skipped: boolean; reason: string; session: Session };

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: "post_stop_activity",
    });
    expect(result.session.status).toBe("active");
    expect(result.session.closeoutStatus).toBeUndefined();
    expect(result.session.closeoutReason).toBeUndefined();
  });
});
