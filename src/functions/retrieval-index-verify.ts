import type { ISdk } from "iii-sdk";

import type { StateKV } from "../state/kv.js";
import { getIndexPersistencePauseReason } from "../health/write-gate.js";
import {
  verifyRetrievalBlockIndex,
  type VerifyRetrievalBlockIndexOptions,
} from "../state/retrieval-block-indexing.js";
import type { IndexPersistenceStatus } from "../state/index-persistence.js";

type RetrievalIndexVerifyPayload = {
  bm25DriftRatio?: unknown;
  vectorDriftRatio?: unknown;
  minAbsoluteDrift?: unknown;
  scheduleSave?: unknown;
  repair?: unknown;
  scanBlocks?: unknown;
};

type RetrievalIndexVerifyFunctionOptions = {
  observationPersistenceStatus?: (() => IndexPersistenceStatus | undefined) | undefined;
};

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function registerRetrievalIndexVerifyFunction(
  sdk: ISdk,
  kv: StateKV,
  functionOptions: RetrievalIndexVerifyFunctionOptions = {},
): void {
  sdk.registerFunction("mem::retrieval-index-verify", async (payload: unknown) => {
    const data =
      payload && typeof payload === "object"
        ? (payload as RetrievalIndexVerifyPayload)
        : {};
    const options: VerifyRetrievalBlockIndexOptions = {};
    const bm25DriftRatio = optionalFiniteNumber(data.bm25DriftRatio);
    const vectorDriftRatio = optionalFiniteNumber(data.vectorDriftRatio);
    const minAbsoluteDrift = optionalFiniteNumber(data.minAbsoluteDrift);
    if (bm25DriftRatio !== undefined) options.bm25DriftRatio = bm25DriftRatio;
    if (vectorDriftRatio !== undefined) {
      options.vectorDriftRatio = vectorDriftRatio;
    }
    if (minAbsoluteDrift !== undefined) {
      options.minAbsoluteDrift = minAbsoluteDrift;
    }
    if (typeof data.scheduleSave === "boolean") {
      options.scheduleSave = data.scheduleSave;
    }
    if (typeof data.repair === "boolean") {
      options.repair = data.repair;
    }
    if (typeof data.scanBlocks === "boolean") {
      options.scanBlocks = data.scanBlocks;
    }
    const result = await verifyRetrievalBlockIndex(kv, options);
    const observationPersistence =
      functionOptions.observationPersistenceStatus?.();
    const indexPersistencePauseReason = await getIndexPersistencePauseReason(kv);
    if (!observationPersistence && !result.persistence) {
      return {
        ...result,
        writeGates: {
          indexPersistence: indexPersistencePauseReason,
        },
      };
    }
    return {
      ...result,
      persistenceScopes: {
        observation: observationPersistence,
        retrieval: result.persistence,
      },
      writeGates: {
        indexPersistence: indexPersistencePauseReason,
      },
    };
  });
}
