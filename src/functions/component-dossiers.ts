import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type {
  BranchOverlay,
  ComponentDossier,
  CompressedObservation,
  DecisionMemory,
  Insight,
  Lesson,
  Session,
} from "../types.js";
import { recordAudit } from "./audit.js";
import { listScopedDecisions } from "./decisions.js";
import { basename, filePathMatches } from "./file-path-match.js";
import { listScopedGuardrails } from "./guardrails.js";
import { loadScopedRetrievalBlocks } from "./retrieval-block-scope-index.js";
import { upsertDossierRetrievalBlock } from "./retrieval-blocks.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sortByUpdatedAt<T extends { updatedAt?: string; createdAt?: string; timestamp?: string }>(
  items: T[],
): T[] {
  return items.slice().sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || a.timestamp || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || b.timestamp || 0).getTime();
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

async function projectObservations(
  kv: StateKV,
  project: string,
  branch?: string,
): Promise<CompressedObservation[]> {
  const sessions = (await kv.list<Session>(KV.sessions).catch(() => []))
    .filter((session) => session.project === project)
    .filter((session) => branchMatches(session, branch));
  const buckets = await Promise.all(
    sessions.map((session) =>
      kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []),
    ),
  );
  return sortByUpdatedAt(buckets.flatMap((bucket) => bucket));
}

async function relevantProjectObservations(
  kv: StateKV,
  project: string,
  filePath: string,
  branch?: string,
): Promise<CompressedObservation[]> {
  const scoped = await loadScopedRetrievalBlocks(kv, {
    project,
    branch,
  }).catch(() => ({ blocks: [], complete: false }));

  if (scoped.complete) {
    const matchedBlocks = scoped.blocks.filter(
      (block) =>
        block.sourceType === "observation" &&
        block.sessionId &&
        block.files.some((candidate) => filePathMatches(candidate, filePath)),
    );
    const observations = await Promise.all(
      matchedBlocks.map((block) =>
        kv
          .get<CompressedObservation>(
            KV.observations(block.sessionId!),
            block.sourceId,
          )
          .catch(() => null),
      ),
    );
    return sortByUpdatedAt(
      observations.filter(
        (observation): observation is CompressedObservation => observation !== null,
      ),
    );
  }

  return (await projectObservations(kv, project, branch)).filter((observation) =>
    observation.files.some((candidate) => filePathMatches(candidate, filePath)),
  );
}

function buildSummary(
  filePath: string,
  observations: CompressedObservation[],
  insights: Insight[],
  decisions: DecisionMemory[],
  guardrails: { explanation: string }[],
): string {
  const parts = uniqueStrings([
    observations[0]?.narrative || "",
    guardrails[0]?.explanation ? `Risk: ${guardrails[0].explanation}` : "",
    decisions[0]?.decision ? `Decision: ${decisions[0].decision}` : "",
    insights[0]?.content ? `Insight: ${insights[0].content}` : "",
  ]).slice(0, 3);
  if (parts.length === 0) {
    return `${basename(filePath)} has no synthesized dossier context yet.`;
  }
  return parts.join(" ");
}

export async function refreshComponentDossier(
  kv: StateKV,
  input: { project: string; filePath: string; branch?: string },
): Promise<ComponentDossier> {
  const { project, filePath, branch } = input;
  const observations = await relevantProjectObservations(kv, project, filePath, branch);
  const lessons = sortByUpdatedAt(
    (await kv.list<Lesson>(KV.lessons).catch(() => []))
      .filter((lesson) => !lesson.deleted)
      .filter((lesson) => !lesson.project || lesson.project === project),
  ).filter((lesson) => {
    const text = `${lesson.content} ${lesson.context}`.toLowerCase();
    return (
      text.includes(filePath.toLowerCase()) ||
      text.includes(basename(filePath).toLowerCase())
    );
  });
  const insights = sortByUpdatedAt(
    (await kv.list<Insight>(KV.insights).catch(() => []))
      .filter((insight) => !insight.deleted)
      .filter((insight) => !insight.project || insight.project === project),
  );
  const relatedInsights = insights.filter((insight) => {
    const text = `${insight.title} ${insight.content}`.toLowerCase();
    return (
      text.includes(filePath.toLowerCase()) ||
      text.includes(basename(filePath).toLowerCase())
    );
  });
  const guardrails = await listScopedGuardrails(kv, {
    project,
    branch,
    filePath,
    includeExpired: false,
    limit: 20,
  });
  const decisions = await listScopedDecisions(kv, {
    project,
    branch,
    filePath,
    activeOnly: true,
    limit: 20,
  });
  const overlays = sortByUpdatedAt(
    (await kv.list<BranchOverlay>(KV.branchOverlays).catch(() => []))
      .filter((overlay) => overlay.project === project)
      .filter((overlay) => branchMatches(overlay, branch))
      .filter(
        (overlay) =>
          overlay.targetType === "dossier" &&
          (overlay.targetId === filePath ||
            overlay.targetId === fingerprintId("dos", `${project}|${branch || ""}|${filePath}`)),
      ),
  );

  const now = new Date().toISOString();
  const dossierId = fingerprintId("dos", `${project}|${branch || ""}|${filePath}`);
  const existing = await kv.get<ComponentDossier>(KV.componentDossiers, dossierId).catch(() => null);
  const keyFacts = uniqueStrings([
    ...observations.slice(0, 4).map((observation) => observation.title),
    ...lessons.slice(0, 3).map((lesson) => lesson.content),
    ...relatedInsights.slice(0, 3).map((insight) => insight.title),
    ...decisions.slice(0, 3).map((decision) => decision.decision),
  ]).slice(0, 8);
  const activeRisks = uniqueStrings([
    ...guardrails.map((guardrail) => guardrail.explanation),
    ...observations
      .filter((observation) => observation.type === "error")
      .slice(0, 3)
      .map((observation) => observation.narrative),
    ...overlays.flatMap((overlay) => overlay.blockers),
  ]).slice(0, 8);
  const openQuestions = uniqueStrings([
    ...guardrails.flatMap((guardrail) =>
      guardrail.triggerConditions.map(
        (condition) => `How do we avoid: ${condition}?`,
      ),
    ),
    ...decisions.flatMap((decision) => decision.reconsiderWhen),
    ...overlays.flatMap((overlay) => overlay.notes),
  ]).slice(0, 8);

  const dossier: ComponentDossier = existing || {
    id: dossierId,
    createdAt: now,
    updatedAt: now,
    project,
    branch,
    filePath,
    summary: "",
    currentState: "",
    keyFacts: [],
    activeRisks: [],
    openQuestions: [],
    relatedLessonIds: [],
    relatedInsightIds: [],
    relatedGuardrailIds: [],
    relatedDecisionIds: [],
    sourceObservationIds: [],
    lastRefreshedAt: now,
  };

  dossier.updatedAt = now;
  dossier.branch = branch;
  dossier.summary = buildSummary(
    filePath,
    observations,
    relatedInsights,
    decisions,
    guardrails,
  );
  dossier.currentState =
    uniqueStrings([
      observations[0]?.narrative || "",
      guardrails[0]?.explanation ? `Risk: ${guardrails[0].explanation}` : "",
      decisions[0]?.rationale ? `Decision rationale: ${decisions[0].rationale}` : "",
      relatedInsights[0]?.content || "",
    ])[0] || `No recent observation state recorded for ${basename(filePath)}.`;
  dossier.keyFacts = keyFacts;
  dossier.activeRisks = activeRisks;
  dossier.openQuestions = openQuestions;
  dossier.relatedLessonIds = lessons.slice(0, 5).map((lesson) => lesson.id);
  dossier.relatedInsightIds = relatedInsights.slice(0, 5).map((insight) => insight.id);
  dossier.relatedGuardrailIds = guardrails.map((guardrail) => guardrail.id);
  dossier.relatedDecisionIds = decisions.map((decision) => decision.id);
  dossier.sourceObservationIds = uniqueStrings(observations.slice(0, 8).map((observation) => observation.id));
  dossier.lastRefreshedAt = now;

  await kv.set(KV.componentDossiers, dossier.id, dossier);
  await upsertDossierRetrievalBlock(kv, dossier);
  return dossier;
}

export function registerComponentDossiersFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::dossier-refresh", 
    async (data: { project: string; filePath: string; branch?: string }) => {
      if (!data.project?.trim() || !data.filePath?.trim()) {
        return { success: false, error: "project and filePath are required" };
      }
      const dossier = await refreshComponentDossier(kv, {
        project: data.project.trim(),
        filePath: data.filePath.trim(),
        branch: data.branch?.trim() || undefined,
      });
      await recordAudit(kv, "dossier_refresh", "mem::dossier-refresh", [dossier.id], {
        project: dossier.project,
        branch: dossier.branch,
        filePath: dossier.filePath,
      });
      return { success: true, dossier };
    },
  );

  sdk.registerFunction("mem::dossier-get", 
    async (data: {
      dossierId?: string;
      project?: string;
      filePath?: string;
      branch?: string;
      refresh?: boolean;
    }) => {
      let dossier: ComponentDossier | null = null;
      if (data.dossierId?.trim()) {
        dossier = await kv.get<ComponentDossier>(KV.componentDossiers, data.dossierId.trim()).catch(() => null);
      } else if (data.project?.trim() && data.filePath?.trim()) {
        const dossierId = fingerprintId(
          "dos",
          `${data.project.trim()}|${data.branch?.trim() || ""}|${data.filePath.trim()}`,
        );
        dossier = await kv.get<ComponentDossier>(KV.componentDossiers, dossierId).catch(() => null);
      } else {
        return {
          success: false,
          error: "dossierId or project+filePath is required",
        };
      }

      if (
        (!dossier || data.refresh) &&
        data.project?.trim() &&
        data.filePath?.trim()
      ) {
        dossier = await refreshComponentDossier(kv, {
          project: data.project.trim(),
          filePath: data.filePath.trim(),
          branch: data.branch?.trim() || undefined,
        });
      }

      if (!dossier) return { success: false, error: "dossier not found" };
      return { success: true, dossier };
    },
  );

  sdk.registerFunction("mem::dossier-list", 
    async (data: { project?: string; branch?: string; limit?: number }) => {
      const limit = Math.max(1, Math.min(data.limit || 50, 500));
      let dossiers = await kv.list<ComponentDossier>(KV.componentDossiers).catch(() => []);
      if (data.project) {
        dossiers = dossiers.filter((dossier) => dossier.project === data.project);
      }
      if (data.branch) {
        dossiers = dossiers.filter((dossier) => branchMatches(dossier, data.branch));
      }
      dossiers = sortByUpdatedAt(dossiers).slice(0, limit);
      return { success: true, dossiers };
    },
  );
}
