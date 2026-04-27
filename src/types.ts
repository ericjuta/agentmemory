// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
export interface Session {
  id: string;
  project: string;
  cwd: string;
  branch?: string;
  latestHandoffPacketId?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "abandoned";
  observationCount: number;
  model?: string;
  tags?: string[];
}

export interface RawObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  hookType: HookType;
  source?: string;
  payloadVersion?: string;
  eventId?: string;
  sourceTimestamp?: string;
  capabilities?: string[];
  persistenceClass?: ObservationPersistenceClass;
  turnId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  assistantResponse?: string;
  raw: unknown;
}

export interface CompressedObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  source?: string;
  payloadVersion?: string;
  eventId?: string;
  sourceTimestamp?: string;
  capabilities?: string[];
  persistenceClass?: ObservationPersistenceClass;
  turnId?: string;
  type: ObservationType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  confidence?: number;
}

export type ObservationType =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "command_run"
  | "search"
  | "web_fetch"
  | "conversation"
  | "error"
  | "decision"
  | "discovery"
  | "subagent"
  | "notification"
  | "task"
  | "other";

export interface Memory {
  id: string;
  createdAt: string;
  updatedAt: string;
  type: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
  title: string;
  content: string;
  concepts: string[];
  files: string[];
  project?: string;
  branch?: string;
  sessionIds: string[];
  strength: number;
  version: number;
  parentId?: string;
  supersedes?: string[];
  relatedIds?: string[];
  sourceObservationIds?: string[];
  isLatest: boolean;
  forgetAfter?: string;
  lastAccessedAt?: string;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  createdAt: string;
  title: string;
  narrative: string;
  keyDecisions: string[];
  filesModified: string[];
  concepts: string[];
  observationCount: number;
}

export type HookType =
  | "session_start"
  | "prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_failure"
  | "assistant_result"
  | "pre_compact"
  | "subagent_start"
  | "subagent_stop"
  | "notification"
  | "task_completed"
  | "stop"
  | "session_end";

export type ObservationPersistenceClass =
  | "persistent"
  | "ephemeral"
  | "diagnostics_only";

export interface TurnCapsule {
  id: string;
  sessionId: string;
  turnId: string;
  project: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  userPrompt?: string;
  assistantConclusion?: string;
  files: string[];
  concepts: string[];
  hadFailure: boolean;
  hadDecision: boolean;
  sourceObservationIds: string[];
  importantObservationIds: string[];
  maxImportance: number;
}

export interface SessionWorkingSet {
  sessionId: string;
  project: string;
  cwd: string;
  updatedAt: string;
  latestTurnId?: string;
  latestCompletedTurnId?: string;
  latestCompletedCapsule?: TurnCapsule;
  latestAssistantConclusion?: string;
  latestImportantFiles: string[];
  latestImportantConcepts: string[];
  latestImportantObservationIds: string[];
  latestHadFailure: boolean;
  latestHadDecision: boolean;
}

export type RetrievalBlockSourceType =
  | "turn_capsule"
  | "working_set"
  | "session_summary"
  | "memory"
  | "semantic_memory"
  | "procedural_memory"
  | "belief"
  | "guardrail"
  | "decision"
  | "dossier"
  | "handoff"
  | "branch_overlay"
  | "observation"
  | "profile";

export interface RetrievalBlock {
  id: string;
  sourceType: RetrievalBlockSourceType;
  sourceId: string;
  project: string;
  branch?: string;
  sessionId?: string;
  turnId?: string;
  scope: "session" | "branch" | "project" | "global";
  freshnessLane: "hot" | "warm" | "cold";
  canonicalText: string;
  title: string;
  files: string[];
  concepts: string[];
  entities: string[];
  sourceObservationIds: string[];
  hadFailure: boolean;
  hadDecision: boolean;
  hadAssistantConclusion: boolean;
  isResumeArtifact: boolean;
  importance: number;
  createdAt: string;
  updatedAt: string;
  eventAt: string;
  embeddingModel?: string;
  embeddingVersion?: string;
}

export interface RetrievalBlockRetryEntry {
  blockId: string;
  sourceType: RetrievalBlockSourceType;
  operation?: "index" | "upsert";
  block?: RetrievalBlock;
  retries: number;
  firstFailedAt: string;
  lastFailedAt: string;
  nextAttemptAt?: string;
  lastError: string;
}

export interface CompressRetryEntry {
  obsId: string;
  sessionId: string;
  retries: number;
  failedAt: string;
  lastError?: string;
}

export interface GraphExtractionRetryEntry {
  observationId: string;
  sessionId: string;
  retries: number;
  firstDeferredAt: string;
  lastDeferredAt: string;
  lastError: string;
}

export interface HookPayload {
  hookType: HookType;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
  source?: string;
  payloadVersion?: string;
  eventId?: string;
  sourceTimestamp?: string;
  capabilities?: string[];
  persistenceClass?: ObservationPersistenceClass;
}

export interface ObserveReceipt {
  eventId: string;
  observationId: string;
  sessionId: string;
  hookType: HookType;
  persistenceClass: ObservationPersistenceClass;
  storedAt: string;
}

export interface ProviderConfig {
  provider: ProviderType;
  model: string;
  maxTokens: number;
  /** Optional base URL override (e.g. for Anthropic-compatible APIs or local proxies) */
  baseURL?: string;
}

export type ProviderType = "agent-sdk" | "anthropic" | "gemini" | "openrouter" | "minimax";

export interface MemoryProvider {
  name: string;
  compress(systemPrompt: string, userPrompt: string): Promise<string>;
  summarize(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface AgentMemoryConfig {
  engineUrl: string;
  restPort: number;
  streamsPort: number;
  provider: ProviderConfig;
  tokenBudget: number;
  maxObservationsPerSession: number;
  compressionModel: string;
  dataDir: string;
}

export interface SearchResult {
  observation: CompressedObservation;
  score: number;
  sessionId: string;
}

export interface RetrievalSearchResult {
  block: RetrievalBlock;
  score: number;
  lexicalScore: number;
  specificityScore?: number;
  vectorScore: number;
  graphScore: number;
  freshnessScore?: number;
  recencyScore?: number;
  rankingMetadata?: RetrievalTraceRankingMetadata;
  sessionId?: string;
  observation?: CompressedObservation | null;
}

export interface ContextBlock {
  type: "summary" | "observation" | "memory";
  content: string;
  tokens: number;
  recency: number;
  sourceIds?: string[];
}

export type RetrievalIntent =
  | "resume"
  | "user_turn"
  | "manual_recall"
  | "file_enrich"
  | "next_action";

export type RetrievalTraceLane = "hot" | "warm" | "cold";

export type RetrievalTraceDecision =
  | "selected_lane_budget"
  | "selected_leftover_fill"
  | "skipped_duplicate_fingerprint"
  | "skipped_observation_already_selected"
  | "skipped_session_already_covered"
  | "skipped_lane_budget"
  | "skipped_total_budget";

export interface RetrievalTraceScore {
  queryOverlap: number;
  lanePriority: number;
  recency: number;
  lexical?: number;
  specificity?: number;
  vector?: number;
  graph?: number;
  file?: number;
  concept?: number;
  freshness?: number;
  session?: number;
  resume?: number;
  sourcePrior?: number;
  exactBoost?: number;
  vectorCoverage?: number;
  combined?: number;
}

export interface RetrievalTraceSources {
  lexical: boolean;
  specificity: boolean;
  vector: boolean;
  graph: boolean;
  file: boolean;
  concept: boolean;
  session: boolean;
  resume: boolean;
  freshness: boolean;
}

export interface RetrievalTraceFreshness {
  lane: RetrievalTraceLane;
  eventAt: string;
  createdAt: string;
  updatedAt: string;
  ageHours: number;
  recencyScore: number;
}

export interface RetrievalTraceRankingMetadata {
  sources: RetrievalTraceSources;
  freshness: RetrievalTraceFreshness;
  factors: RetrievalTraceScore;
  duplicateOf?: string;
  collapsedDuplicateIds?: string[];
  collapsedDuplicateCount?: number;
}

export interface RetrievalTraceCandidate {
  id: string;
  sourceType: string;
  blockType: ContextBlock["type"];
  lane: RetrievalTraceLane;
  preview: string;
  tokens: number;
  score: RetrievalTraceScore;
  sources?: RetrievalTraceSources;
  freshness?: RetrievalTraceFreshness;
  selected: boolean;
  decision: RetrievalTraceDecision;
  sessionId?: string;
  sourceObservationIds?: string[];
  isCapsule?: boolean;
  linkedMemoryId?: string;
  duplicateOf?: string;
  collapsedDuplicateIds?: string[];
  collapsedDuplicateCount?: number;
}

export interface ContextInjection {
  sessionId: string;
  memoryIds: string[];
  timestamp: string;
}

export interface RetrievalTrace {
  generatedAt: string;
  query?: string;
  queryTerms: string[];
  budget: number;
  availableBudget: number;
  selectedTokens: number;
  responseTokens: number;
  laneBudgets: Record<RetrievalTraceLane, number>;
  laneUsage: Record<RetrievalTraceLane, number>;
  selected: RetrievalTraceCandidate[];
  skipped: RetrievalTraceCandidate[];
  usefulnessLink: ContextInjection | null;
  degradedFreshness?: boolean;
  freshnessLag?: {
    queuedCount: number;
    oldestQueuedAt?: string;
    affectedSourceTypes: string[];
  };
  vectorCoverageConfidence?: number;
  graphExpanded?: boolean;
}

export interface RetrievalContextItem {
  sourceType: RetrievalBlockSourceType;
  sourceId: string;
  title: string;
  why: string;
  freshness: RetrievalTraceLane;
  confidence: number;
  relevantFiles: string[];
  concepts: string[];
  blocker?: string | null;
  recommendedNextStep?: string | null;
}

export interface SessionBootstrap {
  context: string;
  items: RetrievalContextItem[];
  latestHandoff: HandoffPacket | null;
  nextAction:
    | {
        actionId?: string;
        title?: string;
        description?: string;
        priority?: number;
        score?: number;
        tags?: string[];
      }
    | null;
  guardrails: GuardrailMemory[];
  activeDecisions: DecisionMemory[];
  branchOverlaySummary?: string | null;
  retrievalTrace?: RetrievalTrace;
  partial?: boolean;
  omitted?: string[];
  warnings?: string[];
}

export type CloseoutStepStatus = "ok" | "skipped" | "failed";

export interface SessionCloseoutResult {
  success: boolean;
  steps: {
    summarize: CloseoutStepStatus;
    endSession: CloseoutStepStatus;
    crystallize: CloseoutStepStatus;
    consolidate: CloseoutStepStatus;
  };
  errors: Array<{ step: string; message: string }>;
  summary?: SessionSummary;
}

export interface EvalResult {
  valid: boolean;
  errors: string[];
  qualityScore: number;
  latencyMs: number;
  functionId: string;
}

export interface FunctionMetrics {
  functionId: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  avgQualityScore: number;
}

export interface HealthWorker {
  id: string;
  name: string | null;
  status: string;
  connected_at_ms?: number;
  function_count?: number;
  ip_address?: string | null;
  runtime?: string | null;
  version?: string | null;
  [key: string]: unknown;
}

export interface HealthSnapshot {
  connectionState: string;
  workers: HealthWorker[];
  memory: {
    heapUsed: number;
    heapTotal: number;
    heapLimit?: number;
    rss: number;
    external: number;
  };
  cpu: { userMicros: number; systemMicros: number; percent: number };
  eventLoopLagMs: number;
  uptimeSeconds: number;
  kvConnectivity?: {
    status: string;
    latencyMs?: number;
    error?: string;
    consecutiveFailures?: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
  };
  snapshotPersistence?: {
    status: "ok" | "error";
    consecutiveFailures: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    error?: string;
  };
  pipeline?: {
    compressActive: number;
    compressPending: number;
    totalInflight: number;
  };
  status: "healthy" | "degraded" | "critical";
  alerts: string[];
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface MemoryRelation {
  type: "supersedes" | "extends" | "derives" | "contradicts" | "related";
  sourceId: string;
  targetId: string;
  createdAt: string;
  confidence?: number;
}

export interface Belief {
  id: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  claim: string;
  normalizedClaim: string;
  status: "active" | "superseded" | "contradicted" | "uncertain";
  confidence: number;
  supportingMemoryIds: string[];
  contradictingMemoryIds: string[];
  supersededByBeliefId?: string;
  supersedesBeliefIds: string[];
  sourceTypes: Memory["type"][];
  files: string[];
  concepts: string[];
}

export interface BeliefEvidence {
  id: string;
  beliefId: string;
  memoryId: string;
  relationType: "supports" | "contradicts" | "supersedes";
  weight: number;
  createdAt: string;
}

export interface BeliefProjection {
  beliefId: string;
  claim: string;
  status: Belief["status"];
  confidence: number;
  supportCount: number;
  contradictionCount: number;
  superseded: boolean;
  files: string[];
  concepts: string[];
  updatedAt: string;
}

export interface HybridSearchResult {
  observation: CompressedObservation;
  bm25Score: number;
  vectorScore: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}

export interface CompactSearchResult {
  obsId: string;
  blockId?: string;
  sessionId: string;
  title: string;
  type: ObservationType | RetrievalBlockSourceType;
  score: number;
  timestamp: string;
  sourceType?: RetrievalBlockSourceType;
  sourceId?: string;
}

export interface TimelineEntry {
  observation: CompressedObservation;
  sessionId: string;
  relativePosition: number;
}

export interface ProjectProfile {
  project: string;
  updatedAt: string;
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  conventions: string[];
  commonErrors: string[];
  recentActivity: string[];
  sessionCount: number;
  totalObservations: number;
  summary?: string;
}

export interface ExportPagination {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface ExportData {
  version: "0.3.0" | "0.4.0" | "0.5.0" | "0.6.0" | "0.6.1" | "0.7.0" | "0.7.2" | "0.7.3" | "0.7.4" | "0.7.5" | "0.7.6" | "0.7.9" | "0.8.0" | "0.8.1" | "0.8.2" | "0.8.3" | "0.8.4" | "0.8.5" | "0.8.6" | "0.8.7" | "0.8.8" | "0.8.9" | "0.8.10" | "0.8.11" | "0.8.12";
  exportedAt: string;
  sessions: Session[];
  observations: Record<string, CompressedObservation[]>;
  memories: Memory[];
  summaries: SessionSummary[];
  profiles?: ProjectProfile[];
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  beliefs?: Belief[];
  beliefEvidence?: BeliefEvidence[];
  semanticMemories?: SemanticMemory[];
  proceduralMemories?: ProceduralMemory[];
  actions?: Action[];
  actionEdges?: ActionEdge[];
  leases?: Lease[];
  missions?: Mission[];
  missionRuns?: MissionRun[];
  routines?: Routine[];
  routineRuns?: RoutineRun[];
  signals?: Signal[];
  checkpoints?: Checkpoint[];
  sentinels?: Sentinel[];
  handoffPackets?: HandoffPacket[];
  sketches?: Sketch[];
  crystals?: Crystal[];
  facets?: Facet[];
  lessons?: Lesson[];
  insights?: Insight[];
  branchOverlays?: BranchOverlay[];
  guardrails?: GuardrailMemory[];
  decisions?: DecisionMemory[];
  componentDossiers?: ComponentDossier[];
  routineCandidates?: RoutineCandidate[];
  accessLogs?: AccessLogExport[];
  pagination?: ExportPagination;
}

export interface AccessLogExport {
  memoryId: string;
  count: number;
  lastAt: string;
  recent: number[];
}

export interface EmbeddingConfig {
  provider?: string;
  bm25Weight: number;
  vectorWeight: number;
}

export interface FallbackConfig {
  providers: ProviderType[];
}

export interface ClaudeBridgeConfig {
  enabled: boolean;
  projectPath: string;
  memoryFilePath: string;
  lineBudget: number;
}

export interface StandaloneConfig {
  dataDir: string;
  persistPath: string;
  agentType?: string;
}

export type GraphNodeType =
  | "file"
  | "function"
  | "concept"
  | "error"
  | "decision"
  | "pattern"
  | "library"
  | "person"
  | "project"
  | "preference"
  | "location"
  | "organization"
  | "event";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  properties: Record<string, unknown>;
  sourceObservationIds: string[];
  createdAt: string;
  updatedAt?: string;
  aliases?: string[];
  stale?: boolean;
}

export type GraphEdgeType =
  | "uses"
  | "imports"
  | "modifies"
  | "causes"
  | "fixes"
  | "depends_on"
  | "related_to"
  | "works_at"
  | "prefers"
  | "blocked_by"
  | "caused_by"
  | "optimizes_for"
  | "rejected"
  | "avoids"
  | "located_in"
  | "succeeded_by";

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
  sourceObservationIds: string[];
  createdAt: string;
  tcommit?: string;
  tvalid?: string;
  tvalidEnd?: string;
  context?: EdgeContext;
  version?: number;
  supersededBy?: string;
  isLatest?: boolean;
  stale?: boolean;
}

export interface EdgeContext {
  reasoning?: string;
  sentiment?: string;
  alternatives?: string[];
  situationalFactors?: string[];
  confidence?: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
}

export type ConsolidationTier =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural";

export interface SemanticMemory {
  id: string;
  fact: string;
  confidence: number;
  project?: string;
  sourceScope?: "project" | "global";
  sourceProjects?: string[];
  sourceSessionIds: string[];
  sourceMemoryIds: string[];
  sourceObservationIds?: string[];
  accessCount: number;
  lastAccessedAt: string;
  strength: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProceduralMemory {
  id: string;
  name: string;
  steps: string[];
  triggerCondition: string;
  expectedOutcome?: string;
  project?: string;
  sourceScope?: "project" | "global";
  sourceProjects?: string[];
  frequency: number;
  sourceSessionIds: string[];
  sourceMemoryIds?: string[];
  sourceObservationIds?: string[];
  tags?: string[];
  concepts?: string[];
  strength: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamConfig {
  teamId: string;
  userId: string;
  mode: "shared" | "private";
}

export interface TeamSharedItem {
  id: string;
  sharedBy: string;
  sharedAt: string;
  type: "observation" | "memory" | "pattern";
  content: unknown;
  project: string;
  visibility: "shared" | "private";
}

export interface TeamProfile {
  teamId: string;
  members: string[];
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  sharedPatterns: string[];
  totalSharedItems: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  operation:
    | "observe"
    | "compress"
    | "remember"
    | "forget"
    | "evolve"
    | "consolidate"
    | "share"
    | "delete"
    | "import"
    | "export"
    | "action_create"
    | "action_update"
    | "lease_acquire"
    | "lease_release"
    | "routine_run"
    | "signal_send"
    | "checkpoint_resolve"
    | "mesh_sync"
    | "relation_create"
    | "relation_update"
    | "sentinel_create"
    | "sentinel_trigger"
    | "sketch_create"
    | "sketch_promote"
    | "retention_score"
    | "sketch_discard"
    | "crystallize"
    | "diagnose"
    | "heal"
    | "facet_tag"
    | "lesson_save"
    | "lesson_recall"
    | "lesson_strengthen"
    | "obsidian_export"
    | "reflect"
    | "insight_search"
    | "skill_extract"
    | "core_add"
    | "core_remove"
    | "auto_page"
    | "belief_project"
    | "belief_update"
    | "relation_create"
    | "mission_create"
    | "mission_update"
    | "handoff_generate"
    | "branch_overlay_save"
    | "branch_overlay_promote"
    | "guardrail_save"
    | "decision_save"
    | "dossier_refresh"
    | "routine_compile"
    | "retrieval_quality_summary";
  userId?: string;
  functionId: string;
  targetIds: string[];
  details: Record<string, unknown>;
  qualityScore?: number;
}

export interface GovernanceFilter {
  type?: string[];
  dateFrom?: string;
  dateTo?: string;
  project?: string;
  qualityBelow?: number;
}

export interface SnapshotMeta {
  id: string;
  commitHash: string;
  createdAt: string;
  message: string;
  stats: {
    sessions: number;
    observations: number;
    memories: number;
    graphNodes: number;
  };
}

export interface SnapshotDiff {
  fromCommit: string;
  toCommit: string;
  added: { memories: number; observations: number; graphNodes: number };
  removed: { memories: number; observations: number; graphNodes: number };
}

export interface Action {
  id: string;
  title: string;
  description: string;
  status: "pending" | "active" | "done" | "blocked" | "cancelled";
  priority: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  assignedTo?: string;
  project?: string;
  tags: string[];
  sourceObservationIds: string[];
  sourceMemoryIds: string[];
  result?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  sketchId?: string;
  crystallizedInto?: string;
  missionId?: string;
}

export type ActionEdgeType =
  | "requires"
  | "unlocks"
  | "spawned_by"
  | "gated_by"
  | "conflicts_with";

export interface ActionEdge {
  id: string;
  type: ActionEdgeType;
  sourceActionId: string;
  targetActionId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Lease {
  id: string;
  actionId: string;
  agentId: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
  status: "active" | "expired" | "released";
  missionId?: string;
}

export interface Mission {
  id: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  cwd?: string;
  branch?: string;
  goal: string;
  successCriteria: string[];
  status: "draft" | "active" | "blocked" | "completed" | "cancelled";
  phase: string;
  owner: string;
  summary: string;
  risk: string;
  confidence: number;
  actionIds: string[];
  checkpointIds: string[];
  sentinelIds: string[];
  leaseIds: string[];
  routineIds: string[];
  latestHandoffPacketId?: string;
}

export interface MissionRun {
  id: string;
  missionId: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  actor: string;
  status: "active" | "blocked" | "completed" | "cancelled";
  notes: string[];
}

export interface Routine {
  id: string;
  name: string;
  description: string;
  steps: RoutineStep[];
  createdAt: string;
  updatedAt: string;
  frozen: boolean;
  tags: string[];
  sourceProceduralIds: string[];
  missionId?: string;
}

export interface RoutineStep {
  order: number;
  title: string;
  description: string;
  actionTemplate: Partial<Action>;
  dependsOn: number[];
}

export interface RoutineRun {
  id: string;
  routineId: string;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  completedAt?: string;
  actionIds: string[];
  stepStatus: Record<number, "pending" | "active" | "done" | "failed">;
  initiatedBy: string;
}

export interface Signal {
  id: string;
  from: string;
  to?: string;
  threadId?: string;
  replyTo?: string;
  type: "info" | "request" | "response" | "alert" | "handoff";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  readAt?: string;
  expiresAt?: string;
}

export interface Checkpoint {
  id: string;
  name: string;
  description: string;
  status: "pending" | "passed" | "failed" | "expired";
  type: "ci" | "approval" | "deploy" | "external" | "timer";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: unknown;
  expiresAt?: string;
  linkedActionIds: string[];
  missionId?: string;
}

export interface Sketch {
  id: string;
  title: string;
  description: string;
  status: "active" | "promoted" | "discarded";
  actionIds: string[];
  project?: string;
  createdAt: string;
  expiresAt: string;
  promotedAt?: string;
  discardedAt?: string;
}

export interface Facet {
  id: string;
  targetId: string;
  targetType: "action" | "memory" | "observation";
  dimension: string;
  value: string;
  createdAt: string;
}

export interface Sentinel {
  id: string;
  name: string;
  type: "webhook" | "timer" | "threshold" | "pattern" | "approval" | "custom";
  status: "watching" | "triggered" | "cancelled" | "expired";
  config: Record<string, unknown>;
  result?: unknown;
  createdAt: string;
  triggeredAt?: string;
  expiresAt?: string;
  linkedActionIds: string[];
  escalatedAt?: string;
  missionId?: string;
}

export interface HandoffPacket {
  id: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  scopeType: "action" | "mission" | "session";
  scopeId: string;
  summary: string;
  recentChanges: string[];
  knownFacts: string[];
  relevantFiles: string[];
  relevantConcepts: string[];
  blockers: string[];
  openQuestions: string[];
  recommendedNextStep: string;
  confidence: number;
  sourceObservationIds: string[];
  sourceActionIds: string[];
  sourceBeliefIds?: string[];
}

export interface BranchOverlay {
  id: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  branch: string;
  targetType:
    | "mission"
    | "handoff"
    | "guardrail"
    | "decision"
    | "dossier"
    | "blocker";
  targetId: string;
  summary: string;
  blockers: string[];
  notes: string[];
  metadata?: Record<string, unknown>;
  status: "active" | "promoted" | "superseded" | "dismissed";
  promotedAt?: string;
  promotedBy?: string;
  supersededBy?: string;
}

export type GuardrailRiskLevel = "low" | "medium" | "high" | "critical";

export interface GuardrailMemory {
  id: string;
  createdAt: string;
  updatedAt: string;
  project?: string;
  branch?: string;
  scopeType: "project" | "file" | "concept" | "mission" | "action";
  scopeId: string;
  triggerConditions: string[];
  riskLevel: GuardrailRiskLevel;
  explanation: string;
  evidence: string[];
  relatedFiles: string[];
  relatedConcepts: string[];
  missionId?: string;
  expiresAt?: string;
  reviewAfter?: string;
  status: "active" | "expired" | "superseded";
  supersedes: string[];
  supersededBy?: string;
  sourceObservationIds: string[];
  sourceActionIds: string[];
}

export interface DecisionMemory {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  reconsiderWhen: string[];
  status: "active" | "superseded" | "reconsidered";
  project?: string;
  branch?: string;
  missionId?: string;
  relatedFiles: string[];
  relatedConcepts: string[];
  sourceObservationIds: string[];
  sourceActionIds: string[];
  supersedes: string[];
  supersededBy?: string;
}

export interface ComponentDossier {
  id: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  branch?: string;
  filePath: string;
  summary: string;
  currentState: string;
  keyFacts: string[];
  activeRisks: string[];
  openQuestions: string[];
  relatedLessonIds: string[];
  relatedInsightIds: string[];
  relatedGuardrailIds: string[];
  relatedDecisionIds: string[];
  sourceObservationIds: string[];
  lastRefreshedAt: string;
}

export interface RoutineCandidate {
  id: string;
  createdAt: string;
  updatedAt: string;
  project?: string;
  branch?: string;
  name: string;
  description: string;
  derivedFromActionIds: string[];
  stepTitles: string[];
  evidenceCount: number;
  confidence: number;
  status: "proposed" | "accepted" | "rejected";
}

export interface MissionStatusSummary {
  status: Mission["status"];
  blockers: string[];
  actionCounts: Record<Action["status"], number>;
  checkpointCounts: Record<Checkpoint["status"], number>;
  sentinelCounts: Record<Sentinel["status"], number>;
  leaseCounts: Record<Lease["status"], number>;
  routineRunCounts: Record<RoutineRun["status"], number>;
  derivedSummary: string;
}

export interface Crystal {
  id: string;
  narrative: string;
  keyOutcomes: string[];
  filesAffected: string[];
  lessons: string[];
  sourceActionIds: string[];
  sessionId?: string;
  project?: string;
  createdAt: string;
}

export interface Lesson {
  id: string;
  content: string;
  context: string;
  confidence: number;
  reinforcements: number;
  source: "crystal" | "manual" | "consolidation";
  sourceIds: string[];
  project?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

export interface Insight {
  id: string;
  title: string;
  content: string;
  confidence: number;
  reinforcements: number;
  sourceConceptCluster: string[];
  sourceMemoryIds: string[];
  sourceLessonIds: string[];
  sourceCrystalIds: string[];
  project?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

export interface DiagnosticCheck {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixable: boolean;
}

export interface MeshPeer {
  id: string;
  url: string;
  name: string;
  lastSyncAt?: string;
  status: "connected" | "disconnected" | "syncing" | "error";
  sharedScopes: string[];
  syncFilter?: { project?: string };
}


export interface EnrichedChunk {
  id: string;
  originalObsId: string;
  sessionId: string;
  content: string;
  resolvedEntities: Record<string, string>;
  preferences: string[];
  contextBridges: string[];
  windowStart: number;
  windowEnd: number;
  createdAt: string;
}

export interface LatentEmbedding {
  obsId: string;
  contentEmbedding: string;
  latentEmbedding: string;
  sessionId: string;
}

export interface QueryExpansion {
  original: string;
  reformulations: string[];
  temporalConcretizations: string[];
  entityExtractions: string[];
}

export interface TripleStreamResult {
  observation: CompressedObservation;
  vectorScore: number;
  bm25Score: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}

export interface TemporalQuery {
  entityName: string;
  asOf?: string;
  from?: string;
  to?: string;
  includeHistory?: boolean;
}

export interface TemporalState {
  entity: GraphNode;
  currentEdges: GraphEdge[];
  historicalEdges: GraphEdge[];
  timeline: Array<{
    edge: GraphEdge;
    validFrom: string;
    validTo?: string;
    context?: EdgeContext;
  }>;
}

export interface RetentionScore {
  memoryId: string;
  // Which KV scope this row came from. Needed by mem::retention-evict
  // so the delete loop routes to KV.memories or KV.semantic correctly.
  // Missing on pre-0.8.10 rows — callers must treat `undefined` as
  // "unknown" and probe both scopes for backwards-compat. See #124.
  source?: "episodic" | "semantic";
  score: number;
  salience: number;
  temporalDecay: number;
  reinforcementBoost: number;
  lastAccessed: string;
  accessCount: number;
}

export interface DecayConfig {
  lambda: number;
  sigma: number;
  tierThresholds: {
    hot: number;
    warm: number;
    cold: number;
  };
}
