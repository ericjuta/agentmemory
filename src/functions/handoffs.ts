import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type {
  Action,
  Checkpoint,
  CompressedObservation,
  HandoffPacket,
  Mission,
  Session,
  SessionSummary,
  SessionWorkingSet,
  Sentinel,
  TurnCapsule,
} from "../types.js";
import { recordAudit } from "./audit.js";
import { listProjectedBeliefs } from "./beliefs.js";
import { upsertHandoffRetrievalBlock } from "./retrieval-blocks.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sortByTimestamp<T extends { updatedAt?: string; createdAt?: string; timestamp?: string }>(
  items: T[],
): T[] {
  return items
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt || a.timestamp || 0).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt || b.timestamp || 0).getTime();
      return bTime - aTime;
    });
}

async function findObservations(
  kv: StateKV,
  observationIds: string[],
  project?: string,
): Promise<CompressedObservation[]> {
  if (observationIds.length === 0) return [];
  const wanted = new Set(observationIds);
  const sessions = (await kv.list<Session>(KV.sessions).catch(() => []))
    .filter((session) => !project || session.project === project);
  const buckets = await Promise.all(
    sessions.map((session) =>
      kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []),
    ),
  );
  return sortByTimestamp(
    buckets
      .flatMap((bucket) => bucket)
      .filter((observation) => wanted.has(observation.id)),
  );
}

async function latestProjectCapsule(
  kv: StateKV,
  project: string,
  sessionId?: string,
): Promise<TurnCapsule | null> {
  const capsules = await kv.list<TurnCapsule>(KV.turnCapsules).catch(() => []);
  return (
    sortByTimestamp(
      capsules.filter(
        (capsule) =>
          capsule.project === project &&
          (!sessionId || capsule.sessionId === sessionId),
      ),
    )[0] || null
  );
}

function recentChangesFromObservations(
  observations: CompressedObservation[],
  capsule: TurnCapsule | null,
  summary: SessionSummary | null,
  action: Action | null,
): string[] {
  return uniqueStrings([
    capsule?.assistantConclusion || "",
    ...(summary?.keyDecisions || []),
    action?.result ? `Action result: ${action.result}` : "",
    ...observations
      .slice(0, 5)
      .map((observation) => `[${observation.type}] ${observation.title}: ${observation.narrative}`),
  ]).slice(0, 6);
}

function blockersFromState(
  action: Action | null,
  checkpoints: Checkpoint[],
  sentinels: Sentinel[],
  missionBlockers: string[] = [],
): string[] {
  return uniqueStrings([
    ...(action?.status === "blocked" ? [`Action blocked: ${action.title}`] : []),
    ...missionBlockers,
    ...checkpoints
      .filter((checkpoint) => checkpoint.status !== "passed")
      .map((checkpoint) => `Checkpoint ${checkpoint.status}: ${checkpoint.name}`),
    ...sentinels
      .filter((sentinel) => sentinel.status === "triggered")
      .map((sentinel) => `Sentinel triggered: ${sentinel.name}`),
  ]).slice(0, 6);
}

function openQuestionsFromBlockers(blockers: string[]): string[] {
  return blockers
    .slice(0, 3)
    .map((blocker) => `What clears ${blocker.toLowerCase()}?`);
}

async function buildSessionPacket(
  sdk: ISdk,
  kv: StateKV,
  session: Session,
): Promise<Omit<HandoffPacket, "id" | "createdAt" | "updatedAt">> {
  const workingSet = await kv
    .get<SessionWorkingSet>(KV.workingSets, session.id)
    .catch(() => null);
  const summary = await kv
    .get<SessionSummary>(KV.summaries, session.id)
    .catch(() => null);
  const capsule =
    workingSet?.latestCompletedCapsule ||
    (await latestProjectCapsule(kv, session.project, session.id));
  const observationIds = uniqueStrings([
    ...(workingSet?.latestImportantObservationIds || []),
    ...(capsule?.sourceObservationIds || []),
  ]);
  const observations = await findObservations(kv, observationIds, session.project);
  const beliefs = (await listProjectedBeliefs(kv, session.project).catch(() => []))
    .filter((belief) => belief.status === "active")
    .slice(0, 5);
  const checkpoints = (await kv.list<Checkpoint>(KV.checkpoints).catch(() => []))
    .filter((checkpoint) => checkpoint.status !== "passed");
  const sentinels = (await kv.list<Sentinel>(KV.sentinels).catch(() => []))
    .filter((sentinel) => sentinel.status === "triggered");
  const next = (await sdk.trigger({
    function_id: "mem::next",
    payload: { project: session.project },
  }).catch(() => ({ success: false, suggestion: null }))) as {
    suggestion?: { title?: string; description?: string } | null;
  };
  const blockers = blockersFromState(null, checkpoints, sentinels);

  return {
    project: session.project,
    scopeType: "session",
    scopeId: session.id,
    summary:
      workingSet?.latestAssistantConclusion ||
      summary?.narrative ||
      `Resume session ${session.id} for ${session.project}.`,
    recentChanges: recentChangesFromObservations(observations, capsule, summary, null),
    knownFacts: uniqueStrings([
      ...beliefs.map((belief) => belief.claim),
      ...(summary?.keyDecisions || []),
    ]).slice(0, 6),
    relevantFiles: uniqueStrings([
      ...(workingSet?.latestImportantFiles || []),
      ...(capsule?.files || []),
      ...observations.flatMap((observation) => observation.files),
      ...(summary?.filesModified || []),
    ]).slice(0, 8),
    relevantConcepts: uniqueStrings([
      ...(workingSet?.latestImportantConcepts || []),
      ...(capsule?.concepts || []),
      ...observations.flatMap((observation) => observation.concepts),
      ...beliefs.flatMap((belief) => belief.concepts),
      ...(summary?.concepts || []),
    ]).slice(0, 10),
    blockers,
    openQuestions: openQuestionsFromBlockers(blockers),
    recommendedNextStep:
      next.suggestion?.title ||
      "Review the latest turn capsule and continue the most recent active work.",
    confidence: summary ? 0.8 : workingSet ? 0.7 : 0.5,
    sourceObservationIds: observationIds,
    sourceActionIds: [],
    sourceBeliefIds: beliefs.map((belief) => belief.beliefId),
  };
}

async function buildActionPacket(
  sdk: ISdk,
  kv: StateKV,
  action: Action,
  project?: string,
): Promise<Omit<HandoffPacket, "id" | "createdAt" | "updatedAt">> {
  const resolvedProject = project || action.project || "";
  const observations = await findObservations(
    kv,
    action.sourceObservationIds,
    resolvedProject || undefined,
  );
  const capsule = resolvedProject
    ? await latestProjectCapsule(kv, resolvedProject)
    : null;
  const checkpoints = (await kv.list<Checkpoint>(KV.checkpoints).catch(() => []))
    .filter((checkpoint) => checkpoint.linkedActionIds.includes(action.id));
  const sentinels = (await kv.list<Sentinel>(KV.sentinels).catch(() => []))
    .filter((sentinel) => sentinel.linkedActionIds.includes(action.id));
  const beliefs = resolvedProject
    ? (await listProjectedBeliefs(kv, resolvedProject).catch(() => []))
        .filter((belief) => belief.status === "active")
        .slice(0, 4)
    : [];
  const next = resolvedProject
    ? ((await sdk.trigger({
        function_id: "mem::next",
        payload: { project: resolvedProject },
      }).catch(() => ({ success: false, suggestion: null }))) as {
        suggestion?: { title?: string } | null;
      })
    : { suggestion: null };
  const blockers = blockersFromState(action, checkpoints, sentinels);

  return {
    project: resolvedProject || action.project || "unknown",
    scopeType: "action",
    scopeId: action.id,
    summary: `Action ${action.status}: ${action.title}${action.result ? ` (${action.result})` : ""}`,
    recentChanges: recentChangesFromObservations(observations, capsule, null, action),
    knownFacts: uniqueStrings([
      action.description,
      ...beliefs.map((belief) => belief.claim),
    ]).slice(0, 6),
    relevantFiles: uniqueStrings([
      ...(capsule?.files || []),
      ...observations.flatMap((observation) => observation.files),
    ]).slice(0, 8),
    relevantConcepts: uniqueStrings([
      ...action.tags,
      ...(capsule?.concepts || []),
      ...observations.flatMap((observation) => observation.concepts),
      ...beliefs.flatMap((belief) => belief.concepts),
    ]).slice(0, 10),
    blockers,
    openQuestions: openQuestionsFromBlockers(blockers),
    recommendedNextStep:
      action.status === "done"
        ? next.suggestion?.title || "Review the next unblocked action in the project."
        : `Continue action: ${action.title}`,
    confidence: action.status === "done" ? 0.85 : blockers.length > 0 ? 0.45 : 0.65,
    sourceObservationIds: uniqueStrings([
      ...action.sourceObservationIds,
      ...(capsule?.sourceObservationIds || []),
    ]),
    sourceActionIds: [action.id],
    sourceBeliefIds: beliefs.map((belief) => belief.beliefId),
  };
}

async function buildMissionPacket(
  sdk: ISdk,
  kv: StateKV,
  missionId: string,
): Promise<Omit<HandoffPacket, "id" | "createdAt" | "updatedAt">> {
  const missionResult = (await sdk.trigger({
    function_id: "mem::mission-get",
    payload: { missionId },
  })) as {
    success: boolean;
    mission: Mission;
    actions: Action[];
    checkpoints: Checkpoint[];
    sentinels: Sentinel[];
    statusSummary: { blockers: string[]; derivedSummary: string };
  };

  if (!missionResult?.success || !missionResult.mission) {
    throw new Error("mission not found");
  }

  const mission = missionResult.mission;
  const observations = await findObservations(
    kv,
    missionResult.actions.flatMap((action) => action.sourceObservationIds),
    mission.project,
  );
  const capsule = await latestProjectCapsule(kv, mission.project);
  const beliefs = (await listProjectedBeliefs(kv, mission.project).catch(() => []))
    .filter((belief) => belief.status === "active")
    .slice(0, 5);
  const nextAction =
    sortByTimestamp(
      missionResult.actions.filter(
        (action) => action.status === "active" || action.status === "pending",
      ),
    )[0] || null;
  const blockers = blockersFromState(
    null,
    missionResult.checkpoints,
    missionResult.sentinels,
    missionResult.statusSummary.blockers,
  );

  return {
    project: mission.project,
    scopeType: "mission",
    scopeId: mission.id,
    summary: mission.summary || missionResult.statusSummary.derivedSummary,
    recentChanges: uniqueStrings([
      mission.summary,
      missionResult.statusSummary.derivedSummary,
      ...recentChangesFromObservations(observations, capsule, null, nextAction),
    ]).slice(0, 6),
    knownFacts: uniqueStrings([
      ...mission.successCriteria,
      ...beliefs.map((belief) => belief.claim),
    ]).slice(0, 6),
    relevantFiles: uniqueStrings([
      ...(capsule?.files || []),
      ...observations.flatMap((observation) => observation.files),
    ]).slice(0, 8),
    relevantConcepts: uniqueStrings([
      ...(capsule?.concepts || []),
      ...observations.flatMap((observation) => observation.concepts),
      ...beliefs.flatMap((belief) => belief.concepts),
    ]).slice(0, 10),
    blockers,
    openQuestions: openQuestionsFromBlockers(blockers),
    recommendedNextStep:
      nextAction?.title ||
      "Review the mission blockers and resume the next unblocked linked action.",
    confidence: mission.confidence,
    sourceObservationIds: uniqueStrings(
      missionResult.actions.flatMap((action) => action.sourceObservationIds),
    ),
    sourceActionIds: missionResult.actions.map((action) => action.id),
    sourceBeliefIds: beliefs.map((belief) => belief.beliefId),
  };
}

export function registerHandoffsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::handoff-generate",
    async (data: {
      scopeType: HandoffPacket["scopeType"];
      scopeId: string;
      project?: string;
      deliverTo?: string;
      from?: string;
      threadId?: string;
      expiresInMs?: number;
    }) => {
      if (!data.scopeType || !data.scopeId) {
        return { success: false, error: "scopeType and scopeId are required" };
      }

      const now = new Date().toISOString();
      const packetBase =
        data.scopeType === "session"
          ? await buildSessionPacket(
              sdk,
              kv,
              (await kv.get<Session>(KV.sessions, data.scopeId)) || (() => {
                throw new Error("session not found");
              })(),
            )
          : data.scopeType === "action"
            ? await buildActionPacket(
                sdk,
                kv,
                (await kv.get<Action>(KV.actions, data.scopeId)) || (() => {
                  throw new Error("action not found");
                })(),
                data.project,
              )
            : await buildMissionPacket(sdk, kv, data.scopeId);

      const packet: HandoffPacket = {
        id: generateId("hdf"),
        createdAt: now,
        updatedAt: now,
        ...packetBase,
      };

      await kv.set(KV.handoffPackets, packet.id, packet);
      await upsertHandoffRetrievalBlock(kv, packet);
      await recordAudit(kv, "handoff_generate", "mem::handoff-generate", [packet.id], {
        scopeType: packet.scopeType,
        scopeId: packet.scopeId,
        project: packet.project,
      });

      if (packet.scopeType === "mission") {
        await withKeyedLock(`mem:mission:${packet.scopeId}`, async () => {
          const mission = await kv.get<Mission>(KV.missions, packet.scopeId);
          if (!mission) return;
          mission.latestHandoffPacketId = packet.id;
          mission.updatedAt = now;
          await kv.set(KV.missions, mission.id, mission);
          await recordAudit(kv, "mission_update", "mem::handoff-generate", [mission.id], {
            latestHandoffPacketId: packet.id,
          });
        });
      }

      let signal = null;
      if (data.deliverTo && data.from) {
        const result = await sdk.trigger({
          function_id: "mem::signal-send",
          payload: {
            from: data.from,
            to: data.deliverTo,
            type: "handoff",
            content: packet.summary,
            threadId: data.threadId,
            metadata: {
              handoffPacketId: packet.id,
              scopeType: packet.scopeType,
              scopeId: packet.scopeId,
            },
            expiresInMs: data.expiresInMs,
          },
        });
        signal = (result as { signal?: unknown }).signal || null;
      }

      return { success: true, handoffPacket: packet, signal };
    },
  );

  sdk.registerFunction(
    "mem::handoff-get",
    async (data: { handoffPacketId: string }) => {
      if (!data.handoffPacketId) {
        return { success: false, error: "handoffPacketId is required" };
      }
      const handoffPacket = await kv.get<HandoffPacket>(KV.handoffPackets, data.handoffPacketId);
      if (!handoffPacket) {
        return { success: false, error: "handoff packet not found" };
      }
      return { success: true, handoffPacket };
    },
  );

  sdk.registerFunction(
    "mem::handoff-list",
    async (data: {
      scopeType?: HandoffPacket["scopeType"];
      scopeId?: string;
      project?: string;
      limit?: number;
    }) => {
      let packets = await kv.list<HandoffPacket>(KV.handoffPackets).catch(() => []);
      if (data.scopeType) {
        packets = packets.filter((packet) => packet.scopeType === data.scopeType);
      }
      if (data.scopeId) {
        packets = packets.filter((packet) => packet.scopeId === data.scopeId);
      }
      if (data.project) {
        packets = packets.filter((packet) => packet.project === data.project);
      }
      return {
        success: true,
        handoffPackets: sortByTimestamp(packets).slice(0, data.limit || 20),
      };
    },
  );
}
