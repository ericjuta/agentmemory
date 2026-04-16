import type { HealthSnapshot } from "../types.js";

export function shouldPauseMaintenance(
  snapshot: HealthSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  if (snapshot.status === "degraded" || snapshot.status === "critical") {
    return true;
  }
  return snapshot.kvConnectivity?.status === "error";
}

export function getMaintenancePauseReason(
  snapshot: HealthSnapshot | null | undefined,
): string | null {
  if (!shouldPauseMaintenance(snapshot)) return null;
  if (!snapshot) return null;
  if (snapshot.kvConnectivity?.status === "error") {
    return snapshot.kvConnectivity.error || "kv_unhealthy";
  }
  return snapshot.status;
}
