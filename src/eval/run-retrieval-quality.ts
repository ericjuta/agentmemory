import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compactRetrievalQualitySummary,
  evaluateRetrievalQuality,
  type RetrievalQualityEvalCase,
} from "./retrieval-quality.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function publishSummary(summary: unknown): Promise<{
  published: boolean;
  error?: string;
}> {
  if (!envFlag("AGENTMEMORY_EVAL_PUBLISH", true)) {
    return { published: false };
  }
  const baseUrl =
    process.env.AGENTMEMORY_EVAL_BASE_URL ||
    `http://localhost:${process.env.III_REST_PORT || "3111"}`;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (process.env.AGENTMEMORY_SECRET) {
      headers.authorization = `Bearer ${process.env.AGENTMEMORY_SECRET}`;
    }
    const response = await fetch(
      `${baseUrl}/agentmemory/retrieval-quality/summary`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(summary),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      return {
        published: false,
        error: `summary publish failed with HTTP ${response.status}`,
      };
    }
    return { published: true };
  } catch (error) {
    return {
      published: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const fixturePath =
  process.env.RETRIEVAL_QUALITY_FIXTURE ||
  join(__dirname, "..", "..", "test", "fixtures", "retrieval-quality-cases.json");
const artifactPath =
  process.env.RETRIEVAL_QUALITY_ARTIFACT ||
  "/tmp/agentmemory-retrieval-quality-latest.json";
const fixtureCases = JSON.parse(
  readFileSync(fixturePath, "utf8"),
) as RetrievalQualityEvalCase[];
const result = evaluateRetrievalQuality(fixtureCases);
const summary = compactRetrievalQualitySummary(result);
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(
  artifactPath,
  JSON.stringify({ summary, result }, null, 2),
  "utf8",
);
const publishResult = await publishSummary(summary);
const requirePublish = envFlag("AGENTMEMORY_EVAL_REQUIRE_PUBLISH", false);
if (requirePublish && !publishResult.published) {
  console.error(
    JSON.stringify({ summary, artifactPath, publishResult }, null, 2),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({ summary, artifactPath, publishResult }, null, 2),
  );
  process.exitCode = result.passed ? 0 : 1;
}
