import type { ISdk } from "iii-sdk";

import { getIndexPersistencePauseReason } from "../health/write-gate.js";
import type { StateKV } from "../state/kv.js";
import type {
  IndexPersistenceSaveOptions,
  IndexPersistenceStatus,
} from "../state/index-persistence.js";
import { rebuildIndex } from "./search.js";

type CompactionTarget = "observation" | "retrieval";

type PersistenceHandle = {
  save: (options?: IndexPersistenceSaveOptions) => Promise<void>;
  status: () => IndexPersistenceStatus | undefined;
};

type CompactionPayload = {
  target?: unknown;
  force?: unknown;
  verify?: unknown;
  timeBudgetMs?: unknown;
  rebuildObservation?: unknown;
};

type CompactionScopeResult = {
  target: CompactionTarget;
  before?: IndexPersistenceStatus;
  after?: IndexPersistenceStatus;
  compacted: boolean;
  error?: string;
  durationMs?: number;
  rebuilt?: number;
};

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
      const rebuildObservation = data.rebuildObservation === true;
      const timeBudgetMs = parsePositiveInteger(data.timeBudgetMs);
      const startedAt = Date.now();
      const pauseReason = await getIndexPersistencePauseReason(kv);
      const before = {
        observation: options.observation.status(),
        retrieval: options.retrieval.status(),
      };

      if (pauseReason && !force) {
        return {
          success: true,
          status: "deferred",
          reason: pauseReason,
          targets,
          before,
        };
      }

      const handles: Record<CompactionTarget, PersistenceHandle> = {
        observation: options.observation,
        retrieval: options.retrieval,
      };
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
        verify && targets.includes("retrieval")
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
        rebuildObservation,
        pauseReason,
        results,
        verification,
        durationMs: Date.now() - startedAt,
      };
    },
  );
}
