// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import { describe, expect, it } from "vitest";
import type {
  Memory,
  CompressedObservation,
  GraphNode,
  ProceduralMemory,
  ProjectProfile,
  SemanticMemory,
  Session,
  SessionSummary,
  SessionWorkingSet,
  TurnCapsule,
} from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { registerBeliefsFunctions } from "../src/functions/beliefs.js";
import { registerContextFunction } from "../src/functions/context.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("context freshness", () => {
  it("prefers the current session turn capsule over older summaries", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 800);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T10:00:00.000Z",
      status: "active",
      observationCount: 2,
    };
    const oldSession: Session = {
      id: "session-old",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-27T10:00:00.000Z",
      status: "completed",
      observationCount: 3,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);
    await kv.set(KV.sessions, oldSession.id, oldSession);

    const capsule: TurnCapsule = {
      id: "session-current:turn-1",
      sessionId: "session-current",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T10:00:01.000Z",
      updatedAt: "2026-03-28T10:00:02.000Z",
      userPrompt: "Fix retrieval freshness",
      assistantConclusion: "Turn capsules now drive same-session freshness.",
      files: ["/project/src/context.ts"],
      concepts: ["turn capsules"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs-1", "obs-2"],
      importantObservationIds: ["obs-2"],
      maxImportance: 8,
    };
    await kv.set(KV.turnCapsules, capsule.id, capsule);

    const summary: SessionSummary = {
      sessionId: "session-old",
      project: "/project",
      createdAt: "2026-03-27T10:30:00.000Z",
      title: "Older session summary",
      narrative: "An older summary should not displace the current turn capsule.",
      keyDecisions: ["Used summaries for old context"],
      filesModified: ["/project/src/legacy.ts"],
      concepts: ["summaries"],
      observationCount: 3,
    };
    await kv.set(KV.summaries, summary.sessionId, summary);

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 800,
    })) as { context: string };

    expect(result.context).toContain("## Current Turn");
    expect(result.context).toContain("Fix retrieval freshness");
    expect(result.context).toContain(
      "Turn capsules now drive same-session freshness.",
    );
    expect(result.context).toContain("Older session summary");
  });

  it("includes recent same-project capsules from other sessions", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 800);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T10:00:00.000Z",
      status: "active",
      observationCount: 0,
    };
    const recentSession: Session = {
      id: "session-recent",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T09:45:00.000Z",
      status: "completed",
      observationCount: 4,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);
    await kv.set(KV.sessions, recentSession.id, recentSession);

    const capsule: TurnCapsule = {
      id: "session-recent:turn-9",
      sessionId: "session-recent",
      turnId: "turn-9",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T09:45:01.000Z",
      updatedAt: "2026-03-28T09:45:03.000Z",
      userPrompt: "Investigate graph freshness",
      assistantConclusion: "Recent session freshness now uses turn-centric context.",
      files: ["/project/src/triggers/api.ts"],
      concepts: ["freshness"],
      hadFailure: false,
      hadDecision: false,
      sourceObservationIds: ["obs-recent"],
      importantObservationIds: ["obs-recent"],
      maxImportance: 7,
    };
    await kv.set(KV.turnCapsules, capsule.id, capsule);

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 800,
    })) as { context: string };

    expect(result.context).toContain("Recent Turn turn-9");
    expect(result.context).toContain(
      "Recent session freshness now uses turn-centric context.",
    );
  });

  it("deduplicates warm observations already covered by a capsule", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 800);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T10:00:00.000Z",
      status: "active",
      observationCount: 2,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);

    const capsule: TurnCapsule = {
      id: "session-current:turn-1",
      sessionId: "session-current",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T10:00:01.000Z",
      updatedAt: "2026-03-28T10:00:03.000Z",
      userPrompt: "Debug duplicate observations",
      assistantConclusion: "Capsule should suppress duplicate warm observations.",
      files: [],
      concepts: [],
      hadFailure: false,
      hadDecision: false,
      sourceObservationIds: ["obs-dup"],
      importantObservationIds: ["obs-dup"],
      maxImportance: 7,
    };
    await kv.set(KV.turnCapsules, capsule.id, capsule);

    const duplicateObservation: CompressedObservation = {
      id: "obs-dup",
      sessionId: "session-current",
      turnId: "turn-1",
      timestamp: "2026-03-28T10:00:02.000Z",
      type: "task",
      title: "Duplicate warm observation",
      facts: [],
      narrative: "This should be skipped because the capsule already covers it.",
      concepts: [],
      files: [],
      importance: 8,
    };
    const distinctObservation: CompressedObservation = {
      id: "obs-distinct",
      sessionId: "session-current",
      turnId: "turn-2",
      timestamp: "2026-03-28T10:00:04.000Z",
      type: "error",
      title: "Distinct warm observation",
      facts: [],
      narrative: "This should remain as warm supplemental context.",
      concepts: [],
      files: [],
      importance: 8,
    };
    await kv.set(KV.observations(currentSession.id), "obs-dup", duplicateObservation);
    await kv.set(
      KV.observations(currentSession.id),
      "obs-distinct",
      distinctObservation,
    );

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 800,
    })) as { context: string };

    expect(result.context).not.toContain("Duplicate warm observation");
    expect(result.context).toContain("Distinct warm observation");
  });

  it("keeps durable memory alongside fresh context", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T10:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);

    const capsule: TurnCapsule = {
      id: "session-current:turn-1",
      sessionId: "session-current",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T10:00:01.000Z",
      updatedAt: "2026-03-28T10:00:02.000Z",
      userPrompt: "Improve freshness",
      assistantConclusion: "Fresh context should coexist with durable memory.",
      files: ["/project/src/functions/context.ts"],
      concepts: ["freshness"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs-1"],
      importantObservationIds: ["obs-1"],
      maxImportance: 8,
    };
    await kv.set(KV.turnCapsules, capsule.id, capsule);

    const profile: ProjectProfile = {
      project: "/project",
      updatedAt: "2026-03-28T09:00:00.000Z",
      topConcepts: [{ concept: "freshness", frequency: 5 }],
      topFiles: [{ file: "/project/src/functions/context.ts", frequency: 4 }],
      conventions: ["TypeScript project"],
      commonErrors: [],
      recentActivity: ["Updated retrieval freshness"],
      sessionCount: 5,
      totalObservations: 100,
    };
    await kv.set(KV.profiles, profile.project, profile);

    const semantic: SemanticMemory = {
      id: "sem-1",
      fact: "Recent turn context should not depend on consolidation.",
      confidence: 0.9,
      sourceSessionIds: ["session-old"],
      sourceMemoryIds: [],
      accessCount: 1,
      lastAccessedAt: "2026-03-28T09:30:00.000Z",
      strength: 0.8,
      createdAt: "2026-03-28T09:00:00.000Z",
      updatedAt: "2026-03-28T09:30:00.000Z",
    };
    await kv.set(KV.semantic, semantic.id, semantic);

    const procedural: ProceduralMemory = {
      id: "proc-1",
      name: "Investigate retrieval freshness",
      steps: ["Inspect recent observations", "Prefer current turn capsule"],
      triggerCondition: "when follow-up recall misses fresh work",
      frequency: 2,
      sourceSessionIds: ["session-old"],
      strength: 0.7,
      createdAt: "2026-03-28T09:00:00.000Z",
      updatedAt: "2026-03-28T09:45:00.000Z",
    };
    await kv.set(KV.procedural, procedural.id, procedural);

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 900,
    })) as { context: string };

    expect(result.context).toContain("## Current Turn");
    expect(result.context).toContain("## Project Profile");
    expect(result.context).toContain("## Semantic Memory");
    expect(result.context).toContain("## Procedural Memory");
  });

  it("includes the session working set as immediate hot-lane context", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 700);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T10:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);

    const capsule: TurnCapsule = {
      id: "session-current:turn-3",
      sessionId: "session-current",
      turnId: "turn-3",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T10:00:01.000Z",
      updatedAt: "2026-03-28T10:00:03.000Z",
      userPrompt: "What just happened?",
      assistantConclusion: "The latest turn snapshot is available immediately.",
      files: ["/project/src/functions/working-set.ts"],
      concepts: ["working set"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs-3"],
      importantObservationIds: ["obs-3"],
      maxImportance: 8,
    };
    const workingSet: SessionWorkingSet = {
      sessionId: "session-current",
      project: "/project",
      cwd: "/project",
      updatedAt: "2026-03-28T10:00:04.000Z",
      latestTurnId: "turn-3",
      latestCompletedTurnId: "turn-3",
      latestCompletedCapsule: capsule,
      latestAssistantConclusion:
        "The latest turn snapshot is available immediately.",
      latestImportantFiles: ["/project/src/functions/working-set.ts"],
      latestImportantConcepts: ["working set"],
      latestImportantObservationIds: ["obs-3"],
      latestHadFailure: false,
      latestHadDecision: true,
    };
    await kv.set(KV.workingSets, currentSession.id, workingSet);

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 700,
    })) as { context: string };

    expect(result.context).toContain("What just happened?");
    expect(result.context).toContain(
      "The latest turn snapshot is available immediately.",
    );
  });

  it("uses graph expansion as supplemental warm context", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T10:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    const recentSession: Session = {
      id: "session-recent",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-28T09:50:00.000Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);
    await kv.set(KV.sessions, recentSession.id, recentSession);

    const capsule: TurnCapsule = {
      id: "session-current:turn-1",
      sessionId: "session-current",
      turnId: "turn-1",
      project: "/project",
      cwd: "/project",
      createdAt: "2026-03-28T10:00:01.000Z",
      updatedAt: "2026-03-28T10:00:02.000Z",
      userPrompt: "Use graph support for freshness",
      assistantConclusion: "Graph should stay supplemental.",
      files: ["/project/src/functions/context.ts"],
      concepts: ["freshness graph"],
      hadFailure: false,
      hadDecision: true,
      sourceObservationIds: ["obs-current"],
      importantObservationIds: ["obs-current"],
      maxImportance: 8,
    };
    await kv.set(KV.turnCapsules, capsule.id, capsule);

    const relatedObservation: CompressedObservation = {
      id: "obs-graph",
      sessionId: "session-recent",
      turnId: "turn-9",
      timestamp: "2026-03-28T09:50:03.000Z",
      type: "decision",
      title: "Graph-linked freshness detail",
      facts: [],
      narrative: "Graph expansion found a related observation.",
      concepts: ["freshness graph"],
      files: ["/project/src/functions/graph-retrieval.ts"],
      importance: 7,
    };
    await kv.set(
      KV.observations(recentSession.id),
      relatedObservation.id,
      relatedObservation,
    );

    const startNode: GraphNode = {
      id: "node-current",
      type: "concept",
      name: "freshness seed",
      properties: {},
      sourceObservationIds: ["obs-current"],
      createdAt: "2026-03-28T10:00:01.000Z",
    };
    const relatedNode: GraphNode = {
      id: "node-related",
      type: "concept",
      name: "freshness graph",
      properties: {},
      sourceObservationIds: ["obs-graph"],
      createdAt: "2026-03-28T09:50:02.000Z",
    };
    await kv.set(KV.graphNodes, startNode.id, startNode);
    await kv.set(KV.graphNodes, relatedNode.id, relatedNode);
    await kv.set(KV.graphEdges, "edge-1", {
      id: "edge-1",
      type: "related_to",
      sourceNodeId: startNode.id,
      targetNodeId: relatedNode.id,
      weight: 0.9,
      sourceObservationIds: ["obs-current", "obs-graph"],
      createdAt: "2026-03-28T09:50:04.000Z",
    });

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 900,
    })) as { context: string };

    expect(result.context).toContain("Graph-linked freshness detail");
    expect(result.context).toContain(
      "Graph: [concept] freshness seed [concept] freshness graph --related_to-->",
    );
  });

  it("uses an optional query to rank matching context higher", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerContextFunction(sdk as never, kv as never, 900);

    const currentSession: Session = {
      id: "session-current",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T10:00:00.000Z",
      status: "active",
      observationCount: 2,
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);

    const matchingObservation: CompressedObservation = {
      id: "obs-match",
      sessionId: "session-current",
      turnId: "turn-1",
      timestamp: "2026-03-29T10:00:02.000Z",
      type: "discovery",
      title: "Graph retrieval implementation detail",
      facts: [],
      narrative: "Updated /project/src/functions/graph-retrieval.ts for Codex ranking.",
      concepts: ["graph retrieval", "codex ranking"],
      files: ["/project/src/functions/graph-retrieval.ts"],
      importance: 6,
    };
    const otherObservation: CompressedObservation = {
      id: "obs-other",
      sessionId: "session-current",
      turnId: "turn-2",
      timestamp: "2026-03-29T10:00:03.000Z",
      type: "task",
      title: "General memory status update",
      facts: [],
      narrative: "Reviewed memory health and service status.",
      concepts: ["service health"],
      files: ["/project/README.md"],
      importance: 6,
    };
    await kv.set(
      KV.observations(currentSession.id),
      matchingObservation.id,
      matchingObservation,
    );
    await kv.set(
      KV.observations(currentSession.id),
      otherObservation.id,
      otherObservation,
    );

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 900,
      query: "graph-retrieval.ts codex ranking",
    })) as { context: string };

    const matchIndex = result.context.indexOf("Graph retrieval implementation detail");
    const otherIndex = result.context.indexOf("General memory status update");
    expect(matchIndex).toBeGreaterThan(-1);
    expect(otherIndex).toBeGreaterThan(-1);
    expect(matchIndex).toBeLessThan(otherIndex);
  });

  it("surfaces active beliefs ahead of plain memories when the query overlaps", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerBeliefsFunctions(sdk as never, kv as never);
    registerContextFunction(sdk as never, kv as never, 1000);

    const currentSession: Session = {
      id: "session-belief",
      project: "/project",
      cwd: "/project",
      startedAt: "2026-03-29T11:00:00.000Z",
      status: "active",
      observationCount: 1,
    };
    const memory: Memory = {
      id: "mem-parser",
      createdAt: "2026-03-29T11:00:01.000Z",
      updatedAt: "2026-03-29T11:00:01.000Z",
      type: "fact",
      title: "Parser choice",
      content: "Use parser Y for ingest.",
      concepts: ["parser", "ingest"],
      files: ["/project/src/parser.ts"],
      sessionIds: [currentSession.id],
      strength: 8,
      version: 1,
      isLatest: true,
      sourceObservationIds: [],
    };
    await kv.set(KV.sessions, currentSession.id, currentSession);
    await kv.set(KV.memories, memory.id, memory);
    await sdk.trigger("mem::belief-project", { project: "/project" });

    const result = (await sdk.trigger("mem::context", {
      sessionId: currentSession.id,
      project: "/project",
      budget: 1000,
      query: "parser Y ingest",
    })) as { context: string };

    const beliefIndex = result.context.indexOf("## Current Belief");
    const memoryIndex = result.context.indexOf("## Fact Memory: Parser choice");
    expect(result.context).toContain("Use parser Y for ingest.");
    expect(beliefIndex).toBeGreaterThan(-1);
    expect(memoryIndex).toBeGreaterThan(-1);
    expect(beliefIndex).toBeLessThan(memoryIndex);
  });
});
