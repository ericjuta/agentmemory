import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type {
  BranchOverlay,
  ComponentDossier,
  DecisionMemory,
  GuardrailMemory,
  HandoffPacket,
  Mission,
  Session,
} from "../types.js";
import { recordAudit } from "./audit.js";
import { detectWorktreeInfo, listWorktrees } from "./branch-utils.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function appendLine(existing: string, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) return existing;
  if (!existing.trim()) return trimmed;
  if (existing.includes(trimmed)) return existing;
  return `${existing}\n${trimmed}`;
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

export function registerBranchAwareFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::detect-worktree", 
    async (data: { cwd: string }) => {
      if (!data.cwd) {
        return { success: false, error: "cwd is required" };
      }

      return { success: true, ...(await detectWorktreeInfo(data.cwd)) };
    },
  );

  sdk.registerFunction("mem::list-worktrees", 
    async (data: { cwd: string }) => {
      if (!data.cwd) {
        return { success: false, error: "cwd is required" };
      }

      return { success: true, worktrees: await listWorktrees(data.cwd) };
    },
  );

  sdk.registerFunction("mem::branch-sessions", 
    async (data: { cwd: string; branch?: string }) => {
      if (!data.cwd) {
        return { success: false, error: "cwd is required" };
      }

      const worktreeInfo = await sdk.trigger<
        { cwd: string },
        {
          success: boolean;
          isWorktree: boolean;
          mainRepoRoot: string;
          branch: string | null;
        }
      >({ function_id: "mem::detect-worktree", payload: { cwd: data.cwd } });

      const projectRoot = worktreeInfo.mainRepoRoot || data.cwd;
      const branch = data.branch || worktreeInfo.branch;

      const sessions = await kv.list<Session>(KV.sessions);

      const matching = sessions.filter((s) => {
        if (s.project === projectRoot || s.cwd === projectRoot) return true;
        if (s.cwd.startsWith(projectRoot + "/")) return true;
        return false;
      });

      matching.sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );

      return {
        success: true,
        sessions: matching,
        projectRoot,
        branch,
        isWorktree: worktreeInfo.isWorktree,
      };
    },
  );

  sdk.registerFunction("mem::branch-overlay-save", 
    async (data: {
      cwd?: string;
      project?: string;
      branch?: string;
      targetType: BranchOverlay["targetType"];
      targetId: string;
      summary: string;
      blockers?: string[];
      notes?: string[];
      metadata?: Record<string, unknown>;
    }) => {
      if (!data.targetType || !data.targetId?.trim() || !data.summary?.trim()) {
        return {
          success: false,
          error: "targetType, targetId, and summary are required",
        };
      }

      const cwd = data.cwd || data.project;
      const worktreeInfo = cwd ? await detectWorktreeInfo(cwd) : null;
      const project = data.project || worktreeInfo?.mainRepoRoot || cwd;
      const branch = data.branch || worktreeInfo?.branch;
      if (!project || !branch) {
        return {
          success: false,
          error: "project and branch are required or must be inferable from cwd",
        };
      }

      return withKeyedLock(`mem:branch-overlay:${branch}:${data.targetType}:${data.targetId}`, async () => {
        const now = new Date().toISOString();
        const overlays = await kv.list<BranchOverlay>(KV.branchOverlays).catch(() => []);
        const existing = overlays.find(
          (overlay) =>
            overlay.project === project &&
            overlay.branch === branch &&
            overlay.targetType === data.targetType &&
            overlay.targetId === data.targetId &&
            overlay.status === "active",
        );

        const overlay: BranchOverlay = existing || {
          id: generateId("brx"),
          createdAt: now,
          updatedAt: now,
          project,
          branch,
          targetType: data.targetType,
          targetId: data.targetId.trim(),
          summary: data.summary.trim(),
          blockers: uniqueStrings(data.blockers || []),
          notes: uniqueStrings(data.notes || []),
          metadata: data.metadata,
          status: "active",
        };

        if (existing) {
          overlay.updatedAt = now;
          overlay.summary = data.summary.trim();
          overlay.blockers = uniqueStrings([
            ...overlay.blockers,
            ...(data.blockers || []),
          ]);
          overlay.notes = uniqueStrings([...overlay.notes, ...(data.notes || [])]);
          overlay.metadata = data.metadata || overlay.metadata;
        }

        await kv.set(KV.branchOverlays, overlay.id, overlay);
        await recordAudit(kv, "branch_overlay_save", "mem::branch-overlay-save", [overlay.id], {
          branch,
          project,
          targetType: data.targetType,
          targetId: data.targetId,
          updatedExisting: Boolean(existing),
        });

        return {
          success: true,
          action: existing ? "updated" : "created",
          overlay,
        };
      });
    },
  );

  sdk.registerFunction("mem::branch-overlays", 
    async (data: {
      project?: string;
      branch?: string;
      targetType?: BranchOverlay["targetType"];
      targetId?: string;
      status?: BranchOverlay["status"];
      limit?: number;
    }) => {
      const limit = Math.max(1, Math.min(data.limit || 100, 500));
      let overlays = await kv.list<BranchOverlay>(KV.branchOverlays).catch(() => []);
      if (data.project) {
        overlays = overlays.filter((overlay) => overlay.project === data.project);
      }
      if (data.branch) {
        overlays = overlays.filter((overlay) => overlay.branch === data.branch);
      }
      if (data.targetType) {
        overlays = overlays.filter((overlay) => overlay.targetType === data.targetType);
      }
      if (data.targetId) {
        overlays = overlays.filter((overlay) => overlay.targetId === data.targetId);
      }
      if (data.status) {
        overlays = overlays.filter((overlay) => overlay.status === data.status);
      }
      overlays = sortByUpdatedAt(overlays).slice(0, limit);
      return { success: true, overlays };
    },
  );

  sdk.registerFunction("mem::branch-overlay-promote", 
    async (data: { overlayId: string; actor?: string }) => {
      if (!data.overlayId?.trim()) {
        return { success: false, error: "overlayId is required" };
      }

      return withKeyedLock(`mem:branch-overlay-promote:${data.overlayId}`, async () => {
        const overlay = await kv.get<BranchOverlay>(KV.branchOverlays, data.overlayId);
        if (!overlay) {
          return { success: false, error: "overlay not found" };
        }
        if (overlay.status !== "active") {
          return {
            success: false,
            error: `overlay is not promotable from status ${overlay.status}`,
          };
        }

        const actor = data.actor || "system";
        const now = new Date().toISOString();
        let promotedTarget: Mission | HandoffPacket | GuardrailMemory | DecisionMemory | ComponentDossier | null =
          null;

        if (overlay.targetType === "mission") {
          const mission = await kv.get<Mission>(KV.missions, overlay.targetId);
          if (!mission) return { success: false, error: "mission target not found" };
          mission.summary = appendLine(
            mission.summary,
            `[branch ${overlay.branch}] ${overlay.summary}`,
          );
          if (overlay.blockers.length > 0 && mission.status === "active") {
            mission.status = "blocked";
          }
          mission.updatedAt = now;
          await kv.set(KV.missions, mission.id, mission);
          promotedTarget = mission;
        } else if (overlay.targetType === "handoff") {
          const packet = await kv.get<HandoffPacket>(KV.handoffPackets, overlay.targetId);
          if (!packet) return { success: false, error: "handoff target not found" };
          packet.summary = appendLine(packet.summary, `[branch ${overlay.branch}] ${overlay.summary}`);
          packet.recentChanges = uniqueStrings([
            `[branch ${overlay.branch}] ${overlay.summary}`,
            ...overlay.notes,
            ...packet.recentChanges,
          ]).slice(0, 8);
          packet.blockers = uniqueStrings([...packet.blockers, ...overlay.blockers]).slice(0, 8);
          packet.updatedAt = now;
          await kv.set(KV.handoffPackets, packet.id, packet);
          promotedTarget = packet;
        } else if (overlay.targetType === "blocker") {
          const guardrail: GuardrailMemory = {
            id: generateId("grd"),
            createdAt: now,
            updatedAt: now,
            project: overlay.project,
            scopeType: "project",
            scopeId: overlay.project,
            triggerConditions: uniqueStrings([...overlay.notes, overlay.summary]),
            riskLevel: "medium",
            explanation: overlay.summary,
            evidence: overlay.blockers,
            relatedFiles: [],
            relatedConcepts: [],
            status: "active",
            supersedes: [],
            sourceObservationIds: [],
            sourceActionIds: [],
          };
          await kv.set(KV.guardrails, guardrail.id, guardrail);
          promotedTarget = guardrail;
        } else if (overlay.targetType === "guardrail") {
          const guardrail = await kv.get<GuardrailMemory>(KV.guardrails, overlay.targetId);
          if (!guardrail) return { success: false, error: "guardrail target not found" };
          guardrail.explanation = appendLine(guardrail.explanation, overlay.summary);
          guardrail.evidence = uniqueStrings([...guardrail.evidence, ...overlay.notes]);
          guardrail.updatedAt = now;
          await kv.set(KV.guardrails, guardrail.id, guardrail);
          promotedTarget = guardrail;
        } else if (overlay.targetType === "decision") {
          const decision = await kv.get<DecisionMemory>(KV.decisions, overlay.targetId);
          if (!decision) return { success: false, error: "decision target not found" };
          decision.rationale = appendLine(decision.rationale, overlay.summary);
          decision.alternatives = uniqueStrings([...decision.alternatives, ...overlay.notes]);
          decision.updatedAt = now;
          await kv.set(KV.decisions, decision.id, decision);
          promotedTarget = decision;
        } else if (overlay.targetType === "dossier") {
          const dossier = await kv.get<ComponentDossier>(KV.componentDossiers, overlay.targetId);
          if (!dossier) return { success: false, error: "dossier target not found" };
          dossier.activeRisks = uniqueStrings([...dossier.activeRisks, ...overlay.blockers]);
          dossier.openQuestions = uniqueStrings([...dossier.openQuestions, ...overlay.notes]);
          dossier.summary = appendLine(dossier.summary, overlay.summary);
          dossier.updatedAt = now;
          dossier.lastRefreshedAt = now;
          await kv.set(KV.componentDossiers, dossier.id, dossier);
          promotedTarget = dossier;
        }

        overlay.status = "promoted";
        overlay.promotedAt = now;
        overlay.promotedBy = actor;
        overlay.updatedAt = now;
        await kv.set(KV.branchOverlays, overlay.id, overlay);
        await recordAudit(kv, "branch_overlay_promote", "mem::branch-overlay-promote", [overlay.id], {
          targetType: overlay.targetType,
          targetId: overlay.targetId,
          promotedBy: actor,
        });

        return {
          success: true,
          overlay,
          promotedTarget,
        };
      });
    },
  );
}
