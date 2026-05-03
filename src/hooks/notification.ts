#!/usr/bin/env node

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
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
  const isPermissionPrompt =
    data.notification_type === "permission_prompt" ||
    data.permission === true ||
    (typeof data.tool_name === "string" && Object.prototype.hasOwnProperty.call(data, "tool_name"));
  if (!isPermissionPrompt) return;

  const sessionId = (data.session_id as string) || "unknown";
  const requestTitle = data.title === undefined
    ? "permission request: " + String((data as { tool_name?: unknown }).tool_name || "")
    : String(data.title);

  try {
    await fetch(`${REST_URL}/agentmemory/observe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hookType: "notification",
        sessionId,
        project: data.cwd || process.cwd(),
        cwd: data.cwd || process.cwd(),
        timestamp: new Date().toISOString(),
        data: {
          notification_type: data.notification_type || "permission_request",
          title: requestTitle,
          message: data.message,
          tool_name: data.tool_name,
          tool_input: data.tool_input,
          permission: data.permission,
        },
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // fire and forget
  }
}

main();
