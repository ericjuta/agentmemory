import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type {
  Action,
  Checkpoint,
  HandoffPacket,
  Lease,
  Mission,
  MissionRun,
  MissionStatusSummary,
  Routine,
  RoutineRun,
  Sentinel,
} from "../types.js";
import { recordAudit } from "./audit.js";

type MissionProjection = {
  mission: Mission;
  actions: Action[];
  checkpoints: Checkpoint[];
  sentinels: Sentinel[];
  leases: Lease[];
  routines: Routine[];
  latestRoutineRuns: RoutineRun[];
  statusSummary: MissionStatusSummary;
};

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function actionCountRecord(): Record<Action["status"], number> {
  return {
    pending: 0,
    active: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
  };
}

function checkpointCountRecord(): Record<Checkpoint["status"], number> {
  return {
    pending: 0,
    passed: 0,
    failed: 0,
    expired: 0,
  };
}

function sentinelCountRecord(): Record<Sentinel["status"], number> {
  return {
    watching: 0,
    triggered: 0,
    cancelled: 0,
    expired: 0,
  };
}

function leaseCountRecord(): Record<Lease["status"], number> {
  return {
    active: 0,
    expired: 0,
    released: 0,
  };
}

function routineRunCountRecord(): Record<RoutineRun["status"], number> {
  return {
    running: 0,
    completed: 0,
    failed: 0,
    paused: 0,
  };
}

function sortByMostRecent<T extends { updatedAt?: string; createdAt?: string }>(
  items: T[],
): T[] {
  return items
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    });
}

function latestRoutineRuns(runs: RoutineRun[]): RoutineRun[] {
  const latestByRoutine = new Map<string, RoutineRun>();
  for (const run of runs) {
    const existing = latestByRoutine.get(run.routineId);
    if (!existing) {
      latestByRoutine.set(run.routineId, run);
      continue;
    }
    const existingTime = new Date(existing.completedAt || existing.startedAt).getTime();
    const runTime = new Date(run.completedAt || run.startedAt).getTime();
    if (runTime > existingTime) {
      latestByRoutine.set(run.routineId, run);
    }
  }
  return [...latestByRoutine.values()];
}

function deriveMissionSummary(
  mission: Mission,
  blockers: string[],
  actionCounts: Record<Action["status"], number>,
  checkpointCounts: Record<Checkpoint["status"], number>,
  sentinelCounts: Record<Sentinel["status"], number>,
): string {
  const segments = [
    `${actionCounts.done}/${Object.values(actionCounts).reduce((sum, count) => sum + count, 0)} actions done`,
  ];
  if (checkpointCounts.pending > 0) {
    segments.push(`${checkpointCounts.pending} checkpoints pending`);
  }
  if (sentinelCounts.triggered > 0) {
    segments.push(`${sentinelCounts.triggered} sentinels triggered`);
  }
  if (blockers.length > 0) {
    segments.push(`${blockers.length} blockers`);
  }
  return `${mission.goal} (${segments.join(", ")})`;
}

function deriveMissionStatus(
  mission: Mission,
  actions: Action[],
  checkpoints: Checkpoint[],
  sentinels: Sentinel[],
  leases: Lease[],
  routineRuns: RoutineRun[],
): MissionStatusSummary {
  const actionCounts = actionCountRecord();
  const checkpointCounts = checkpointCountRecord();
  const sentinelCounts = sentinelCountRecord();
  const leaseCounts = leaseCountRecord();
  const routineRunCounts = routineRunCountRecord();

  for (const action of actions) actionCounts[action.status]++;
  for (const checkpoint of checkpoints) checkpointCounts[checkpoint.status]++;
  for (const sentinel of sentinels) sentinelCounts[sentinel.status]++;
  for (const lease of leases) leaseCounts[lease.status]++;
  for (const run of routineRuns) routineRunCounts[run.status]++;

  const blockers = [
    ...actions
      .filter((action) => action.status === "blocked")
      .map((action) => `Action blocked: ${action.title}`),
    ...checkpoints
      .filter((checkpoint) => checkpoint.status !== "passed")
      .map((checkpoint) => `Checkpoint ${checkpoint.status}: ${checkpoint.name}`),
    ...sentinels
      .filter((sentinel) => sentinel.status === "triggered")
      .map((sentinel) => `Sentinel triggered: ${sentinel.name}`),
    ...routineRuns
      .filter((run) => run.status === "failed" || run.status === "paused")
      .map((run) => `Routine run ${run.status}: ${run.id}`),
  ];

  let status: Mission["status"];
  if (mission.status === "cancelled") {
    status = "cancelled";
  } else if (blockers.length > 0) {
    status = "blocked";
  } else {
    const totalActions = Object.values(actionCounts).reduce((sum, count) => sum + count, 0);
    const allActionsDone =
      totalActions > 0 &&
      actionCounts.done === totalActions;
    if (allActionsDone) {
      status = "completed";
    } else if (totalActions === 0) {
      status = mission.status === "draft" ? "draft" : "active";
    } else {
      status = "active";
    }
  }

  return {
    status,
    blockers,
    actionCounts,
    checkpointCounts,
    sentinelCounts,
    leaseCounts,
    routineRunCounts,
    derivedSummary: deriveMissionSummary(
      mission,
      blockers,
      actionCounts,
      checkpointCounts,
      sentinelCounts,
    ),
  };
}

async function syncMissionRun(
  kv: StateKV,
  mission: Mission,
  actor: string,
  status: Mission["status"],
): Promise<void> {
  const runs = sortByMostRecent(
    (await kv.list<MissionRun>(KV.missionRuns)).filter(
      (run) => run.missionId === mission.id,
    ),
  );
  const activeRun = runs.find((run) => !run.endedAt);
  const now = new Date().toISOString();

  if (status === "active" || status === "blocked") {
    if (activeRun) {
      if (activeRun.status !== status) {
        activeRun.status = status;
        activeRun.updatedAt = now;
        activeRun.notes = uniqueIds([
          ...activeRun.notes,
          `Mission status projected to ${status} at ${now}`,
        ]);
        await kv.set(KV.missionRuns, activeRun.id, activeRun);
      }
      return;
    }

    const run: MissionRun = {
      id: generateId("mrn"),
      missionId: mission.id,
      startedAt: now,
      updatedAt: now,
      actor,
      status,
      notes: [`Mission run opened with status ${status}`],
    };
    await kv.set(KV.missionRuns, run.id, run);
    return;
  }

  if (!activeRun) return;

  activeRun.status = status === "completed" ? "completed" : "cancelled";
  activeRun.updatedAt = now;
  activeRun.endedAt = now;
  activeRun.notes = uniqueIds([
    ...activeRun.notes,
    `Mission run closed with status ${activeRun.status} at ${now}`,
  ]);
  await kv.set(KV.missionRuns, activeRun.id, activeRun);
}

async function projectMission(
  kv: StateKV,
  mission: Mission,
  actor: string,
): Promise<MissionProjection> {
  const [
    allActions,
    allCheckpoints,
    allSentinels,
    allLeases,
    allRoutines,
    allRoutineRuns,
  ] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
    kv.list<Sentinel>(KV.sentinels).catch(() => []),
    kv.list<Lease>(KV.leases).catch(() => []),
    kv.list<Routine>(KV.routines).catch(() => []),
    kv.list<RoutineRun>(KV.routineRuns).catch(() => []),
  ]);

  const actions = sortByMostRecent(
    allActions.filter(
      (action) =>
        action.missionId === mission.id || mission.actionIds.includes(action.id),
    ),
  );
  const actionIds = uniqueIds(actions.map((action) => action.id));

  const checkpoints = sortByMostRecent(
    allCheckpoints.filter(
      (checkpoint) =>
        checkpoint.missionId === mission.id ||
        mission.checkpointIds.includes(checkpoint.id) ||
        checkpoint.linkedActionIds.some((actionId) => actionIds.includes(actionId)),
    ),
  );

  const sentinels = sortByMostRecent(
    allSentinels.filter(
      (sentinel) =>
        sentinel.missionId === mission.id ||
        mission.sentinelIds.includes(sentinel.id) ||
        sentinel.linkedActionIds.some((actionId) => actionIds.includes(actionId)),
    ),
  );

  const leases = sortByMostRecent(
    allLeases.filter(
      (lease) =>
        lease.missionId === mission.id ||
        mission.leaseIds.includes(lease.id) ||
        actionIds.includes(lease.actionId),
    ),
  );

  const routines = sortByMostRecent(
    allRoutines.filter(
      (routine) =>
        routine.missionId === mission.id || mission.routineIds.includes(routine.id),
    ),
  );
  const routineIds = uniqueIds(routines.map((routine) => routine.id));
  const routineRuns = latestRoutineRuns(
    allRoutineRuns.filter((run) => routineIds.includes(run.routineId)),
  );

  const statusSummary = deriveMissionStatus(
    mission,
    actions,
    checkpoints,
    sentinels,
    leases,
    routineRuns,
  );
  const updatedMission: Mission = {
    ...mission,
    updatedAt: new Date().toISOString(),
    actionIds,
    checkpointIds: uniqueIds(checkpoints.map((checkpoint) => checkpoint.id)),
    sentinelIds: uniqueIds(sentinels.map((sentinel) => sentinel.id)),
    leaseIds: uniqueIds(leases.map((lease) => lease.id)),
    routineIds,
    status: statusSummary.status,
    summary: mission.summary || statusSummary.derivedSummary,
  };

  await kv.set(KV.missions, updatedMission.id, updatedMission);
  await syncMissionRun(kv, updatedMission, actor, statusSummary.status);

  return {
    mission: updatedMission,
    actions,
    checkpoints,
    sentinels,
    leases,
    routines,
    latestRoutineRuns: routineRuns,
    statusSummary,
  };
}

async function ensureLinkedHandoffExists(
  kv: StateKV,
  handoffPacketId: string | undefined,
): Promise<boolean> {
  if (!handoffPacketId) return true;
  const handoff = await kv
    .get<HandoffPacket>(KV.handoffPackets, handoffPacketId)
    .catch(() => null);
  return Boolean(handoff);
}

export function registerMissionsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::mission-create",
    async (data: {
      goal: string;
      project: string;
      cwd?: string;
      branch?: string;
      successCriteria?: string[];
      owner?: string;
      phase?: string;
      status?: Mission["status"];
      summary?: string;
      risk?: string;
      confidence?: number;
    }) => {
      if (!data.goal?.trim() || !data.project?.trim()) {
        return { success: false, error: "goal and project are required" };
      }

      return withKeyedLock("mem:missions", async () => {
        const now = new Date().toISOString();
        const mission: Mission = {
          id: generateId("msn"),
          createdAt: now,
          updatedAt: now,
          project: data.project.trim(),
          cwd: data.cwd?.trim() || undefined,
          branch: data.branch?.trim() || undefined,
          goal: data.goal.trim(),
          successCriteria: (data.successCriteria || []).filter(Boolean),
          status: data.status || "active",
          phase: data.phase?.trim() || "planned",
          owner: data.owner?.trim() || "unknown",
          summary: data.summary?.trim() || "",
          risk: data.risk?.trim() || "",
          confidence:
            typeof data.confidence === "number"
              ? Math.max(0, Math.min(1, data.confidence))
              : 0.5,
          actionIds: [],
          checkpointIds: [],
          sentinelIds: [],
          leaseIds: [],
          routineIds: [],
        };

        await kv.set(KV.missions, mission.id, mission);
        await recordAudit(kv, "mission_create", "mem::mission-create", [mission.id], {
          goal: mission.goal,
          project: mission.project,
          owner: mission.owner,
          status: mission.status,
        });

        const projection = await projectMission(kv, mission, mission.owner);
        return { success: true, mission: projection.mission, statusSummary: projection.statusSummary };
      });
    },
  );

  sdk.registerFunction(
    "mem::mission-update",
    async (data: {
      missionId: string;
      status?: Mission["status"];
      phase?: string;
      summary?: string;
      risk?: string;
      confidence?: number;
      owner?: string;
      successCriteria?: string[];
      actionIds?: string[];
      checkpointIds?: string[];
      sentinelIds?: string[];
      leaseIds?: string[];
      routineIds?: string[];
      latestHandoffPacketId?: string;
    }) => {
      if (!data.missionId) {
        return { success: false, error: "missionId is required" };
      }

      return withKeyedLock(`mem:mission:${data.missionId}`, async () => {
        const mission = await kv.get<Mission>(KV.missions, data.missionId);
        if (!mission) {
          return { success: false, error: "mission not found" };
        }

        if (!(await ensureLinkedHandoffExists(kv, data.latestHandoffPacketId))) {
          return { success: false, error: "latestHandoffPacketId not found" };
        }

        if (data.status !== undefined) mission.status = data.status;
        if (data.phase !== undefined) mission.phase = data.phase.trim();
        if (data.summary !== undefined) mission.summary = data.summary.trim();
        if (data.risk !== undefined) mission.risk = data.risk.trim();
        if (data.owner !== undefined) mission.owner = data.owner.trim() || mission.owner;
        if (data.confidence !== undefined) {
          mission.confidence = Math.max(0, Math.min(1, data.confidence));
        }
        if (data.successCriteria !== undefined) {
          mission.successCriteria = data.successCriteria.filter(Boolean);
        }
        if (data.actionIds !== undefined) mission.actionIds = uniqueIds(data.actionIds);
        if (data.checkpointIds !== undefined) {
          mission.checkpointIds = uniqueIds(data.checkpointIds);
        }
        if (data.sentinelIds !== undefined) {
          mission.sentinelIds = uniqueIds(data.sentinelIds);
        }
        if (data.leaseIds !== undefined) mission.leaseIds = uniqueIds(data.leaseIds);
        if (data.routineIds !== undefined) {
          mission.routineIds = uniqueIds(data.routineIds);
        }
        if (data.latestHandoffPacketId !== undefined) {
          mission.latestHandoffPacketId = data.latestHandoffPacketId;
        }
        mission.updatedAt = new Date().toISOString();

        await kv.set(KV.missions, mission.id, mission);
        await recordAudit(kv, "mission_update", "mem::mission-update", [mission.id], {
          status: mission.status,
          phase: mission.phase,
          owner: mission.owner,
        });

        const projection = await projectMission(kv, mission, mission.owner);
        return { success: true, mission: projection.mission, statusSummary: projection.statusSummary };
      });
    },
  );

  sdk.registerFunction(
    "mem::mission-get",
    async (data: { missionId: string }) => {
      if (!data.missionId) {
        return { success: false, error: "missionId is required" };
      }

      return withKeyedLock(`mem:mission:${data.missionId}`, async () => {
        const mission = await kv.get<Mission>(KV.missions, data.missionId);
        if (!mission) {
          return { success: false, error: "mission not found" };
        }

        const projection = await projectMission(kv, mission, mission.owner);
        return {
          success: true,
          mission: projection.mission,
          actions: projection.actions,
          checkpoints: projection.checkpoints,
          sentinels: projection.sentinels,
          leases: projection.leases,
          routines: projection.routines,
          latestRoutineRuns: projection.latestRoutineRuns,
          statusSummary: projection.statusSummary,
        };
      });
    },
  );

  sdk.registerFunction(
    "mem::mission-list",
    async (data: {
      project?: string;
      status?: Mission["status"];
      owner?: string;
      limit?: number;
    }) => {
      const missions = sortByMostRecent(await kv.list<Mission>(KV.missions).catch(() => []));
      const projected = await Promise.all(
        missions.map((mission) =>
          withKeyedLock(`mem:mission:${mission.id}`, async () =>
            projectMission(kv, mission, mission.owner),
          ),
        ),
      );

      let filtered = projected;
      if (data.project) {
        filtered = filtered.filter(({ mission }) => mission.project === data.project);
      }
      if (data.status) {
        filtered = filtered.filter(
          ({ mission, statusSummary }) =>
            mission.status === data.status || statusSummary.status === data.status,
        );
      }
      if (data.owner) {
        filtered = filtered.filter(({ mission }) => mission.owner === data.owner);
      }

      return {
        success: true,
        missions: filtered
          .sort(
            (a, b) =>
              new Date(b.mission.updatedAt).getTime() -
              new Date(a.mission.updatedAt).getTime(),
          )
          .slice(0, data.limit || 50)
          .map(({ mission, statusSummary }) => ({ mission, statusSummary })),
      };
    },
  );
}
