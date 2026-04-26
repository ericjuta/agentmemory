// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

const OPERATOR_DIAGNOSTIC_ENDPOINTS = [
  "/agentmemory/health",
  "/agentmemory/livez",
  "/agentmemory/retrieval-proof",
  "/agentmemory/retrieval-blocks/diagnostics",
  "/agentmemory/retrieval-index/verify",
  "/agentmemory/retrieval-vector/backfill",
  "/agentmemory/retrieval-blocks/retry",
  "/agentmemory/compress-retry",
];

const OPERATOR_DIAGNOSTIC_PATTERNS = [
  /docker\s+compose\s+(?:ps|logs)\b/i,
  /git\s+status\s+--short\s+--branch\b/i,
  /git\s+log\s+--oneline\b/i,
];

function stringifyForDiagnosticScan(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isOperatorDiagnosticToolUse(data: Record<string, unknown>): boolean {
  const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  const toolInput = stringifyForDiagnosticScan(data.tool_input).slice(0, 20_000);
  const haystack = `${toolName}\n${toolInput}`.toLowerCase();
  if (!haystack.trim()) return false;
  if (OPERATOR_DIAGNOSTIC_ENDPOINTS.some((endpoint) => haystack.includes(endpoint))) {
    return true;
  }
  return OPERATOR_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(haystack));
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  const sessionId = (data.session_id as string) || "unknown";
  const operatorDiagnostic = isOperatorDiagnosticToolUse(data);

  try {
    await fetch(`${REST_URL}/agentmemory/observe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hookType: "post_tool_use",
        sessionId,
        project: data.cwd || process.cwd(),
        cwd: data.cwd || process.cwd(),
        timestamp: new Date().toISOString(),
        ...(operatorDiagnostic
          ? {
              persistenceClass: "diagnostics_only",
              capabilities: ["operator_diagnostic"],
            }
          : {}),
        data: {
          turn_id: data.turn_id ?? data.turnId,
          tool_name: data.tool_name,
          tool_input: data.tool_input,
          tool_output: truncate(data.tool_output, 8000),
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // fire and forget
  }
}

function truncate(value: unknown, max: number): unknown {
  if (typeof value === "string" && value.length > max) {
    return value.slice(0, max) + "\n[...truncated]";
  }
  if (typeof value === "object" && value !== null) {
    const str = JSON.stringify(value);
    if (str.length > max) return str.slice(0, max) + "...[truncated]";
    return value;
  }
  return value;
}

main();
