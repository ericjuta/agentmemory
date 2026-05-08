import type { FunctionMetrics } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const MAX_RECENT_EVENTS = 200;

interface FunctionMetricEvent {
  timestamp: number;
  success: boolean;
  latencyMs: number;
  failureReason?: string;
}

type StoredFunctionMetrics = FunctionMetrics & {
  recentEvents?: FunctionMetricEvent[];
};

export class MetricsStore {
  private cache = new Map<string, StoredFunctionMetrics>();
  private qualityCallCounts = new Map<string, number>();

  constructor(private kv: StateKV) {}

  private refreshRecent(
    metric: StoredFunctionMetrics,
    now = Date.now(),
  ): StoredFunctionMetrics {
    const cutoff = now - RECENT_WINDOW_MS;
    const recentEvents = (metric.recentEvents ?? [])
      .filter((event) => event.timestamp >= cutoff)
      .slice(-MAX_RECENT_EVENTS);
    const recentCalls = recentEvents.length;
    const recentFailureCount = recentEvents.filter(
      (event) => !event.success,
    ).length;
    const recentSuccessCount = recentCalls - recentFailureCount;
    const recentAvgLatencyMs =
      recentCalls > 0
        ? recentEvents.reduce((sum, event) => sum + event.latencyMs, 0) /
          recentCalls
        : 0;
    const recentFailureReasons: Record<string, number> = {};
    for (const event of recentEvents) {
      if (event.success) continue;
      const reason = event.failureReason || "error";
      recentFailureReasons[reason] = (recentFailureReasons[reason] || 0) + 1;
    }

    return {
      ...metric,
      recentEvents,
      recentWindowMs: RECENT_WINDOW_MS,
      recentCalls,
      recentSuccessCount,
      recentFailureCount,
      recentFailureRate:
        recentCalls > 0 ? recentFailureCount / recentCalls : 0,
      recentAvgLatencyMs,
      recentFailureReasons,
    };
  }

  private publicMetric(metric: StoredFunctionMetrics): FunctionMetrics {
    const { recentEvents: _recentEvents, ...publicMetric } =
      this.refreshRecent(metric);
    return publicMetric;
  }

  async record(
    functionId: string,
    latencyMs: number,
    success: boolean,
    qualityScore?: number,
    failureReason?: string,
  ): Promise<void> {
    const now = Date.now();
    const calledAt = new Date(now).toISOString();
    let m = this.cache.get(functionId);
    if (!m) {
      m = (await this.kv.get<StoredFunctionMetrics>(KV.metrics, functionId)) ?? {
        functionId,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        failureReasons: {},
        avgLatencyMs: 0,
        avgQualityScore: 0,
      };
    }

    const prev = m.totalCalls;
    m.totalCalls += 1;
    m.avgLatencyMs = (m.avgLatencyMs * prev + latencyMs) / m.totalCalls;
    m.lastCalledAt = calledAt;
    if (success) {
      m.successCount += 1;
      m.lastSuccessAt = calledAt;
    } else {
      m.failureCount += 1;
      m.lastFailureAt = calledAt;
      m.failureReasons = m.failureReasons ?? {};
      const reason = (failureReason || "error").trim() || "error";
      m.failureReasons[reason] = (m.failureReasons[reason] || 0) + 1;
    }
    if (qualityScore !== undefined) {
      const prevQualityCalls = this.qualityCallCounts.get(functionId) || 0;
      m.avgQualityScore =
        (m.avgQualityScore * prevQualityCalls + qualityScore) /
        (prevQualityCalls + 1);
      this.qualityCallCounts.set(functionId, prevQualityCalls + 1);
    }

    m.recentEvents = [
      ...(m.recentEvents ?? []),
      {
        timestamp: now,
        success,
        latencyMs,
        ...(!success
          ? { failureReason: (failureReason || "error").trim() || "error" }
          : {}),
      },
    ];
    m = this.refreshRecent(m, now);
    this.cache.set(functionId, m);
    await this.kv.set(KV.metrics, functionId, m).catch(() => {});
  }

  async get(functionId: string): Promise<FunctionMetrics | null> {
    const metric =
      this.cache.get(functionId) ??
      (await this.kv.get<StoredFunctionMetrics>(KV.metrics, functionId));
    return metric ? this.publicMetric(metric) : null;
  }

  async getAll(): Promise<FunctionMetrics[]> {
    const kvMetrics = await this.kv
      .list<StoredFunctionMetrics>(KV.metrics)
      .catch(() => []);
    const merged = new Map<string, StoredFunctionMetrics>();
    for (const m of kvMetrics) merged.set(m.functionId, m);
    for (const [id, m] of this.cache) merged.set(id, m);
    return Array.from(merged.values()).map((metric) =>
      this.publicMetric(metric),
    );
  }
}
