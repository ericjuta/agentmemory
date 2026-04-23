import type { ObservationType, RawObservation } from "../types.js";

const FILE_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filepath",
  "filePath",
  "dir_path",
  "directory",
  "cwd",
  "target",
  "target_path",
  "source",
  "source_path",
  "destination",
  "destination_path",
  "new_path",
  "old_path",
  "output_path",
  "input_path",
  "changed_file",
  "changed_files",
  "modified_file",
  "modified_files",
  "created_file",
  "created_files",
  "deleted_file",
  "deleted_files",
  "relevant_files",
]);

const FACT_KEYS = new Set([
  "status",
  "message",
  "summary",
  "reason",
  "error",
  "stderr",
  "stdout",
  "exit_code",
  "exitCode",
  "assistant_text",
  "last_assistant_message",
]);

const CONCEPT_KEYS = new Set([
  "query",
  "queries",
  "pattern",
  "patterns",
  "glob",
  "search",
  "search_terms",
  "terms",
  "concept",
  "concepts",
  "symbol",
  "symbols",
  "identifier",
  "identifiers",
  "command",
  "prompt",
  "assistant_text",
  "last_assistant_message",
  "tool_name",
  "title",
]);

const PHRASE_CONCEPT_KEYS = new Set([
  "query",
  "queries",
  "pattern",
  "patterns",
  "glob",
  "search",
  "search_terms",
  "terms",
]);

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "then",
  "when",
  "where",
  "what",
  "which",
  "while",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "will",
  "would",
  "should",
  "could",
  "can",
  "not",
  "now",
  "just",
  "still",
  "more",
  "less",
  "some",
  "over",
  "under",
  "into",
  "onto",
  "about",
  "after",
  "before",
  "through",
  "using",
  "use",
  "used",
  "user",
  "assistant",
  "result",
  "final",
  "current",
  "latest",
  "service",
  "looks",
]);

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))];
}

function clipText(text: string, maxLength = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function displayKey(keyHint?: string): string {
  return (keyHint || "detail").replace(/[_-]+/g, " ").trim();
}

function looksLikeFilePath(value: string): boolean {
  if (!value || value.length > 512) return false;
  const normalized = value.trim();
  if (!normalized || /^https?:\/\//i.test(normalized)) return false;
  if (normalized.includes("/") || normalized.includes("\\")) return true;
  return /(^|[.])[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(normalized);
}

function conceptTokens(text: string): string[] {
  return uniqueStrings(
    text
      .toLowerCase()
      .split(/[^a-z0-9_./:-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !STOPWORDS.has(token))
      .filter((token) => !looksLikeFilePath(token))
      .filter((token) => !/^[0-9]{1,3}$/.test(token)),
  ).slice(0, 24);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SignalBuckets = {
  files: Set<string>;
  concepts: Set<string>;
  facts: Set<string>;
};

function collectSignals(
  value: unknown,
  keyHint: string | undefined,
  depth: number,
  buckets: SignalBuckets,
): void {
  if (value === undefined || value === null || depth < 0) return;

  if (typeof value === "string") {
    const trimmed = clipText(value, 512);
    if (!trimmed) return;
    if (FILE_KEYS.has(keyHint || "") || looksLikeFilePath(trimmed)) {
      buckets.files.add(trimmed);
    }
    if (FACT_KEYS.has(keyHint || "")) {
      buckets.facts.add(`${displayKey(keyHint)}: ${clipText(trimmed)}`);
    }
    if (PHRASE_CONCEPT_KEYS.has(keyHint || "")) {
      buckets.concepts.add(clipText(trimmed, 80).toLowerCase());
    }
    if (CONCEPT_KEYS.has(keyHint || "") || !keyHint) {
      for (const token of conceptTokens(trimmed)) {
        buckets.concepts.add(token);
      }
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    if (FACT_KEYS.has(keyHint || "")) {
      buckets.facts.add(`${displayKey(keyHint)}: ${String(value)}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 24)) {
      collectSignals(entry, keyHint, depth - 1, buckets);
    }
    return;
  }

  if (!isPlainObject(value)) return;

  for (const [entryKey, entryValue] of Object.entries(value)) {
    collectSignals(entryValue, entryKey, depth - 1, buckets);
  }
}

function deriveBuckets(values: unknown[]): SignalBuckets {
  const buckets: SignalBuckets = {
    files: new Set<string>(),
    concepts: new Set<string>(),
    facts: new Set<string>(),
  };

  for (const value of values) {
    collectSignals(value, undefined, 3, buckets);
  }

  return buckets;
}

export function extractObservationFiles(...values: unknown[]): string[] {
  return [...deriveBuckets(values).files].slice(0, 16);
}

export function extractObservationConcepts(...values: unknown[]): string[] {
  return [...deriveBuckets(values).concepts].slice(0, 24);
}

export function extractObservationFacts(...values: unknown[]): string[] {
  return [...deriveBuckets(values).facts].slice(0, 12);
}

export function scoreSyntheticObservation(
  raw: RawObservation,
  type: ObservationType,
  signals: {
    files: string[];
    concepts: string[];
    facts: string[];
  },
): { importance: number; confidence: number } {
  let importance = 4;

  if (raw.hookType === "post_tool_failure") {
    importance = 9;
  } else if (raw.hookType === "assistant_result") {
    importance = 8;
  } else if (raw.hookType === "stop") {
    importance = raw.assistantResponse ? 7 : 5;
  } else {
    switch (type) {
      case "file_edit":
      case "file_write":
        importance = 6;
        break;
      case "command_run":
      case "search":
      case "web_fetch":
      case "subagent":
        importance = 5;
        break;
      case "file_read":
      case "conversation":
        importance = 4;
        break;
      default:
        importance = 4;
    }
  }

  if (signals.files.length > 0) importance += 1;
  if (signals.concepts.length > 0) importance += 1;
  if (signals.facts.length > 2) importance += 1;
  if (
    signals.facts.some((fact) =>
      /(error|failed|failure|exception|exit code|stderr)/i.test(fact),
    )
  ) {
    importance = Math.max(importance, 8);
  }

  let confidence = 0.3;
  if (signals.files.length > 0) confidence += 0.15;
  if (signals.concepts.length > 0) confidence += 0.15;
  if (signals.facts.length > 0) confidence += 0.15;
  if (raw.toolOutput !== undefined) confidence += 0.1;
  if (raw.assistantResponse || raw.userPrompt) confidence += 0.1;
  if (raw.hookType === "post_tool_failure") confidence += 0.1;

  return {
    importance: Math.max(1, Math.min(10, importance)),
    confidence: Math.max(0.3, Math.min(0.9, confidence)),
  };
}
