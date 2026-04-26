import type {
  BeliefProjection,
  BranchOverlay,
  ComponentDossier,
  CompressedObservation,
  DecisionMemory,
  GuardrailMemory,
  HandoffPacket,
  Memory,
  ProceduralMemory,
  ProjectProfile,
  RetrievalBlock,
  RetrievalBlockRetryEntry,
  RetrievalBlockSourceType,
  SemanticMemory,
  Session,
  SessionSummary,
  SessionWorkingSet,
  TurnCapsule,
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  indexRetrievalBlock,
  removeRetrievalBlock,
} from "../state/retrieval-block-indexing.js";
import { invalidateContextResultCache } from "./context-result-cache.js";
import { listProjectedBeliefs } from "./beliefs.js";
import {
  removeRetrievalBlockScopeMembership,
  upsertRetrievalBlockScopeMembership,
} from "./retrieval-block-scope-index.js";
import { logger } from "../logger.js";
import { getDerivedKvWritePauseReason } from "../health/write-gate.js";

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function retrievalBlockId(
  sourceType: RetrievalBlockSourceType,
  sourceId: string,
): string {
  return fingerprintId("rblk", `${sourceType}|${sourceId}`);
}

function normalizeImportance(value: number, fallback = 5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(10, Math.round(value)));
}

function riskImportance(risk: GuardrailMemory["riskLevel"]): number {
  switch (risk) {
    case "critical":
      return 10;
    case "high":
      return 9;
    case "medium":
      return 7;
    case "low":
      return 5;
  }
}

function textEntities(...parts: string[]): string[] {
  const tokens = parts
    .join(" ")
    .split(/[^a-zA-Z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return uniqueStrings(tokens).slice(0, 32);
}

function formatTurnCapsule(capsule: TurnCapsule, currentSession: boolean): string {
  const lines = [
    `## ${currentSession ? "Current Turn" : `Recent Turn ${capsule.turnId}`}`,
  ];
  if (capsule.userPrompt) lines.push(`User: ${capsule.userPrompt}`);
  if (capsule.assistantConclusion) lines.push(`Conclusion: ${capsule.assistantConclusion}`);
  if (capsule.files.length > 0) lines.push(`Files: ${capsule.files.slice(0, 6).join(", ")}`);
  if (capsule.concepts.length > 0) lines.push(`Concepts: ${capsule.concepts.slice(0, 8).join(", ")}`);
  const signals: string[] = [];
  if (capsule.hadFailure) signals.push("failure");
  if (capsule.hadDecision) signals.push("decision");
  if (capsule.maxImportance > 0) signals.push(`importance ${capsule.maxImportance}`);
  if (signals.length > 0) lines.push(`Signals: ${signals.join(", ")}`);
  return lines.join("\n");
}

function formatWorkingSet(workingSet: SessionWorkingSet): string | null {
  if (workingSet.latestCompletedCapsule) {
    return formatTurnCapsule(workingSet.latestCompletedCapsule, true);
  }
  const lines = ["## Current Working Set"];
  if (workingSet.latestAssistantConclusion) {
    lines.push(`Conclusion: ${workingSet.latestAssistantConclusion}`);
  }
  if (workingSet.latestImportantFiles.length > 0) {
    lines.push(`Files: ${workingSet.latestImportantFiles.slice(0, 6).join(", ")}`);
  }
  if (workingSet.latestImportantConcepts.length > 0) {
    lines.push(
      `Concepts: ${workingSet.latestImportantConcepts.slice(0, 8).join(", ")}`,
    );
  }
  const signals: string[] = [];
  if (workingSet.latestHadFailure) signals.push("failure");
  if (workingSet.latestHadDecision) signals.push("decision");
  if (signals.length > 0) lines.push(`Signals: ${signals.join(", ")}`);
  return lines.length > 1 ? lines.join("\n") : null;
}

function formatSummary(summary: SessionSummary): string {
  return `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
}

function formatObservation(
  observation: CompressedObservation,
  currentSession: boolean,
): string {
  const lines = [
    `## ${currentSession ? "Current Session Observation" : "Recent Observation"}`,
    `- [${observation.type}] ${observation.title}: ${observation.narrative}`,
  ];
  if (observation.facts.length > 0) {
    lines.push(`Facts: ${observation.facts.slice(0, 4).join(" | ")}`);
  }
  if (observation.files.length > 0) {
    lines.push(`Files: ${observation.files.slice(0, 6).join(", ")}`);
  }
  if (observation.concepts.length > 0) {
    lines.push(`Concepts: ${observation.concepts.slice(0, 8).join(", ")}`);
  }
  return lines.join("\n");
}

function formatMemory(memory: Memory): string {
  const lines = [
    `## ${memory.type.charAt(0).toUpperCase() + memory.type.slice(1)} Memory: ${memory.title}`,
    memory.content,
  ];
  if (memory.files.length > 0) {
    lines.push(`Files: ${memory.files.slice(0, 5).join(", ")}`);
  }
  if (memory.concepts.length > 0) {
    lines.push(`Concepts: ${memory.concepts.slice(0, 6).join(", ")}`);
  }
  return lines.join("\n");
}

function formatSemantic(memory: SemanticMemory): string {
  return `## Semantic Memory\n- ${memory.fact}`;
}

function formatProcedural(memory: ProceduralMemory): string {
  return `## Procedural Memory\nName: ${memory.name}\nTrigger: ${memory.triggerCondition}\nSteps: ${memory.steps.slice(0, 4).join(" -> ")}`;
}

function formatHandoffPacket(packet: HandoffPacket): string {
  const lines = ["## Resume Handoff Packet"];
  lines.push(`Scope: ${packet.scopeType} ${packet.scopeId}`);
  lines.push(`Summary: ${packet.summary}`);
  if (packet.recentChanges.length > 0) {
    lines.push(`Recent changes: ${packet.recentChanges.slice(0, 4).join(" | ")}`);
  }
  if (packet.blockers.length > 0) {
    lines.push(`Blockers: ${packet.blockers.slice(0, 4).join(" | ")}`);
  }
  if (packet.openQuestions.length > 0) {
    lines.push(`Open questions: ${packet.openQuestions.slice(0, 3).join(" | ")}`);
  }
  if (packet.recommendedNextStep) {
    lines.push(`Recommended next step: ${packet.recommendedNextStep}`);
  }
  if (packet.relevantFiles.length > 0) {
    lines.push(`Files: ${packet.relevantFiles.slice(0, 6).join(", ")}`);
  }
  if (packet.relevantConcepts.length > 0) {
    lines.push(`Concepts: ${packet.relevantConcepts.slice(0, 8).join(", ")}`);
  }
  if (packet.knownFacts.length > 0) {
    lines.push(`Known facts: ${packet.knownFacts.slice(0, 4).join(" | ")}`);
  }
  lines.push(`Confidence: ${packet.confidence.toFixed(2)}`);
  return lines.join("\n");
}

function formatBranchOverlay(overlay: BranchOverlay): string {
  const lines = ["## Branch Overlay"];
  lines.push(`Branch: ${overlay.branch}`);
  lines.push(`Target: ${overlay.targetType} ${overlay.targetId}`);
  lines.push(`Summary: ${overlay.summary}`);
  if (overlay.blockers.length > 0) {
    lines.push(`Blockers: ${overlay.blockers.slice(0, 4).join(" | ")}`);
  }
  if (overlay.notes.length > 0) {
    lines.push(`Notes: ${overlay.notes.slice(0, 4).join(" | ")}`);
  }
  return lines.join("\n");
}

function formatBelief(projection: BeliefProjection): string {
  const lines = ["## Current Belief", projection.claim];
  lines.push(
    `Status: ${projection.status} (confidence ${projection.confidence.toFixed(2)})`,
  );
  lines.push(
    `Evidence: ${projection.supportCount} support / ${projection.contradictionCount} contradiction`,
  );
  if (projection.files.length > 0) {
    lines.push(`Files: ${projection.files.slice(0, 5).join(", ")}`);
  }
  if (projection.concepts.length > 0) {
    lines.push(`Concepts: ${projection.concepts.slice(0, 8).join(", ")}`);
  }
  return lines.join("\n");
}

function formatGuardrail(guardrail: GuardrailMemory): string {
  const lines = ["## Guardrail"];
  lines.push(`Risk: ${guardrail.riskLevel}`);
  lines.push(`Scope: ${guardrail.scopeType} ${guardrail.scopeId}`);
  lines.push(`Explanation: ${guardrail.explanation}`);
  if (guardrail.triggerConditions.length > 0) {
    lines.push(`Triggers: ${guardrail.triggerConditions.slice(0, 4).join(" | ")}`);
  }
  if (guardrail.evidence.length > 0) {
    lines.push(`Evidence: ${guardrail.evidence.slice(0, 4).join(" | ")}`);
  }
  if (guardrail.relatedFiles.length > 0) {
    lines.push(`Files: ${guardrail.relatedFiles.slice(0, 5).join(", ")}`);
  }
  if (guardrail.relatedConcepts.length > 0) {
    lines.push(`Concepts: ${guardrail.relatedConcepts.slice(0, 6).join(", ")}`);
  }
  return lines.join("\n");
}

function formatDecision(decision: DecisionMemory): string {
  const lines = ["## Decision Memory"];
  lines.push(`Title: ${decision.title}`);
  lines.push(`Decision: ${decision.decision}`);
  lines.push(`Rationale: ${decision.rationale}`);
  if (decision.alternatives.length > 0) {
    lines.push(`Alternatives: ${decision.alternatives.slice(0, 4).join(" | ")}`);
  }
  if (decision.reconsiderWhen.length > 0) {
    lines.push(`Reconsider when: ${decision.reconsiderWhen.slice(0, 4).join(" | ")}`);
  }
  if (decision.relatedFiles.length > 0) {
    lines.push(`Files: ${decision.relatedFiles.slice(0, 5).join(", ")}`);
  }
  if (decision.relatedConcepts.length > 0) {
    lines.push(`Concepts: ${decision.relatedConcepts.slice(0, 6).join(", ")}`);
  }
  return lines.join("\n");
}

function formatDossier(dossier: ComponentDossier): string {
  const lines = ["## Component Dossier"];
  lines.push(`File: ${dossier.filePath}`);
  lines.push(`Summary: ${dossier.summary}`);
  lines.push(`Current state: ${dossier.currentState}`);
  if (dossier.keyFacts.length > 0) {
    lines.push(`Key facts: ${dossier.keyFacts.slice(0, 4).join(" | ")}`);
  }
  if (dossier.activeRisks.length > 0) {
    lines.push(`Active risks: ${dossier.activeRisks.slice(0, 4).join(" | ")}`);
  }
  if (dossier.openQuestions.length > 0) {
    lines.push(`Open questions: ${dossier.openQuestions.slice(0, 4).join(" | ")}`);
  }
  return lines.join("\n");
}

function formatProfile(profile: ProjectProfile): string | null {
  const lines: string[] = ["## Project Profile"];
  if (profile.topConcepts.length > 0) {
    lines.push(`Concepts: ${profile.topConcepts.slice(0, 8).map((item) => item.concept).join(", ")}`);
  }
  if (profile.topFiles.length > 0) {
    lines.push(`Key files: ${profile.topFiles.slice(0, 5).map((item) => item.file).join(", ")}`);
  }
  if (profile.conventions.length > 0) {
    lines.push(`Conventions: ${profile.conventions.join("; ")}`);
  }
  if (profile.commonErrors.length > 0) {
    lines.push(`Common errors: ${profile.commonErrors.slice(0, 4).join("; ")}`);
  }
  if (profile.recentActivity.length > 0) {
    lines.push(`Recent activity: ${profile.recentActivity.slice(0, 4).join("; ")}`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

function blockEntities(files: string[], concepts: string[], text: string): string[] {
  return uniqueStrings([
    ...files,
    ...files.map((filePath) => basename(filePath)),
    ...concepts,
    ...textEntities(text),
  ]).slice(0, 32);
}

export function buildTurnCapsuleRetrievalBlock(capsule: TurnCapsule): RetrievalBlock {
  const canonicalText = formatTurnCapsule(capsule, false);
  return {
    id: retrievalBlockId("turn_capsule", capsule.id),
    sourceType: "turn_capsule",
    sourceId: capsule.id,
    project: capsule.project,
    sessionId: capsule.sessionId,
    turnId: capsule.turnId,
    scope: "session",
    freshnessLane: "hot",
    canonicalText,
    title: capsule.assistantConclusion || capsule.userPrompt || `Turn ${capsule.turnId}`,
    files: capsule.files.slice(0, 12),
    concepts: capsule.concepts.slice(0, 16),
    entities: blockEntities(capsule.files, capsule.concepts, canonicalText),
    sourceObservationIds: capsule.sourceObservationIds,
    hadFailure: capsule.hadFailure,
    hadDecision: capsule.hadDecision,
    hadAssistantConclusion: Boolean(capsule.assistantConclusion),
    isResumeArtifact: true,
    importance: normalizeImportance(capsule.maxImportance || 7, 7),
    createdAt: capsule.createdAt,
    updatedAt: capsule.updatedAt,
    eventAt: capsule.updatedAt,
  };
}

export function buildWorkingSetRetrievalBlock(
  workingSet: SessionWorkingSet,
): RetrievalBlock | null {
  const canonicalText = formatWorkingSet(workingSet);
  if (!canonicalText) return null;
  return {
    id: retrievalBlockId("working_set", workingSet.sessionId),
    sourceType: "working_set",
    sourceId: workingSet.sessionId,
    project: workingSet.project,
    sessionId: workingSet.sessionId,
    turnId: workingSet.latestCompletedTurnId || workingSet.latestTurnId,
    scope: "session",
    freshnessLane: "hot",
    canonicalText,
    title: `Working set ${workingSet.sessionId}`,
    files: workingSet.latestImportantFiles.slice(0, 12),
    concepts: workingSet.latestImportantConcepts.slice(0, 16),
    entities: blockEntities(
      workingSet.latestImportantFiles,
      workingSet.latestImportantConcepts,
      canonicalText,
    ),
    sourceObservationIds: workingSet.latestImportantObservationIds,
    hadFailure: workingSet.latestHadFailure,
    hadDecision: workingSet.latestHadDecision,
    hadAssistantConclusion: Boolean(workingSet.latestAssistantConclusion),
    isResumeArtifact: true,
    importance: normalizeImportance(
      workingSet.latestCompletedCapsule?.maxImportance || 8,
      8,
    ),
    createdAt: workingSet.updatedAt,
    updatedAt: workingSet.updatedAt,
    eventAt: workingSet.updatedAt,
  };
}

export function buildSessionSummaryRetrievalBlock(summary: SessionSummary): RetrievalBlock {
  const canonicalText = formatSummary(summary);
  return {
    id: retrievalBlockId("session_summary", summary.sessionId),
    sourceType: "session_summary",
    sourceId: summary.sessionId,
    project: summary.project,
    sessionId: summary.sessionId,
    scope: "session",
    freshnessLane: "cold",
    canonicalText,
    title: summary.title,
    files: summary.filesModified.slice(0, 12),
    concepts: summary.concepts.slice(0, 16),
    entities: blockEntities(summary.filesModified, summary.concepts, canonicalText),
    sourceObservationIds: [],
    hadFailure: false,
    hadDecision: summary.keyDecisions.length > 0,
    hadAssistantConclusion: true,
    isResumeArtifact: true,
    importance: 7,
    createdAt: summary.createdAt,
    updatedAt: summary.createdAt,
    eventAt: summary.createdAt,
  };
}

export function buildObservationRetrievalBlock(
  observation: CompressedObservation,
  project: string,
): RetrievalBlock {
  const canonicalText = formatObservation(observation, false);
  return {
    id: retrievalBlockId("observation", observation.id),
    sourceType: "observation",
    sourceId: observation.id,
    project,
    sessionId: observation.sessionId,
    turnId: observation.turnId,
    scope: "project",
    freshnessLane: "warm",
    canonicalText,
    title: observation.title,
    files: observation.files.slice(0, 12),
    concepts: observation.concepts.slice(0, 16),
    entities: blockEntities(observation.files, observation.concepts, canonicalText),
    sourceObservationIds: [observation.id],
    hadFailure: observation.type === "error",
    hadDecision: observation.type === "decision",
    hadAssistantConclusion: false,
    isResumeArtifact: false,
    importance: normalizeImportance(observation.importance, 5),
    createdAt: observation.timestamp,
    updatedAt: observation.timestamp,
    eventAt: observation.timestamp,
  };
}

function shouldIndexObservation(observation: CompressedObservation): boolean {
  return (
    observation.importance >= 6 ||
    observation.type === "error" ||
    observation.type === "decision" ||
    ((observation.type === "file_edit" ||
      observation.type === "file_write" ||
      observation.type === "command_run" ||
      observation.type === "search" ||
      observation.type === "web_fetch" ||
      observation.type === "subagent") &&
      (observation.files.length > 0 ||
        observation.concepts.length > 0 ||
        observation.facts.length > 0))
  );
}

export function buildMemoryRetrievalBlock(memory: Memory): RetrievalBlock {
  const canonicalText = formatMemory(memory);
  return {
    id: retrievalBlockId("memory", memory.id),
    sourceType: "memory",
    sourceId: memory.id,
    project: memory.project || "global",
    branch: memory.branch,
    scope: memory.branch ? "branch" : memory.project ? "project" : "global",
    freshnessLane: "cold",
    canonicalText,
    title: memory.title,
    files: memory.files.slice(0, 12),
    concepts: memory.concepts.slice(0, 16),
    entities: blockEntities(memory.files, memory.concepts, canonicalText),
    sourceObservationIds: memory.sourceObservationIds || [],
    hadFailure: memory.type === "bug",
    hadDecision: memory.type === "architecture",
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: normalizeImportance(memory.strength, 7),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    eventAt: memory.updatedAt,
  };
}

export function buildSemanticRetrievalBlock(memory: SemanticMemory): RetrievalBlock {
  const canonicalText = formatSemantic(memory);
  const project = memory.project || "global";
  return {
    id: retrievalBlockId("semantic_memory", memory.id),
    sourceType: "semantic_memory",
    sourceId: memory.id,
    project,
    scope: memory.project ? "project" : "global",
    freshnessLane: "cold",
    canonicalText,
    title: memory.fact.slice(0, 80),
    files: [],
    concepts: [],
    entities: blockEntities([], [], canonicalText),
    sourceObservationIds: memory.sourceObservationIds || [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: normalizeImportance(memory.confidence * 10, 6),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    eventAt: memory.updatedAt,
  };
}

export function buildProceduralRetrievalBlock(memory: ProceduralMemory): RetrievalBlock {
  const canonicalText = formatProcedural(memory);
  const project = memory.project || "global";
  return {
    id: retrievalBlockId("procedural_memory", memory.id),
    sourceType: "procedural_memory",
    sourceId: memory.id,
    project,
    scope: memory.project ? "project" : "global",
    freshnessLane: "cold",
    canonicalText,
    title: memory.name,
    files: [],
    concepts: (memory.concepts || []).slice(0, 16),
    entities: blockEntities([], memory.concepts || [], canonicalText),
    sourceObservationIds: memory.sourceObservationIds || [],
    hadFailure: false,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: normalizeImportance(memory.strength * 10, 6),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    eventAt: memory.updatedAt,
  };
}

export function buildGuardrailRetrievalBlock(guardrail: GuardrailMemory): RetrievalBlock {
  const canonicalText = formatGuardrail(guardrail);
  return {
    id: retrievalBlockId("guardrail", guardrail.id),
    sourceType: "guardrail",
    sourceId: guardrail.id,
    project: guardrail.project || "global",
    branch: guardrail.branch,
    scope: guardrail.branch ? "branch" : "project",
    freshnessLane: "warm",
    canonicalText,
    title: guardrail.explanation.slice(0, 80),
    files: guardrail.relatedFiles.slice(0, 12),
    concepts: guardrail.relatedConcepts.slice(0, 16),
    entities: blockEntities(guardrail.relatedFiles, guardrail.relatedConcepts, canonicalText),
    sourceObservationIds: guardrail.sourceObservationIds,
    hadFailure: true,
    hadDecision: false,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: riskImportance(guardrail.riskLevel),
    createdAt: guardrail.createdAt,
    updatedAt: guardrail.updatedAt,
    eventAt: guardrail.updatedAt,
  };
}

export function buildBeliefRetrievalBlock(projection: BeliefProjection): RetrievalBlock {
  const canonicalText = formatBelief(projection);
  return {
    id: retrievalBlockId("belief", projection.beliefId),
    sourceType: "belief",
    sourceId: projection.beliefId,
    project: projection.files[0]?.startsWith("/") ? projection.files[0] : "global",
    scope: "project",
    freshnessLane: "warm",
    canonicalText,
    title: projection.claim.slice(0, 100),
    files: projection.files.slice(0, 12),
    concepts: projection.concepts.slice(0, 16),
    entities: blockEntities(projection.files, projection.concepts, canonicalText),
    sourceObservationIds: [],
    hadFailure: projection.contradictionCount > 0,
    hadDecision: true,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: normalizeImportance(projection.confidence * 10, 7),
    createdAt: projection.updatedAt,
    updatedAt: projection.updatedAt,
    eventAt: projection.updatedAt,
  };
}

export function buildDecisionRetrievalBlock(decision: DecisionMemory): RetrievalBlock {
  const canonicalText = formatDecision(decision);
  return {
    id: retrievalBlockId("decision", decision.id),
    sourceType: "decision",
    sourceId: decision.id,
    project: decision.project || "global",
    branch: decision.branch,
    scope: decision.branch ? "branch" : "project",
    freshnessLane: "warm",
    canonicalText,
    title: decision.title,
    files: decision.relatedFiles.slice(0, 12),
    concepts: decision.relatedConcepts.slice(0, 16),
    entities: blockEntities(decision.relatedFiles, decision.relatedConcepts, canonicalText),
    sourceObservationIds: decision.sourceObservationIds,
    hadFailure: false,
    hadDecision: true,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 8,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
    eventAt: decision.updatedAt,
  };
}

export function buildDossierRetrievalBlock(dossier: ComponentDossier): RetrievalBlock {
  const canonicalText = formatDossier(dossier);
  return {
    id: retrievalBlockId("dossier", dossier.id),
    sourceType: "dossier",
    sourceId: dossier.id,
    project: dossier.project,
    branch: dossier.branch,
    scope: dossier.branch ? "branch" : "project",
    freshnessLane: "warm",
    canonicalText,
    title: basename(dossier.filePath),
    files: [dossier.filePath],
    concepts: [],
    entities: blockEntities([dossier.filePath], [], canonicalText),
    sourceObservationIds: dossier.sourceObservationIds,
    hadFailure: dossier.activeRisks.length > 0,
    hadDecision: dossier.relatedDecisionIds.length > 0,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 7,
    createdAt: dossier.createdAt,
    updatedAt: dossier.updatedAt,
    eventAt: dossier.updatedAt,
  };
}

export function buildHandoffRetrievalBlock(packet: HandoffPacket): RetrievalBlock {
  const canonicalText = formatHandoffPacket(packet);
  return {
    id: retrievalBlockId("handoff", packet.id),
    sourceType: "handoff",
    sourceId: packet.id,
    project: packet.project,
    sessionId: packet.scopeType === "session" ? packet.scopeId : undefined,
    scope: packet.scopeType === "session" ? "session" : "project",
    freshnessLane: packet.scopeType === "session" ? "hot" : "warm",
    canonicalText,
    title: packet.summary.slice(0, 100),
    files: packet.relevantFiles.slice(0, 12),
    concepts: packet.relevantConcepts.slice(0, 16),
    entities: blockEntities(packet.relevantFiles, packet.relevantConcepts, canonicalText),
    sourceObservationIds: packet.sourceObservationIds,
    hadFailure: packet.blockers.length > 0,
    hadDecision: packet.knownFacts.length > 0,
    hadAssistantConclusion: true,
    isResumeArtifact: true,
    importance: packet.scopeType === "session" ? 9 : 8,
    createdAt: packet.createdAt,
    updatedAt: packet.updatedAt,
    eventAt: packet.updatedAt,
  };
}

export function buildBranchOverlayRetrievalBlock(overlay: BranchOverlay): RetrievalBlock {
  const canonicalText = formatBranchOverlay(overlay);
  return {
    id: retrievalBlockId("branch_overlay", overlay.id),
    sourceType: "branch_overlay",
    sourceId: overlay.id,
    project: overlay.project,
    branch: overlay.branch,
    scope: "branch",
    freshnessLane: "warm",
    canonicalText,
    title: `${overlay.branch} ${overlay.targetType}`,
    files: [],
    concepts: [],
    entities: blockEntities([], [], canonicalText),
    sourceObservationIds: [],
    hadFailure: overlay.blockers.length > 0,
    hadDecision: overlay.targetType === "decision",
    hadAssistantConclusion: true,
    isResumeArtifact: overlay.targetType === "handoff",
    importance: 6,
    createdAt: overlay.createdAt,
    updatedAt: overlay.updatedAt,
    eventAt: overlay.updatedAt,
  };
}

export function buildProfileRetrievalBlock(profile: ProjectProfile): RetrievalBlock | null {
  const canonicalText = formatProfile(profile);
  if (!canonicalText) return null;
  return {
    id: retrievalBlockId("profile", profile.project),
    sourceType: "profile",
    sourceId: profile.project,
    project: profile.project,
    scope: "project",
    freshnessLane: "cold",
    canonicalText,
    title: `Profile ${profile.project}`,
    files: profile.topFiles.map((item) => item.file).slice(0, 12),
    concepts: profile.topConcepts.map((item) => item.concept).slice(0, 16),
    entities: blockEntities(
      profile.topFiles.map((item) => item.file),
      profile.topConcepts.map((item) => item.concept),
      canonicalText,
    ),
    sourceObservationIds: [],
    hadFailure: profile.commonErrors.length > 0,
    hadDecision: profile.conventions.length > 0,
    hadAssistantConclusion: true,
    isResumeArtifact: false,
    importance: 5,
    createdAt: profile.updatedAt,
    updatedAt: profile.updatedAt,
    eventAt: profile.updatedAt,
  };
}

async function queueRetrievalBlockUpsert(
  kv: StateKV,
  block: RetrievalBlock,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await kv
    .get<RetrievalBlockRetryEntry>(KV.retrievalBlockRetry, block.id)
    .catch(() => null);
  await kv
    .set(KV.retrievalBlockRetry, block.id, {
      blockId: block.id,
      sourceType: block.sourceType,
      operation: "upsert",
      block,
      retries: existing?.retries ?? 0,
      firstFailedAt: existing?.firstFailedAt ?? now,
      lastFailedAt: now,
      nextAttemptAt: existing?.nextAttemptAt,
      lastError: reason,
    } satisfies RetrievalBlockRetryEntry)
    .catch((err) => {
      logger.warn("Failed to queue retrieval block upsert", {
        blockId: block.id,
        sourceType: block.sourceType,
        error: err instanceof Error ? err.message : String(err),
        originalError: reason,
      });
    });
}

export async function upsertRetrievalBlock(
  kv: StateKV,
  block: RetrievalBlock,
): Promise<RetrievalBlock> {
  const pauseReason = await getDerivedKvWritePauseReason(kv);
  if (pauseReason) {
    await queueRetrievalBlockUpsert(kv, block, pauseReason);
    logger.warn("Retrieval block upsert deferred while health is unhealthy", {
      blockId: block.id,
      sourceType: block.sourceType,
      reason: pauseReason,
    });
    return block;
  }
  const previous = await kv.get<RetrievalBlock>(KV.retrievalBlocks, block.id).catch(() => null);
  await kv.set(KV.retrievalBlocks, block.id, block);
  await upsertRetrievalBlockScopeMembership(kv, block, previous);
  await indexRetrievalBlock(kv, block);
  invalidateContextResultCache();
  return block;
}

export async function deleteStoredRetrievalBlock(
  kv: StateKV,
  blockId: string,
  options?: { block?: RetrievalBlock | null; scheduleSave?: boolean },
): Promise<void> {
  const block =
    options?.block === undefined
      ? await kv.get<RetrievalBlock>(KV.retrievalBlocks, blockId).catch(() => null)
      : options.block;
  await kv.delete(KV.retrievalBlocks, blockId).catch(() => {});
  if (block) {
    await removeRetrievalBlockScopeMembership(kv, block).catch(() => {});
  }
  await removeRetrievalBlock(kv, blockId, { scheduleSave: options?.scheduleSave }).catch(
    () => {},
  );
  invalidateContextResultCache();
}

export async function upsertTurnCapsuleRetrievalBlock(
  kv: StateKV,
  capsule: TurnCapsule,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildTurnCapsuleRetrievalBlock(capsule));
}

export async function upsertWorkingSetRetrievalBlock(
  kv: StateKV,
  workingSet: SessionWorkingSet,
): Promise<RetrievalBlock | null> {
  const block = buildWorkingSetRetrievalBlock(workingSet);
  if (!block) return null;
  return upsertRetrievalBlock(kv, block);
}

export async function upsertSummaryRetrievalBlock(
  kv: StateKV,
  summary: SessionSummary,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildSessionSummaryRetrievalBlock(summary));
}

export async function upsertMemoryRetrievalBlock(
  kv: StateKV,
  memory: Memory,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildMemoryRetrievalBlock(memory));
}

export async function upsertObservationRetrievalBlock(
  kv: StateKV,
  observation: CompressedObservation,
  project: string,
): Promise<RetrievalBlock | null> {
  if (!shouldIndexObservation(observation)) return null;
  return upsertRetrievalBlock(kv, buildObservationRetrievalBlock(observation, project));
}

export async function upsertSemanticRetrievalBlock(
  kv: StateKV,
  memory: SemanticMemory,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildSemanticRetrievalBlock(memory));
}

export async function upsertProceduralRetrievalBlock(
  kv: StateKV,
  memory: ProceduralMemory,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildProceduralRetrievalBlock(memory));
}

export async function upsertGuardrailRetrievalBlock(
  kv: StateKV,
  guardrail: GuardrailMemory,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildGuardrailRetrievalBlock(guardrail));
}

export async function upsertDecisionRetrievalBlock(
  kv: StateKV,
  decision: DecisionMemory,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildDecisionRetrievalBlock(decision));
}

export async function upsertDossierRetrievalBlock(
  kv: StateKV,
  dossier: ComponentDossier,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildDossierRetrievalBlock(dossier));
}

export async function upsertHandoffRetrievalBlock(
  kv: StateKV,
  packet: HandoffPacket,
): Promise<RetrievalBlock> {
  return upsertRetrievalBlock(kv, buildHandoffRetrievalBlock(packet));
}

export async function upsertProfileRetrievalBlock(
  kv: StateKV,
  profile: ProjectProfile,
): Promise<RetrievalBlock | null> {
  const block = buildProfileRetrievalBlock(profile);
  if (!block) return null;
  return upsertRetrievalBlock(kv, block);
}

function retrievalBlockEquals(a: RetrievalBlock, b: RetrievalBlock): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runSequentially<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    await worker(item);
  }
}

export async function collectRetrievalBlocksFromState(
  kv: StateKV,
): Promise<RetrievalBlock[]> {
  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  const turnCapsules = await kv.list<TurnCapsule>(KV.turnCapsules).catch(() => []);
  const workingSets = await kv.list<SessionWorkingSet>(KV.workingSets).catch(() => []);
  const summaries = await kv.list<SessionSummary>(KV.summaries).catch(() => []);
  const memories = await kv.list<Memory>(KV.memories).catch(() => []);
  const semantic = await kv.list<SemanticMemory>(KV.semantic).catch(() => []);
  const procedural = await kv.list<ProceduralMemory>(KV.procedural).catch(() => []);
  const handoffs = await kv.list<HandoffPacket>(KV.handoffPackets).catch(() => []);
  const branchOverlays = await kv.list<BranchOverlay>(KV.branchOverlays).catch(() => []);
  const guardrails = await kv.list<GuardrailMemory>(KV.guardrails).catch(() => []);
  const decisions = await kv.list<DecisionMemory>(KV.decisions).catch(() => []);
  const dossiers = await kv.list<ComponentDossier>(KV.componentDossiers).catch(() => []);
  const profiles = await kv.list<ProjectProfile>(KV.profiles).catch(() => []);
  const beliefProjects = uniqueStrings([
    ...sessions.map((session) => session.project),
    ...profiles.map((profile) => profile.project),
    ...guardrails.map((guardrail) => guardrail.project),
    ...decisions.map((decision) => decision.project),
    ...dossiers.map((dossier) => dossier.project),
    ...handoffs.map((handoff) => handoff.project),
  ]);

  const blocks = new Map<string, RetrievalBlock>();
  const put = (block: RetrievalBlock | null) => {
    if (block) blocks.set(block.id, block);
  };

  for (const capsule of turnCapsules) put(buildTurnCapsuleRetrievalBlock(capsule));
  for (const workingSet of workingSets) put(buildWorkingSetRetrievalBlock(workingSet));
  for (const summary of summaries) put(buildSessionSummaryRetrievalBlock(summary));
  for (const memory of memories.filter((item) => item.isLatest)) put(buildMemoryRetrievalBlock(memory));
  for (const item of semantic) put(buildSemanticRetrievalBlock(item));
  for (const item of procedural) put(buildProceduralRetrievalBlock(item));
  for (const packet of handoffs) put(buildHandoffRetrievalBlock(packet));
  for (const overlay of branchOverlays.filter((item) => item.status === "active")) {
    put(buildBranchOverlayRetrievalBlock(overlay));
  }
  for (const guardrail of guardrails.filter((item) => item.status === "active")) {
    put(buildGuardrailRetrievalBlock(guardrail));
  }
  for (const decision of decisions.filter((item) => item.status === "active")) {
    put(buildDecisionRetrievalBlock(decision));
  }
  for (const dossier of dossiers) put(buildDossierRetrievalBlock(dossier));
  for (const profile of profiles) put(buildProfileRetrievalBlock(profile));
  for (const project of beliefProjects) {
    const beliefs = await listProjectedBeliefs(kv, project).catch(() => []);
    for (const belief of beliefs.filter((item) => item.status === "active")) {
      const block = buildBeliefRetrievalBlock(belief);
      block.project = project;
      put(block);
    }
  }

  for (const session of sessions) {
    const observations = await kv
      .list<CompressedObservation>(KV.observations(session.id))
      .catch(() => []);
    for (const observation of observations) {
      if (shouldIndexObservation(observation)) {
        put(buildObservationRetrievalBlock(observation, session.project));
      }
    }
  }

  return [...blocks.values()];
}

export async function collectLightweightRetrievalBlocksFromState(
  kv: StateKV,
  options?: {
    project?: string;
    sessionId?: string;
    sessionLimit?: number;
    deriveBeliefs?: boolean;
  },
): Promise<RetrievalBlock[]> {
  const [
    sessions,
    turnCapsules,
    workingSets,
    summaries,
    memories,
    semantic,
    procedural,
    handoffs,
    branchOverlays,
    guardrails,
    decisions,
    dossiers,
    profiles,
  ] = await Promise.all([
    kv.list<Session>(KV.sessions).catch(() => []),
    kv.list<TurnCapsule>(KV.turnCapsules).catch(() => []),
    kv.list<SessionWorkingSet>(KV.workingSets).catch(() => []),
    kv.list<SessionSummary>(KV.summaries).catch(() => []),
    kv.list<Memory>(KV.memories).catch(() => []),
    kv.list<SemanticMemory>(KV.semantic).catch(() => []),
    kv.list<ProceduralMemory>(KV.procedural).catch(() => []),
    kv.list<HandoffPacket>(KV.handoffPackets).catch(() => []),
    kv.list<BranchOverlay>(KV.branchOverlays).catch(() => []),
    kv.list<GuardrailMemory>(KV.guardrails).catch(() => []),
    kv.list<DecisionMemory>(KV.decisions).catch(() => []),
    kv.list<ComponentDossier>(KV.componentDossiers).catch(() => []),
    kv.list<ProjectProfile>(KV.profiles).catch(() => []),
  ]);
  const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
  const resolvedProject =
    options?.project ||
    (options?.sessionId ? sessionById.get(options.sessionId)?.project : undefined);
  const observationSessionLimit = options?.sessionId
    ? 8
    : typeof options?.sessionLimit === "number" &&
        Number.isFinite(options.sessionLimit) &&
        options.sessionLimit >= 0
      ? Math.floor(options.sessionLimit)
      : resolvedProject
        ? 4
        : 0;
  const sessionsForObservations = sessions
    .filter((session) => {
      if (options?.sessionId && session.id === options.sessionId) return true;
      if (resolvedProject) return session.project === resolvedProject;
      return observationSessionLimit > 0;
    })
    .sort((a, b) => {
      const aCurrent = Number(a.id === options?.sessionId);
      const bCurrent = Number(b.id === options?.sessionId);
      if (bCurrent !== aCurrent) return bCurrent - aCurrent;
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    })
    .slice(0, observationSessionLimit);

  const blocks = new Map<string, RetrievalBlock>();
  const put = (block: RetrievalBlock | null) => {
    if (!block) return;
    if (
      resolvedProject &&
      block.project !== resolvedProject &&
      block.project !== "global"
    ) {
      return;
    }
    blocks.set(block.id, block);
  };

  const matchesProject = (project?: string) => {
    if (!resolvedProject) return true;
    return project === resolvedProject;
  };

  const beliefProjects = resolvedProject
    ? [resolvedProject]
    : uniqueStrings([
        ...sessions.map((session) => session.project),
        ...profiles.map((profile) => profile.project),
        ...guardrails
          .map((guardrail) => guardrail.project)
          .filter((project): project is string => Boolean(project)),
        ...decisions
          .map((decision) => decision.project)
          .filter((project): project is string => Boolean(project)),
        ...dossiers.map((dossier) => dossier.project),
        ...handoffs.map((handoff) => handoff.project),
      ]);

  for (const capsule of turnCapsules) {
    if (
      options?.sessionId &&
      capsule.sessionId === options.sessionId
    ) {
      put(buildTurnCapsuleRetrievalBlock(capsule));
      continue;
    }
    if (matchesProject(capsule.project)) {
      put(buildTurnCapsuleRetrievalBlock(capsule));
    }
  }
  for (const workingSet of workingSets) {
    if (
      options?.sessionId &&
      workingSet.sessionId === options.sessionId
    ) {
      put(buildWorkingSetRetrievalBlock(workingSet));
      continue;
    }
    if (matchesProject(workingSet.project)) {
      put(buildWorkingSetRetrievalBlock(workingSet));
    }
  }
  for (const summary of summaries) {
    if (
      options?.sessionId &&
      summary.sessionId === options.sessionId
    ) {
      put(buildSessionSummaryRetrievalBlock(summary));
      continue;
    }
    if (matchesProject(summary.project)) {
      put(buildSessionSummaryRetrievalBlock(summary));
    }
  }

  for (const memory of memories.filter((item) => item.isLatest)) {
    put(buildMemoryRetrievalBlock(memory));
  }
  for (const item of semantic) put(buildSemanticRetrievalBlock(item));
  for (const item of procedural) put(buildProceduralRetrievalBlock(item));
  for (const packet of handoffs) {
    if (
      options?.sessionId &&
      packet.scopeType === "session" &&
      packet.scopeId === options.sessionId
    ) {
      put(buildHandoffRetrievalBlock(packet));
      continue;
    }
    if (matchesProject(packet.project)) {
      put(buildHandoffRetrievalBlock(packet));
    }
  }
  for (const overlay of branchOverlays.filter((item) => item.status === "active")) {
    if (matchesProject(overlay.project)) {
      put(buildBranchOverlayRetrievalBlock(overlay));
    }
  }
  for (const guardrail of guardrails.filter((item) => item.status === "active")) {
    if (matchesProject(guardrail.project)) {
      put(buildGuardrailRetrievalBlock(guardrail));
    }
  }
  for (const decision of decisions.filter((item) => item.status === "active")) {
    if (matchesProject(decision.project)) {
      put(buildDecisionRetrievalBlock(decision));
    }
  }
  for (const dossier of dossiers) {
    if (matchesProject(dossier.project)) {
      put(buildDossierRetrievalBlock(dossier));
    }
  }
  for (const profile of profiles) {
    if (matchesProject(profile.project)) {
      put(buildProfileRetrievalBlock(profile));
    }
  }
  if (options?.deriveBeliefs !== false) {
    const projectedBeliefs = await Promise.all(
      beliefProjects.map(async (project) => ({
        project,
        beliefs: await listProjectedBeliefs(kv, project).catch(() => []),
      })),
    );
    for (const { project, beliefs } of projectedBeliefs) {
      for (const belief of beliefs.filter((item) => item.status === "active")) {
        const block = buildBeliefRetrievalBlock(belief);
        block.project = project;
        put(block);
      }
    }
  }

  const observationsBySession = await Promise.all(
    sessionsForObservations.map(async (session) => ({
      project: session.project,
      observations: await kv
        .list<CompressedObservation>(KV.observations(session.id))
        .catch(() => []),
    })),
  );
  for (const { project, observations } of observationsBySession) {
    for (const observation of observations) {
      if (shouldIndexObservation(observation)) {
        put(buildObservationRetrievalBlock(observation, project));
      }
    }
  }

  return [...blocks.values()];
}

export async function refreshRetrievalBlocksFromState(
  kv: StateKV,
): Promise<number> {
  const report = await reconcileRetrievalBlocksFromState(kv);
  return report.total;
}

export interface RetrievalBlockRefreshReport {
  total: number;
  stale: number;
  changed: number;
  indexed: number;
  indexFailures: number;
  limited: boolean;
}

export async function reconcileRetrievalBlocksFromState(
  kv: StateKV,
  options: {
    indexChanged?: boolean;
    maxChanged?: number;
    partial?: boolean;
    project?: string;
    sessionId?: string;
    sessionLimit?: number;
    deriveBeliefs?: boolean;
  } = {},
): Promise<RetrievalBlockRefreshReport> {
  const partial = options.partial === true;
  const nextBlocks = partial
    ? await collectLightweightRetrievalBlocksFromState(kv, {
        project: options.project,
        sessionId: options.sessionId,
        sessionLimit: options.sessionLimit,
        deriveBeliefs: options.deriveBeliefs ?? false,
      })
    : await collectRetrievalBlocksFromState(kv);
  const blocks = new Map(nextBlocks.map((block) => [block.id, block] as const));

  const existingById = new Map<string, RetrievalBlock>();
  const existing = partial
    ? []
    : await kv.list<RetrievalBlock>(KV.retrievalBlocks).catch(() => []);
  if (partial) {
    await runSequentially([...blocks.keys()], async (blockId) => {
      const existingBlock = await kv
        .get<RetrievalBlock>(KV.retrievalBlocks, blockId)
        .catch(() => null);
      if (existingBlock) existingById.set(blockId, existingBlock);
    });
  } else {
    for (const block of existing) existingById.set(block.id, block);
  }
  const nextIds = new Set(blocks.keys());
  const staleBlocks = partial
    ? []
    : existing.filter((block) => !nextIds.has(block.id));
  await runSequentially(staleBlocks, async (block) => {
    await deleteStoredRetrievalBlock(kv, block.id, {
      block,
      scheduleSave: false,
    }).catch(() => {});
  });

  const changedBlocks = [...blocks.values()].filter((block) => {
    const existingBlock = existingById.get(block.id);
    return !existingBlock || !retrievalBlockEquals(existingBlock, block);
  });
  const maxChanged =
    typeof options.maxChanged === "number" &&
    Number.isFinite(options.maxChanged) &&
    options.maxChanged >= 0
      ? Math.floor(options.maxChanged)
      : undefined;
  const writableChangedBlocks =
    maxChanged === undefined ? changedBlocks : changedBlocks.slice(0, maxChanged);

  let indexed = 0;
  let indexFailures = 0;
  await runSequentially(writableChangedBlocks, async (block) => {
    const previous = existingById.get(block.id);
    await kv.set(KV.retrievalBlocks, block.id, block);
    await upsertRetrievalBlockScopeMembership(kv, block, previous).catch(() => {});
    if (options.indexChanged) {
      const result = await indexRetrievalBlock(kv, block);
      if (result.success) indexed++;
      else indexFailures++;
    }
  });
  if (staleBlocks.length > 0 || writableChangedBlocks.length > 0) {
    invalidateContextResultCache();
  }
  return {
    total: blocks.size,
    stale: staleBlocks.length,
    changed: writableChangedBlocks.length,
    indexed,
    indexFailures,
    limited: writableChangedBlocks.length < changedBlocks.length,
  };
}
