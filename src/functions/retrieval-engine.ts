import type {
  CompressedObservation,
  ComponentDossier,
  DecisionMemory,
  GuardrailMemory,
  HandoffPacket,
  RetrievalBlock,
  RetrievalContextItem,
  RetrievalIntent,
  RetrievalSearchResult,
  RetrievalTrace,
  RetrievalTraceCandidate,
  RetrievalTraceDecision,
  RetrievalTraceFreshness,
  RetrievalTraceLane,
  RetrievalTraceRankingMetadata,
  RetrievalTraceScore,
  RetrievalTraceSources,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  buildRetrievalBlockLexicalText,
  getRetrievalBlockIndexingRuntime,
  getRetrievalSearchIndex,
  getRetrievalVectorIndex,
} from "../state/retrieval-block-indexing.js";
import { SearchIndex } from "../state/search-index.js";
import { GraphRetrieval } from "./graph-retrieval.js";
import { extractEntitiesFromQuery } from "./query-expansion.js";
import {
  contextResultCacheKey,
  getCachedContextResult,
  setCachedContextResult,
} from "./context-result-cache.js";
import {
  collectLightweightRetrievalBlocksFromState,
  collectRetrievalBlocksFromState,
} from "./retrieval-blocks.js";
import {
  loadScopedRetrievalBlocks,
  warmRetrievalBlockScopeMemberships,
} from "./retrieval-block-scope-index.js";

const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 128;
const QUERY_EMBEDDING_CACHE_TTL_MS = 5 * 60_000;
const QUERY_EMBEDDING_TIMEOUT_MS = 2500;
const RETRIEVAL_BLOCK_SCOPE_COOLDOWN_MS = 60_000;
const RETRIEVAL_BLOCK_VECTOR_MIN_SCORE = 0.35;
const DUPLICATE_CLUSTER_MIN_JACCARD = 0.72;
const DUPLICATE_CLUSTER_MIN_SHARED_TERMS = 5;

const DUPLICATE_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "because",
  "before",
  "between",
  "could",
  "current",
  "during",
  "first",
  "from",
  "have",
  "into",
  "keep",
  "keeps",
  "last",
  "latest",
  "more",
  "need",
  "needs",
  "only",
  "other",
  "over",
  "same",
  "should",
  "state",
  "still",
  "than",
  "that",
  "then",
  "there",
  "this",
  "through",
  "turn",
  "with",
  "work",
  "would",
]);

type CachedQueryEmbedding = {
  embedding: Float32Array;
  cachedAt: number;
};

const queryEmbeddingCache = new Map<string, CachedQueryEmbedding>();
let retrievalBlockScopeUnavailableUntil = 0;

export function resetRetrievalEngineStateForTests(): void {
  queryEmbeddingCache.clear();
  retrievalBlockScopeUnavailableUntil = 0;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function queryTerms(query?: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length >= 3);
}

export function scoreQueryOverlap(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const normalized = content.toLowerCase();
  const meaningfulTerms = terms.filter((term) => term.length >= 4);
  if (meaningfulTerms.length === 0) return 0;
  let hits = 0;
  for (const term of meaningfulTerms) {
    if (normalized.includes(term)) hits++;
  }
  return hits / meaningfulTerms.length;
}

function fileOverlapScore(block: RetrievalBlock, focusFiles: string[]): number {
  if (focusFiles.length === 0 || block.files.length === 0) return 0;
  const normalized = focusFiles.map((filePath) => filePath.toLowerCase());
  const basenames = normalized.map((filePath) => basename(filePath));
  let exact = 0;
  let partial = 0;
  for (const file of block.files.map((value) => value.toLowerCase())) {
    if (normalized.includes(file)) {
      exact++;
      continue;
    }
    if (basenames.includes(basename(file))) {
      partial++;
      continue;
    }
    if (normalized.some((focus) => file.includes(focus) || focus.includes(file))) {
      partial++;
    }
  }
  return Math.min(1, exact * 1 + partial * 0.4);
}

function conceptOverlapScore(block: RetrievalBlock, focusConcepts: string[]): number {
  if (focusConcepts.length === 0 || block.concepts.length === 0) return 0;
  const wanted = new Set(focusConcepts.map((concept) => concept.toLowerCase()));
  const hits = block.concepts.filter((concept) => wanted.has(concept.toLowerCase())).length;
  return hits > 0 ? Math.min(1, hits / Math.max(1, Math.min(wanted.size, 4))) : 0;
}

function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function textHasTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  return text.toLowerCase().includes(term.toLowerCase());
}

function scoreSpecificity(block: RetrievalBlock, terms: string[]): number {
  const meaningfulTerms = uniqueStrings(terms).filter((term) => term.length >= 3);
  if (meaningfulTerms.length === 0) return 0;
  const title = block.title;
  const entities = block.entities.join(" ");
  const concepts = block.concepts.join(" ");
  const files = block.files.join(" ");
  const text = block.canonicalText;

  let score = 0;
  let covered = 0;
  for (const term of meaningfulTerms) {
    const termScore =
      textHasTerm(title, term)
        ? 1
        : textHasTerm(entities, term) || textHasTerm(concepts, term)
          ? 0.9
          : textHasTerm(files, term)
            ? 0.75
            : textHasTerm(text, term)
              ? 0.55
              : 0;
    if (termScore > 0) covered += 1;
    score += termScore;
  }

  const coverageBonus = covered === meaningfulTerms.length ? 0.1 : 0;
  return Math.min(1, score / meaningfulTerms.length + coverageBonus);
}

function duplicateTermsFromText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4)
    .filter((term) => !DUPLICATE_STOPWORDS.has(term))
    .filter((term) => !/^\d+$/.test(term));
}

function duplicateTermSet(block: RetrievalBlock): Set<string> {
  return new Set(
    duplicateTermsFromText(
      [
        block.title,
        block.canonicalText,
        ...block.files.map((filePath) => basename(filePath)),
        ...block.concepts,
        ...block.entities,
      ].join(" "),
    ),
  );
}

function setIntersectionSize(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const value of a) {
    if (b.has(value)) hits += 1;
  }
  return hits;
}

function duplicateSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = setIntersectionSize(a, b);
  if (shared < DUPLICATE_CLUSTER_MIN_SHARED_TERMS) return 0;
  return shared / (a.size + b.size - shared);
}

function blockPreview(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => !line.startsWith("## "));
  return (preferred ?? lines[0] ?? "").slice(0, 160);
}

function renderBlock(
  block: RetrievalBlock,
  sessionId?: string,
  graphContext?: string,
): string {
  let text = block.canonicalText;
  if (block.sourceType === "turn_capsule" && block.sessionId && block.sessionId === sessionId) {
    text = text.replace(/^## Recent Turn [^\n]+/, "## Current Turn");
  }
  if (graphContext) {
    text = `${text}\nGraph: ${graphContext}`;
  }
  return text;
}

function linkedMemoryId(block: RetrievalBlock): string | undefined {
  if (
    block.sourceType === "memory" ||
    block.sourceType === "semantic_memory" ||
    block.sourceType === "procedural_memory"
  ) {
    return block.sourceId;
  }
  return undefined;
}

function lanePriority(lane: RetrievalTraceLane): number {
  switch (lane) {
    case "hot":
      return 3;
    case "warm":
      return 2;
    case "cold":
      return 1;
  }
}

function hotBlockPriority(block: RetrievalBlock): number {
  switch (block.sourceType) {
    case "working_set":
      return 3;
    case "turn_capsule":
      return 2;
    case "handoff":
      return 1;
    default:
      return 0;
  }
}

function isResumeQuery(query?: string): boolean {
  if (!query) return false;
  const normalized = query.toLowerCase();
  return [
    "resume",
    "handoff",
    "continue",
    "left off",
    "pick up",
    "picked up",
    "where was i",
    "what just happened",
    "what happened",
    "current status",
    "blocked",
    "blockers",
    "next step",
    "current objective",
  ].some((term) => normalized.includes(term));
}

function getCachedQueryEmbedding(cacheKey: string): Float32Array | null {
  const cached = queryEmbeddingCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > QUERY_EMBEDDING_CACHE_TTL_MS) {
    queryEmbeddingCache.delete(cacheKey);
    return null;
  }
  queryEmbeddingCache.delete(cacheKey);
  queryEmbeddingCache.set(cacheKey, cached);
  return cached.embedding;
}

function setCachedQueryEmbedding(
  cacheKey: string,
  embedding: Float32Array,
): void {
  queryEmbeddingCache.set(cacheKey, {
    embedding,
    cachedAt: Date.now(),
  });
  if (queryEmbeddingCache.size <= QUERY_EMBEDDING_CACHE_MAX_ENTRIES) return;
  const oldestKey = queryEmbeddingCache.keys().next().value;
  if (typeof oldestKey === "string") {
    queryEmbeddingCache.delete(oldestKey);
  }
}

async function embedQueryWithTimeout(
  embed: (text: string) => Promise<Float32Array>,
  text: string,
): Promise<Float32Array> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      embed(text),
      new Promise<Float32Array>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(`query embedding timed out after ${QUERY_EMBEDDING_TIMEOUT_MS}ms`),
          );
        }, QUERY_EMBEDDING_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function branchMatches(block: RetrievalBlock, branch?: string): boolean {
  if (!branch) return !block.branch;
  return !block.branch || block.branch === branch;
}

function projectMatches(block: RetrievalBlock, project?: string): boolean {
  if (!project) return true;
  if (block.project === project) return true;
  if (block.project !== "global") return false;
  return (
    block.sourceType !== "semantic_memory" &&
    block.sourceType !== "procedural_memory"
  );
}

type RankedRetrievalBlock = {
  block: RetrievalBlock;
  tokens: number;
  recency: number;
  fingerprint: string;
  lexicalScore: number;
  vectorScore: number;
  graphScore: number;
  specificityScore: number;
  fileScore: number;
  conceptScore: number;
  sessionScore: number;
  resumeScore: number;
  freshnessScore: number;
  recencyScore: number;
  ageHours: number;
  duplicateTerms: Set<string>;
  combinedScore: number;
};

function buildSourceSignals(ranked: RankedRetrievalBlock): RetrievalTraceSources {
  return {
    lexical: ranked.lexicalScore > 0,
    specificity: ranked.specificityScore > 0,
    vector: ranked.vectorScore > 0,
    graph: ranked.graphScore > 0,
    file: ranked.fileScore > 0,
    concept: ranked.conceptScore > 0,
    session: ranked.sessionScore > 0,
    resume: ranked.resumeScore > 0,
    freshness: ranked.freshnessScore > 0,
  };
}

function buildFreshnessTrace(ranked: RankedRetrievalBlock): RetrievalTraceFreshness {
  return {
    lane: ranked.block.freshnessLane,
    eventAt: ranked.block.eventAt,
    createdAt: ranked.block.createdAt,
    updatedAt: ranked.block.updatedAt,
    ageHours: ranked.ageHours,
    recencyScore: ranked.recencyScore,
  };
}

function buildTraceScore(ranked: RankedRetrievalBlock): RetrievalTraceScore {
  return {
    queryOverlap:
      ranked.lexicalScore +
      ranked.specificityScore +
      ranked.fileScore +
      ranked.conceptScore +
      ranked.vectorScore +
      ranked.graphScore,
    lanePriority: lanePriority(ranked.block.freshnessLane),
    recency: ranked.recency,
    lexical: ranked.lexicalScore,
    specificity: ranked.specificityScore,
    vector: ranked.vectorScore,
    graph: ranked.graphScore,
    file: ranked.fileScore,
    concept: ranked.conceptScore,
    freshness: ranked.freshnessScore,
    session: ranked.sessionScore,
    resume: ranked.resumeScore,
    combined: ranked.combinedScore,
  };
}

function buildRankingMetadata(ranked: RankedRetrievalBlock): RetrievalTraceRankingMetadata {
  return {
    sources: buildSourceSignals(ranked),
    freshness: buildFreshnessTrace(ranked),
    factors: buildTraceScore(ranked),
  };
}

function traceIdForBlock(block: RetrievalBlock): string {
  return `${block.sourceType}:${block.sourceId}`;
}

function sourceKey(block: RetrievalBlock): string {
  return `${block.sourceType}:${block.sourceId}`;
}

function findDuplicateRepresentative(
  item: RankedRetrievalBlock,
  selected: RankedRetrievalBlock[],
): RankedRetrievalBlock | null {
  for (const selectedItem of selected) {
    if (sourceKey(selectedItem.block) === sourceKey(item.block)) return selectedItem;
    if (selectedItem.fingerprint === item.fingerprint) return selectedItem;
    if (
      duplicateSimilarity(selectedItem.duplicateTerms, item.duplicateTerms) >=
      DUPLICATE_CLUSTER_MIN_JACCARD
    ) {
      return selectedItem;
    }
  }
  return null;
}

function buildTraceCandidate(ranked: RankedRetrievalBlock): RetrievalTraceCandidate {
  const metadata = buildRankingMetadata(ranked);
  return {
    id: traceIdForBlock(ranked.block),
    sourceType: ranked.block.sourceType,
    blockType: ranked.block.sourceType === "observation" ? "observation" : "memory",
    lane: ranked.block.freshnessLane,
    preview: blockPreview(ranked.block.canonicalText),
    tokens: ranked.tokens,
    score: metadata.factors,
    sources: metadata.sources,
    freshness: metadata.freshness,
    selected: false,
    decision: "skipped_lane_budget",
    sessionId: ranked.block.sessionId,
    sourceObservationIds: ranked.block.sourceObservationIds,
    isCapsule: ranked.block.sourceType === "turn_capsule" || ranked.block.sourceType === "working_set",
    linkedMemoryId: linkedMemoryId(ranked.block),
  };
}

export interface UnifiedRetrievalQuery {
  project?: string;
  sessionId?: string;
  branch?: string;
  query?: string;
  intent?: RetrievalIntent;
  focusFiles?: string[];
  focusConcepts?: string[];
  budget: number;
  purpose: "context" | "enrich" | "search" | "smart-search";
  maxBlocks?: number;
}

export interface UnifiedRetrievalResult {
  context: string;
  blocks: RetrievalBlock[];
  items: RetrievalContextItem[];
  tokens: number;
  trace: RetrievalTrace;
  searchResults: RetrievalSearchResult[];
}

function hasExplicitRelevance(item: RankedRetrievalBlock): boolean {
  return (
    item.lexicalScore > 0 ||
    item.specificityScore > 0 ||
    item.fileScore > 0 ||
    item.conceptScore > 0 ||
    item.vectorScore > 0 ||
    item.graphScore > 0 ||
    item.resumeScore > 0
  );
}

function describeWhyRetrieved(ranked: RankedRetrievalBlock): string {
  const reasons: string[] = [];
  if (ranked.resumeScore > 0) reasons.push("resume artifact");
  if (ranked.fileScore > 0) reasons.push("file overlap");
  if (ranked.conceptScore > 0) reasons.push("concept overlap");
  if (ranked.sessionScore > 0 && ranked.block.freshnessLane === "hot") {
    reasons.push("recent same-session state");
  }
  if (ranked.specificityScore >= 0.75) reasons.push("specific query coverage");
  if (ranked.lexicalScore > 0) reasons.push("text match");
  if (ranked.vectorScore > 0.2) reasons.push("semantic match");
  if (ranked.graphScore > 0.2) reasons.push("graph relation");
  if (reasons.length === 0) {
    reasons.push(
      ranked.block.freshnessLane === "hot" ? "fresh context" : "relevance ranking",
    );
  }
  return reasons.slice(0, 2).join(" + ");
}

function defaultBlockConfidence(block: RetrievalBlock): number {
  return Math.max(0.35, Math.min(0.95, block.importance / 10));
}

function guardrailConfidence(guardrail: GuardrailMemory): number {
  switch (guardrail.riskLevel) {
    case "critical":
      return 0.95;
    case "high":
      return 0.88;
    case "medium":
      return 0.76;
    case "low":
      return 0.64;
  }
}

async function buildRetrievalContextItem(
  kv: StateKV,
  ranked: RankedRetrievalBlock,
): Promise<RetrievalContextItem> {
  let blocker: string | null = null;
  let recommendedNextStep: string | null = null;
  let confidence = defaultBlockConfidence(ranked.block);

  switch (ranked.block.sourceType) {
    case "handoff": {
      const packet = await kv
        .get<HandoffPacket>(KV.handoffPackets, ranked.block.sourceId)
        .catch(() => null);
      if (packet) {
        blocker = packet.blockers[0] || null;
        recommendedNextStep = packet.recommendedNextStep || null;
        confidence = packet.confidence;
      }
      break;
    }
    case "guardrail": {
      const guardrail = await kv
        .get<GuardrailMemory>(KV.guardrails, ranked.block.sourceId)
        .catch(() => null);
      if (guardrail) {
        blocker = guardrail.triggerConditions[0] || null;
        recommendedNextStep = `Review guardrail: ${guardrail.explanation}`;
        confidence = guardrailConfidence(guardrail);
      }
      break;
    }
    case "decision": {
      const decision = await kv
        .get<DecisionMemory>(KV.decisions, ranked.block.sourceId)
        .catch(() => null);
      if (decision) {
        recommendedNextStep =
          decision.reconsiderWhen[0] || `Respect decision: ${decision.title}`;
        confidence = decision.status === "active" ? 0.82 : 0.65;
      }
      break;
    }
    case "dossier": {
      const dossier = await kv
        .get<ComponentDossier>(KV.componentDossiers, ranked.block.sourceId)
        .catch(() => null);
      if (dossier) {
        blocker = dossier.activeRisks[0] || null;
        recommendedNextStep = dossier.openQuestions[0] || null;
        confidence = 0.72;
      }
      break;
    }
  }

  return {
    sourceType: ranked.block.sourceType,
    sourceId: ranked.block.sourceId,
    title: ranked.block.title,
    why: describeWhyRetrieved(ranked),
    freshness: ranked.block.freshnessLane,
    confidence,
    relevantFiles: ranked.block.files.slice(0, 8),
    concepts: ranked.block.concepts.slice(0, 8),
    blocker,
    recommendedNextStep,
  };
}

export async function retrieveRelevantBlocks(
  kv: StateKV,
  query: UnifiedRetrievalQuery,
): Promise<UnifiedRetrievalResult> {
  const cacheKey = contextResultCacheKey(query);
  if (cacheKey) {
    const cached = getCachedContextResult(cacheKey);
    if (cached) {
      const timestamp = new Date().toISOString();
      cached.trace.generatedAt = timestamp;
      if (cached.trace.usefulnessLink && query.sessionId) {
        const usefulnessLink = {
          sessionId: query.sessionId,
          memoryIds: cached.trace.usefulnessLink.memoryIds,
          timestamp,
        };
        cached.trace.usefulnessLink = usefulnessLink;
        await kv.set(KV.contextInjections, query.sessionId, usefulnessLink).catch(() => {});
      }
      return cached;
    }
  }

  const hasProjectCoverage = (blocks: RetrievalBlock[]): boolean =>
    blocks.some((block) => projectMatches(block, query.project));
  let allBlocks: RetrievalBlock[] = [];
  let usingStateFallbackBlocks = false;
  let storedBlockReadFailed = false;
  let scopedBlockReadIncomplete = false;
  const canReadStoredBlocks = Date.now() >= retrievalBlockScopeUnavailableUntil;
  if (canReadStoredBlocks) {
    try {
      const scopedBlocks = await loadScopedRetrievalBlocks(kv, {
        project: query.project,
        sessionId: query.sessionId,
        branch: query.branch,
      }).catch(() => ({ blocks: [], complete: false }));
      if (scopedBlocks.complete) {
        allBlocks = scopedBlocks.blocks;
      } else {
        scopedBlockReadIncomplete = true;
        allBlocks = await kv.list<RetrievalBlock>(KV.retrievalBlocks);
        if (allBlocks.length > 0) {
          void warmRetrievalBlockScopeMemberships(kv, allBlocks).catch(() => {});
        }
      }
      retrievalBlockScopeUnavailableUntil = 0;
    } catch {
      storedBlockReadFailed = true;
      retrievalBlockScopeUnavailableUntil = Date.now() + RETRIEVAL_BLOCK_SCOPE_COOLDOWN_MS;
    }
  }
  const needsProjectCoverageRefresh =
    allBlocks.length === 0 ||
    (Boolean(query.project) && !hasProjectCoverage(allBlocks));
  let canFallbackFromState =
    query.purpose === "context" ||
    query.purpose === "enrich" ||
    Boolean(query.project) ||
    Boolean(query.sessionId);
  if (!canFallbackFromState && needsProjectCoverageRefresh) {
    const sessionCount = await kv.list(KV.sessions).then((items) => items.length).catch(() => Infinity);
    canFallbackFromState = sessionCount <= 32;
  }
  const shouldRefreshBlocks =
    needsProjectCoverageRefresh ||
    (scopedBlockReadIncomplete && canFallbackFromState);
  if (shouldRefreshBlocks) {
    if (!canFallbackFromState && (storedBlockReadFailed || !canReadStoredBlocks)) {
      usingStateFallbackBlocks = true;
    } else {
      const lightweightBlocks = await collectLightweightRetrievalBlocksFromState(kv, {
        project: query.project,
        sessionId: query.sessionId,
      }).catch(() => []);
      if (lightweightBlocks.length > 0) {
        allBlocks = lightweightBlocks;
        usingStateFallbackBlocks = true;
      } else if (canFallbackFromState) {
        const stateBlocks = await collectRetrievalBlocksFromState(kv).catch(() => []);
        if (stateBlocks.length > 0) {
          allBlocks = stateBlocks;
          usingStateFallbackBlocks = true;
        }
      }
    }
  }
  const blocks = allBlocks
    .filter((block) => projectMatches(block, query.project))
    .filter((block) => branchMatches(block, query.branch));

  const terms = uniqueStrings([
    ...queryTerms(query.query),
    ...(query.focusFiles || []).flatMap((filePath) => queryTerms(filePath)),
    ...(query.focusConcepts || []).flatMap((concept) => queryTerms(concept)),
  ]);
  const focusFiles = uniqueStrings(query.focusFiles || []);
  const focusConcepts = uniqueStrings(query.focusConcepts || []);
  const lexicalQuery = uniqueStrings([
    query.query || "",
    ...focusFiles,
    ...focusConcepts,
  ]).join(" ");
  const resumeQuery =
    query.intent === "resume" ||
    (query.intent !== "next_action" && isResumeQuery(query.query));
  const nextActionIntent = query.intent === "next_action";
  const hasTargetedInput =
    lexicalQuery.trim().length > 0 || resumeQuery || nextActionIntent;
  const forceHotSessionBlocks =
    (query.purpose === "context" || query.purpose === "enrich") &&
    (!hasTargetedInput || resumeQuery);
  const forcedIds = new Set<string>();
  const candidateIds = new Set<string>();
  if (forceHotSessionBlocks && query.sessionId) {
    const hotSessionBlocks = blocks
      .filter((block) => block.sessionId === query.sessionId)
      .filter((block) => block.freshnessLane === "hot")
      .sort((a, b) => {
        const priorityDelta = hotBlockPriority(b) - hotBlockPriority(a);
        if (priorityDelta !== 0) return priorityDelta;
        return new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime();
      })
      .slice(0, resumeQuery ? 4 : 8);
    for (const block of hotSessionBlocks) forcedIds.add(block.id);
  }

  const lexicalScores = new Map<string, number>();
  if (lexicalQuery.trim()) {
    let lexicalResults = usingStateFallbackBlocks
      ? []
      : getRetrievalSearchIndex().searchDocuments(lexicalQuery, 120);
    if (blocks.length > 0 && (usingStateFallbackBlocks || lexicalResults.length === 0)) {
      const fallbackIndex = new SearchIndex();
      for (const block of blocks) {
        fallbackIndex.addDocument(
          block.id,
          block.sessionId || block.project,
          buildRetrievalBlockLexicalText(block),
        );
      }
      lexicalResults = fallbackIndex.searchDocuments(lexicalQuery, 120);
    }
    const maxLexical = lexicalResults[0]?.score || 0;
    for (const result of lexicalResults) {
      candidateIds.add(result.id);
      lexicalScores.set(
        result.id,
        maxLexical > 0 ? result.score / maxLexical : 0,
      );
    }
  }

  const vectorScores = new Map<string, number>();
  const graphContexts = new Map<string, string>();
  const runtime = getRetrievalBlockIndexingRuntime();
  const vectorIndex = getRetrievalVectorIndex();
  const scopedBlockIds = new Set(blocks.map((block) => block.id));
  if (lexicalQuery.trim() && runtime.embeddingProvider && vectorIndex && vectorIndex.size > 0) {
    try {
      const cacheKey = `${runtime.embeddingProvider.name}:${lexicalQuery}`;
      let queryEmbedding = getCachedQueryEmbedding(cacheKey);
      if (!queryEmbedding) {
        queryEmbedding = await embedQueryWithTimeout(
          runtime.embeddingProvider.embed.bind(runtime.embeddingProvider),
          lexicalQuery,
        );
        setCachedQueryEmbedding(cacheKey, queryEmbedding);
      }
      const vectorResults = vectorIndex.search(queryEmbedding, 120, {
        candidateIds: scopedBlockIds,
        minScore: RETRIEVAL_BLOCK_VECTOR_MIN_SCORE,
      });
      const maxVector = vectorResults[0]?.score || 0;
      for (const result of vectorResults) {
        candidateIds.add(result.obsId);
        vectorScores.set(
          result.obsId,
          maxVector > 0 ? result.score / maxVector : result.score,
        );
      }
    } catch {
      // best effort
    }
  }

  const graphScores = new Map<string, number>();
  let graphRetrieval: GraphRetrieval | null = null;
  const getGraphRetrieval = () => {
    graphRetrieval ??= new GraphRetrieval(kv);
    return graphRetrieval;
  };
  const entityHints = uniqueStrings([
    ...extractEntitiesFromQuery(lexicalQuery),
    ...focusFiles.map((filePath) => basename(filePath)),
    ...focusConcepts,
  ]);
  if (entityHints.length > 0) {
    try {
      const graphResults = await getGraphRetrieval().searchByEntities(entityHints, 2, 40);
      const byObservationId = new Map<string, number>();
      const contextByObservationId = new Map<string, string>();
      for (const result of graphResults) {
        byObservationId.set(
          result.obsId,
          Math.max(byObservationId.get(result.obsId) || 0, result.score),
        );
        if (result.graphContext && !contextByObservationId.has(result.obsId)) {
          contextByObservationId.set(result.obsId, result.graphContext);
        }
      }
      const maxGraph = Math.max(1, ...byObservationId.values());
      for (const block of blocks) {
        const score = Math.max(
          0,
          ...block.sourceObservationIds.map(
            (obsId) => (byObservationId.get(obsId) || 0) / maxGraph,
          ),
        );
        if (score > 0) {
          candidateIds.add(block.id);
          graphScores.set(block.id, score);
          const obsId = block.sourceObservationIds.find((id) => contextByObservationId.has(id));
          if (obsId) {
            graphContexts.set(block.id, contextByObservationId.get(obsId)!);
          }
        }
      }
    } catch {
      // best effort
    }
  }

  if (forceHotSessionBlocks && query.sessionId) {
    try {
      const seedObservationIds = blocks
        .filter((block) => block.sessionId === query.sessionId)
        .filter((block) => block.freshnessLane === "hot")
        .flatMap((block) => block.sourceObservationIds)
        .slice(0, 12);
      if (seedObservationIds.length > 0) {
        const graphResults = await getGraphRetrieval().expandFromChunks(seedObservationIds, 1, 20);
        const byObservationId = new Map<string, number>();
        const contextByObservationId = new Map<string, string>();
        for (const result of graphResults) {
          byObservationId.set(
            result.obsId,
            Math.max(byObservationId.get(result.obsId) || 0, result.score),
          );
          if (result.graphContext && !contextByObservationId.has(result.obsId)) {
            contextByObservationId.set(result.obsId, result.graphContext);
          }
        }
        const maxGraph = Math.max(1, ...byObservationId.values());
        for (const block of blocks) {
          const score = Math.max(
            graphScores.get(block.id) || 0,
            ...block.sourceObservationIds.map(
              (obsId) => (byObservationId.get(obsId) || 0) / maxGraph,
            ),
          );
          if (score > 0) {
            candidateIds.add(block.id);
            graphScores.set(block.id, score);
            const obsId = block.sourceObservationIds.find((id) => contextByObservationId.has(id));
            if (obsId) {
              graphContexts.set(block.id, contextByObservationId.get(obsId)!);
            }
          }
        }
      }
    } catch {
      // best effort
    }
  }

  const now = Date.now();
  let candidateBlocks = blocks.filter((block) => {
    if (
      (query.purpose === "context" || query.purpose === "enrich") &&
      block.sourceType === "handoff" &&
      !resumeQuery
    ) {
      return false;
    }
    if (forcedIds.has(block.id)) return true;
    if (candidateIds.size === 0) return true;
    return candidateIds.has(block.id);
  });
  if (resumeQuery && (query.purpose === "context" || query.purpose === "enrich")) {
    const handoffBlocks = candidateBlocks
      .filter((block) => block.sourceType === "handoff")
      .sort((a, b) => {
        const aSession = Number(a.sessionId === query.sessionId);
        const bSession = Number(b.sessionId === query.sessionId);
        if (bSession !== aSession) return bSession - aSession;
        const laneDelta = lanePriority(b.freshnessLane) - lanePriority(a.freshnessLane);
        if (laneDelta !== 0) return laneDelta;
        const recencyDelta = new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime();
        if (recencyDelta !== 0) return recencyDelta;
        return b.importance - a.importance;
      });
    const bestHandoffId = handoffBlocks[0]?.id;
    candidateBlocks = candidateBlocks.filter(
      (block) => block.sourceType !== "handoff" || block.id === bestHandoffId,
    );
  }
  const newest = Math.max(
    1,
    ...candidateBlocks.map((block) => new Date(block.eventAt).getTime()),
  );
  const oldest = Math.min(
    newest,
    ...candidateBlocks.map((block) => new Date(block.eventAt).getTime()),
  );
  const preliminaryRanked = candidateBlocks.map((block): RankedRetrievalBlock => {
      const eventMs = new Date(block.eventAt).getTime();
      const lexicalScore = Math.max(
        lexicalScores.get(block.id) || 0,
        scoreQueryOverlap(block.canonicalText, terms),
      );
      const fileScore = fileOverlapScore(block, focusFiles);
      const conceptScore = conceptOverlapScore(block, focusConcepts);
      const specificityScore = scoreSpecificity(block, terms);
      const vectorScore = vectorScores.get(block.id) || 0;
      const graphScore = graphScores.get(block.id) || 0;
      const sessionScore =
        query.sessionId && block.sessionId === query.sessionId ? 1 : 0;
      const resumeScore =
        resumeQuery && block.isResumeArtifact ? 1 : 0;
      const freshnessScore =
        block.freshnessLane === "hot"
          ? 1
          : block.freshnessLane === "warm"
            ? 0.65
            : 0.35;
      const intentScore =
        nextActionIntent &&
        (block.sourceType === "handoff" ||
          block.sourceType === "decision" ||
          block.sourceType === "guardrail")
          ? 1
          : 0;
      const recencyScore =
        newest === oldest ? 1 : Math.max(0, (eventMs - oldest) / (newest - oldest));
      const ageHours = Math.max(0, (now - eventMs) / 3_600_000);
      const importanceScore = normalizeImportance(block.importance);
      const combinedScore =
        lexicalQuery.trim()
          ? lexicalScore * 2.2 +
            specificityScore * 1.4 +
            fileScore * 1.8 +
            conceptScore * 1.5 +
            vectorScore * 1.2 +
            graphScore * 0.8 +
            sessionScore * 0.7 +
            resumeScore * 0.6 +
            intentScore * 0.6 +
            freshnessScore * 0.5 +
            recencyScore * 0.5 +
            importanceScore * 0.05
          : sessionScore * 2.4 +
            freshnessScore * 1.6 +
            resumeScore * 1.2 +
            intentScore * 1.1 +
            recencyScore * 0.8 +
            importanceScore * 0.08;
      return {
        block,
        tokens: estimateTokens(renderBlock(block, query.sessionId, graphContexts.get(block.id))),
        recency: eventMs,
        fingerprint: normalizeFingerprint(
          renderBlock(block, query.sessionId, graphContexts.get(block.id)),
        ),
        lexicalScore,
        specificityScore,
        vectorScore,
        graphScore,
        fileScore,
        conceptScore,
        sessionScore,
        resumeScore,
        freshnessScore,
        recencyScore,
        ageHours,
        duplicateTerms: duplicateTermSet(block),
        combinedScore,
      };
    });
  const hasExplicitRelevantCandidate = preliminaryRanked.some(hasExplicitRelevance);
  const ranked = preliminaryRanked
    .filter((item) => {
      if (query.purpose !== "context") {
        return hasExplicitRelevance(item);
      }
      if (!hasTargetedInput) {
        return true;
      }
      if (hasExplicitRelevantCandidate) {
        return hasExplicitRelevance(item);
      }
      return item.block.freshnessLane === "hot" && item.sessionScore > 0;
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const traceTimestamp = new Date().toISOString();
  const laneBudgets: Record<RetrievalTraceLane, number> =
    query.purpose === "enrich"
      ? {
          hot: Math.floor(query.budget * 0.2),
          warm: Math.floor(query.budget * 0.55),
          cold: query.budget - Math.floor(query.budget * 0.2) - Math.floor(query.budget * 0.55),
        }
      : terms.length > 0
        ? {
            hot: Math.floor(query.budget * 0.2),
            warm: Math.floor(query.budget * 0.4),
            cold: query.budget - Math.floor(query.budget * 0.2) - Math.floor(query.budget * 0.4),
          }
        : {
            hot: Math.floor(query.budget * 0.4),
            warm: Math.floor(query.budget * 0.3),
            cold: query.budget - Math.floor(query.budget * 0.4) - Math.floor(query.budget * 0.3),
          };
  const laneUsage: Record<RetrievalTraceLane, number> = { hot: 0, warm: 0, cold: 0 };
  const traceCandidates = new Map(
    ranked.map((item) => [item.block.id, buildTraceCandidate(item)]),
  );
  const selected: RankedRetrievalBlock[] = [];
  const selectedObservationIds = new Set<string>();
  const selectedSessionBlocks = new Set<string>();

  const markSkipped = (item: RankedRetrievalBlock, decision: RetrievalTraceDecision) => {
    const candidate = traceCandidates.get(item.block.id);
    if (!candidate || candidate.selected) return;
    candidate.decision = decision;
    candidate.selected = false;
  };

  const markDuplicate = (
    item: RankedRetrievalBlock,
    representative: RankedRetrievalBlock,
  ) => {
    markSkipped(item, "skipped_duplicate_fingerprint");
    const candidate = traceCandidates.get(item.block.id);
    const representativeCandidate = traceCandidates.get(representative.block.id);
    if (!candidate || !representativeCandidate) return;
    candidate.duplicateOf = traceIdForBlock(representative.block);
    const duplicateId = traceIdForBlock(item.block);
    const collapsed = representativeCandidate.collapsedDuplicateIds ?? [];
    if (!collapsed.includes(duplicateId)) {
      collapsed.push(duplicateId);
    }
    representativeCandidate.collapsedDuplicateIds = collapsed;
    representativeCandidate.collapsedDuplicateCount = collapsed.length;
  };

  const take = (item: RankedRetrievalBlock, decision: RetrievalTraceDecision) => {
    selected.push(item);
    if (item.block.sessionId) {
      selectedSessionBlocks.add(item.block.sessionId);
    }
    for (const obsId of item.block.sourceObservationIds) {
      selectedObservationIds.add(obsId);
    }
    laneUsage[item.block.freshnessLane] += item.tokens;
    const candidate = traceCandidates.get(item.block.id);
    if (candidate) {
      candidate.selected = true;
      candidate.decision = decision;
    }
  };

  const maxBlocks = Math.max(1, query.maxBlocks || (query.purpose === "enrich" ? 8 : 12));
  let usedTokens = 0;
  for (const item of ranked) {
    if (selected.length >= maxBlocks) {
      markSkipped(item, "skipped_lane_budget");
      continue;
    }
    const duplicateRepresentative = findDuplicateRepresentative(item, selected);
    if (duplicateRepresentative) {
      markDuplicate(item, duplicateRepresentative);
      continue;
    }
    if (
      item.block.sourceObservationIds.some((obsId) => selectedObservationIds.has(obsId))
    ) {
      markSkipped(item, "skipped_observation_already_selected");
      continue;
    }
    if (
      item.block.scope === "session" &&
      item.block.sessionId &&
      selectedSessionBlocks.has(item.block.sessionId) &&
      item.block.freshnessLane === "cold"
    ) {
      markSkipped(item, "skipped_session_already_covered");
      continue;
    }
    if (laneUsage[item.block.freshnessLane] + item.tokens > laneBudgets[item.block.freshnessLane]) {
      markSkipped(item, "skipped_lane_budget");
      continue;
    }
    if (usedTokens + item.tokens > query.budget) {
      markSkipped(item, "skipped_total_budget");
      continue;
    }
    take(item, "selected_lane_budget");
    usedTokens += item.tokens;
  }

  for (const item of ranked) {
    if (selected.includes(item)) continue;
    if (selected.length >= maxBlocks) {
      markSkipped(item, "skipped_lane_budget");
      continue;
    }
    const duplicateRepresentative = findDuplicateRepresentative(item, selected);
    if (duplicateRepresentative) {
      markDuplicate(item, duplicateRepresentative);
      continue;
    }
    if (
      item.block.sourceObservationIds.some((obsId) => selectedObservationIds.has(obsId))
    ) {
      markSkipped(item, "skipped_observation_already_selected");
      continue;
    }
    if (usedTokens + item.tokens > query.budget) {
      markSkipped(item, "skipped_total_budget");
      continue;
    }
    take(item, "selected_leftover_fill");
    usedTokens += item.tokens;
  }

  const selectedBlocks = selected.map((item) => item.block);
  const items = await Promise.all(
    selected.map((item) => buildRetrievalContextItem(kv, item)),
  );
  const injectedMemoryIds = uniqueStrings(
    selectedBlocks.map((block) => linkedMemoryId(block)),
  );
  const usefulnessLink =
    query.sessionId && injectedMemoryIds.length > 0
      ? {
          sessionId: query.sessionId,
          memoryIds: injectedMemoryIds,
          timestamp: traceTimestamp,
        }
      : null;

  if (usefulnessLink) {
    await kv.set(KV.contextInjections, query.sessionId!, usefulnessLink).catch(() => {});
  }

  const renderedBlocksWithGraph = selectedBlocks.map((block) =>
    renderBlock(block, query.sessionId, graphContexts.get(block.id)),
  );
  const context =
    renderedBlocksWithGraph.length > 0
      ? `<agentmemory-context project="${escapeXmlAttr(query.project || "*")}">\n${renderedBlocksWithGraph.join("\n\n")}\n</agentmemory-context>`
      : "";

  const rankedByBlockId = new Map(ranked.map((item) => [item.block.id, item]));
  const searchResults: RetrievalSearchResult[] = await Promise.all(
    selectedBlocks.map(async (block) => {
      const rankedItem = rankedByBlockId.get(block.id);
      const traceCandidate = traceCandidates.get(block.id);
      const rankingMetadata = rankedItem
        ? {
            ...buildRankingMetadata(rankedItem),
            duplicateOf: traceCandidate?.duplicateOf,
            collapsedDuplicateIds: traceCandidate?.collapsedDuplicateIds,
            collapsedDuplicateCount: traceCandidate?.collapsedDuplicateCount,
          }
        : undefined;
      return {
        block,
        score: rankedItem?.combinedScore || 0,
        lexicalScore: rankedItem?.lexicalScore || 0,
        specificityScore: rankedItem?.specificityScore || 0,
        vectorScore: rankedItem?.vectorScore || 0,
        graphScore: rankedItem?.graphScore || 0,
        freshnessScore: rankedItem?.freshnessScore || 0,
        recencyScore: rankedItem?.recencyScore || 0,
        rankingMetadata,
        sessionId: block.sessionId,
        observation:
          block.sourceType === "observation" && block.sessionId
            ? await kv
                .get<CompressedObservation>(KV.observations(block.sessionId), block.sourceId)
                .catch(() => null)
            : null,
      };
    }),
  );

  const trace: RetrievalTrace = {
    generatedAt: traceTimestamp,
    query: query.query?.trim() || undefined,
    queryTerms: terms,
    budget: query.budget,
    availableBudget: query.budget,
    selectedTokens: usedTokens,
    responseTokens: usedTokens,
    laneBudgets,
    laneUsage,
    selected: selected
      .map((item) => traceCandidates.get(item.block.id))
      .filter((candidate): candidate is RetrievalTraceCandidate => Boolean(candidate)),
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

  const result = {
    context,
    blocks: selectedBlocks,
    items,
    tokens: usedTokens,
    trace,
    searchResults,
  };
  if (cacheKey && !usingStateFallbackBlocks) {
    setCachedContextResult(cacheKey, result);
  }
  return result;
}

function normalizeImportance(value: number): number {
  return Math.max(1, Math.min(10, value || 0));
}
