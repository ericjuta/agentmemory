import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { Action, Crystal, RoutineCandidate } from "../types.js";
import { recordAudit } from "./audit.js";

function normalizeStep(step: string): string {
  return step.toLowerCase().replace(/\s+/g, " ").trim();
}

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

export function registerRoutineCompilerFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::routine-candidates", 
    async (data: { project?: string; branch?: string; limit?: number }) => {
      const limit = Math.max(1, Math.min(data.limit || 50, 500));
      let candidates = await kv.list<RoutineCandidate>(KV.routineCandidates).catch(() => []);
      if (data.project) {
        candidates = candidates.filter((candidate) => candidate.project === data.project);
      }
      if (data.branch) {
        candidates = candidates.filter(
          (candidate) => !candidate.branch || candidate.branch === data.branch,
        );
      }
      return {
        success: true,
        routineCandidates: sortByUpdatedAt(candidates).slice(0, limit),
      };
    },
  );

  sdk.registerFunction("mem::routine-compile", 
    async (data: {
      project?: string;
      branch?: string;
      minActionCount?: number;
      minEvidenceCount?: number;
      limit?: number;
    }) => {
      const minActionCount = Math.max(2, Math.min(data.minActionCount || 2, 10));
      const minEvidenceCount = Math.max(1, Math.min(data.minEvidenceCount || 2, 20));
      const limit = Math.max(1, Math.min(data.limit || 20, 100));
      const actions = await kv.list<Action>(KV.actions).catch(() => []);
      const crystals = (await kv.list<Crystal>(KV.crystals).catch(() => []))
        .filter((crystal) => !data.project || crystal.project === data.project);
      const actionMap = new Map(actions.map((action) => [action.id, action]));
      const grouped = new Map<
        string,
        {
          project?: string;
          actionIds: Set<string>;
          stepTitles: string[];
          evidenceCount: number;
        }
      >();

      for (const crystal of crystals) {
        if ((crystal.sourceActionIds || []).length < minActionCount) continue;
        const stepTitles = crystal.sourceActionIds
          .map((actionId) => actionMap.get(actionId))
          .filter((action): action is Action => Boolean(action))
          .map((action) => action.title.trim())
          .filter(Boolean);
        if (stepTitles.length < minActionCount) continue;
        const key = stepTitles.map(normalizeStep).join(" -> ");
        const existing = grouped.get(key) || {
          project: crystal.project,
          actionIds: new Set<string>(),
          stepTitles,
          evidenceCount: 0,
        };
        crystal.sourceActionIds.forEach((actionId) => existing.actionIds.add(actionId));
        existing.evidenceCount += 1;
        grouped.set(key, existing);
      }

      const now = new Date().toISOString();
      const candidates: RoutineCandidate[] = [];
      for (const [key, group] of grouped.entries()) {
        if (group.evidenceCount < minEvidenceCount) continue;
        const id = fingerprintId("rtc", `${group.project || ""}|${data.branch || ""}|${key}`);
        const candidate: RoutineCandidate = {
          id,
          createdAt: now,
          updatedAt: now,
          project: group.project,
          branch: data.branch,
          name: group.stepTitles[0],
          description: `Proposed from ${group.evidenceCount} repeated successful chains.`,
          derivedFromActionIds: [...group.actionIds],
          stepTitles: uniqueStrings(group.stepTitles),
          evidenceCount: group.evidenceCount,
          confidence: Math.min(0.95, 0.35 + group.evidenceCount * 0.15),
          status: "proposed",
        };
        await kv.set(KV.routineCandidates, candidate.id, candidate);
        candidates.push(candidate);
      }

      await recordAudit(kv, "routine_compile", "mem::routine-compile", candidates.map((candidate) => candidate.id), {
        project: data.project,
        branch: data.branch,
        generated: candidates.length,
      });

      return {
        success: true,
        routineCandidates: sortByUpdatedAt(candidates).slice(0, limit),
      };
    },
  );
}
