// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { HealthSnapshot } from "../types.js";

interface ThresholdConfig {
  eventLoopLagWarnMs: number;
  eventLoopLagCriticalMs: number;
  cpuWarnPercent: number;
  cpuCriticalPercent: number;
  memoryWarnPercent: number;
  memoryCriticalPercent: number;
}

const DEFAULTS: ThresholdConfig = {
  eventLoopLagWarnMs: 100,
  eventLoopLagCriticalMs: 500,
  cpuWarnPercent: 80,
  cpuCriticalPercent: 90,
  memoryWarnPercent: 80,
  memoryCriticalPercent: 95,
};

export function evaluateHealth(
  snapshot: HealthSnapshot,
  config: Partial<ThresholdConfig> = {},
): { status: "healthy" | "degraded" | "critical"; alerts: string[] } {
  const cfg = { ...DEFAULTS, ...config };
  const alerts: string[] = [];
  let critical = false;
  let degraded = false;

  if (
    snapshot.connectionState === "disconnected" ||
    snapshot.connectionState === "failed"
  ) {
    alerts.push(`connection_${snapshot.connectionState}`);
    critical = true;
  } else if (snapshot.connectionState === "reconnecting") {
    alerts.push("connection_reconnecting");
    degraded = true;
  }

  const kvFailureCount =
    snapshot.kvConnectivity?.consecutiveFailures ??
    (snapshot.kvConnectivity?.status === "error" ? 1 : 0);
  if (snapshot.kvConnectivity?.status === "error") {
    alerts.push(`kv_probe_error_streak_${kvFailureCount}`);
    if (kvFailureCount >= 3) {
      critical = true;
    } else {
      degraded = true;
    }
  }

  const snapshotPersistFailureCount =
    snapshot.snapshotPersistence?.consecutiveFailures ??
    (snapshot.snapshotPersistence?.status === "error" ? 1 : 0);
  if (snapshot.snapshotPersistence?.status === "error") {
    alerts.push(
      `health_snapshot_persist_error_streak_${snapshotPersistFailureCount}`,
    );
    if (snapshotPersistFailureCount >= 3) {
      critical = true;
    } else {
      degraded = true;
    }
  }

  if (snapshot.eventLoopLagMs > cfg.eventLoopLagCriticalMs) {
    alerts.push(
      `event_loop_lag_critical_${Math.round(snapshot.eventLoopLagMs)}ms`,
    );
    critical = true;
  } else if (snapshot.eventLoopLagMs > cfg.eventLoopLagWarnMs) {
    alerts.push(`event_loop_lag_warn_${Math.round(snapshot.eventLoopLagMs)}ms`);
    degraded = true;
  }

  if (snapshot.cpu.percent > cfg.cpuCriticalPercent) {
    alerts.push(`cpu_critical_${Math.round(snapshot.cpu.percent)}%`);
    critical = true;
  } else if (snapshot.cpu.percent > cfg.cpuWarnPercent) {
    alerts.push(`cpu_warn_${Math.round(snapshot.cpu.percent)}%`);
    degraded = true;
  }

  const memPercent =
    snapshot.memory.heapTotal > 0
      ? (snapshot.memory.heapUsed / snapshot.memory.heapTotal) * 100
      : 0;
  if (memPercent > cfg.memoryCriticalPercent) {
    alerts.push(`memory_critical_${Math.round(memPercent)}%`);
    critical = true;
  } else if (memPercent > cfg.memoryWarnPercent) {
    alerts.push(`memory_warn_${Math.round(memPercent)}%`);
    degraded = true;
  }

  const status = critical ? "critical" : degraded ? "degraded" : "healthy";
  return { status, alerts };
}
