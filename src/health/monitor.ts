import type { ISdk } from "iii-sdk";
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { evaluateHealth } from "./thresholds.js";

let latestHealthSnapshot: HealthSnapshot | null = null;

export interface PipelineMetrics {
  compressActive: number;
  compressPending: number;
  totalInflight: number;
}

export function registerHealthMonitor(
  sdk: ISdk,
  kv: StateKV,
  getPipelineMetrics?: () => PipelineMetrics,
): { stop: () => void } {
  let connectionState = "connected";
  let prevCpuUsage = process.cpuUsage();
  let prevCpuTime = Date.now();
  let kvFailureStreak = 0;
  let kvLastSuccessAt: string | undefined;
  let kvLastFailureAt: string | undefined;
  let snapshotPersistFailureStreak = 0;
  let snapshotPersistLastSuccessAt: string | undefined;
  let snapshotPersistLastFailureAt: string | undefined;
  let snapshotPersistError: string | undefined;

  if (typeof sdk.on === "function") {
    sdk.on("connection_state", (state?: unknown) => {
      connectionState = state as string;
    });
  }

  async function collectHealth(): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const uptime = process.uptime();

    const elapsedMs = now - prevCpuTime;
    const userDelta = currentCpu.user - prevCpuUsage.user;
    const systemDelta = currentCpu.system - prevCpuUsage.system;
    const cpuPercent =
      elapsedMs > 0 ? ((userDelta + systemDelta) / 1000 / elapsedMs) * 100 : 0;
    prevCpuUsage = currentCpu;
    prevCpuTime = now;

    const startMark = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
    const eventLoopLagMs = performance.now() - startMark;

    let workers: HealthSnapshot["workers"] = [];
    try {
      const result = await sdk.trigger<
        unknown,
        { workers?: HealthSnapshot["workers"] }
      >({ function_id: "engine::workers::list", payload: {} });
      if (result?.workers) workers = result.workers;
    } catch {}

    const KV_PROBE_TIMEOUT = 5000;
    let kvConnectivity: HealthSnapshot["kvConnectivity"];
    const kvStart = performance.now();
    try {
      await Promise.race([
        (async () => {
          await kv.set(KV.health, "_probe", { ts: Date.now() });
          await kv.get(KV.health, "_probe");
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), KV_PROBE_TIMEOUT),
        ),
      ]);
      kvFailureStreak = 0;
      kvLastSuccessAt = nowIso;
      kvConnectivity = {
        status: "ok",
        latencyMs: Math.round((performance.now() - kvStart) * 100) / 100,
        consecutiveFailures: kvFailureStreak,
        lastSuccessAt: kvLastSuccessAt,
        lastFailureAt: kvLastFailureAt,
      };
    } catch (err) {
      kvFailureStreak++;
      kvLastFailureAt = nowIso;
      kvConnectivity = {
        status: "error",
        error: err instanceof Error ? err.message : "kv_probe_failed",
        latencyMs: Math.round((performance.now() - kvStart) * 100) / 100,
        consecutiveFailures: kvFailureStreak,
        lastSuccessAt: kvLastSuccessAt,
        lastFailureAt: kvLastFailureAt,
      };
    }

    const snapshot: HealthSnapshot = {
      connectionState,
      workers,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      },
      cpu: {
        userMicros: currentCpu.user,
        systemMicros: currentCpu.system,
        percent: Math.round(cpuPercent * 100) / 100,
      },
      eventLoopLagMs,
      uptimeSeconds: uptime,
      kvConnectivity,
      snapshotPersistence: {
        status: snapshotPersistFailureStreak > 0 ? "error" : "ok",
        consecutiveFailures: snapshotPersistFailureStreak,
        lastSuccessAt: snapshotPersistLastSuccessAt,
        lastFailureAt: snapshotPersistLastFailureAt,
        error: snapshotPersistError,
      },
      pipeline: getPipelineMetrics?.(),
      status: "healthy",
      alerts: [],
    };

    const evaluated = evaluateHealth(snapshot);
    snapshot.status = evaluated.status;
    snapshot.alerts = evaluated.alerts;
    latestHealthSnapshot = snapshot;

    try {
      await kv.set(KV.health, "latest", snapshot);
      snapshotPersistFailureStreak = 0;
      snapshotPersistLastSuccessAt = nowIso;
      snapshotPersistError = undefined;
      latestHealthSnapshot = {
        ...snapshot,
        snapshotPersistence: {
          status: "ok",
          consecutiveFailures: 0,
          lastSuccessAt: snapshotPersistLastSuccessAt,
          lastFailureAt: snapshotPersistLastFailureAt,
        },
      };
    } catch (err) {
      snapshotPersistFailureStreak++;
      snapshotPersistLastFailureAt = nowIso;
      snapshotPersistError = err instanceof Error ? err.message : String(err);
      latestHealthSnapshot = {
        ...snapshot,
        snapshotPersistence: {
          status: "error",
          consecutiveFailures: snapshotPersistFailureStreak,
          lastSuccessAt: snapshotPersistLastSuccessAt,
          lastFailureAt: snapshotPersistLastFailureAt,
          error: snapshotPersistError,
        },
      };
      console.warn("[agentmemory] Health snapshot persist failed:", err);
    }
    return latestHealthSnapshot;
  }

  collectHealth().catch(() => {});
  const interval = setInterval(() => {
    collectHealth().catch(() => {});
  }, 30_000);
  interval.unref();

  return {
    stop: () => clearInterval(interval),
  };
}

export async function getLatestHealth(
  kv: StateKV,
): Promise<HealthSnapshot | null> {
  if (latestHealthSnapshot) return latestHealthSnapshot;
  return kv.get<HealthSnapshot>(KV.health, "latest");
}
