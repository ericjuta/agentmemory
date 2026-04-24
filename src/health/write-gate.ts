// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { StateKV } from "../state/kv.js";
import { getLatestHealth } from "./monitor.js";
import { getMaintenancePauseReason } from "./maintenance-gate.js";

export async function getUnhealthyPauseReason(
  kv: StateKV,
): Promise<string | null> {
  const health = await getLatestHealth(kv).catch(() => null);
  return getMaintenancePauseReason(health);
}
