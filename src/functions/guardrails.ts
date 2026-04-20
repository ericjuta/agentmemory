import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { GuardrailMemory } from "../types.js";
import { recordAudit } from "./audit.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sortByUpdatedAt<T extends { updatedAt?: string; createdAt?: string }>(
  items: T[],
): T[] {
  return items.slice().sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

async function expireElapsedGuardrails(
  kv: StateKV,
  guardrails: GuardrailMemory[],
): Promise<GuardrailMemory[]> {
  const now = Date.now();
  const next = [...guardrails];
  await Promise.all(
    next.map(async (guardrail) => {
      if (
        guardrail.status === "active" &&
        guardrail.expiresAt &&
        new Date(guardrail.expiresAt).getTime() <= now
      ) {
        guardrail.status = "expired";
        guardrail.updatedAt = new Date().toISOString();
        await kv.set(KV.guardrails, guardrail.id, guardrail);
      }
    }),
  );
  return next;
}

function branchMatches(
  value: { branch?: string },
  requested?: string,
): boolean {
  if (!requested) return true;
  return !value.branch || value.branch === requested;
}

function guardrailText(guardrail: GuardrailMemory): string {
  return [
    guardrail.explanation,
    ...guardrail.triggerConditions,
    ...guardrail.evidence,
    ...guardrail.relatedFiles,
    ...guardrail.relatedConcepts,
  ].join(" ");
}

function queryScore(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  if (terms.length === 0) return 0;
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

export async function listScopedGuardrails(
  kv: StateKV,
  filter: {
    project?: string;
    branch?: string;
    scopeType?: GuardrailMemory["scopeType"];
    scopeId?: string;
    filePath?: string;
    concept?: string;
    includeExpired?: boolean;
    limit?: number;
  },
): Promise<GuardrailMemory[]> {
  const limit = Math.max(1, Math.min(filter.limit || 50, 500));
  let guardrails = await expireElapsedGuardrails(
    kv,
    await kv.list<GuardrailMemory>(KV.guardrails).catch(() => []),
  );
  if (filter.project) {
    guardrails = guardrails.filter((guardrail) => guardrail.project === filter.project);
  }
  if (filter.branch) {
    guardrails = guardrails.filter((guardrail) => branchMatches(guardrail, filter.branch));
  }
  if (filter.scopeType) {
    guardrails = guardrails.filter((guardrail) => guardrail.scopeType === filter.scopeType);
  }
  if (filter.scopeId) {
    guardrails = guardrails.filter((guardrail) => guardrail.scopeId === filter.scopeId);
  }
  if (filter.filePath) {
    guardrails = guardrails.filter((guardrail) =>
      guardrail.relatedFiles.includes(filter.filePath as string),
    );
  }
  if (filter.concept) {
    guardrails = guardrails.filter((guardrail) =>
      guardrail.relatedConcepts.includes(filter.concept as string),
    );
  }
  if (!filter.includeExpired) {
    guardrails = guardrails.filter((guardrail) => guardrail.status === "active");
  }
  return sortByUpdatedAt(guardrails).slice(0, limit);
}

export function registerGuardrailsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::guardrail-save", 
    async (data: {
      project?: string;
      branch?: string;
      scopeType: GuardrailMemory["scopeType"];
      scopeId: string;
      triggerConditions: string[];
      riskLevel: GuardrailMemory["riskLevel"];
      explanation: string;
      evidence?: string[];
      relatedFiles?: string[];
      relatedConcepts?: string[];
      missionId?: string;
      expiresAt?: string;
      reviewAfter?: string;
      supersedes?: string[];
      sourceObservationIds?: string[];
      sourceActionIds?: string[];
    }) => {
      if (!data.scopeType || !data.scopeId?.trim() || !data.explanation?.trim()) {
        return {
          success: false,
          error: "scopeType, scopeId, and explanation are required",
        };
      }
      if (
        !data.riskLevel ||
        !["low", "medium", "high", "critical"].includes(data.riskLevel)
      ) {
        return { success: false, error: "riskLevel must be low, medium, high, or critical" };
      }
      const triggerConditions = uniqueStrings(data.triggerConditions || []);
      if (triggerConditions.length === 0) {
        return { success: false, error: "triggerConditions must contain at least one entry" };
      }

      const now = new Date().toISOString();
      const id = fingerprintId(
        "grd",
        [
          data.project || "",
          data.branch || "",
          data.scopeType,
          data.scopeId.trim(),
          data.explanation.trim().toLowerCase(),
        ].join("|"),
      );
      const existing = await kv.get<GuardrailMemory>(KV.guardrails, id).catch(() => null);
      const guardrail: GuardrailMemory = existing || {
        id,
        createdAt: now,
        updatedAt: now,
        project: data.project,
        branch: data.branch,
        scopeType: data.scopeType,
        scopeId: data.scopeId.trim(),
        triggerConditions,
        riskLevel: data.riskLevel,
        explanation: data.explanation.trim(),
        evidence: uniqueStrings(data.evidence || []),
        relatedFiles: uniqueStrings(data.relatedFiles || []),
        relatedConcepts: uniqueStrings(data.relatedConcepts || []),
        missionId: data.missionId,
        expiresAt: data.expiresAt,
        reviewAfter: data.reviewAfter,
        status: "active",
        supersedes: uniqueStrings(data.supersedes || []),
        sourceObservationIds: uniqueStrings(data.sourceObservationIds || []),
        sourceActionIds: uniqueStrings(data.sourceActionIds || []),
      };

      guardrail.updatedAt = now;
      guardrail.project = data.project || guardrail.project;
      guardrail.branch = data.branch === undefined ? guardrail.branch : data.branch;
      guardrail.triggerConditions = triggerConditions;
      guardrail.riskLevel = data.riskLevel;
      guardrail.explanation = data.explanation.trim();
      guardrail.evidence = uniqueStrings([...(guardrail.evidence || []), ...(data.evidence || [])]);
      guardrail.relatedFiles = uniqueStrings([
        ...(guardrail.relatedFiles || []),
        ...(data.relatedFiles || []),
      ]);
      guardrail.relatedConcepts = uniqueStrings([
        ...(guardrail.relatedConcepts || []),
        ...(data.relatedConcepts || []),
      ]);
      guardrail.missionId = data.missionId || guardrail.missionId;
      guardrail.expiresAt = data.expiresAt || guardrail.expiresAt;
      guardrail.reviewAfter = data.reviewAfter || guardrail.reviewAfter;
      guardrail.status = "active";
      guardrail.supersedes = uniqueStrings([...(guardrail.supersedes || []), ...(data.supersedes || [])]);
      guardrail.sourceObservationIds = uniqueStrings([
        ...(guardrail.sourceObservationIds || []),
        ...(data.sourceObservationIds || []),
      ]);
      guardrail.sourceActionIds = uniqueStrings([
        ...(guardrail.sourceActionIds || []),
        ...(data.sourceActionIds || []),
      ]);

      for (const supersededId of guardrail.supersedes) {
        const superseded = await kv.get<GuardrailMemory>(KV.guardrails, supersededId).catch(() => null);
        if (!superseded || superseded.id === guardrail.id) continue;
        superseded.status = "superseded";
        superseded.supersededBy = guardrail.id;
        superseded.updatedAt = now;
        await kv.set(KV.guardrails, superseded.id, superseded);
      }

      await kv.set(KV.guardrails, guardrail.id, guardrail);
      await recordAudit(kv, "guardrail_save", "mem::guardrail-save", [guardrail.id], {
        scopeType: guardrail.scopeType,
        scopeId: guardrail.scopeId,
        branch: guardrail.branch,
        project: guardrail.project,
      });

      return {
        success: true,
        action: existing ? "updated" : "created",
        guardrail,
      };
    },
  );

  sdk.registerFunction("mem::guardrail-list", 
    async (data: {
      project?: string;
      branch?: string;
      scopeType?: GuardrailMemory["scopeType"];
      scopeId?: string;
      filePath?: string;
      concept?: string;
      includeExpired?: boolean;
      limit?: number;
    }) => {
      const guardrails = await listScopedGuardrails(kv, data);
      return { success: true, guardrails };
    },
  );

  sdk.registerFunction("mem::guardrail-search", 
    async (data: {
      query: string;
      project?: string;
      branch?: string;
      limit?: number;
    }) => {
      if (!data.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const limit = Math.max(1, Math.min(data.limit || 20, 100));
      const guardrails = await listScopedGuardrails(kv, {
        project: data.project,
        branch: data.branch,
        includeExpired: false,
        limit: 500,
      });
      const matches = guardrails
        .map((guardrail) => ({
          guardrail,
          score: queryScore(guardrailText(guardrail), data.query),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return {
        success: true,
        guardrails: matches.map((item) => ({
          ...item.guardrail,
          score: Math.round(item.score * 1000) / 1000,
        })),
      };
    },
  );
}
