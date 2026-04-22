// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";
import { getHeapStatistics } from "node:v8";
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { evaluateHealth } from "./thresholds.js";
import { CircuitBreaker } from "../providers/circuit-breaker.js";

let latestHealthSnapshot: HealthSnapshot | null = null;

const BASE_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 300_000; // 5 min cap when backing off

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
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let interval = BASE_INTERVAL_MS;

  const persistCircuit = new CircuitBreaker({
    failureThreshold: 3,
    failureWindowMs: 120_000,
    recoveryTimeoutMs: 60_000,
  });

  if (typeof sdk.on === "function") {
    sdk.on("connection_state", (state?: unknown) => {
      connectionState = state as string;
    });
  }

  async function collectHealth(): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const heapStats = getHeapStatistics();
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

    // Skip KV probe when persist circuit is open — engine is already struggling
    let kvConnectivity: HealthSnapshot["kvConnectivity"];
    if (!persistCircuit.isAllowed) {
      kvConnectivity = {
        status: "error",
        error: "skipped_circuit_open",
        latencyMs: 0,
        consecutiveFailures: kvFailureStreak,
        lastSuccessAt: kvLastSuccessAt,
        lastFailureAt: kvLastFailureAt,
      };
    } else {
      const KV_PROBE_TIMEOUT = 5000;
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
        persistCircuit.recordFailure();
        kvConnectivity = {
          status: "error",
          error: err instanceof Error ? err.message : "kv_probe_failed",
          latencyMs: Math.round((performance.now() - kvStart) * 100) / 100,
          consecutiveFailures: kvFailureStreak,
          lastSuccessAt: kvLastSuccessAt,
          lastFailureAt: kvLastFailureAt,
        };
      }
    }

    const snapshot: HealthSnapshot = {
      connectionState,
      workers,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        heapLimit: heapStats.heap_size_limit,
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

    if (!persistCircuit.isAllowed || kvConnectivity.status !== "ok") {
      const persistError = !persistCircuit.isAllowed
        ? "circuit_open"
        : `skipped_due_kv_probe_error:${kvConnectivity.error ?? "unknown"}`;
      const persistFailureCount = Math.max(snapshotPersistFailureStreak, 1);
      const persistLastFailureAt =
        kvConnectivity.status !== "ok" ? nowIso : (snapshotPersistLastFailureAt ?? nowIso);
      snapshotPersistError = persistError;
      latestHealthSnapshot = {
        ...snapshot,
        snapshotPersistence: {
          status: "error",
          consecutiveFailures: persistFailureCount,
          lastSuccessAt: snapshotPersistLastSuccessAt,
          lastFailureAt: persistLastFailureAt,
          error: persistError,
        },
      };
    } else {
      try {
        await kv.set(KV.health, "latest", snapshot);
        persistCircuit.recordSuccess();
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
        persistCircuit.recordFailure();
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
    }
    return latestHealthSnapshot;
  }

  const tick = async () => {
    if (stopped) return;
    try {
      await collectHealth();
      // Success — ease back to base interval
      interval = Math.max(BASE_INTERVAL_MS, interval * 0.75);
    } catch {
      // Backoff on failure
      interval = Math.min(MAX_INTERVAL_MS, interval * 2);
    }
    if (!stopped) {
      timer = setTimeout(tick, interval);
      timer.unref();
    }
  };

  // Initial collection after short delay
  timer = setTimeout(tick, 5_000);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export async function getLatestHealth(
  kv: StateKV,
): Promise<HealthSnapshot | null> {
  if (latestHealthSnapshot) return latestHealthSnapshot;
  return kv.get<HealthSnapshot>(KV.health, "latest");
}
