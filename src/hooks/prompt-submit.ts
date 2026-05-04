#!/usr/bin/env node

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const PROMPT_CONTEXT_BUDGET = parsePositiveInt(
  process.env["AGENTMEMORY_PROMPT_CONTEXT_BUDGET"],
);

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isCodexHook(payload: Record<string, unknown>): boolean {
  return typeof payload.hook_event_name === "string";
}

function writeContext(payload: Record<string, unknown>, context: string): void {
  if (isCodexHook(payload)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    }));
    return;
  }
  process.stdout.write(context);
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

  if (isSdkChildContext(data)) return;

  const sessionId = (data.session_id as string) || "unknown";
  const project = (data.cwd as string) || process.cwd();

  try {
    await fetch(`${REST_URL}/agentmemory/observe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hookType: "prompt_submit",
        sessionId,
        project,
        cwd: project,
        timestamp: new Date().toISOString(),
        data: { prompt: data.prompt },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // fire and forget
  }

  if (!INJECT_CONTEXT || sessionId === "unknown") return;

  try {
    const payload: { sessionId: string; project: string; budget?: number } = {
      sessionId,
      project,
    };
    if (PROMPT_CONTEXT_BUDGET !== undefined) {
      payload.budget = PROMPT_CONTEXT_BUDGET;
    }
    const res = await fetch(`${REST_URL}/agentmemory/context`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const result = (await res.json()) as { context?: string };
    if (result.context) writeContext(data, result.context);
  } catch {
    // Context is helpful, but prompts must still submit if memory is slow.
  }
}

main();
