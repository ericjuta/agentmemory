// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { getLatestHealth } from "./monitor.js";
import { getMaintenancePauseReason } from "./maintenance-gate.js";

export type WriteGateKind =
  | "llm_work"
  | "derived_kv_write"
  | "graph_extraction"
  | "index_persistence";

function kvPauseReason(snapshot: HealthSnapshot | null | undefined): string | null {
  if (snapshot?.kvConnectivity?.status !== "error") return null;
  return snapshot.kvConnectivity.error || "kv_unhealthy";
}

function snapshotPersistencePauseReason(
  snapshot: HealthSnapshot | null | undefined,
): string | null {
  if (snapshot?.snapshotPersistence?.status !== "error") return null;
  return snapshot.snapshotPersistence.error || "health_snapshot_persistence_unhealthy";
}

function statusPauseReason(snapshot: HealthSnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  if (snapshot.status !== "degraded" && snapshot.status !== "critical") return null;
  return snapshot.alerts[0] || snapshot.status;
}

export function getWriteGatePauseReason(
  snapshot: HealthSnapshot | null | undefined,
  kind: WriteGateKind,
): string | null {
  const kvReason = kvPauseReason(snapshot);
  if (kvReason) return kvReason;

  if (kind === "index_persistence") {
    return snapshotPersistencePauseReason(snapshot) || statusPauseReason(snapshot);
  }

  if (kind === "derived_kv_write") {
    if (snapshot?.status === "critical") return statusPauseReason(snapshot);
    return null;
  }

  return statusPauseReason(snapshot);
}

export async function getLlmWorkPauseReason(kv: StateKV): Promise<string | null> {
  const health = await getLatestHealth(kv).catch(() => null);
  return getWriteGatePauseReason(health, "llm_work");
}

export async function getGraphExtractionPauseReason(
  kv: StateKV,
): Promise<string | null> {
  const health = await getLatestHealth(kv).catch(() => null);
  return getWriteGatePauseReason(health, "graph_extraction");
}

export async function getDerivedKvWritePauseReason(
  kv: StateKV,
): Promise<string | null> {
  const health = await getLatestHealth(kv).catch(() => null);
  return getWriteGatePauseReason(health, "derived_kv_write");
}

export async function getIndexPersistencePauseReason(
  kv: StateKV,
): Promise<string | null> {
  const health = await getLatestHealth(kv).catch(() => null);
  return getWriteGatePauseReason(health, "index_persistence");
}

export async function getUnhealthyPauseReason(
  kv: StateKV,
): Promise<string | null> {
  const health = await getLatestHealth(kv).catch(() => null);
  return getMaintenancePauseReason(health);
}
