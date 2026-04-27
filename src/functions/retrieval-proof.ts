import type { ISdk } from "iii-sdk";

import { getLatestHealth } from "../health/monitor.js";
import { getWriteGatePauseReason } from "../health/write-gate.js";
import type { StateKV } from "../state/kv.js";
import { retrieveRelevantBlocks } from "./retrieval-engine.js";

interface RetrievalProofPayload {
  project?: unknown;
  cwd?: unknown;
  branch?: unknown;
  query?: unknown;
  limit?: unknown;
  coverageTarget?: unknown;
  includeSearch?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function ratio(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRetrievalProofFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::retrieval-proof", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object" ? (payload as RetrievalProofPayload) : {};
    const project = stringValue(data.project) || stringValue(data.cwd);
    const branch = stringValue(data.branch);
    const query = stringValue(data.query);
    const limit = Math.min(10, positiveInteger(data.limit, 3));
    const coverageTarget = ratio(data.coverageTarget, 0.98);
    const includeSearch = booleanValue(data.includeSearch, Boolean(query));
    const generatedAt = new Date().toISOString();

    const health = await getLatestHealth(kv).catch(() => null);
    const writeGates = {
      llmWork: getWriteGatePauseReason(health, "llm_work"),
      derivedKvWrites: getWriteGatePauseReason(health, "derived_kv_write"),
      graphExtraction: getWriteGatePauseReason(health, "graph_extraction"),
      indexPersistence: getWriteGatePauseReason(health, "index_persistence"),
    };

    const diagnostics = await sdk
      .trigger({
        function_id: "mem::retrieval-blocks-diagnostics",
        payload: {
          ...(project ? { project } : {}),
          ...(branch ? { branch } : {}),
          sampleLimit: 0,
        },
      })
      .catch((error) => ({ success: false, error: errorMessage(error) }));

    const diagnosticsRecord =
      diagnostics && typeof diagnostics === "object"
        ? (diagnostics as Record<string, unknown>)
        : {};
    const quality =
      diagnosticsRecord.quality && typeof diagnosticsRecord.quality === "object"
        ? (diagnosticsRecord.quality as Record<string, unknown>)
        : {};
    const vectorCoverage =
      typeof quality.vectorCoverage === "number" ? quality.vectorCoverage : null;
    const leakageCount =
      typeof quality.lastEvalLeakageCount === "number"
        ? quality.lastEvalLeakageCount
        : null;
    const freshnessLag =
      quality.deferredFreshnessLag &&
      typeof quality.deferredFreshnessLag === "object" &&
      !Array.isArray(quality.deferredFreshnessLag)
        ? (quality.deferredFreshnessLag as Record<string, unknown>)
        : null;
    const queuedCount =
      typeof freshnessLag?.queuedCount === "number"
        ? freshnessLag.queuedCount
        : null;
    const blockingQueuedCount =
      typeof freshnessLag?.blockingQueuedCount === "number"
        ? freshnessLag.blockingQueuedCount
        : queuedCount;

    let search:
      | {
          skipped: true;
          reason: string;
        }
      | {
          skipped?: false;
          count: number;
          degradedFreshness: boolean;
          vectorCoverageConfidence?: number;
          first?: {
            blockId: string;
            title: string;
            sourceType: string;
            score: number;
          };
        }
      | {
          skipped?: false;
          error: string;
        } = { skipped: true, reason: "includeSearch=false" };

    if (includeSearch) {
      if (!project) {
        search = { skipped: true, reason: "scope_required" };
      } else if (!query) {
        search = { skipped: true, reason: "query_required" };
      } else {
        try {
          const result = await retrieveRelevantBlocks(kv, {
            project,
            branch,
            query,
            purpose: "smart-search",
            budget: limit * 350,
            maxBlocks: Math.max(limit, 1),
          });
          const first = result.searchResults[0];
          search = {
            count: result.searchResults.length,
            degradedFreshness: result.trace.degradedFreshness === true,
            vectorCoverageConfidence: result.trace.vectorCoverageConfidence,
            ...(first
              ? {
                  first: {
                    blockId: first.block.id,
                    title: first.block.title,
                    sourceType: first.block.sourceType,
                    score: first.score,
                  },
                }
              : {}),
          };
        } catch (error) {
          search = { error: errorMessage(error) };
        }
      }
    }

    const pass =
      diagnosticsRecord.success === true &&
      (vectorCoverage === null || vectorCoverage >= coverageTarget) &&
      (leakageCount === null || leakageCount === 0) &&
      (blockingQueuedCount === null || blockingQueuedCount === 0) &&
      !Object.values(writeGates).some(Boolean) &&
      !("error" in search);

    return {
      success: true,
      generatedAt,
      pass,
      project,
      branch,
      health: {
        status: health?.status ?? "unknown",
        alerts: health?.alerts ?? [],
      },
      writeGates,
      maintenance: {
        status:
          blockingQueuedCount && blockingQueuedCount > 0
            ? "blocking_freshness_lag"
            : queuedCount && queuedCount > 0
              ? "non_blocking_backlog"
              : "caught_up",
        queuedCount,
        blockingQueuedCount,
        diagnosticQueuedCount:
          typeof freshnessLag?.diagnosticQueuedCount === "number"
            ? freshnessLag.diagnosticQueuedCount
            : null,
        byLane: freshnessLag?.byLane ?? null,
      },
      coverageTarget,
      diagnostics: diagnosticsRecord,
      search,
    };
  });
}
