import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type CodexLiveRetrievalIntent =
  | "resume"
  | "user_turn"
  | "manual_recall"
  | "file_enrich"
  | "next_action";

export type CodexLiveRetrievalCase = {
  id: string;
  category?: string;
  description?: string;
  project: string;
  cwd?: string;
  branch?: string;
  query: string;
  intent?: CodexLiveRetrievalIntent;
  budget?: number;
  contextBudget?: number;
  limit?: number;
  searchLimit?: number;
  files?: string[];
  terms?: string[];
  requiredEvidenceIds?: string[];
  requiredSubstrings?: string[];
  requiredAnySubstrings?: string[][];
  freshnessSubstrings?: string[];
  freshnessRequiredSubstrings?: string[];
  staleSubstrings?: string[];
  forbiddenStaleSubstrings?: string[];
  forbiddenProjectSubstrings?: string[];
  forbiddenEvidenceIds?: string[];
  forbiddenSubstrings?: string[];
  knownEvidence?: boolean;
  maxContextLatencyMs?: number;
  maxSmartSearchLatencyMs?: number;
};

export type CodexLiveRetrievalHttpResult = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  body: unknown;
  error?: string;
};

export type CodexLiveRetrievalSurfaceResult = {
  sessionStart?: CodexLiveRetrievalHttpResult;
  context: CodexLiveRetrievalHttpResult;
  smartSearch: CodexLiveRetrievalHttpResult;
  sessionEnd?: CodexLiveRetrievalHttpResult;
};

export type CodexLiveRetrievalCaseResult = {
  id: string;
  query: string;
  project: string;
  branch?: string;
  relevancePass: boolean;
  freshnessPass: boolean;
  leakagePass: boolean;
  latencyPass: boolean;
  contextNonEmptyPass: boolean;
  httpPass: boolean;
  passed: boolean;
  failures: string[];
  missingRequiredEvidenceIds: string[];
  missingRequiredSubstrings: string[];
  missingRequiredAnySubstrings: string[][];
  missingFreshnessSubstrings: string[];
  staleSubstringHits: string[];
  forbiddenEvidenceIdHits: string[];
  forbiddenSubstringHits: string[];
  contextChars: number;
  contextItems: number | null;
  smartSearchResults: number | null;
  contextLatencyMs: number;
  smartSearchLatencyMs: number;
  sessionStartLatencyMs?: number;
  contextStatus: number | null;
  smartSearchStatus: number | null;
  searchResultIds: string[];
  trace: {
    context?: unknown;
    smartSearch?: unknown;
  };
  previews: {
    context: string;
    smartSearch: string;
  };
};

export type CodexLiveRetrievalSummary = {
  evaluatedAt: string;
  passed: boolean;
  cases: number;
  relevance: {
    pass: boolean;
    passedCases: number;
    score: number;
  };
  freshness: {
    pass: boolean;
    passedCases: number;
    score: number;
  };
  leakage: {
    pass: boolean;
    leakageCount: number;
  };
  latency: {
    pass: boolean;
    required: boolean;
    contextP95Ms: number;
    smartSearchP95Ms: number;
    maxContextLatencyMs: number;
    maxSmartSearchLatencyMs: number;
  };
  context: {
    nonEmptyKnownEvidencePass: boolean;
    emptyKnownEvidenceCount: number;
  };
  http: {
    pass: boolean;
    failedCases: number;
  };
  failures: string[];
};

export type CodexLiveRetrievalSuiteResult = {
  summary: CodexLiveRetrievalSummary;
  cases: CodexLiveRetrievalCaseResult[];
};

export type CodexLiveRetrievalEvalCase = CodexLiveRetrievalCase & {
  category?: string;
  freshnessRequiredSubstrings?: string[];
  forbiddenStaleSubstrings?: string[];
  forbiddenProjectSubstrings?: string[];
};

export type CodexLiveRetrievalCaseRun = {
  evalCase: CodexLiveRetrievalEvalCase;
  context: CodexLiveRetrievalHttpResult;
  smartSearch: CodexLiveRetrievalHttpResult;
  sessionStart?: CodexLiveRetrievalHttpResult;
};

export type CodexLiveRetrievalRunsResult = {
  pass: boolean;
  warnings: string[];
  failures: string[];
  relevance: {
    requiredChecks: number;
    requiredHits: number;
    knownEvidenceCases: number;
    nonEmptyContextKnownEvidenceCases: number;
    pass: boolean;
  };
  freshness: {
    requiredChecks: number;
    requiredHits: number;
    forbiddenStaleHits: number;
    pass: boolean;
  };
  leakage: {
    forbiddenHits: number;
    pass: boolean;
  };
  latency: CodexLiveRetrievalSummary["latency"];
  cases: CodexLiveRetrievalCaseResult[];
};

export type CodexLiveRetrievalRunOptions = {
  baseUrl: string;
  cases: CodexLiveRetrievalCase[];
  timeoutMs?: number;
  artifactPath?: string;
  jsonlPath?: string;
  requireLatency?: boolean;
  startSessions?: boolean;
  endSessions?: boolean;
  sessionPrefix?: string;
  defaultProject?: string;
  defaultCodexProject?: string;
  maxContextLatencyMs?: number;
  maxSmartSearchLatencyMs?: number;
};

type RequestOptions = {
  baseUrl: string;
  timeoutMs: number;
};

const DEFAULT_CONTEXT_LATENCY_MS = 2000;
const DEFAULT_SMART_SEARCH_LATENCY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SESSION_PREFIX = "codex-live-retrieval-eval";
const DEFAULT_AGENTMEMORY_PROJECT =
  "/home/ericjuta/.openclaw/workspace/repos/agentmemory";
const DEFAULT_CODEX_PROJECT = "/home/ericjuta/.openclaw/workspace/repos/codex";

function normalizeRestBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/agentmemory") ? trimmed : trimmed + "/agentmemory";
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

function preview(value: unknown, maxLength = 900): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function containsNormalized(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function contextText(body: unknown): string {
  const record = asObject(body);
  const context = record?.context;
  return typeof context === "string" ? context : "";
}

function contextItemsCount(body: unknown): number | null {
  const record = asObject(body);
  const items = record?.items;
  return Array.isArray(items) ? items.length : null;
}

function smartSearchResultsCount(body: unknown): number | null {
  const record = asObject(body);
  const results = record?.results;
  return Array.isArray(results) ? results.length : null;
}

function collectIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, ids);
    return ids;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (
      (key === "id" ||
        key === "obsId" ||
        key === "blockId" ||
        key === "sourceId" ||
        key === "sessionId") &&
      typeof entry === "string" &&
      entry.trim()
    ) {
      ids.add(entry);
    }
    collectIds(entry, ids);
  }
  return ids;
}

function extractSearchResultIds(body: unknown): string[] {
  const record = asObject(body);
  const results = record?.results;
  if (!Array.isArray(results)) return [];
  const ids = new Set<string>();
  for (const result of results) collectIds(result, ids);
  return [...ids];
}

function evidenceKnown(evalCase: CodexLiveRetrievalCase): boolean {
  if (typeof evalCase.knownEvidence === "boolean") return evalCase.knownEvidence;
  return Boolean(
    evalCase.requiredEvidenceIds?.length ||
      evalCase.requiredSubstrings?.length ||
      evalCase.requiredAnySubstrings?.length ||
      evalCase.freshnessSubstrings?.length,
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function ratio(passed: number, total: number): number {
  return total === 0 ? 1 : passed / total;
}

function expandFixtureValue(
  value: string,
  options: {
    defaultProject?: string;
    defaultCodexProject?: string;
  },
): string {
  const agentmemoryProject =
    options.defaultProject ||
    process.env.AGENTMEMORY_CODEX_LIVE_EVAL_PROJECT ||
    process.env.AGENTMEMORY_PROJECT ||
    DEFAULT_AGENTMEMORY_PROJECT;
  const codexProject =
    options.defaultCodexProject ||
    process.env.AGENTMEMORY_CODEX_LIVE_EVAL_CODEX_PROJECT ||
    process.env.CODEX_PROJECT ||
    DEFAULT_CODEX_PROJECT;
  return value
    .replaceAll("$AGENTMEMORY_REPO", agentmemoryProject)
    .replaceAll("$CODEX_REPO", codexProject)
    .replaceAll("$CWD", process.cwd());
}

export function expandCodexLiveRetrievalCase(
  evalCase: CodexLiveRetrievalCase,
  options: {
    defaultProject?: string;
    defaultCodexProject?: string;
  } = {},
): CodexLiveRetrievalCase {
  return {
    ...evalCase,
    project: expandFixtureValue(evalCase.project, options),
    cwd: evalCase.cwd ? expandFixtureValue(evalCase.cwd, options) : undefined,
  };
}

export function loadCodexLiveRetrievalCases(
  fixturePath: string,
  options: {
    defaultProject?: string;
    defaultCodexProject?: string;
  } = {},
): CodexLiveRetrievalCase[] {
  const parsed = JSON.parse(readFileSync(resolve(fixturePath), "utf8")) as unknown;
  const cases = Array.isArray(parsed) ? parsed : asObject(parsed)?.cases;
  if (!Array.isArray(cases)) {
    throw new Error(
      "codex live retrieval fixture must be an array or object with cases",
    );
  }
  return cases.map((entry) =>
    expandCodexLiveRetrievalCase(entry as CodexLiveRetrievalCase, options),
  );
}

export function evaluateCodexLiveRetrievalCase(
  evalCase: CodexLiveRetrievalCase,
  surfaces: CodexLiveRetrievalSurfaceResult,
): CodexLiveRetrievalCaseResult {
  const contextBody = asObject(surfaces.context.body);
  const smartSearchBody = asObject(surfaces.smartSearch.body);
  const context = contextText(surfaces.context.body);
  const contextChars = context.length;
  const contextItems = contextItemsCount(surfaces.context.body);
  const smartSearchResults = smartSearchResultsCount(surfaces.smartSearch.body);
  const scoredBody = {
    context: {
      context: contextBody?.context,
      items: contextBody?.items,
      blocks: contextBody?.blocks,
    },
    smartSearch: {
      results: smartSearchBody?.results,
    },
  };
  const combined = jsonText(scoredBody);
  const ids = collectIds(scoredBody);
  const searchResultIds = extractSearchResultIds(surfaces.smartSearch.body);
  const requiredEvidenceIds = stringArray(evalCase.requiredEvidenceIds);
  const requiredSubstrings = stringArray(evalCase.requiredSubstrings);
  const requiredAnySubstrings = Array.isArray(evalCase.requiredAnySubstrings)
    ? evalCase.requiredAnySubstrings.filter((group): group is string[] =>
        Array.isArray(group),
      )
    : [];
  const freshnessSubstrings = [
    ...stringArray(evalCase.freshnessSubstrings),
    ...stringArray(evalCase.freshnessRequiredSubstrings),
  ];
  const staleSubstrings = [
    ...stringArray(evalCase.staleSubstrings),
    ...stringArray(evalCase.forbiddenStaleSubstrings),
  ];
  const forbiddenEvidenceIds = stringArray(evalCase.forbiddenEvidenceIds);
  const forbiddenSubstrings = [
    ...stringArray(evalCase.forbiddenSubstrings),
    ...stringArray(evalCase.forbiddenProjectSubstrings),
  ];
  const missingRequiredEvidenceIds = requiredEvidenceIds.filter(
    (id) => !ids.has(id) && !containsNormalized(combined, id),
  );
  const missingRequiredSubstrings = requiredSubstrings.filter(
    (item) => !containsNormalized(combined, item),
  );
  const missingRequiredAnySubstrings = requiredAnySubstrings.filter(
    (group) => !group.some((item) => containsNormalized(combined, item)),
  );
  const missingFreshnessSubstrings = freshnessSubstrings.filter(
    (item) => !containsNormalized(combined, item),
  );
  const staleSubstringHits = staleSubstrings.filter((item) =>
    containsNormalized(combined, item),
  );
  const forbiddenEvidenceIdHits = forbiddenEvidenceIds.filter(
    (id) => ids.has(id) || containsNormalized(combined, id),
  );
  const forbiddenSubstringHits = forbiddenSubstrings.filter((item) =>
    containsNormalized(combined, item),
  );
  const contextNonEmptyPass =
    !evidenceKnown(evalCase) || contextChars > 0 || (contextItems ?? 0) > 0;
  const relevancePass =
    missingRequiredEvidenceIds.length === 0 &&
    missingRequiredSubstrings.length === 0 &&
    missingRequiredAnySubstrings.length === 0;
  const freshnessPass =
    missingFreshnessSubstrings.length === 0 && staleSubstringHits.length === 0;
  const leakagePass =
    forbiddenEvidenceIdHits.length === 0 && forbiddenSubstringHits.length === 0;
  const maxContextLatencyMs =
    evalCase.maxContextLatencyMs ?? DEFAULT_CONTEXT_LATENCY_MS;
  const maxSmartSearchLatencyMs =
    evalCase.maxSmartSearchLatencyMs ?? DEFAULT_SMART_SEARCH_LATENCY_MS;
  const latencyPass =
    surfaces.context.latencyMs <= maxContextLatencyMs &&
    surfaces.smartSearch.latencyMs <= maxSmartSearchLatencyMs;
  const httpPass =
    surfaces.context.ok &&
    surfaces.smartSearch.ok &&
    (surfaces.sessionStart?.ok ?? true);
  const failures: string[] = [];
  if (!httpPass) failures.push("http");
  if (!contextNonEmptyPass) failures.push("context_empty_for_known_evidence");
  if (!relevancePass) failures.push("relevance");
  if (!freshnessPass) failures.push("freshness");
  if (!leakagePass) failures.push("leakage");
  if (!latencyPass) failures.push("latency");
  const passed =
    httpPass && contextNonEmptyPass && relevancePass && freshnessPass && leakagePass;

  return {
    id: evalCase.id,
    query: evalCase.query,
    project: evalCase.project,
    branch: evalCase.branch,
    relevancePass,
    freshnessPass,
    leakagePass,
    latencyPass,
    contextNonEmptyPass,
    httpPass,
    passed,
    failures,
    missingRequiredEvidenceIds,
    missingRequiredSubstrings,
    missingRequiredAnySubstrings,
    missingFreshnessSubstrings,
    staleSubstringHits,
    forbiddenEvidenceIdHits,
    forbiddenSubstringHits,
    contextChars,
    contextItems,
    smartSearchResults,
    contextLatencyMs: surfaces.context.latencyMs,
    smartSearchLatencyMs: surfaces.smartSearch.latencyMs,
    sessionStartLatencyMs: surfaces.sessionStart?.latencyMs,
    contextStatus: surfaces.context.status,
    smartSearchStatus: surfaces.smartSearch.status,
    searchResultIds,
    trace: {
      context: contextBody?.trace,
      smartSearch: smartSearchBody?.trace,
    },
    previews: {
      context: preview(context),
      smartSearch: preview(jsonText(surfaces.smartSearch.body)),
    },
  };
}

export function summarizeCodexLiveRetrievalSuite(
  cases: CodexLiveRetrievalCaseResult[],
  options: {
    requireLatency?: boolean;
    maxContextLatencyMs?: number;
    maxSmartSearchLatencyMs?: number;
  } = {},
): CodexLiveRetrievalSummary {
  const relevancePassed = cases.filter((item) => item.relevancePass).length;
  const freshnessPassed = cases.filter((item) => item.freshnessPass).length;
  const leakageCount = cases.reduce(
    (sum, item) =>
      sum +
      item.forbiddenEvidenceIdHits.length +
      item.forbiddenSubstringHits.length,
    0,
  );
  const emptyKnownEvidenceCount = cases.filter(
    (item) => !item.contextNonEmptyPass,
  ).length;
  const httpFailedCases = cases.filter((item) => !item.httpPass).length;
  const maxContextLatencyMs =
    options.maxContextLatencyMs ?? DEFAULT_CONTEXT_LATENCY_MS;
  const maxSmartSearchLatencyMs =
    options.maxSmartSearchLatencyMs ?? DEFAULT_SMART_SEARCH_LATENCY_MS;
  const contextP95Ms = percentile(
    cases.map((item) => item.contextLatencyMs),
    95,
  );
  const smartSearchP95Ms = percentile(
    cases.map((item) => item.smartSearchLatencyMs),
    95,
  );
  const latencyPass =
    contextP95Ms <= maxContextLatencyMs &&
    smartSearchP95Ms <= maxSmartSearchLatencyMs &&
    cases.every((item) => item.latencyPass);
  const failures = [
    ...new Set(
      cases.flatMap((item) =>
        item.failures
          .filter((failure) => failure !== "latency" || options.requireLatency)
          .map((failure) => item.id + ":" + failure),
      ),
    ),
  ];
  const passWithoutLatency = cases.every((item) => item.passed);
  const passed = passWithoutLatency && (!options.requireLatency || latencyPass);
  return {
    evaluatedAt: new Date().toISOString(),
    passed,
    cases: cases.length,
    relevance: {
      pass: relevancePassed === cases.length,
      passedCases: relevancePassed,
      score: ratio(relevancePassed, cases.length),
    },
    freshness: {
      pass: freshnessPassed === cases.length,
      passedCases: freshnessPassed,
      score: ratio(freshnessPassed, cases.length),
    },
    leakage: {
      pass: leakageCount === 0,
      leakageCount,
    },
    latency: {
      pass: latencyPass,
      required: options.requireLatency === true,
      contextP95Ms,
      smartSearchP95Ms,
      maxContextLatencyMs,
      maxSmartSearchLatencyMs,
    },
    context: {
      nonEmptyKnownEvidencePass: emptyKnownEvidenceCount === 0,
      emptyKnownEvidenceCount,
    },
    http: {
      pass: httpFailedCases === 0,
      failedCases: httpFailedCases,
    },
    failures,
  };
}

function normalizeLegacyEvalCase(
  evalCase: CodexLiveRetrievalEvalCase,
): CodexLiveRetrievalCase {
  return {
    ...evalCase,
    freshnessSubstrings:
      evalCase.freshnessSubstrings ??
      evalCase.freshnessRequiredSubstrings,
    staleSubstrings:
      evalCase.staleSubstrings ?? evalCase.forbiddenStaleSubstrings,
    forbiddenSubstrings: [
      ...(evalCase.forbiddenSubstrings ?? []),
      ...(evalCase.forbiddenProjectSubstrings ?? []),
    ],
  };
}

export function evaluateCodexLiveRetrievalRuns(
  runs: CodexLiveRetrievalCaseRun[],
  options: {
    targetContextP95Ms?: number;
    targetSmartSearchP95Ms?: number;
    enforceLatency?: boolean;
  } = {},
): CodexLiveRetrievalRunsResult {
  const normalizedRuns = runs.map((run) => ({
    ...run,
    evalCase: normalizeLegacyEvalCase(run.evalCase),
  }));
  const cases = normalizedRuns.map((run) =>
    evaluateCodexLiveRetrievalCase(run.evalCase, {
      sessionStart: run.sessionStart,
      context: run.context,
      smartSearch: run.smartSearch,
    }),
  );
  const summary = summarizeCodexLiveRetrievalSuite(cases, {
    requireLatency: options.enforceLatency,
    maxContextLatencyMs: options.targetContextP95Ms,
    maxSmartSearchLatencyMs: options.targetSmartSearchP95Ms,
  });
  const relevanceRequiredChecks = normalizedRuns.reduce(
    (sum, run) =>
      sum +
      (run.evalCase.requiredSubstrings?.length ?? 0) +
      (run.evalCase.requiredEvidenceIds?.length ?? 0) +
      (run.evalCase.requiredAnySubstrings?.length ?? 0),
    0,
  );
  const relevanceMisses = cases.reduce(
    (sum, item) =>
      sum +
      item.missingRequiredSubstrings.length +
      item.missingRequiredEvidenceIds.length +
      item.missingRequiredAnySubstrings.length,
    0,
  );
  const freshnessRequiredChecks = normalizedRuns.reduce(
    (sum, run) => sum + (run.evalCase.freshnessSubstrings?.length ?? 0),
    0,
  );
  const freshnessMisses = cases.reduce(
    (sum, item) => sum + item.missingFreshnessSubstrings.length,
    0,
  );
  const forbiddenStaleHits = cases.reduce(
    (sum, item) => sum + item.staleSubstringHits.length,
    0,
  );
  const forbiddenHits = cases.reduce(
    (sum, item) =>
      sum + item.forbiddenEvidenceIdHits.length + item.forbiddenSubstringHits.length,
    0,
  );
  const knownEvidenceCases = normalizedRuns.filter((run) =>
    evidenceKnown(run.evalCase),
  ).length;
  const nonEmptyContextKnownEvidenceCases = cases.filter(
    (item, index) =>
      evidenceKnown(normalizedRuns[index]!.evalCase) && item.contextNonEmptyPass,
  ).length;
  const failures = cases.flatMap((item) => [
    ...(!item.httpPass ? [item.id + ":http"] : []),
    ...(!item.contextNonEmptyPass
      ? [item.id + ":context_empty_for_known_evidence"]
      : []),
    ...(!item.relevancePass ? [item.id + ":required_evidence_missing"] : []),
    ...item.staleSubstringHits.map(
      (hit) => item.id + ":stale_evidence_returned:" + hit,
    ),
    ...item.forbiddenEvidenceIdHits.map((hit) => item.id + ":leakage:" + hit),
    ...item.forbiddenSubstringHits.map((hit) => item.id + ":leakage:" + hit),
  ]);
  const warnings: string[] = [];
  if (!summary.latency.pass) warnings.push("latency_target_exceeded");
  if (options.enforceLatency && !summary.latency.pass) {
    failures.push("latency_target_exceeded");
  }
  return {
    pass: summary.passed,
    warnings,
    failures,
    relevance: {
      requiredChecks: relevanceRequiredChecks,
      requiredHits: relevanceRequiredChecks - relevanceMisses,
      knownEvidenceCases,
      nonEmptyContextKnownEvidenceCases,
      pass: relevanceMisses === 0,
    },
    freshness: {
      requiredChecks: freshnessRequiredChecks,
      requiredHits: freshnessRequiredChecks - freshnessMisses,
      forbiddenStaleHits,
      pass: freshnessMisses === 0 && forbiddenStaleHits === 0,
    },
    leakage: {
      forbiddenHits,
      pass: forbiddenHits === 0,
    },
    latency: summary.latency,
    cases,
  };
}

async function requestJson(
  method: string,
  url: string,
  body: unknown,
  options: RequestOptions,
): Promise<CodexLiveRetrievalHttpResult> {
  const startedAt = Date.now();
  const headers: Record<string, string> =
    body === undefined ? {} : { "content-type": "application/json" };
  if (process.env.AGENTMEMORY_SECRET) {
    headers.authorization = "Bearer " + process.env.AGENTMEMORY_SECRET;
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const responseText = await response.text();
    let parsed: unknown = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      parsed = { text: responseText };
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      body: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function appendJsonl(path: string, rows: unknown[]): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await appendFile(path, body, "utf8");
}

async function runLiveCase(
  evalCase: CodexLiveRetrievalCase,
  index: number,
  options: Required<Pick<CodexLiveRetrievalRunOptions, "baseUrl">> &
    Omit<CodexLiveRetrievalRunOptions, "baseUrl" | "cases">,
): Promise<CodexLiveRetrievalCaseResult> {
  const restBase = normalizeRestBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessionPrefix = options.sessionPrefix ?? DEFAULT_SESSION_PREFIX;
  const sessionId =
    sessionPrefix + "-" + evalCase.id + "-" + Date.now() + "-" + index;
  const requestOptions = { baseUrl: restBase, timeoutMs };
  const cwd = evalCase.cwd || evalCase.project;
  const budget = evalCase.contextBudget ?? evalCase.budget ?? 6000;
  let sessionStart: CodexLiveRetrievalHttpResult | undefined;
  let sessionEnd: CodexLiveRetrievalHttpResult | undefined;

  if (options.startSessions !== false) {
    sessionStart = await requestJson(
      "POST",
      restBase + "/session/start",
      {
        sessionId,
        project: evalCase.project,
        cwd,
        ...(evalCase.branch ? { branch: evalCase.branch } : {}),
        budget,
      },
      requestOptions,
    );
  }

  const [context, smartSearch] = await Promise.all([
    requestJson(
      "POST",
      restBase + "/context",
      {
        sessionId,
        project: evalCase.project,
        query: evalCase.query,
        budget,
        ...(evalCase.intent ? { intent: evalCase.intent } : {}),
        ...(evalCase.files?.length ? { files: evalCase.files } : {}),
        ...(evalCase.terms?.length ? { terms: evalCase.terms } : {}),
      },
      requestOptions,
    ),
    requestJson(
      "POST",
      restBase + "/smart-search",
      {
        query: evalCase.query,
        project: evalCase.project,
        cwd,
        ...(evalCase.branch ? { branch: evalCase.branch } : {}),
        limit: evalCase.searchLimit ?? evalCase.limit ?? 5,
        trace: true,
      },
      requestOptions,
    ),
  ]);

  if (options.endSessions !== false && options.startSessions !== false) {
    sessionEnd = await requestJson(
      "POST",
      restBase + "/session/end",
      { sessionId },
      requestOptions,
    );
  }

  return evaluateCodexLiveRetrievalCase(evalCase, {
    sessionStart,
    context,
    smartSearch,
    sessionEnd,
  });
}

export async function runCodexLiveRetrievalEval(
  options: CodexLiveRetrievalRunOptions,
): Promise<CodexLiveRetrievalSuiteResult> {
  const cases = options.cases.map((evalCase) =>
    expandCodexLiveRetrievalCase(evalCase, {
      defaultProject: options.defaultProject,
      defaultCodexProject: options.defaultCodexProject,
    }),
  );
  const results: CodexLiveRetrievalCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const result = await runLiveCase(cases[i]!, i + 1, options);
    results.push(result);
    if (options.jsonlPath) {
      await appendJsonl(options.jsonlPath, [
        {
          type: "codex_live_retrieval_case",
          evaluatedAt: new Date().toISOString(),
          ...result,
        },
      ]);
    }
  }
  const summary = summarizeCodexLiveRetrievalSuite(results, {
    requireLatency: options.requireLatency,
    maxContextLatencyMs: options.maxContextLatencyMs,
    maxSmartSearchLatencyMs: options.maxSmartSearchLatencyMs,
  });
  const suite = { summary, cases: results };
  if (options.artifactPath) {
    mkdirSync(dirname(options.artifactPath), { recursive: true });
    writeFileSync(options.artifactPath, JSON.stringify(suite, null, 2), "utf8");
  }
  if (options.jsonlPath) {
    await appendJsonl(options.jsonlPath, [
      {
        type: "codex_live_retrieval_summary",
        ...summary,
      },
    ]);
  }
  return suite;
}
