// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import {
  loadConfig,
  getEnvVar,
  loadEmbeddingConfig,
  loadFallbackConfig,
  loadClaudeBridgeConfig,
  loadTeamConfig,
  loadSnapshotConfig,
  isGraphExtractionEnabled,
  isAutoCompressEnabled,
  isConsolidationEnabled,
  isContextInjectionEnabled,
} from "./config.js";
import {
  createProvider,
  createFallbackProvider,
  createEmbeddingProvider,
} from "./providers/index.js";
import { StateKV } from "./state/kv.js";
import { KV } from "./state/schema.js";
import { registerWorker } from "./iii-sdk-worker.js";
import { VectorIndex } from "./state/vector-index.js";
import { HybridSearch } from "./state/hybrid-search.js";
import { IndexPersistence } from "./state/index-persistence.js";
import {
  configureRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  verifyRetrievalBlockIndex,
} from "./state/retrieval-block-indexing.js";
import { registerPrivacyFunction } from "./functions/privacy.js";
import { registerObserveFunction } from "./functions/observe.js";
import { registerCompressFunction, getCompressMetrics } from "./functions/compress.js";
import {
  registerSearchFunction,
  rebuildIndex,
  getSearchIndex,
} from "./functions/search.js";
import { registerContextFunction } from "./functions/context.js";
import { registerSummarizeFunction } from "./functions/summarize.js";
import { registerMigrateFunction } from "./functions/migrate.js";
import { registerFileIndexFunction } from "./functions/file-index.js";
import { registerConsolidateFunction } from "./functions/consolidate.js";
import { registerPatternsFunction } from "./functions/patterns.js";
import { registerRememberFunction } from "./functions/remember.js";
import { registerBeliefsFunctions } from "./functions/beliefs.js";
import { registerEvictFunction } from "./functions/evict.js";
import { registerRelationsFunction } from "./functions/relations.js";
import { registerTimelineFunction } from "./functions/timeline.js";
import { registerSmartSearchFunction } from "./functions/smart-search.js";
import { registerProfileFunction } from "./functions/profile.js";
import { registerAutoForgetFunction } from "./functions/auto-forget.js";
import { registerExportImportFunction } from "./functions/export-import.js";
import { registerEnrichFunction } from "./functions/enrich.js";
import { registerClaudeBridgeFunction } from "./functions/claude-bridge.js";
import { registerGraphFunction, pruneGraphForObservation } from "./functions/graph.js";
import { registerConsolidationPipelineFunction } from "./functions/consolidation-pipeline.js";
import { registerTeamFunction } from "./functions/team.js";
import { registerGovernanceFunction } from "./functions/governance.js";
import { registerSnapshotFunction } from "./functions/snapshot.js";
import { registerActionsFunction } from "./functions/actions.js";
import { registerFrontierFunction } from "./functions/frontier.js";
import { registerLeasesFunction } from "./functions/leases.js";
import { registerMissionsFunction } from "./functions/missions.js";
import { registerRoutinesFunction } from "./functions/routines.js";
import { registerSignalsFunction } from "./functions/signals.js";
import { registerCheckpointsFunction } from "./functions/checkpoints.js";
import { registerFlowCompressFunction } from "./functions/flow-compress.js";
import { registerMeshFunction } from "./functions/mesh.js";
import { registerBranchAwareFunction } from "./functions/branch-aware.js";
import { registerGuardrailsFunction } from "./functions/guardrails.js";
import { registerDecisionsFunction } from "./functions/decisions.js";
import { registerComponentDossiersFunction } from "./functions/component-dossiers.js";
import { registerRoutineCompilerFunction } from "./functions/routine-compiler.js";
import { registerSentinelsFunction } from "./functions/sentinels.js";
import { registerSketchesFunction } from "./functions/sketches.js";
import { registerCrystallizeFunction } from "./functions/crystallize.js";
import { registerDiagnosticsFunction } from "./functions/diagnostics.js";
import { registerFacetsFunction } from "./functions/facets.js";
import { registerVerifyFunction } from "./functions/verify.js";
import { registerCascadeFunction } from "./functions/cascade.js";
import { registerLessonsFunctions } from "./functions/lessons.js";
import { registerHandoffsFunction } from "./functions/handoffs.js";
import { registerObsidianExportFunction } from "./functions/obsidian-export.js";
import { registerReflectFunctions } from "./functions/reflect.js";
import { registerWorkingMemoryFunctions } from "./functions/working-memory.js";
import { registerSkillExtractFunctions } from "./functions/skill-extract.js";
import { registerSlidingWindowFunction } from "./functions/sliding-window.js";
import { registerQueryExpansionFunction } from "./functions/query-expansion.js";
import { registerTemporalGraphFunctions } from "./functions/temporal-graph.js";
import { registerRetentionFunctions } from "./functions/retention.js";
import { registerCompressFileFunction } from "./functions/compress-file.js";
import {
  deleteStoredRetrievalBlock,
  retrievalBlockId,
} from "./functions/retrieval-blocks.js";
import { registerRetrievalBlockRetryFunction } from "./functions/retrieval-block-retry.js";
import { registerRetrievalIndexVerifyFunction } from "./functions/retrieval-index-verify.js";
import { registerRetrievalBlockDiagnosticsFunction } from "./functions/retrieval-block-diagnostics.js";
import { registerRetrievalVectorBackfillFunction } from "./functions/retrieval-vector-backfill.js";
import { registerConsolidatedMemoryBackfillFunction } from "./functions/consolidated-memory-backfill.js";
import { registerDeferredWorkFunction } from "./functions/deferred-work.js";
import { registerApiTriggers } from "./triggers/api.js";
import { registerEventTriggers } from "./triggers/events.js";
import { registerMcpEndpoints } from "./mcp/server.js";
import { startViewerServer } from "./viewer/server.js";
import { MetricsStore } from "./eval/metrics-store.js";
import { DedupMap } from "./functions/dedup.js";
import { CompressionTracker } from "./state/compression-tracker.js";
import { createAdaptiveTimer, type AdaptiveTimerHandle } from "./state/adaptive-timer.js";
import { registerHealthMonitor } from "./health/monitor.js";
import { getLatestHealth } from "./health/monitor.js";
import {
  getMaintenancePauseReason,
  shouldPauseMaintenance,
} from "./health/maintenance-gate.js";
import { getIndexPersistencePauseReason } from "./health/write-gate.js";
import { initMetrics, OTEL_CONFIG } from "./telemetry/setup.js";
import { VERSION } from "./version.js";
import { configureObservationIndexingRuntime } from "./state/observation-indexing.js";

function hasGetMeter(
  sdk: unknown,
): sdk is { getMeter: (name: string) => unknown } {
  return (
    typeof sdk === "object" &&
    sdk !== null &&
    "getMeter" in sdk &&
    typeof (sdk as { getMeter?: unknown }).getMeter === "function"
  );
}

async function main() {
  const config = loadConfig();
  const embeddingConfig = loadEmbeddingConfig();
  const fallbackConfig = loadFallbackConfig();

  const provider =
    fallbackConfig.providers.length > 0
      ? createFallbackProvider(config.provider, fallbackConfig)
      : createProvider(config.provider);

  const embeddingProvider = createEmbeddingProvider();

  console.log(`[agentmemory] Starting worker v${VERSION}...`);
  console.log(`[agentmemory] Engine: ${config.engineUrl}`);
  console.log(
    `[agentmemory] Provider: ${config.provider.provider} (${config.provider.model})`,
  );
  if (embeddingProvider) {
    console.log(
      `[agentmemory] Embedding provider: ${embeddingProvider.name} (${embeddingProvider.dimensions} dims)`,
    );
  } else {
    console.log(`[agentmemory] Embedding provider: none (BM25-only mode)`);
  }
  console.log(
    `[agentmemory] REST API: http://localhost:${config.restPort}/agentmemory/*`,
  );
  console.log(`[agentmemory] Streams: ws://localhost:${config.streamsPort}`);

  const sdk = registerWorker(config.engineUrl, {
    workerName: "agentmemory",
    otel: {
      serviceName: OTEL_CONFIG.serviceName,
      serviceVersion: OTEL_CONFIG.serviceVersion,
      metricsExportIntervalMs: OTEL_CONFIG.metricsExportIntervalMs,
    },
  });

  const kv = new StateKV(sdk, {
    failureThreshold: 4,
    cooldownMs: 2_000,
  });
  const persistenceKv = new StateKV(sdk, {
    timeoutMs: Math.max(
      Number.parseInt(getEnvVar("STATE_KV_TIMEOUT_MS") || "5000", 10) || 5000,
      20000,
    ),
  });
  const secret = getEnvVar("AGENTMEMORY_SECRET");
  const metricsStore = new MetricsStore(kv);
  const dedupMap = new DedupMap();
  const compressionTracker = new CompressionTracker();

  const vectorIndex = embeddingProvider ? new VectorIndex() : null;
  const retrievalVectorIndex = embeddingProvider ? new VectorIndex() : null;

  let indexPersistence: IndexPersistence | null = null;
  let retrievalIndexPersistence: IndexPersistence | null = null;

  const onEvict = (obsId: string) => {
    getSearchIndex().remove(obsId);
    vectorIndex?.remove(obsId);
    void kv.delete(KV.embeddings(obsId), "data").catch(() => {});
    indexPersistence?.scheduleSave();
    void deleteStoredRetrievalBlock(
      kv,
      retrievalBlockId("observation", obsId),
      { scheduleSave: false },
    ).catch(() => {});
    // Background graph cleanup - mark nodes stale when all source observations gone
    if (isGraphExtractionEnabled()) {
      pruneGraphForObservation(kv, obsId).catch(() => {});
    }
  };

  const meterAccessor = hasGetMeter(sdk)
    ? (sdk.getMeter.bind(sdk) as (name: string) => unknown)
    : undefined;

  initMetrics(meterAccessor as ((name: string) => import("@opentelemetry/api").Meter) | undefined);

  registerPrivacyFunction(sdk);
  registerObserveFunction(sdk, kv, dedupMap, config.maxObservationsPerSession, compressionTracker);
  registerCompressFunction(sdk, kv, provider, metricsStore, compressionTracker, isGraphExtractionEnabled());
  registerSearchFunction(sdk, kv);
  registerContextFunction(sdk, kv, config.tokenBudget);
  registerSummarizeFunction(sdk, kv, provider, metricsStore);
  registerMigrateFunction(sdk, kv);
  registerFileIndexFunction(sdk, kv);
  registerConsolidateFunction(sdk, kv, provider);
  registerPatternsFunction(sdk, kv);
  registerRememberFunction(sdk, kv);
  registerBeliefsFunctions(sdk, kv);
  registerEvictFunction(sdk, kv, onEvict);

  registerRelationsFunction(sdk, kv);
  registerTimelineFunction(sdk, kv);
  registerProfileFunction(sdk, kv);
  registerAutoForgetFunction(sdk, kv, onEvict);
  registerExportImportFunction(sdk, kv);
  registerEnrichFunction(sdk, kv);
  registerRetrievalBlockRetryFunction(sdk, kv);
  registerRetrievalIndexVerifyFunction(sdk, persistenceKv, {
    observationPersistenceStatus: () => indexPersistence?.getStatus(),
  });
  registerRetrievalBlockDiagnosticsFunction(sdk, kv);
  registerRetrievalVectorBackfillFunction(sdk, kv);
  registerConsolidatedMemoryBackfillFunction(sdk, kv);
  registerDeferredWorkFunction(sdk, kv);

  const claudeBridgeConfig = loadClaudeBridgeConfig();
  if (claudeBridgeConfig.enabled) {
    registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
    console.log(
      `[agentmemory] Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`,
    );
  }

  if (isGraphExtractionEnabled()) {
    registerGraphFunction(sdk, kv, provider);
    console.log(`[agentmemory] Knowledge graph: extraction enabled`);
  }

  registerConsolidationPipelineFunction(sdk, kv, provider);
  console.log(`[agentmemory] Consolidation pipeline: registered (CONSOLIDATION_ENABLED=${isConsolidationEnabled() ? "true" : "false"})`);

  if (isAutoCompressEnabled()) {
    console.log(
      `[agentmemory] WARNING: AGENTMEMORY_AUTO_COMPRESS=true — every PostToolUse observation will be sent to your LLM provider for compression. This spends API tokens proportional to your session tool-use frequency (see #138). Set AGENTMEMORY_AUTO_COMPRESS=false to disable.`,
    );
  } else {
    console.log(
      `[agentmemory] Auto-compress: OFF (default, #138) — observations indexed via zero-LLM synthetic compression. Set AGENTMEMORY_AUTO_COMPRESS=true to opt-in to LLM-powered summaries (uses your API key).`,
    );
  }

  if (isContextInjectionEnabled()) {
    console.log(
      `[agentmemory] WARNING: AGENTMEMORY_INJECT_CONTEXT=true — the PreToolUse and SessionStart hooks will inject up to ~4000 chars of memory context into every tool turn. On Claude Pro this burns session tokens proportional to your tool-call frequency (see #143). Set AGENTMEMORY_INJECT_CONTEXT=false to disable.`,
    );
  } else {
    console.log(
      `[agentmemory] Context injection: OFF (default, #143) — hooks capture observations but do not inject context into Claude Code's conversation. Set AGENTMEMORY_INJECT_CONTEXT=true to opt-in (warning: expect your Claude Pro allocation to drain faster).`,
    );
  }

  const teamConfig = loadTeamConfig();
  if (teamConfig) {
    registerTeamFunction(sdk, kv, teamConfig);
    console.log(
      `[agentmemory] Team memory: ${teamConfig.teamId} (${teamConfig.mode})`,
    );
  }

  registerGovernanceFunction(sdk, kv);

  registerActionsFunction(sdk, kv);
  registerFrontierFunction(sdk, kv);
  registerLeasesFunction(sdk, kv);
  registerMissionsFunction(sdk, kv);
  registerRoutinesFunction(sdk, kv);
  registerSignalsFunction(sdk, kv);
  registerCheckpointsFunction(sdk, kv);
  registerMeshFunction(sdk, kv, secret);
  registerBranchAwareFunction(sdk, kv);
  registerGuardrailsFunction(sdk, kv);
  registerDecisionsFunction(sdk, kv);
  registerComponentDossiersFunction(sdk, kv);
  registerRoutineCompilerFunction(sdk, kv);
  registerFlowCompressFunction(sdk, kv, provider);
  registerSentinelsFunction(sdk, kv);
  registerSketchesFunction(sdk, kv);
  registerCrystallizeFunction(sdk, kv, provider);
  registerDiagnosticsFunction(sdk, kv);
  registerFacetsFunction(sdk, kv);
  registerVerifyFunction(sdk, kv);
  registerLessonsFunctions(sdk, kv);
  registerHandoffsFunction(sdk, kv);
  registerObsidianExportFunction(sdk, kv);
  registerReflectFunctions(sdk, kv, provider);
  registerWorkingMemoryFunctions(sdk, kv, config.tokenBudget);
  registerSkillExtractFunctions(sdk, kv, provider);
  registerCascadeFunction(sdk, kv);

  registerSlidingWindowFunction(sdk, kv, provider);
  registerQueryExpansionFunction(sdk, provider);
  registerTemporalGraphFunctions(sdk, kv, provider);
  registerRetentionFunctions(sdk, kv);
  registerCompressFileFunction(sdk, kv, provider);
  console.log(
    `[agentmemory] v0.6 advanced retrieval: sliding-window, query-expansion, temporal-graph, retention-scoring`,
  );
  console.log(
    `[agentmemory] Orchestration layer: actions, frontier, leases, missions, handoffs, branch-aware, guardrails, decisions, dossiers, routine-compiler, routines, signals, checkpoints, flow-compress, mesh, sentinels, sketches, crystallize, diagnostics, facets`,
  );

  const snapshotConfig = loadSnapshotConfig();
  if (snapshotConfig.enabled) {
    registerSnapshotFunction(sdk, kv, snapshotConfig.dir);
    console.log(
      `[agentmemory] Git snapshots: ${snapshotConfig.dir} (every ${snapshotConfig.interval}s)`,
    );
  }

  const bm25Index = getSearchIndex();
  const graphWeight = parseFloat(getEnvVar("AGENTMEMORY_GRAPH_WEIGHT") || "0.3");
  const hybridSearch = new HybridSearch(
    bm25Index,
    vectorIndex,
    embeddingProvider,
    kv,
    embeddingConfig.bm25Weight,
    embeddingConfig.vectorWeight,
    graphWeight,
  );

  registerSmartSearchFunction(sdk, kv, (query, limit) =>
    hybridSearch.search(query, limit),
  );

  registerApiTriggers(sdk, kv, secret, metricsStore, provider);
  registerEventTriggers(sdk, kv, compressionTracker);
  registerMcpEndpoints(sdk, kv, secret);

  const healthMonitor = registerHealthMonitor(sdk, kv, () => {
    const cm = getCompressMetrics();
    return {
      compressActive: cm.active,
      compressPending: cm.pending,
      totalInflight: compressionTracker.totalInflight(),
    };
  });
  const shouldDeferIndexSave = async () => getIndexPersistencePauseReason(kv);

  indexPersistence = new IndexPersistence(
    persistenceKv,
    bm25Index,
    vectorIndex,
    KV.bm25Index,
    { mode: "sharded", shouldDeferSave: shouldDeferIndexSave },
  );
  retrievalIndexPersistence = new IndexPersistence(
    persistenceKv,
    getRetrievalSearchIndex(),
    retrievalVectorIndex,
    KV.retrievalBlockIndex,
    { mode: "sharded", shouldDeferSave: shouldDeferIndexSave },
  );
  configureObservationIndexingRuntime({
    embeddingProvider,
    vectorIndex,
    scheduleSave: () => indexPersistence?.scheduleSave(),
  });
  configureRetrievalBlockIndexingRuntime({
    embeddingProvider,
    vectorIndex: retrievalVectorIndex,
    scheduleSave: () => retrievalIndexPersistence?.scheduleSave(),
    persistenceStatus: () =>
      retrievalIndexPersistence?.getStatus() ?? {
        scope: KV.retrievalBlockIndex,
        mode: "sharded",
        status: "idle",
      },
  });

  const loaded = await indexPersistence.load().catch((err) => {
    console.warn(`[agentmemory] Failed to load persisted index:`, err);
    return null;
  });
  if (loaded?.bm25 && loaded.bm25.size > 0) {
    bm25Index.restoreFrom(loaded.bm25);
    console.log(
      `[agentmemory] Loaded persisted BM25 index (${bm25Index.size} docs)`,
    );
  }
  if (loaded?.vector && vectorIndex && loaded.vector.size > 0) {
    vectorIndex.restoreFrom(loaded.vector);
    console.log(
      `[agentmemory] Loaded persisted vector index (${vectorIndex.size} vectors)`,
    );
  }
  const loadedRetrieval = await retrievalIndexPersistence.load().catch((err) => {
    console.warn(`[agentmemory] Failed to load persisted retrieval index:`, err);
    return null;
  });
  if (loadedRetrieval?.bm25 && loadedRetrieval.bm25.size > 0) {
    getRetrievalSearchIndex().restoreFrom(loadedRetrieval.bm25);
    console.log(
      `[agentmemory] Loaded persisted retrieval BM25 index (${getRetrievalSearchIndex().size} docs)`,
    );
  }
  if (loadedRetrieval?.vector && retrievalVectorIndex && loadedRetrieval.vector.size > 0) {
    retrievalVectorIndex.restoreFrom(loadedRetrieval.vector);
    console.log(
      `[agentmemory] Loaded persisted retrieval vector index (${retrievalVectorIndex.size} vectors)`,
    );
  }

  const needsRebuild = bm25Index.size === 0;

  if (needsRebuild) {
    console.log(
      `[agentmemory] Search index rebuild skipped on startup (no persisted BM25 index loaded)`,
    );
  }

  console.log(
    `[agentmemory] Retrieval blocks: startup inspection skipped, ${getRetrievalSearchIndex().size} indexed`,
  );

  console.log(
    `[agentmemory] Ready. ${embeddingProvider ? "Triple-stream (BM25+Vector+Graph)" : "BM25+Graph"} search active.`,
  );
  console.log(
    `[agentmemory] Endpoints: 133 REST + 44 MCP tools + 6 MCP resources + 3 MCP prompts`,
  );

  const viewerPort = config.restPort + 2;
  const viewerServer = startViewerServer(
    viewerPort,
    kv,
    sdk,
    secret,
    config.restPort,
  );

  const autoForgetIntervalMs = parseInt(process.env.AUTO_FORGET_INTERVAL_MS || "3600000", 10);
  const consolidationIntervalMs = parseInt(process.env.CONSOLIDATION_INTERVAL_MS || "7200000", 10);
  const lastMaintenancePauseLog = new Map<string, string>();

  const runMaintenanceTask = async (
    label: string,
    fn: () => Promise<number>,
  ): Promise<number> => {
    const health = await getLatestHealth(kv).catch(() => null);
    if (shouldPauseMaintenance(health)) {
      const reason = getMaintenancePauseReason(health) || "unhealthy";
      if (lastMaintenancePauseLog.get(label) !== reason) {
        console.warn(
          `[agentmemory] ${label} paused while health is unhealthy: ${reason}`,
        );
        lastMaintenancePauseLog.set(label, reason);
      }
      return 0;
    }

    lastMaintenancePauseLog.delete(label);
    return fn();
  };

  let autoForgetHandle: AdaptiveTimerHandle | undefined;
  let consolidationHandle: AdaptiveTimerHandle | undefined;
  if (process.env.AUTO_FORGET_ENABLED !== "false") {
    autoForgetHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Auto-forget", async () => {
        const result = await sdk.trigger<
          { dryRun: boolean },
          { ttlExpired: string[]; contradictions: unknown[]; lowValueObs: string[] }
        >({ function_id: "mem::auto-forget", payload: { dryRun: false } });
        return (result?.ttlExpired?.length || 0) + (result?.contradictions?.length || 0) + (result?.lowValueObs?.length || 0);
        }),
      { baseMs: autoForgetIntervalMs, minMs: 900_000, maxMs: 14_400_000, label: "Auto-forget" },
    );
    console.log(`[agentmemory] Auto-forget: enabled (every ${autoForgetIntervalMs / 60000}m, adaptive)`);
  }

  if (process.env.LESSON_DECAY_ENABLED !== "false") {
    const lessonDecayTimer = setInterval(async () => {
      try {
        await sdk.trigger({ function_id: "mem::lesson-decay-sweep", payload: {} });
      } catch {}
    }, 86400000);
    lessonDecayTimer.unref();
    console.log(`[agentmemory] Lesson decay sweep: enabled (every 24h)`);
  }

  if (process.env.INSIGHT_DECAY_ENABLED !== "false") {
    const insightDecayTimer = setInterval(async () => {
      try {
        await sdk.trigger({ function_id: "mem::insight-decay-sweep", payload: {} });
      } catch {}
    }, 86400000);
    insightDecayTimer.unref();
  }

  if (isConsolidationEnabled()) {
    consolidationHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Consolidation", async () => {
        const pipelineResult = await sdk.trigger<
          Record<string, never>,
          { results?: { semantic?: { newFacts?: number }; procedural?: { newProcedures?: number } } }
        >({ function_id: "mem::consolidate-pipeline", payload: {} });

        // Also run concept-grouped consolidation
        const consolidateResult = await sdk.trigger<
          { project?: string; minObservations?: number },
          { consolidated?: number; totalObservations?: number }
        >({ function_id: "mem::consolidate", payload: {} });

        // Discover relations between memories
        const relateResult = await sdk.trigger<
          Record<string, never>,
          { created?: number }
        >({ function_id: "mem::auto-relate", payload: {} }).catch(() => ({ created: 0 }));

        const r = pipelineResult?.results || {};
        const pipelineWork = ((r.semantic as any)?.newFacts || 0) + ((r.procedural as any)?.newProcedures || 0);
        const consolidateWork = consolidateResult?.consolidated || 0;
        const relateWork = relateResult?.created || 0;
        return pipelineWork + consolidateWork + relateWork;
        }),
      { baseMs: consolidationIntervalMs, minMs: 600_000, maxMs: 14_400_000, label: "Consolidation" },
    );
    console.log(`[agentmemory] Auto-consolidation: enabled (every ${consolidationIntervalMs / 60000}m, adaptive)`);
  }

  let compressRetryHandle: AdaptiveTimerHandle | undefined;
  if (process.env.COMPRESS_RETRY_ENABLED !== "false") {
    compressRetryHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Compress retry", async () => {
          const result = await sdk.trigger<
            Record<string, never>,
            { retried?: number; removed?: number; queued?: number; succeeded?: number }
          >({ function_id: "mem::compress-retry", payload: {} });
          return (result?.retried || 0) + (result?.removed || 0) + (result?.queued || 0) + (result?.succeeded || 0);
        }),
      { baseMs: 300_000, minMs: 60_000, maxMs: 900_000, label: "Compress retry" },
    );
    console.log(`[agentmemory] Compress retry: enabled (every 5m, adaptive)`);
  }

  let retrievalBlockRetryHandle: AdaptiveTimerHandle | undefined;
  if (process.env.RETRIEVAL_BLOCK_RETRY_ENABLED !== "false") {
    retrievalBlockRetryHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Retrieval block retry", async () => {
          const result = await sdk.trigger<
            Record<string, never>,
            { retried?: number; removed?: number; succeeded?: number; refreshed?: number; refreshIndexed?: number }
          >({ function_id: "mem::retrieval-block-retry", payload: { refreshFromState: true } });
          return (result?.retried || 0) + (result?.removed || 0) + (result?.succeeded || 0) + (result?.refreshed || 0) + (result?.refreshIndexed || 0);
        }),
      { baseMs: 300_000, minMs: 60_000, maxMs: 900_000, label: "Retrieval block retry" },
    );
    console.log(`[agentmemory] Retrieval block retry: enabled (every 5m, adaptive)`);
  }

  let graphCatchUpHandle: AdaptiveTimerHandle | undefined;
  if (isGraphExtractionEnabled() && process.env.GRAPH_CATCH_UP_ENABLED !== "false") {
    graphCatchUpHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Graph catch-up", async () => {
          const result = await sdk.trigger<
            Record<string, never>,
            { extracted?: number; removed?: number }
          >({ function_id: "mem::graph-catch-up", payload: {} });
          return (result?.extracted || 0) + (result?.removed || 0);
        }),
      { baseMs: 300_000, minMs: 60_000, maxMs: 900_000, label: "Graph catch-up" },
    );
    console.log(`[agentmemory] Graph catch-up: enabled (every 5m, adaptive)`);
  }

  let evictionHandle: AdaptiveTimerHandle | undefined;
  if (process.env.EVICTION_ENABLED !== "false") {
    evictionHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Eviction", async () => {
          try {
            await sdk.trigger({ function_id: "mem::retention-score", payload: {} });
          } catch {}

          const retentionResult = await sdk.trigger<
            { dryRun?: boolean },
            { evicted?: number }
          >({ function_id: "mem::retention-evict", payload: { dryRun: false } }).catch(() => ({ evicted: 0 }));

          const evictResult = await sdk.trigger<
            { dryRun?: boolean },
            { staleSessions?: number; lowImportanceObs?: number; capEvictions?: number; expiredMemories?: number; nonLatestMemories?: number }
          >({ function_id: "mem::evict", payload: { dryRun: false } }).catch(() => ({}));

          const work = (retentionResult?.evicted || 0) +
            ((evictResult as any)?.staleSessions || 0) +
            ((evictResult as any)?.lowImportanceObs || 0) +
            ((evictResult as any)?.capEvictions || 0) +
            ((evictResult as any)?.expiredMemories || 0) +
            ((evictResult as any)?.nonLatestMemories || 0);
          return work;
        }),
      { baseMs: 14_400_000, minMs: 3_600_000, maxMs: 43_200_000, label: "Eviction" },
    );
    console.log(`[agentmemory] Eviction: enabled (every 240m, adaptive)`);
  }

  let indexVerifyHandle: AdaptiveTimerHandle | undefined;
  let retrievalIndexVerifyHandle: AdaptiveTimerHandle | undefined;
  let retrievalVectorBackfillHandle: AdaptiveTimerHandle | undefined;
  let delayedRetrievalIndexVerifyTimer: ReturnType<typeof setTimeout> | undefined;
  if (process.env.INDEX_VERIFY_ENABLED !== "false") {
    indexVerifyHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Index verify", async () => {
          const bm25Size = bm25Index.size;
          const vectorSize = vectorIndex?.size ?? 0;

          const sessions = await kv.list<{ id: string }>(KV.sessions).catch(() => []);
          let kvObsCount = 0;
          for (const session of sessions) {
            const obs = await kv.list(KV.observations(session.id)).catch(() => []);
            kvObsCount += obs.filter((o: any) => o.title).length;
          }

          const drift = Math.abs(bm25Size - kvObsCount);
          const driftPct = kvObsCount > 0 ? drift / kvObsCount : 0;
          const vectorDrift = Math.abs(vectorSize - kvObsCount);
          const vectorDriftPct = kvObsCount > 0 ? vectorDrift / kvObsCount : 0;

          const bm25NeedsRebuild = driftPct > 0.1 && drift > 50;
          const vectorNeedsRebuild =
            !!vectorIndex &&
            ((kvObsCount > 0 && vectorSize === 0) ||
              (vectorDriftPct > 0.1 && vectorDrift > 50));

          if (bm25NeedsRebuild || vectorNeedsRebuild) {
            console.warn(
              `[agentmemory] Index drift detected: bm25=${bm25Size} vector=${vectorSize} kv=${kvObsCount}, rebuilding`,
            );
            const rebuilt = await rebuildIndex(kv).catch(() => 0);
            if (rebuilt > 0) {
              indexPersistence.scheduleSave();
              console.log(`[agentmemory] Index rebuilt: ${rebuilt} observations`);
            }
            return 1;
          }
          return 0;
        }),
      { baseMs: 7_200_000, minMs: 1_800_000, maxMs: 28_800_000, label: "Index verify" },
    );
    console.log(`[agentmemory] Index verify: enabled (every 120m, adaptive)`);

    retrievalIndexVerifyHandle = createAdaptiveTimer(
      async () =>
        runMaintenanceTask("Retrieval index verify", async () => {
          const result = await verifyRetrievalBlockIndex(kv, {
            vectorBackfill: false,
          });
          if (result.error) {
            console.warn(
              `[agentmemory] Retrieval index verify failed: ${result.error}`,
            );
            return 0;
          }
          if (result.repaired) {
            console.warn(
              `[agentmemory] Retrieval index drift repaired: bm25=${result.bm25Size} vector=${result.vectorSize} kv=${result.blockCount}, rebuilt=${result.rebuilt}`,
            );
            return 1;
          }
          return 0;
        }),
      {
        baseMs: 7_200_000,
        minMs: 1_800_000,
        maxMs: 28_800_000,
        label: "Retrieval index verify",
      },
    );
    console.log(
      `[agentmemory] Retrieval index verify: enabled (every 120m, adaptive)`,
    );
    if (process.env.RETRIEVAL_VECTOR_BACKFILL_ENABLED !== "false") {
      retrievalVectorBackfillHandle = createAdaptiveTimer(
        async () =>
          runMaintenanceTask("Retrieval vector backfill", async () => {
            const result = await sdk.trigger<
              Record<string, unknown>,
              { backfilled?: number; failed?: number; attempted?: number }
            >({
              function_id: "mem::retrieval-vector-backfill",
              payload: {},
            });
            return (
              (result?.backfilled || 0) +
              (result?.failed || 0) +
              (result?.attempted || 0)
            );
          }),
        {
          baseMs: parseInt(
            process.env.RETRIEVAL_VECTOR_BACKFILL_INTERVAL_MS || "60000",
            10,
          ),
          minMs: 30_000,
          maxMs: 900_000,
          label: "Retrieval vector backfill",
        },
      );
      console.log(
        `[agentmemory] Retrieval vector backfill: enabled (adaptive, every 1m base)`,
      );
    }
    if (process.env.RETRIEVAL_INDEX_STARTUP_VERIFY_ENABLED !== "false") {
      const startupVerifyDelayMs = parseInt(
        process.env.RETRIEVAL_INDEX_STARTUP_VERIFY_DELAY_MS || "30000",
        10,
      );
      if (Number.isFinite(startupVerifyDelayMs) && startupVerifyDelayMs > 0) {
        delayedRetrievalIndexVerifyTimer = setTimeout(() => {
          void runMaintenanceTask("Retrieval index startup verify", async () => {
            const result = await sdk.trigger<
              Record<string, unknown>,
              { error?: string; repaired?: boolean; rebuilt?: number }
            >({
              function_id: "mem::retrieval-index-verify",
              payload: {
                reason: "startup",
                repair: false,
                scanBlocks: false,
                scheduleSave: false,
              },
            });
            if (result.error) {
              console.warn(
                `[agentmemory] Retrieval index startup verify failed: ${result.error}`,
              );
              return 0;
            }
            if (result.repaired) {
              console.warn(
                `[agentmemory] Retrieval index startup drift repaired: rebuilt=${result.rebuilt ?? 0}`,
              );
              return 1;
            }
            return 0;
          }).catch((err) => {
            console.warn(
              `[agentmemory] Retrieval index startup verify failed:`,
              err,
            );
          });
        }, startupVerifyDelayMs);
        delayedRetrievalIndexVerifyTimer.unref();
        console.log(
          `[agentmemory] Retrieval index startup verify: scheduled in ${startupVerifyDelayMs}ms`,
        );
      }
    }
  }

  const shutdown = async () => {
    console.log(`\n[agentmemory] Shutting down...`);
    healthMonitor.stop();
    autoForgetHandle?.stop();
    consolidationHandle?.stop();
    compressRetryHandle?.stop();
    retrievalBlockRetryHandle?.stop();
    graphCatchUpHandle?.stop();
    evictionHandle?.stop();
    indexVerifyHandle?.stop();
    retrievalIndexVerifyHandle?.stop();
    retrievalVectorBackfillHandle?.stop();
    if (delayedRetrievalIndexVerifyTimer) {
      clearTimeout(delayedRetrievalIndexVerifyTimer);
    }
    dedupMap.stop();
    indexPersistence.stop();
    retrievalIndexPersistence?.stop();
    await new Promise<void>((resolve) => viewerServer.close(() => resolve()));
    await indexPersistence.save().catch((err) => {
      console.warn(`[agentmemory] Failed to save index on shutdown:`, err);
    });
    await retrievalIndexPersistence?.save().catch((err) => {
      console.warn(`[agentmemory] Failed to save retrieval index on shutdown:`, err);
    });
    await sdk.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[agentmemory] Fatal:`, err);
  process.exit(1);
});
