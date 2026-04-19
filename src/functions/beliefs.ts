import type { ISdk } from "iii-sdk";
import type {
  Belief,
  BeliefEvidence,
  BeliefProjection,
  CompressedObservation,
  Memory,
  MemoryRelation,
  Session,
} from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

type BeliefGroup = {
  claim: string;
  normalizedClaim: string;
  memories: Memory[];
};

const BELIEF_STATUS_PRIORITY: Record<Belief["status"], number> = {
  active: 4,
  uncertain: 3,
  contradicted: 2,
  superseded: 1,
};

function normalizeClaim(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function sortBeliefs(beliefs: Belief[]): Belief[] {
  return beliefs.slice().sort((a, b) => {
    const statusDelta = BELIEF_STATUS_PRIORITY[b.status] - BELIEF_STATUS_PRIORITY[a.status];
    if (statusDelta !== 0) return statusDelta;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function sortBeliefProjections(projections: BeliefProjection[]): BeliefProjection[] {
  return projections.slice().sort((a, b) => {
    const statusDelta = BELIEF_STATUS_PRIORITY[b.status] - BELIEF_STATUS_PRIORITY[a.status];
    if (statusDelta !== 0) return statusDelta;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function beliefId(project: string, normalizedClaim: string): string {
  return fingerprintId("belief", `${project}:${normalizedClaim}`);
}

function evidenceId(
  beliefIdValue: string,
  memoryId: string,
  relationType: BeliefEvidence["relationType"],
): string {
  return fingerprintId("beliefev", `${beliefIdValue}:${relationType}:${memoryId}`);
}

async function buildProjectScope(
  kv: StateKV,
  project: string,
): Promise<{
  projectSessionIds: Set<string>;
  projectObservationIds: Set<string>;
}> {
  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  const projectSessions =
    project === "*"
      ? sessions
      : sessions.filter((session) => session.project === project);
  const projectSessionIds = new Set(projectSessions.map((session) => session.id));
  const projectObservationIds = new Set<string>();

  const observationsPerSession = await Promise.all(
    projectSessions.map((session) =>
      kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []),
    ),
  );
  for (const observations of observationsPerSession) {
    for (const observation of observations) {
      projectObservationIds.add(observation.id);
    }
  }

  return { projectSessionIds, projectObservationIds };
}

function memoryMatchesProject(
  memory: Memory,
  project: string,
  projectSessionIds: Set<string>,
  projectObservationIds: Set<string>,
): boolean {
  if (project === "*") return true;
  if (memory.files.some((file) => !file.startsWith("/") || file.startsWith(project))) {
    return true;
  }
  if (memory.sessionIds.some((sessionId) => projectSessionIds.has(sessionId))) {
    return true;
  }
  if (
    (memory.sourceObservationIds || []).some((observationId) =>
      projectObservationIds.has(observationId),
    )
  ) {
    return true;
  }
  return false;
}

async function projectsToDerive(
  kv: StateKV,
  project: string,
  memoryIds?: string[],
): Promise<string[]> {
  if (project !== "*") return [project];

  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  const sessionProjects = sessions.map((session) => session.project);

  if (!memoryIds || memoryIds.length === 0) {
    const knownProjects = uniqueStrings(sessionProjects);
    return knownProjects.length > 0 ? knownProjects : ["*"];
  }

  const memories = await kv.list<Memory>(KV.memories).catch(() => []);
  const sessionsById = new Map(sessions.map((session) => [session.id, session.project] as const));
  const inferredProjects = new Set<string>();

  for (const memory of memories) {
    if (!memoryIds.includes(memory.id)) continue;
    for (const sessionId of memory.sessionIds) {
      const sessionProject = sessionsById.get(sessionId);
      if (sessionProject) inferredProjects.add(sessionProject);
    }
  }

  if (inferredProjects.size > 0) {
    return [...inferredProjects];
  }

  const knownProjects = uniqueStrings(sessionProjects);
  return knownProjects.length > 0 ? knownProjects : ["*"];
}

export function beliefProjection(belief: Belief): BeliefProjection {
  return {
    beliefId: belief.id,
    claim: belief.claim,
    status: belief.status,
    confidence: belief.confidence,
    supportCount: belief.supportingMemoryIds.length,
    contradictionCount: belief.contradictingMemoryIds.length,
    superseded: Boolean(belief.supersededByBeliefId),
    files: belief.files,
    concepts: belief.concepts,
    updatedAt: belief.updatedAt,
  };
}

export async function deriveBeliefsForProject(
  kv: StateKV,
  project: string,
): Promise<{
  beliefs: Belief[];
  evidence: BeliefEvidence[];
  projections: BeliefProjection[];
}> {
  const memories = await kv.list<Memory>(KV.memories).catch(() => []);
  const relations = await kv.list<MemoryRelation>(KV.relations).catch(() => []);
  const { projectSessionIds, projectObservationIds } = await buildProjectScope(kv, project);

  const relevantMemories = memories.filter((memory) =>
    memoryMatchesProject(memory, project, projectSessionIds, projectObservationIds),
  );

  const groups = new Map<string, BeliefGroup>();
  for (const memory of relevantMemories) {
    const claim = memory.content.trim() || memory.title.trim();
    if (!claim) continue;
    const normalizedClaim = normalizeClaim(claim);
    const existing = groups.get(normalizedClaim);
    if (existing) {
      existing.memories.push(memory);
      continue;
    }
    groups.set(normalizedClaim, {
      claim,
      normalizedClaim,
      memories: [memory],
    });
  }

  const memoryToBelief = new Map<string, string>();
  for (const group of groups.values()) {
    const id = beliefId(project, group.normalizedClaim);
    for (const memory of group.memories) {
      memoryToBelief.set(memory.id, id);
    }
  }

  const supersedesByBelief = new Map<string, Set<string>>();
  const supersededByBelief = new Map<string, Set<string>>();
  const contradictingMemoryIds = new Map<string, Set<string>>();

  const addSupersedes = (sourceMemoryId: string, targetMemoryId: string) => {
    const sourceBeliefId = memoryToBelief.get(sourceMemoryId);
    const targetBeliefId = memoryToBelief.get(targetMemoryId);
    if (!sourceBeliefId || !targetBeliefId || sourceBeliefId === targetBeliefId) return;
    if (!supersedesByBelief.has(sourceBeliefId)) {
      supersedesByBelief.set(sourceBeliefId, new Set());
    }
    supersedesByBelief.get(sourceBeliefId)!.add(targetBeliefId);
    if (!supersededByBelief.has(targetBeliefId)) {
      supersededByBelief.set(targetBeliefId, new Set());
    }
    supersededByBelief.get(targetBeliefId)!.add(sourceBeliefId);
  };

  const addContradiction = (sourceMemoryId: string, targetMemoryId: string) => {
    const sourceBeliefId = memoryToBelief.get(sourceMemoryId);
    const targetBeliefId = memoryToBelief.get(targetMemoryId);
    if (!sourceBeliefId || !targetBeliefId || sourceBeliefId === targetBeliefId) return;
    if (!contradictingMemoryIds.has(sourceBeliefId)) {
      contradictingMemoryIds.set(sourceBeliefId, new Set());
    }
    if (!contradictingMemoryIds.has(targetBeliefId)) {
      contradictingMemoryIds.set(targetBeliefId, new Set());
    }
    contradictingMemoryIds.get(sourceBeliefId)!.add(targetMemoryId);
    contradictingMemoryIds.get(targetBeliefId)!.add(sourceMemoryId);
  };

  for (const memory of relevantMemories) {
    for (const supersededId of memory.supersedes || []) {
      addSupersedes(memory.id, supersededId);
    }
    if (memory.parentId) {
      addSupersedes(memory.id, memory.parentId);
    }
  }

  for (const relation of relations) {
    if (relation.type === "supersedes") {
      addSupersedes(relation.sourceId, relation.targetId);
    }
    if (relation.type === "contradicts") {
      addContradiction(relation.sourceId, relation.targetId);
    }
  }

  const beliefs: Belief[] = [];
  for (const group of groups.values()) {
    const id = beliefId(project, group.normalizedClaim);
    const supportIds = uniqueStrings(group.memories.map((memory) => memory.id));
    const contradictionIds = uniqueStrings([
      ...((contradictingMemoryIds.get(id) || new Set()).values()),
    ]);
    const supersedesBeliefIds = uniqueStrings([
      ...((supersedesByBelief.get(id) || new Set()).values()),
    ]);
    const supersededByBeliefIds = uniqueStrings([
      ...((supersededByBelief.get(id) || new Set()).values()),
    ]);
    const hasLatestSupport = group.memories.some((memory) => memory.isLatest);
    const supportCount = supportIds.length;
    const contradictionCount = contradictionIds.length;

    let confidence =
      0.5 +
      (hasLatestSupport ? 0.2 : 0) +
      Math.min(supportCount * 0.05, 0.2) -
      Math.min(contradictionCount * 0.05, 0.2);
    confidence = Math.max(0, Math.min(1, confidence));

    let status: Belief["status"] = "active";
    if (supersededByBeliefIds.length > 0) {
      status = "superseded";
    } else if (contradictionCount > supportCount && contradictionCount > 0) {
      status = "contradicted";
    } else if (contradictionCount > 0 || !hasLatestSupport) {
      status = "uncertain";
    }

    const timestamps = group.memories.map((memory) => ({
      createdAt: new Date(memory.createdAt).getTime(),
      updatedAt: new Date(memory.updatedAt).getTime(),
    }));
    beliefs.push({
      id,
      createdAt: new Date(Math.min(...timestamps.map((entry) => entry.createdAt))).toISOString(),
      updatedAt: new Date(Math.max(...timestamps.map((entry) => entry.updatedAt))).toISOString(),
      project,
      claim: group.claim,
      normalizedClaim: group.normalizedClaim,
      status,
      confidence,
      supportingMemoryIds: supportIds,
      contradictingMemoryIds: contradictionIds,
      supersededByBeliefId: supersededByBeliefIds[0],
      supersedesBeliefIds,
      sourceTypes: uniqueStrings(group.memories.map((memory) => memory.type)) as Memory["type"][],
      files: uniqueStrings(group.memories.flatMap((memory) => memory.files)),
      concepts: uniqueStrings(group.memories.flatMap((memory) => memory.concepts)),
    });
  }

  const beliefById = new Map(sortBeliefs(beliefs).map((belief) => [belief.id, belief] as const));
  const evidence: BeliefEvidence[] = [];
  for (const belief of beliefById.values()) {
    for (const memoryId of belief.supportingMemoryIds) {
      evidence.push({
        id: evidenceId(belief.id, memoryId, "supports"),
        beliefId: belief.id,
        memoryId,
        relationType: "supports",
        weight: 1,
        createdAt: belief.updatedAt,
      });
    }
    for (const memoryId of belief.contradictingMemoryIds) {
      evidence.push({
        id: evidenceId(belief.id, memoryId, "contradicts"),
        beliefId: belief.id,
        memoryId,
        relationType: "contradicts",
        weight: 0.8,
        createdAt: belief.updatedAt,
      });
    }
    for (const supersededBeliefId of belief.supersedesBeliefIds) {
      const supersededBelief = beliefById.get(supersededBeliefId);
      for (const memoryId of supersededBelief?.supportingMemoryIds || []) {
        evidence.push({
          id: evidenceId(belief.id, memoryId, "supersedes"),
          beliefId: belief.id,
          memoryId,
          relationType: "supersedes",
          weight: 1,
          createdAt: belief.updatedAt,
        });
      }
    }
  }

  const sortedBeliefs = sortBeliefs([...beliefById.values()]);
  const projections = sortBeliefProjections(sortedBeliefs.map(beliefProjection));
  return { beliefs: sortedBeliefs, evidence, projections };
}

async function deriveBeliefsForProjects(
  kv: StateKV,
  projects: string[],
): Promise<{
  beliefs: Belief[];
  evidence: BeliefEvidence[];
  projections: BeliefProjection[];
}> {
  const derived = await Promise.all(projects.map((project) => deriveBeliefsForProject(kv, project)));
  return {
    beliefs: sortBeliefs(derived.flatMap((entry) => entry.beliefs)),
    evidence: derived.flatMap((entry) => entry.evidence),
    projections: sortBeliefProjections(derived.flatMap((entry) => entry.projections)),
  };
}

export async function listProjectedBeliefs(
  kv: StateKV,
  project: string,
): Promise<BeliefProjection[]> {
  const stored = await kv.list<Belief>(KV.beliefs).catch(() => []);
  const storedForProject =
    project === "*"
      ? stored
      : stored.filter((belief) => belief.project === project);
  if (storedForProject.length > 0) {
    return sortBeliefProjections(storedForProject.map(beliefProjection));
  }

  const projects = await projectsToDerive(kv, project);
  return (await deriveBeliefsForProjects(kv, projects)).projections;
}

export async function getBeliefDetails(
  kv: StateKV,
  beliefIdValue: string,
): Promise<{ belief: Belief; evidence: BeliefEvidence[] } | null> {
  const direct = await kv.get<Belief>(KV.beliefs, beliefIdValue).catch(() => null);
  if (direct) {
    const evidence = (await kv.list<BeliefEvidence>(KV.beliefEvidence).catch(() => [])).filter(
      (entry) => entry.beliefId === direct.id,
    );
    return { belief: direct, evidence };
  }

  const storedBeliefs = await kv.list<Belief>(KV.beliefs).catch(() => []);
  const storedBelief = storedBeliefs.find((belief) => belief.id === beliefIdValue);
  if (storedBelief) {
    const evidence = (await kv.list<BeliefEvidence>(KV.beliefEvidence).catch(() => [])).filter(
      (entry) => entry.beliefId === storedBelief.id,
    );
    return { belief: storedBelief, evidence };
  }

  const projects = await projectsToDerive(kv, "*");
  for (const project of projects) {
    const derived = await deriveBeliefsForProject(kv, project);
    const belief = derived.beliefs.find((entry) => entry.id === beliefIdValue);
    if (belief) {
      return {
        belief,
        evidence: derived.evidence.filter((entry) => entry.beliefId === belief.id),
      };
    }
  }

  return null;
}

export function registerBeliefsFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::belief-project",
    async (data: { project?: string; memoryIds?: string[]; force?: boolean }) => {
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : "*";
      const memoryIds = Array.isArray(data.memoryIds)
        ? data.memoryIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      const projects = await projectsToDerive(kv, project, memoryIds);
      const { beliefs, evidence } = await deriveBeliefsForProjects(kv, projects);
      const existingBeliefs = await kv.list<Belief>(KV.beliefs).catch(() => []);
      const existingEvidence = await kv.list<BeliefEvidence>(KV.beliefEvidence).catch(() => []);
      const targetProjects = new Set(projects);
      const targetExistingBeliefIds = new Set(
        existingBeliefs
          .filter((belief) => targetProjects.has(belief.project))
          .map((belief) => belief.id),
      );
      const nextBeliefIds = new Set(beliefs.map((belief) => belief.id));
      const nextEvidenceIds = new Set(evidence.map((entry) => entry.id));

      await Promise.all([
        ...beliefs.map((belief) => kv.set(KV.beliefs, belief.id, belief)),
        ...evidence.map((entry) => kv.set(KV.beliefEvidence, entry.id, entry)),
      ]);

      await Promise.all([
        ...existingBeliefs
          .filter((belief) => targetProjects.has(belief.project) && !nextBeliefIds.has(belief.id))
          .map((belief) => kv.delete(KV.beliefs, belief.id)),
        ...existingEvidence
          .filter(
            (entry) =>
              targetExistingBeliefIds.has(entry.beliefId) && !nextEvidenceIds.has(entry.id),
          )
          .map((entry) => kv.delete(KV.beliefEvidence, entry.id)),
      ]);

      await recordAudit(
        kv,
        "belief_project",
        "mem::belief-project",
        beliefs.map((belief) => belief.id),
        {
          project,
          projects,
          memoryIds,
          force: Boolean(data.force),
          beliefCount: beliefs.length,
        },
      );
      logger.info("Beliefs projected", { project, projects, beliefCount: beliefs.length });
      return {
        success: true,
        beliefCount: beliefs.length,
        updatedBeliefIds: beliefs.map((belief) => belief.id),
      };
    },
  );

  sdk.registerFunction(
    "mem::belief-list",
    async (data: { project?: string; status?: string; limit?: number }) => {
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : "*";
      let beliefs =
        project === "*"
          ? await kv.list<Belief>(KV.beliefs).catch(() => [])
          : (await kv.list<Belief>(KV.beliefs).catch(() => [])).filter(
              (belief) => belief.project === project,
            );
      if (beliefs.length === 0) {
        const projects = await projectsToDerive(kv, project);
        beliefs = (await deriveBeliefsForProjects(kv, projects)).beliefs;
      }

      const validStatuses = new Set<Belief["status"]>([
        "active",
        "uncertain",
        "contradicted",
        "superseded",
      ]);
      const requestedStatus =
        typeof data.status === "string" && validStatuses.has(data.status as Belief["status"])
          ? (data.status as Belief["status"])
          : undefined;
      beliefs = requestedStatus
        ? beliefs.filter((belief) => belief.status === requestedStatus)
        : beliefs.filter((belief) => belief.status === "active");
      beliefs = sortBeliefs(beliefs);

      const limit =
        typeof data.limit === "number" && data.limit > 0
          ? Math.min(data.limit, 100)
          : 20;
      return {
        success: true,
        beliefs: beliefs.slice(0, limit),
        projections: beliefs.slice(0, limit).map(beliefProjection),
      };
    },
  );

  sdk.registerFunction(
    "mem::belief-get",
    async (data: { beliefId: string }) => {
      if (!data.beliefId || typeof data.beliefId !== "string") {
        return { success: false, error: "beliefId is required" };
      }

      const details = await getBeliefDetails(kv, data.beliefId);
      if (!details) {
        return { success: false, error: "belief not found" };
      }

      const supportingMemories = await Promise.all(
        details.belief.supportingMemoryIds.map((memoryId) => kv.get<Memory>(KV.memories, memoryId)),
      );
      const contradictingMemories = await Promise.all(
        details.belief.contradictingMemoryIds.map((memoryId) => kv.get<Memory>(KV.memories, memoryId)),
      );

      return {
        success: true,
        belief: details.belief,
        projection: beliefProjection(details.belief),
        supportingMemories: supportingMemories.filter(
          (memory): memory is Memory => Boolean(memory),
        ),
        contradictingMemories: contradictingMemories.filter(
          (memory): memory is Memory => Boolean(memory),
        ),
        evidence: details.evidence,
      };
    },
  );
}
