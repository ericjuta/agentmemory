import type { ISdk } from "iii-sdk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getEnvVar } from "../config.js";
import { getIndexPersistencePauseReason } from "../health/write-gate.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  IndexPersistencePhysicalScopeReferences,
  IndexPersistenceSaveOptions,
  IndexPersistenceStatus,
} from "../state/index-persistence.js";
import { rebuildIndex } from "./search.js";

type CompactionTarget = "observation" | "retrieval";

type PersistenceHandle = {
  save: (options?: IndexPersistenceSaveOptions) => Promise<void>;
  status: () => IndexPersistenceStatus | undefined;
  physicalScopeReferences?: () => IndexPersistencePhysicalScopeReferences;
};

type CompactionPayload = {
  target?: unknown;
  force?: unknown;
  verify?: unknown;
  dryRun?: unknown;
  timeBudgetMs?: unknown;
  rebuildObservation?: unknown;
  dataDir?: unknown;
};

type CompactionScopeResult = {
  target: CompactionTarget;
  before?: IndexPersistenceStatus;
  after?: IndexPersistenceStatus;
  compacted: boolean;
  error?: string;
  durationMs?: number;
  rebuilt?: number;
  dryRun?: boolean;
  estimatedRemovableBytes?: number;
  estimatedRemovableFiles?: number;
};

type PhysicalScopeClassification =
  | "active_scope"
  | "active_shard_payload"
  | "manifest"
  | "legacy_parent_index"
  | "orphan_cleanup_candidate"
  | "unknown";

type PhysicalScopeFile = {
  scope: string;
  fileName: string;
  path: string;
  bytes: number;
  classification: PhysicalScopeClassification;
  target?: CompactionTarget;
};

type PhysicalScopeDiagnostics = {
  available: boolean;
  dataDir: string;
  totalBytes: number;
  totalFiles: number;
  largest: PhysicalScopeFile[];
  cleanupCandidates: {
    files: number;
    bytes: number;
    byTarget: Record<CompactionTarget, { files: number; bytes: number }>;
  };
  error?: string;
};

const ACTIVE_KV_SCOPES = new Set(
  Object.values(KV).filter((value): value is string => typeof value === "string"),
);
const ACTIVE_KV_SCOPE_PREFIXES = [
  "mem:obs:",
  "mem:observe-receipts:",
  "mem:emb:",
  "mem:retrieval-emb:",
  "mem:retrieval-blocks:shard:",
  "mem:team:",
  "mem:enriched:",
  "mem:latent:",
];

export type IndexPersistenceCompactionOptions = {
  observation: PersistenceHandle;
  retrieval: PersistenceHandle;
};

function parseTargets(value: unknown): CompactionTarget[] {
  if (value === undefined || value === null || value === "all") {
    return ["observation", "retrieval"];
  }
  if (value === "observation" || value === "retrieval") return [value];
  return [];
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusMode(status: IndexPersistenceStatus | undefined): string | undefined {
  return status?.manifest?.physicalScopeMode;
}

function scopeFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".bin")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -4));
  } catch {
    return null;
  }
}

function defaultDataDir(): string {
  return getEnvVar("STATE_KV_DATA_DIR") || "/data/state_store.db";
}

function targetForParentScope(scope: string): CompactionTarget | undefined {
  if (scope === KV.bm25Index) return "observation";
  if (scope === KV.retrievalBlockIndex) return "retrieval";
  return undefined;
}

function classifyScope(
  scope: string,
  activeParentScopes: Map<string, CompactionTarget>,
  activeManifestScopes: Map<string, CompactionTarget>,
  activeShardScopes: Map<string, CompactionTarget>,
): { classification: PhysicalScopeClassification; target?: CompactionTarget } {
  const shardTarget = activeShardScopes.get(scope);
  if (shardTarget) {
    return { classification: "active_shard_payload", target: shardTarget };
  }
  const manifestTarget = activeManifestScopes.get(scope);
  if (manifestTarget) {
    return { classification: "manifest", target: manifestTarget };
  }
  const parentTarget = activeParentScopes.get(scope);
  if (parentTarget) {
    return { classification: "legacy_parent_index", target: parentTarget };
  }
  for (const [parentScope, target] of activeParentScopes) {
    if (scope.startsWith(parentScope + ":shard:")) {
      return { classification: "orphan_cleanup_candidate", target };
    }
  }
  const knownTarget = targetForParentScope(scope);
  if (knownTarget) {
    return { classification: "active_scope", target: knownTarget };
  }
  if (
    ACTIVE_KV_SCOPES.has(scope) ||
    ACTIVE_KV_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix))
  ) {
    return { classification: "active_scope" };
  }
  return { classification: "unknown" };
}

function retainedStablePairScope(
  shard: IndexPersistencePhysicalScopeReferences["shardScopes"][number],
): string | null {
  if (shard.generation !== "stable-a" && shard.generation !== "stable-b") {
    return null;
  }
  const suffix =
    ":shard:" +
    shard.kind +
    ":" +
    shard.generation +
    ":" +
    String(shard.index).padStart(5, "0");
  if (!shard.scope.endsWith(suffix)) return null;
  const pairedGeneration =
    shard.generation === "stable-a" ? "stable-b" : "stable-a";
  return (
    shard.scope.slice(0, -suffix.length) +
    ":shard:" +
    shard.kind +
    ":" +
    pairedGeneration +
    ":" +
    String(shard.index).padStart(5, "0")
  );
}

function buildPhysicalScopeDiagnostics(
  handles: Record<CompactionTarget, PersistenceHandle>,
  targets: CompactionTarget[],
  dataDir = defaultDataDir(),
  limit = 20,
): PhysicalScopeDiagnostics {
  if (!existsSync(dataDir)) {
    return {
      available: false,
      dataDir,
      totalBytes: 0,
      totalFiles: 0,
      largest: [],
      cleanupCandidates: {
        files: 0,
        bytes: 0,
        byTarget: {
          observation: { files: 0, bytes: 0 },
          retrieval: { files: 0, bytes: 0 },
        },
      },
      error: "statekv_data_dir_not_found",
    };
  }

  const activeParentScopes = new Map<string, CompactionTarget>();
  const activeManifestScopes = new Map<string, CompactionTarget>();
  const activeShardScopes = new Map<string, CompactionTarget>();
  for (const target of targets) {
    const refs = handles[target].physicalScopeReferences?.();
    if (refs) {
      activeParentScopes.set(refs.parentScope, target);
      activeManifestScopes.set(refs.manifestScope, target);
      for (const shard of refs.shardScopes) {
        activeShardScopes.set(shard.scope, target);
        const retainedPair = retainedStablePairScope(shard);
        if (retainedPair) activeShardScopes.set(retainedPair, target);
      }
      continue;
    }
    const status = handles[target].status();
    if (status?.scope) activeParentScopes.set(status.scope, target);
    if (status?.manifestScope) activeManifestScopes.set(status.manifestScope, target);
  }

  const files: PhysicalScopeFile[] = [];
  for (const fileName of readdirSync(dataDir)) {
    const scope = scopeFromFileName(fileName);
    if (!scope) continue;
    const path = join(dataDir, fileName);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const classified = classifyScope(
      scope,
      activeParentScopes,
      activeManifestScopes,
      activeShardScopes,
    );
    files.push({
      scope,
      fileName,
      path,
      bytes: stat.size,
      classification: classified.classification,
      target: classified.target,
    });
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const cleanupCandidates = files.filter(
    (file) => file.classification === "orphan_cleanup_candidate",
  );
  const cleanupCandidatesByTarget: Record<
    CompactionTarget,
    { files: number; bytes: number }
  > = {
    observation: { files: 0, bytes: 0 },
    retrieval: { files: 0, bytes: 0 },
  };
  for (const file of cleanupCandidates) {
    if (!file.target) continue;
    cleanupCandidatesByTarget[file.target].files++;
    cleanupCandidatesByTarget[file.target].bytes += file.bytes;
  }
  return {
    available: true,
    dataDir,
    totalBytes,
    totalFiles: files.length,
    largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, limit),
    cleanupCandidates: {
      files: cleanupCandidates.length,
      bytes: cleanupCandidates.reduce((sum, file) => sum + file.bytes, 0),
      byTarget: cleanupCandidatesByTarget,
    },
  };
}

export function registerIndexPersistenceCompactionFunction(
  sdk: ISdk,
  kv: StateKV,
  options: IndexPersistenceCompactionOptions,
): void {
  sdk.registerFunction(
    "mem::index-persistence-compact",
    async (payload: unknown) => {
      const data =
        payload && typeof payload === "object"
          ? (payload as CompactionPayload)
          : {};
      const targets = parseTargets(data.target);
      if (targets.length === 0) {
        return {
          success: false,
          status: "error",
          error: "target must be observation, retrieval, or all",
        };
      }

      const force = data.force === true;
      const verify = data.verify !== false;
      const dryRun = data.dryRun === true;
      const rebuildObservation = data.rebuildObservation === true;
      const timeBudgetMs = parsePositiveInteger(data.timeBudgetMs);
      const startedAt = Date.now();
      const pauseReason = await getIndexPersistencePauseReason(kv);
      const before = {
        observation: options.observation.status(),
        retrieval: options.retrieval.status(),
      };

      const handles: Record<CompactionTarget, PersistenceHandle> = {
        observation: options.observation,
        retrieval: options.retrieval,
      };
      const scopeDiagnostics = buildPhysicalScopeDiagnostics(
        handles,
        targets,
        typeof data.dataDir === "string" && data.dataDir ? data.dataDir : undefined,
      );

      if (pauseReason && !dryRun && force) {
        return {
          success: false,
          status: "refused",
          reason: pauseReason,
          targets,
          forced: force,
          dryRun,
          before,
          scopeDiagnostics,
        };
      }

      if (pauseReason && !force && !dryRun) {
        return {
          success: true,
          status: "deferred",
          reason: pauseReason,
          targets,
          before,
          scopeDiagnostics,
        };
      }

      const results: CompactionScopeResult[] = [];

      for (const target of targets) {
        if (timeBudgetMs && Date.now() - startedAt >= timeBudgetMs) {
          results.push({
            target,
            before: handles[target].status(),
            after: handles[target].status(),
            compacted: false,
            error: "time_budget_exceeded",
          });
          continue;
        }

        const scopeStartedAt = Date.now();
        const scopeBefore = handles[target].status();
        try {
          if (dryRun) {
            const removable = scopeDiagnostics.cleanupCandidates.byTarget[target];
            results.push({
              target,
              before: scopeBefore,
              after: scopeBefore,
              compacted: false,
              dryRun: true,
              estimatedRemovableBytes: removable.bytes,
              estimatedRemovableFiles: removable.files,
              durationMs: Date.now() - scopeStartedAt,
            });
            continue;
          }
          const rebuilt =
            target === "observation" && rebuildObservation
              ? await rebuildIndex(kv)
              : undefined;
          await handles[target].save({ allowShrink: true });
          const scopeAfter = handles[target].status();
          results.push({
            target,
            before: scopeBefore,
            after: scopeAfter,
            compacted: statusMode(scopeAfter) === "physical-scope",
            durationMs: Date.now() - scopeStartedAt,
            rebuilt,
          });
        } catch (error) {
          results.push({
            target,
            before: scopeBefore,
            after: handles[target].status(),
            compacted: false,
            error: errorMessage(error),
            durationMs: Date.now() - scopeStartedAt,
          });
        }
      }

      const verification =
        verify && !dryRun && targets.includes("retrieval")
          ? await sdk
              .trigger({
                function_id: "mem::retrieval-index-verify",
                payload: {
                  repair: false,
                  scanBlocks: false,
                  scheduleSave: false,
                  vectorBackfill: false,
                },
              })
              .catch((error) => ({ error: errorMessage(error) }))
          : undefined;
      const failures = results.filter((result) => result.error);

      return {
        success: failures.length === 0,
        status: failures.length === 0 ? "ok" : "partial",
        targets,
        forced: force,
        verify,
        dryRun,
        rebuildObservation,
        pauseReason,
        scopeDiagnostics,
        results,
        verification,
        durationMs: Date.now() - startedAt,
      };
    },
  );
}
