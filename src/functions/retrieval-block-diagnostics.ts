import type { ISdk } from "iii-sdk";

import type { RetrievalBlock } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  getRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  getRetrievalVectorIndex,
} from "../state/retrieval-block-indexing.js";

interface DiagnosticsPayload {
  project?: unknown;
  sessionId?: unknown;
  branch?: unknown;
  sampleLimit?: unknown;
  largeScanThreshold?: unknown;
}

interface ScopeEntry {
  ids?: unknown;
  updatedAt?: unknown;
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function scopeKey(kind: "global" | "project" | "session" | "branch", ...parts: string[]): string {
  if (kind === "global") return "scope:global";
  return `scope:${kind}:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

function requestedScopeKeys(options: {
  project?: string;
  sessionId?: string;
  branch?: string;
}): string[] {
  const keys = [scopeKey("global")];
  if (options.project) keys.push(scopeKey("project", options.project));
  if (options.sessionId) keys.push(scopeKey("session", options.sessionId));
  if (options.project && options.branch) {
    keys.push(scopeKey("branch", options.project, options.branch));
  }
  return [...new Set(keys)];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readScopeEntry(
  kv: StateKV,
  key: string,
): Promise<{ key: string; count: number; updatedAt?: string; ids: string[]; error?: string }> {
  try {
    const entry = await kv.get<ScopeEntry>(KV.retrievalBlockIndex, key);
    const ids = Array.isArray(entry?.ids)
      ? entry.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return {
      key,
      count: ids.length,
      updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : undefined,
      ids,
    };
  } catch (error) {
    return {
      key,
      count: 0,
      ids: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerRetrievalBlockDiagnosticsFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retrieval-blocks-diagnostics", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object" ? (payload as DiagnosticsPayload) : {};
    const project = stringValue(data.project);
    const sessionId = stringValue(data.sessionId);
    const branch = stringValue(data.branch);
    const sampleLimit = parseNonNegativeInt(data.sampleLimit, 10);
    const largeScanThreshold = parseNonNegativeInt(data.largeScanThreshold, 5_000);
    const persistence = getRetrievalBlockIndexingRuntime().persistenceStatus?.();
    const manifestDocumentCount = persistence?.manifest?.documentCount;
    const scopeEntries = await Promise.all(
      requestedScopeKeys({ project, sessionId, branch }).map((key) =>
        readScopeEntry(kv, key),
      ),
    );
    const scopedIds = [...new Set(scopeEntries.flatMap((entry) => entry.ids))];
    const sampleIds = scopedIds.slice(0, sampleLimit);
    const samples = await Promise.all(
      sampleIds.map(async (id) => {
        const block = await kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null);
        return block
          ? {
              id,
              sourceType: block.sourceType,
              sourceId: block.sourceId,
              project: block.project,
              scope: block.scope,
              updatedAt: block.updatedAt,
            }
          : { id, missing: true };
      }),
    );
    const estimatedFullScanCount = manifestDocumentCount ?? scopedIds.length;
    const scanRisk =
      estimatedFullScanCount >= largeScanThreshold
        ? {
            level: "high",
            reason: "manifest_or_scope_index_exceeds_threshold",
            threshold: largeScanThreshold,
          }
        : {
            level: "normal",
            reason: "manifest_or_scope_index_below_threshold",
            threshold: largeScanThreshold,
          };

    return {
      success: true,
      fullScanAvoided: true,
      source: "retrieval-index-manifest-and-scope-memberships",
      persistence,
      manifestDocumentCount,
      bm25Size: getRetrievalSearchIndex().size,
      vectorSize: getRetrievalVectorIndex()?.size ?? 0,
      estimatedFullScanCount,
      scanRisk,
      scopes: scopeEntries.map(({ ids, ...entry }) => entry),
      sampleCount: samples.length,
      samples,
    };
  });
}
