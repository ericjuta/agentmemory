import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { detectWorktreeInfo } from "./branch-utils.js";

export async function resolveSessionBranch(
  kv: StateKV,
  session: Session | null,
): Promise<string | undefined> {
  const storedBranch = session?.branch?.trim();
  if (storedBranch) return storedBranch;
  const cwd = session?.cwd?.trim();
  if (!cwd || !session?.id) return undefined;
  const branch = (await detectWorktreeInfo(cwd)).branch || undefined;
  if (branch) {
    await kv
      .set(KV.sessions, session.id, {
        ...session,
        branch,
      })
      .catch(() => {});
  }
  return branch;
}
