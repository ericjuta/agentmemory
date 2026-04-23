import { describe, expect, it } from "vitest";
import { registerRememberFunction } from "../src/functions/remember.js";
import { retrievalBlockId } from "../src/functions/retrieval-blocks.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("remember", () => {
  it("derives project scope from the session and keeps dedup scoped to that lane", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);
    sdk.registerFunction("mem::cascade-update", async () => ({ success: true }));

    const session: Session = {
      id: "session-1",
      project: "/project",
      cwd: "/project",
      branch: "main",
      startedAt: "2026-03-29T12:00:00.000Z",
      status: "active",
      observationCount: 0,
    };
    await kv.set(KV.sessions, session.id, session);

    const first = (await sdk.trigger("mem::remember", {
      content: "Auth approvals remain required for production changes.",
      sessionId: session.id,
    })) as { success: boolean; memory: { id: string; version: number; project?: string; branch?: string; sessionIds: string[] } };
    const second = (await sdk.trigger("mem::remember", {
      content: "Auth approvals remain required for production changes.",
      sessionId: session.id,
    })) as { success: boolean; memory: { id: string; version: number; parentId?: string } };
    const otherProject = (await sdk.trigger("mem::remember", {
      content: "Auth approvals remain required for production changes.",
      project: "/other-project",
    })) as { success: boolean; memory: { version: number; parentId?: string; project?: string } };

    expect(first.memory.project).toBe("/project");
    expect(first.memory.branch).toBe("main");
    expect(first.memory.sessionIds).toEqual(["session-1"]);
    expect(second.memory.version).toBe(2);
    expect(second.memory.parentId).toBe(first.memory.id);
    expect(otherProject.memory.version).toBe(1);
    expect(otherProject.memory.parentId).toBeUndefined();
    expect(otherProject.memory.project).toBe("/other-project");

    const block = await kv.get<any>(
      KV.retrievalBlocks,
      retrievalBlockId("memory", first.memory.id),
    );
    expect(block.project).toBe("/project");
    expect(block.branch).toBe("main");
    expect(block.scope).toBe("branch");
  });
});
