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
import { basename, filePathMatchesAny } from "./file-path-match.js";
import { listScopedGuardrails } from "./guardrails.js";
import { loadScopedRetrievalBlocks } from "./retrieval-block-scope-index.js";
import { upsertDossierRetrievalBlock } from "./retrieval-blocks.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .map((entry) => asNonEmptyString(entry))
      .filter((entry): entry is string => entry !== null),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceCompressedObservation(
  value: unknown,
): CompressedObservation | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id);
  const sessionId = asNonEmptyString(value.sessionId);
  const timestamp = asNonEmptyString(value.timestamp);
  const type = asNonEmptyString(value.type);
  const title = asNonEmptyString(value.title);
  const narrative = asNonEmptyString(value.narrative);
  if (!id || !sessionId || !timestamp || !type || !title || !narrative) {
    return null;
  }
  return {
    id,
    sessionId,
    timestamp,
    type: type as CompressedObservation["type"],
    title,
    subtitle: asNonEmptyString(value.subtitle) || undefined,
    facts: safeStringArray(value.facts),
    narrative,
    concepts: safeStringArray(value.concepts),
    files: safeStringArray(value.files),
    importance:
      typeof value.importance === "number" && Number.isFinite(value.importance)
        ? value.importance
        : 0,
    confidence:
      typeof value.confidence === "number" && Number.isFinite(value.confidence)
        ? value.confidence
        : undefined,
    source: asNonEmptyString(value.source) || undefined,
    payloadVersion: asNonEmptyString(value.payloadVersion) || undefined,
    eventId: asNonEmptyString(value.eventId) || undefined,
    sourceTimestamp: asNonEmptyString(value.sourceTimestamp) || undefined,
    capabilities: safeStringArray(value.capabilities),
    persistenceClass:
      value.persistenceClass === "persistent" ||
      value.persistenceClass === "ephemeral" ||
      value.persistenceClass === "diagnostics_only"
        ? value.persistenceClass
        : undefined,
    turnId: asNonEmptyString(value.turnId) || undefined,
  };
}

function coerceInsight(value: unknown): Insight | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id);
  const title = asNonEmptyString(value.title);
  const content = asNonEmptyString(value.content);
  const createdAt = asNonEmptyString(value.createdAt);
  const updatedAt = asNonEmptyString(value.updatedAt);
  if (!id || !title || !content || !createdAt || !updatedAt) {
    return null;
  }
  return {
    id,
    title,
    content,
    confidence:
      typeof value.confidence === "number" && Number.isFinite(value.confidence)
        ? value.confidence
        : 0,
    reinforcements:
      typeof value.reinforcements === "number" &&
      Number.isFinite(value.reinforcements)
        ? value.reinforcements
        : 0,
    sourceConceptCluster: safeStringArray(value.sourceConceptCluster),
    sourceMemoryIds: safeStringArray(value.sourceMemoryIds),
    sourceLessonIds: safeStringArray(value.sourceLessonIds),
    sourceCrystalIds: safeStringArray(value.sourceCrystalIds),
    project: asNonEmptyString(value.project) || undefined,
    tags: safeStringArray(value.tags),
    createdAt,
    updatedAt,
    lastReinforcedAt: asNonEmptyString(value.lastReinforcedAt) || undefined,
    lastDecayedAt: asNonEmptyString(value.lastDecayedAt) || undefined,
    decayRate:
      typeof value.decayRate === "number" && Number.isFinite(value.decayRate)
        ? value.decayRate
        : 0,
    deleted: value.deleted === true,
  };
}

function coerceLesson(value: unknown): Lesson | null {
  if (!isRecord(value)) return null;
  const id = asNonEmptyString(value.id);
  const content = asNonEmptyString(value.content);
  const context = asNonEmptyString(value.context);
  const createdAt = asNonEmptyString(value.createdAt);
  const updatedAt = asNonEmptyString(value.updatedAt);
  if (!id || !content || !context || !createdAt || !updatedAt) {
    return null;
  }
  return {
    id,
    content,
    context,
    confidence:
      typeof value.confidence === "number" && Number.isFinite(value.confidence)
        ? value.confidence
        : 0,
    reinforcements:
      typeof value.reinforcements === "number" &&
      Number.isFinite(value.reinforcements)
        ? value.reinforcements
        : 0,
    source:
      value.source === "crystal" ||
      value.source === "manual" ||
      value.source === "consolidation"
        ? value.source
        : "manual",
    sourceIds: safeStringArray(value.sourceIds),
    project: asNonEmptyString(value.project) || undefined,
    tags: safeStringArray(value.tags),
    createdAt,
    updatedAt,
    lastReinforcedAt: asNonEmptyString(value.lastReinforcedAt) || undefined,
    lastDecayedAt: asNonEmptyString(value.lastDecayedAt) || undefined,
    decayRate:
      typeof value.decayRate === "number" && Number.isFinite(value.decayRate)
        ? value.decayRate
        : 0,
    deleted: value.deleted === true,
  };
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

function expandConceptTerms(values: string[]): string[] {
  return uniqueStrings([
    ...values,
    ...values.flatMap((value) =>
      value
        .toLowerCase()
        .split(/[^a-z0-9_./:-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  ]);
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
      kv.list<unknown>(KV.observations(session.id)).catch(() => []),
    ),
  );
  return sortByUpdatedAt(
    buckets
      .flatMap((bucket) => bucket)
      .map((entry) => coerceCompressedObservation(entry))
      .filter(
        (entry): entry is CompressedObservation => entry !== null,
      ),
  );
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
        filePathMatchesAny(block.files, filePath),
    );
    const observations = await Promise.all(
      matchedBlocks.map((block) =>
        kv
          .get<unknown>(
            KV.observations(block.sessionId!),
            block.sourceId,
          )
          .catch(() => null),
      ),
    );
    const matchedObservations = sortByUpdatedAt(
      observations.filter(
        (observation): observation is unknown => observation !== null,
      )
        .map((observation) => coerceCompressedObservation(observation))
        .filter(
          (observation): observation is CompressedObservation =>
            observation !== null,
        ),
    );
    if (matchedObservations.length > 0) {
      return matchedObservations;
    }
  }

  return (await projectObservations(kv, project, branch)).filter((observation) =>
    filePathMatchesAny(safeStringArray(observation.files), filePath),
  );
}

function summaryParts(
  observations: CompressedObservation[],
  insights: Insight[],
  decisions: DecisionMemory[],
  guardrails: { explanation: string }[],
): string[] {
  return uniqueStrings([
    observations[0]?.narrative || "",
    guardrails[0]?.explanation ? `Risk: ${guardrails[0].explanation}` : "",
    decisions[0]?.decision ? `Decision: ${decisions[0].decision}` : "",
    insights[0]?.content ? `Insight: ${insights[0].content}` : "",
  ]).slice(0, 3);
}

function buildSummary(
  filePath: string,
  observations: CompressedObservation[],
  insights: Insight[],
  decisions: DecisionMemory[],
  guardrails: { explanation: string }[],
): string {
  const parts = summaryParts(observations, insights, decisions, guardrails);
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
    (await kv.list<unknown>(KV.lessons).catch(() => []))
      .map((lesson) => coerceLesson(lesson))
      .filter((lesson): lesson is Lesson => lesson !== null)
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
    (await kv.list<unknown>(KV.insights).catch(() => []))
      .map((insight) => coerceInsight(insight))
      .filter((insight): insight is Insight => insight !== null)
      .filter((insight) => !insight.deleted)
      .filter((insight) => !insight.project || insight.project === project),
  );
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
  const dossierConcepts = new Set(
    expandConceptTerms([
      ...observations.flatMap((observation) => safeStringArray(observation.concepts)),
      ...guardrails.flatMap((guardrail) => safeStringArray(guardrail.relatedConcepts)),
      ...decisions.flatMap((decision) => safeStringArray(decision.relatedConcepts)),
      basename(filePath),
    ]).map((concept) => concept.toLowerCase()),
  );
  const relatedInsights = insights.filter((insight) => {
    const text = `${insight.title} ${insight.content}`.toLowerCase();
    const inferredConcepts = expandConceptTerms([insight.title, insight.content]).map(
      (concept) => concept.toLowerCase(),
    );
    return (
      text.includes(filePath.toLowerCase()) ||
      text.includes(basename(filePath).toLowerCase()) ||
      inferredConcepts.some((concept) => dossierConcepts.has(concept)) ||
      safeStringArray(insight.sourceConceptCluster).some((concept) =>
        dossierConcepts.has(concept.toLowerCase()),
      ) ||
      safeStringArray(insight.tags).some((tag) =>
        dossierConcepts.has(tag.toLowerCase()),
      )
    );
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
    ...guardrails
      .map((guardrail) => asNonEmptyString(guardrail.explanation))
      .filter((value): value is string => value !== null),
    ...observations
      .filter((observation) => observation.type === "error")
      .slice(0, 3)
      .map((observation) => observation.narrative),
    ...overlays.flatMap((overlay) => safeStringArray(overlay.blockers)),
  ]).slice(0, 8);
  const openQuestions = uniqueStrings([
    ...guardrails.flatMap((guardrail) =>
      safeStringArray(guardrail.triggerConditions).map(
        (condition) => `How do we avoid: ${condition}?`,
      ),
    ),
    ...decisions.flatMap((decision) => safeStringArray(decision.reconsiderWhen)),
    ...overlays.flatMap((overlay) => safeStringArray(overlay.notes)),
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
