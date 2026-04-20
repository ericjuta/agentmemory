// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import type { ISdk } from "iii-sdk";
import type {
  BeliefProjection,
  Session,
  CompressedObservation,
  SessionSummary,
  ContextBlock,
  ContextInjection,
  ProjectProfile,
  ProceduralMemory,
  RetrievalTrace,
  RetrievalTraceCandidate,
  RetrievalTraceDecision,
  RetrievalTraceLane,
  SemanticMemory,
  Memory,
  TurnCapsule,
  SessionWorkingSet,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import { GraphRetrieval } from "./graph-retrieval.js";
import { listProjectedBeliefs } from "./beliefs.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Lane = RetrievalTraceLane;

type RankedContextBlock = ContextBlock & {
  id: string;
  lane: Lane;
  sessionId?: string;
  sourceObservationIds?: string[];
  isCapsule?: boolean;
  fingerprint: string;
};

function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function blockPreview(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => !line.startsWith("## "));
  return (preferred ?? lines[0] ?? "").slice(0, 160);
}

function blockSourceType(id: string): string {
  return id.split(":")[0] || "unknown";
}

function linkedMemoryId(id: string): string | undefined {
  if (
    id.startsWith("memory:") ||
    id.startsWith("semantic:") ||
    id.startsWith("procedural:")
  ) {
    return id.split(":").slice(1).join(":");
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function queryTerms(query?: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length >= 3);
}

function scoreQueryOverlap(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const normalized = content.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (term.length < 4) continue; // skip noise words like "etc", "the"
    if (normalized.includes(term)) hits++;
  }
  // Normalize: fraction of meaningful query terms matched
  const meaningful = terms.filter((t) => t.length >= 4).length;
  return meaningful > 0 ? hits / meaningful : 0;
}

function formatTurnCapsule(capsule: TurnCapsule, currentSession: boolean): string {
  const lines = [
    `## ${currentSession ? "Current Turn" : `Recent Turn ${capsule.turnId}`}`,
  ];
  if (capsule.userPrompt) {
    lines.push(`User: ${capsule.userPrompt}`);
  }
  if (capsule.assistantConclusion) {
    lines.push(`Conclusion: ${capsule.assistantConclusion}`);
  }
  if (capsule.files.length > 0) {
    lines.push(`Files: ${capsule.files.slice(0, 6).join(", ")}`);
  }
  if (capsule.concepts.length > 0) {
    lines.push(`Concepts: ${capsule.concepts.slice(0, 8).join(", ")}`);
  }
  const signals: string[] = [];
  if (capsule.hadFailure) signals.push("failure");
  if (capsule.hadDecision) signals.push("decision");
  if (capsule.maxImportance > 0) signals.push(`importance ${capsule.maxImportance}`);
  if (signals.length > 0) {
    lines.push(`Signals: ${signals.join(", ")}`);
  }
  return lines.join("\n");
}

function formatWorkingSet(workingSet: SessionWorkingSet): string | null {
  if (workingSet.latestCompletedCapsule) {
    return formatTurnCapsule(workingSet.latestCompletedCapsule, true);
  }

  const lines = ["## Current Working Set"];
  if (workingSet.latestAssistantConclusion) {
    lines.push("Conclusion: " + workingSet.latestAssistantConclusion);
  }
  if (workingSet.latestImportantFiles.length > 0) {
    lines.push("Files: " + workingSet.latestImportantFiles.slice(0, 6).join(", "));
  }
  if (workingSet.latestImportantConcepts.length > 0) {
    lines.push(
      "Concepts: " + workingSet.latestImportantConcepts.slice(0, 8).join(", "),
    );
  }
  const signals: string[] = [];
  if (workingSet.latestHadFailure) signals.push("failure");
  if (workingSet.latestHadDecision) signals.push("decision");
  if (signals.length > 0) {
    lines.push("Signals: " + signals.join(", "));
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

function formatProfile(profile: ProjectProfile): string | null {
  const profileParts = [];
  if (profile.topConcepts.length > 0) {
    profileParts.push(
      `Concepts: ${profile.topConcepts
        .slice(0, 8)
        .map((c) => c.concept)
        .join(", ")}`,
    );
  }
  if (profile.topFiles.length > 0) {
    profileParts.push(
      `Key files: ${profile.topFiles
        .slice(0, 5)
        .map((f) => f.file)
        .join(", ")}`,
    );
  }
  if (profile.conventions.length > 0) {
    profileParts.push(`Conventions: ${profile.conventions.join("; ")}`);
  }
  if (profile.commonErrors.length > 0) {
    profileParts.push(
      `Common errors: ${profile.commonErrors.slice(0, 3).join("; ")}`,
    );
  }
  if (profile.recentActivity.length > 0) {
    profileParts.push(
      `Recent activity: ${profile.recentActivity.slice(0, 3).join("; ")}`,
    );
  }
  if (profileParts.length === 0) return null;
  return `## Project Profile\n${profileParts.join("\n")}`;
}

function formatSummary(summary: SessionSummary): string {
  return `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
}

function formatObservation(
  observation: CompressedObservation,
  currentSession: boolean,
): string {
  return `## ${currentSession ? "Current Session Observation" : "Recent Observation"}\n- [${observation.type}] ${observation.title}: ${observation.narrative}`;
}

function formatSemantic(memory: SemanticMemory): string {
  return `## Semantic Memory\n- ${memory.fact}`;
}

function formatProcedural(memory: ProceduralMemory): string {
  return `## Procedural Memory\nName: ${memory.name}\nTrigger: ${memory.triggerCondition}\nSteps: ${memory.steps.slice(0, 4).join(" -> ")}`;
}

function formatMemory(memory: Memory): string {
  const lines = [`## ${memory.type.charAt(0).toUpperCase() + memory.type.slice(1)} Memory: ${memory.title}`];
  lines.push(memory.content);
  if (memory.files.length > 0) {
    lines.push(`Files: ${memory.files.slice(0, 5).join(", ")}`);
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

function expandTerms(values: string[]): string[] {
  return values.flatMap((value) => queryTerms(value));
}

function makeBlock(
  id: string,
  lane: Lane,
  type: ContextBlock["type"],
  content: string,
  recency: number,
  options: {
    isCapsule?: boolean;
    sessionId?: string;
    sourceObservationIds?: string[];
  } = {},
): RankedContextBlock {
  return {
    id,
    lane,
    type,
    content,
    tokens: estimateTokens(content),
    recency,
    fingerprint: normalizeFingerprint(content),
    sessionId: options.sessionId,
    sourceObservationIds: options.sourceObservationIds,
    isCapsule: options.isCapsule,
  };
}

function lanePriority(lane: Lane): number {
  switch (lane) {
    case "hot":
      return 3;
    case "warm":
      return 2;
    case "cold":
      return 1;
  }
}

function buildTraceCandidate(
  block: RankedContextBlock,
  terms: string[],
): RetrievalTraceCandidate {
  return {
    id: block.id,
    sourceType: blockSourceType(block.id),
    blockType: block.type,
    lane: block.lane,
    preview: blockPreview(block.content),
    tokens: block.tokens,
    score: {
      queryOverlap: scoreQueryOverlap(block.content, terms),
      lanePriority: lanePriority(block.lane),
      recency: block.recency,
    },
    selected: false,
    decision: "skipped_lane_budget",
    sessionId: block.sessionId,
    sourceObservationIds: block.sourceObservationIds,
    isCapsule: block.isCapsule,
    linkedMemoryId: linkedMemoryId(block.id),
  };
}

function updateTraceCandidate(
  traceCandidates: Map<string, RetrievalTraceCandidate>,
  block: RankedContextBlock,
  decision: RetrievalTraceDecision,
  selected: boolean,
): void {
  const candidate = traceCandidates.get(block.id);
  if (!candidate) return;
  candidate.decision = decision;
  candidate.selected = selected;
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction("mem::context", 
    async (data: {
      sessionId: string;
      project: string;
      budget?: number;
      query?: string;
    }) => {
      const budget = data.budget || tokenBudget;
      const terms = queryTerms(data.query);
      const hotBlocks: RankedContextBlock[] = [];
      const warmBlocks: RankedContextBlock[] = [];
      const coldBlocks: RankedContextBlock[] = [];
      const graphRetrieval = new GraphRetrieval(kv);

      const workingSet = await kv
        .get<SessionWorkingSet>(KV.workingSets, data.sessionId)
        .catch(() => null);
      if (workingSet?.project === data.project) {
        const snapshotContent = formatWorkingSet(workingSet);
        if (snapshotContent) {
          hotBlocks.push(
            makeBlock(
              `working-set:${workingSet.sessionId}`,
              "hot",
              "observation",
              snapshotContent,
              new Date(workingSet.updatedAt).getTime(),
              {
                isCapsule: Boolean(workingSet.latestCompletedCapsule),
                sessionId: workingSet.sessionId,
                sourceObservationIds: workingSet.latestImportantObservationIds,
              },
            ),
          );
        }
      }

      const focusTerms = uniqueStrings([
        ...terms,
        ...expandTerms(workingSet?.latestImportantConcepts || []),
        ...expandTerms(workingSet?.latestImportantFiles || []),
        ...expandTerms(workingSet?.latestCompletedCapsule?.concepts || []),
        ...expandTerms(workingSet?.latestCompletedCapsule?.files || []),
      ]);

      const projectedBeliefs = await listProjectedBeliefs(kv, data.project).catch(() => []);
      for (const belief of projectedBeliefs
        .filter((projection) => projection.status === "active")
        .slice(0, 8)) {
        const beliefText = [belief.claim, ...belief.files, ...belief.concepts].join(" ");
        const warmBelief = scoreQueryOverlap(beliefText, focusTerms) > 0;
        const lane = warmBelief ? warmBlocks : coldBlocks;
        lane.push(
          makeBlock(
            `belief:${belief.beliefId}`,
            warmBelief ? "warm" : "cold",
            "memory",
            formatBelief(belief),
            new Date(belief.updatedAt).getTime(),
          ),
        );
      }

      const profile = await kv
        .get<ProjectProfile>(KV.profiles, data.project)
        .catch(() => null);
      if (profile) {
        const profileContent = formatProfile(profile);
        if (profileContent) {
          coldBlocks.push(
            makeBlock(
              `profile:${profile.project}`,
              "cold",
              "memory",
              profileContent,
              new Date(profile.updatedAt).getTime(),
            ),
          );
        }
      }

      const allSessions = await kv.list<Session>(KV.sessions);
      const otherSessions = allSessions
        .filter((s) => s.project === data.project && s.id !== data.sessionId)
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .slice(0, 10);

      const allCapsules = await kv.list<TurnCapsule>(KV.turnCapsules).catch(() => []);
      const projectCapsules = allCapsules
        .filter((capsule) => capsule.project === data.project)
        .sort((a, b) => {
          const sameSessionDelta =
            Number(b.sessionId === data.sessionId) -
            Number(a.sessionId === data.sessionId);
          if (sameSessionDelta !== 0) return sameSessionDelta;
          const recencyDelta =
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          if (recencyDelta !== 0) return recencyDelta;
          return b.maxImportance - a.maxImportance;
        })
        .slice(0, 12);
      for (const capsule of projectCapsules) {
        hotBlocks.push(
          makeBlock(
            `capsule:${capsule.id}`,
            "hot",
            "observation",
            formatTurnCapsule(capsule, capsule.sessionId === data.sessionId),
            new Date(capsule.updatedAt).getTime(),
            {
              isCapsule: true,
              sessionId: capsule.sessionId,
              sourceObservationIds: capsule.sourceObservationIds,
            },
          ),
        );
      }

      const summariesPerSession = await Promise.all(
        otherSessions.map((s) =>
          kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null),
        ),
      );

      const sessionsNeedingObs: number[] = [];
      for (let i = 0; i < otherSessions.length; i++) {
        const summary = summariesPerSession[i];
        if (summary) {
          coldBlocks.push(
            makeBlock(
              `summary:${summary.sessionId}`,
              "cold",
              "summary",
              formatSummary(summary),
              new Date(summary.createdAt).getTime(),
              { sessionId: summary.sessionId },
            ),
          );
        } else {
          sessionsNeedingObs.push(i);
        }
      }

      const obsResults = await Promise.all(
        sessionsNeedingObs.map((i) =>
          kv
            .list<CompressedObservation>(KV.observations(otherSessions[i].id))
            .catch(() => []),
        ),
      );

      for (let j = 0; j < sessionsNeedingObs.length; j++) {
        const i = sessionsNeedingObs[j];
        const observations = obsResults[j];
        const important = observations.filter(
          (o) => o.title && o.importance >= 5,
        );

        if (important.length > 0) {
          const top = important
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 5);
          const items = top
            .map((observation) =>
              `- [${observation.type}] ${observation.title}: ${observation.narrative}`,
            )
            .join("\n");
          coldBlocks.push(
            makeBlock(
              `fallback-observations:${otherSessions[i].id}`,
              "cold",
              "observation",
              `## Session ${otherSessions[i].id.slice(0, 8)} (${otherSessions[i].startedAt})\n${items}`,
              new Date(otherSessions[i].startedAt).getTime(),
              {
                sessionId: otherSessions[i].id,
                sourceObservationIds: top.map((observation) => observation.id),
              },
            ),
          );
        }
      }

      const semanticMemories = await kv.list<SemanticMemory>(KV.semantic).catch(() => []);
      for (const memory of semanticMemories
        .slice()
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, 5)) {
        coldBlocks.push(
          makeBlock(
            `semantic:${memory.id}`,
            "cold",
            "memory",
            formatSemantic(memory),
            new Date(memory.updatedAt).getTime(),
          ),
        );
      }

      const proceduralMemories = await kv
        .list<ProceduralMemory>(KV.procedural)
        .catch(() => []);
      for (const memory of proceduralMemories
        .slice()
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, 5)) {
        coldBlocks.push(
          makeBlock(
            `procedural:${memory.id}`,
            "cold",
            "memory",
            formatProcedural(memory),
            new Date(memory.updatedAt).getTime(),
          ),
        );
      }

      const consolidatedMemories = await kv.list<Memory>(KV.memories).catch(() => []);
      const latestMemories = consolidatedMemories
        .filter((m) => m.isLatest)
        .sort((a, b) => {
          // Prefer higher strength, then recency
          const strengthDelta = b.strength - a.strength;
          if (strengthDelta !== 0) return strengthDelta;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
        .slice(0, 10);
      for (const memory of latestMemories) {
        coldBlocks.push(
          makeBlock(
            `memory:${memory.id}`,
            "cold",
            "memory",
            formatMemory(memory),
            new Date(memory.updatedAt).getTime(),
          ),
        );
      }

      const recentSessions = allSessions
        .filter((session) => session.project === data.project)
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .slice(0, 6);
      const recentObservationsPerSession = await Promise.all(
        recentSessions.map((session) =>
          kv
            .list<CompressedObservation>(KV.observations(session.id))
            .catch(() => [] as CompressedObservation[]),
        ),
      );
      const warmObservations = recentObservationsPerSession
        .flatMap((observations) => observations)
        .filter((observation) => observation.title && observation.importance >= 5)
        .sort((a, b) => {
          const sameSessionDelta =
            Number(b.sessionId === data.sessionId) -
            Number(a.sessionId === data.sessionId);
          if (sameSessionDelta !== 0) return sameSessionDelta;
          const recencyDelta =
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
          if (recencyDelta !== 0) return recencyDelta;
          return b.importance - a.importance;
        })
        .slice(0, 20);
      const recentObservationIndex = new Map(
        recentObservationsPerSession
          .flatMap((observations) => observations)
          .filter((observation) => observation.title)
          .map((observation) => [observation.id, observation] as const),
      );
      for (const observation of warmObservations) {
        warmBlocks.push(
          makeBlock(
            `observation:${observation.id}`,
            "warm",
            "observation",
            formatObservation(observation, observation.sessionId === data.sessionId),
            new Date(observation.timestamp).getTime(),
            {
              sessionId: observation.sessionId,
              sourceObservationIds: [observation.id],
            },
          ),
        );
      }

      const graphSeedObservationIds = [
        ...(workingSet?.latestImportantObservationIds || []),
        ...projectCapsules
          .filter((capsule) => capsule.sessionId === data.sessionId)
          .flatMap((capsule) => capsule.sourceObservationIds)
          .slice(0, 12),
      ];
      if (graphSeedObservationIds.length > 0) {
        const graphResults = await graphRetrieval
          .expandFromChunks(graphSeedObservationIds, 1, 8)
          .catch(() => []);
        for (const result of graphResults) {
          const observation = recentObservationIndex.get(result.obsId);
          if (!observation) continue;
          const content =
            formatObservation(observation, observation.sessionId === data.sessionId) +
            "\nGraph: " +
            result.graphContext;
          warmBlocks.push(
            makeBlock(
              `graph:${observation.id}`,
              "warm",
              "observation",
              content,
              new Date(observation.timestamp).getTime() + Math.round(result.score * 1000),
              {
                sessionId: observation.sessionId,
                sourceObservationIds: [observation.id],
              },
            ),
          );
        }
      }

      const traceTimestamp = new Date().toISOString();
      let usedTokens = 0;
      let selectedTokens = 0;
      const selected: string[] = [];
      const accessedIds: string[] = [];
      const header = `<agentmemory-context project="${escapeXmlAttr(data.project)}">`;
      const footer = `</agentmemory-context>`;
      const wrapperTokens = estimateTokens(header) + estimateTokens(footer);
      usedTokens += wrapperTokens;
      const availableBudget = Math.max(0, budget - wrapperTokens);
      // When a query is present, shift budget toward warm/cold (relevant content)
      // over hot (recent-but-possibly-irrelevant capsules)
      const hasQuery = terms.length > 0;
      const hotPct = hasQuery ? 0.2 : 0.4;
      const warmPct = hasQuery ? 0.4 : 0.3;
      const laneBudgets: Record<RetrievalTraceLane, number> = {
        hot: Math.floor(availableBudget * hotPct),
        warm: Math.floor(availableBudget * warmPct),
        cold:
          availableBudget -
          Math.floor(availableBudget * hotPct) -
          Math.floor(availableBudget * warmPct),
      };
      const laneUsage: Record<RetrievalTraceLane, number> = {
        hot: 0,
        warm: 0,
        cold: 0,
      };

      const selectedIds = new Set<string>();
      const fingerprints = new Set<string>();
      const selectedObservationIds = new Set<string>();
      const selectedCapsuleSessions = new Set<string>();
      const selectedTraceIds: string[] = [];
      const allBlocks = [...hotBlocks, ...warmBlocks, ...coldBlocks];
      const traceCandidates = new Map(
        allBlocks.map((block) => [block.id, buildTraceCandidate(block, terms)]),
      );
      const sortBlocks = (blocks: RankedContextBlock[]) =>
        blocks.sort((a, b) => {
          const aScore = scoreQueryOverlap(a.content, terms);
          const bScore = scoreQueryOverlap(b.content, terms);
          // Blocks with any query match always beat blocks with none
          if (hasQuery && aScore !== bScore) {
            if (bScore > 0 && aScore === 0) return 1;
            if (aScore > 0 && bScore === 0) return -1;
            return bScore - aScore;
          }
          return b.recency - a.recency;
        });

      const markSkipped = (
        block: RankedContextBlock,
        decision: RetrievalTraceDecision,
      ) => {
        const candidate = traceCandidates.get(block.id);
        if (!candidate || candidate.selected) return;
        updateTraceCandidate(traceCandidates, block, decision, false);
      };

      const selectBlock = (
        block: RankedContextBlock,
        decision: RetrievalTraceDecision,
      ) => {
        selected.push(block.content);
        usedTokens += block.tokens;
        selectedTokens += block.tokens;
        selectedIds.add(block.id);
        selectedTraceIds.push(block.id);
        fingerprints.add(block.fingerprint);
        laneUsage[block.lane] += block.tokens;
        updateTraceCandidate(traceCandidates, block, decision, true);
        if (block.isCapsule && block.sessionId) {
          selectedCapsuleSessions.add(block.sessionId);
        }
        for (const id of block.sourceObservationIds || []) {
          selectedObservationIds.add(id);
          accessedIds.push(id);
        }
      };

      const takeFromLane = (blocks: RankedContextBlock[], laneBudget: number) => {
        let laneUsed = 0;
        for (const block of blocks) {
          if (selectedIds.has(block.id)) continue;
          if (fingerprints.has(block.fingerprint)) {
            markSkipped(block, "skipped_duplicate_fingerprint");
            continue;
          }
          if (
            block.lane === "warm" &&
            block.sourceObservationIds?.some((id) => selectedObservationIds.has(id))
          ) {
            markSkipped(block, "skipped_observation_already_selected");
            continue;
          }
          if (
            block.lane === "cold" &&
            !block.isCapsule &&
            block.sessionId &&
            selectedCapsuleSessions.has(block.sessionId)
          ) {
            markSkipped(block, "skipped_session_already_covered");
            continue;
          }
          if (laneUsed + block.tokens > laneBudget) {
            markSkipped(block, "skipped_lane_budget");
            continue;
          }
          if (usedTokens + block.tokens > budget) {
            markSkipped(block, "skipped_total_budget");
            continue;
          }
          selectBlock(block, "selected_lane_budget");
          laneUsed += block.tokens;
        }
      };

      takeFromLane(
        sortBlocks(hotBlocks),
        laneBudgets.hot,
      );
      takeFromLane(
        sortBlocks(warmBlocks),
        laneBudgets.warm,
      );
      takeFromLane(
        sortBlocks(coldBlocks),
        laneBudgets.cold,
      );

      const leftovers = [...hotBlocks, ...warmBlocks, ...coldBlocks]
        .filter((block) => !selectedIds.has(block.id))
        .sort((a, b) => {
          const queryDelta =
            scoreQueryOverlap(b.content, terms) -
            scoreQueryOverlap(a.content, terms);
          if (queryDelta !== 0) return queryDelta;
          const laneDelta = lanePriority(b.lane) - lanePriority(a.lane);
          if (laneDelta !== 0) return laneDelta;
          return b.recency - a.recency;
        });
      for (const block of leftovers) {
        if (fingerprints.has(block.fingerprint)) {
          markSkipped(block, "skipped_duplicate_fingerprint");
          continue;
        }
        if (
          block.lane === "warm" &&
          block.sourceObservationIds?.some((id) => selectedObservationIds.has(id))
        ) {
          markSkipped(block, "skipped_observation_already_selected");
          continue;
        }
        if (
          block.lane === "cold" &&
          !block.isCapsule &&
          block.sessionId &&
          selectedCapsuleSessions.has(block.sessionId)
        ) {
          markSkipped(block, "skipped_session_already_covered");
          continue;
        }
        if (usedTokens + block.tokens > budget) {
          markSkipped(block, "skipped_total_budget");
          continue;
        }
        selectBlock(block, "selected_leftover_fill");
      }

      const injectedMemoryIds = uniqueStrings(
        selectedTraceIds
          .map((id) => traceCandidates.get(id)?.linkedMemoryId)
          .filter((id): id is string => Boolean(id)),
      );
      const usefulnessLink: ContextInjection | null =
        injectedMemoryIds.length > 0
          ? {
              sessionId: data.sessionId,
              memoryIds: injectedMemoryIds,
              timestamp: traceTimestamp,
            }
          : null;

      if (usefulnessLink) {
        await kv
          .set(KV.contextInjections, data.sessionId, usefulnessLink)
          .catch(() => {});
      }

      if (accessedIds.length > 0) {
        void recordAccessBatch(kv, accessedIds);
      }

      const trace: RetrievalTrace = {
        generatedAt: traceTimestamp,
        query: data.query?.trim() || undefined,
        queryTerms: terms,
        budget,
        availableBudget,
        selectedTokens,
        responseTokens: selected.length > 0 ? usedTokens : 0,
        laneBudgets,
        laneUsage,
        selected: selectedTraceIds
          .map((id) => traceCandidates.get(id))
          .filter((candidate): candidate is RetrievalTraceCandidate =>
            Boolean(candidate),
          ),
        skipped: [...traceCandidates.values()]
          .filter((candidate) => !candidate.selected)
          .sort((a, b) => {
            const queryDelta = b.score.queryOverlap - a.score.queryOverlap;
            if (queryDelta !== 0) return queryDelta;
            const laneDelta = b.score.lanePriority - a.score.lanePriority;
            if (laneDelta !== 0) return laneDelta;
            return b.score.recency - a.score.recency;
          }),
        usefulnessLink,
      };

      if (selected.length === 0) {
        logger.info("No context available", { project: data.project });
        return { context: "", blocks: 0, tokens: 0, trace };
      }

      const result = `${header}\n${selected.join("\n\n")}\n${footer}`;
      logger.info("Context generated", {
        blocks: selected.length,
        tokens: usedTokens,
      });
      return {
        context: result,
        blocks: selected.length,
        tokens: usedTokens,
        trace,
      };
    },
  );
}
