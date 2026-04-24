import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { DecisionMemory } from "../types.js";
import { recordAudit } from "./audit.js";
import { filePathMatches } from "./file-path-match.js";
import {
  deleteStoredRetrievalBlock,
  retrievalBlockId,
  upsertDecisionRetrievalBlock,
} from "./retrieval-blocks.js";

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

function branchMatches(
  value: { branch?: string },
  requested?: string,
): boolean {
  if (!requested) return true;
  return !value.branch || value.branch === requested;
}

function decisionText(decision: DecisionMemory): string {
  return [
    decision.title,
    decision.decision,
    decision.rationale,
    ...decision.alternatives,
    ...decision.reconsiderWhen,
    ...decision.relatedFiles,
    ...decision.relatedConcepts,
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

export async function listScopedDecisions(
  kv: StateKV,
  filter: {
    project?: string;
    branch?: string;
    missionId?: string;
    filePath?: string;
    concept?: string;
    activeOnly?: boolean;
    limit?: number;
  },
): Promise<DecisionMemory[]> {
  const limit = Math.max(1, Math.min(filter.limit || 50, 500));
  let decisions = await kv.list<DecisionMemory>(KV.decisions).catch(() => []);
  if (filter.project) {
    decisions = decisions.filter((decision) => decision.project === filter.project);
  }
  if (filter.branch) {
    decisions = decisions.filter((decision) => branchMatches(decision, filter.branch));
  }
  if (filter.missionId) {
    decisions = decisions.filter((decision) => decision.missionId === filter.missionId);
  }
  if (filter.filePath) {
    decisions = decisions.filter((decision) =>
      decision.relatedFiles.some((filePath) =>
        filePathMatches(filePath, filter.filePath as string),
      ),
    );
  }
  if (filter.concept) {
    decisions = decisions.filter((decision) =>
      decision.relatedConcepts.includes(filter.concept as string),
    );
  }
  if (filter.activeOnly !== false) {
    decisions = decisions.filter((decision) => decision.status === "active");
  }
  return sortByUpdatedAt(decisions).slice(0, limit);
}

export function registerDecisionsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::decision-save", 
    async (data: {
      title: string;
      decision: string;
      rationale: string;
      alternatives?: string[];
      reconsiderWhen?: string[];
      project?: string;
      branch?: string;
      missionId?: string;
      relatedFiles?: string[];
      relatedConcepts?: string[];
      sourceObservationIds?: string[];
      sourceActionIds?: string[];
      supersedes?: string[];
    }) => {
      if (!data.title?.trim() || !data.decision?.trim() || !data.rationale?.trim()) {
        return {
          success: false,
          error: "title, decision, and rationale are required",
        };
      }

      const now = new Date().toISOString();
      const id = fingerprintId(
        "dec",
        [
          data.project || "",
          data.branch || "",
          data.title.trim().toLowerCase(),
          data.decision.trim().toLowerCase(),
        ].join("|"),
      );
      const existing = await kv.get<DecisionMemory>(KV.decisions, id).catch(() => null);
      const record: DecisionMemory = existing || {
        id,
        createdAt: now,
        updatedAt: now,
        title: data.title.trim(),
        decision: data.decision.trim(),
        rationale: data.rationale.trim(),
        alternatives: uniqueStrings(data.alternatives || []),
        reconsiderWhen: uniqueStrings(data.reconsiderWhen || []),
        status: "active",
        project: data.project,
        branch: data.branch,
        missionId: data.missionId,
        relatedFiles: uniqueStrings(data.relatedFiles || []),
        relatedConcepts: uniqueStrings(data.relatedConcepts || []),
        sourceObservationIds: uniqueStrings(data.sourceObservationIds || []),
        sourceActionIds: uniqueStrings(data.sourceActionIds || []),
        supersedes: uniqueStrings(data.supersedes || []),
      };

      record.updatedAt = now;
      record.title = data.title.trim();
      record.decision = data.decision.trim();
      record.rationale = data.rationale.trim();
      record.project = data.project || record.project;
      record.branch = data.branch === undefined ? record.branch : data.branch;
      record.missionId = data.missionId || record.missionId;
      record.alternatives = uniqueStrings([...(record.alternatives || []), ...(data.alternatives || [])]);
      record.reconsiderWhen = uniqueStrings([
        ...(record.reconsiderWhen || []),
        ...(data.reconsiderWhen || []),
      ]);
      record.relatedFiles = uniqueStrings([...(record.relatedFiles || []), ...(data.relatedFiles || [])]);
      record.relatedConcepts = uniqueStrings([
        ...(record.relatedConcepts || []),
        ...(data.relatedConcepts || []),
      ]);
      record.sourceObservationIds = uniqueStrings([
        ...(record.sourceObservationIds || []),
        ...(data.sourceObservationIds || []),
      ]);
      record.sourceActionIds = uniqueStrings([
        ...(record.sourceActionIds || []),
        ...(data.sourceActionIds || []),
      ]);
      record.supersedes = uniqueStrings([...(record.supersedes || []), ...(data.supersedes || [])]);
      record.status = "active";

      for (const supersededId of record.supersedes) {
        const superseded = await kv.get<DecisionMemory>(KV.decisions, supersededId).catch(() => null);
        if (!superseded || superseded.id === record.id) continue;
        superseded.status = "superseded";
        superseded.supersededBy = record.id;
        superseded.updatedAt = now;
        await kv.set(KV.decisions, superseded.id, superseded);
        await deleteStoredRetrievalBlock(
          kv,
          retrievalBlockId("decision", superseded.id),
        );
      }

      await kv.set(KV.decisions, record.id, record);
      await upsertDecisionRetrievalBlock(kv, record);
      await recordAudit(kv, "decision_save", "mem::decision-save", [record.id], {
        project: record.project,
        branch: record.branch,
        missionId: record.missionId,
      });

      return {
        success: true,
        action: existing ? "updated" : "created",
        decisionRecord: record,
      };
    },
  );

  sdk.registerFunction("mem::decision-list", 
    async (data: {
      project?: string;
      branch?: string;
      missionId?: string;
      filePath?: string;
      concept?: string;
      activeOnly?: boolean;
      limit?: number;
    }) => {
      const decisions = await listScopedDecisions(kv, data);
      return { success: true, decisions };
    },
  );

  sdk.registerFunction("mem::decision-search", 
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
      const decisions = await listScopedDecisions(kv, {
        project: data.project,
        branch: data.branch,
        activeOnly: true,
        limit: 500,
      });
      const matches = decisions
        .map((decision) => ({
          decision,
          score: queryScore(decisionText(decision), data.query),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return {
        success: true,
        decisions: matches.map((item) => ({
          ...item.decision,
          score: Math.round(item.score * 1000) / 1000,
        })),
      };
    },
  );
}
