#!/usr/bin/env node
//#region src/hooks/notification.ts
function isSdkChildContext(payload) {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}
async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data;
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

  const sessionId = data.session_id || "unknown";
  const requestTitle = data.title === void 0 ? "permission request: " + String(data.tool_name || "") : data.title;
  try {
    await fetch(`${REST_URL}/agentmemory/observe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hookType: "notification",
        sessionId,
        project: data.cwd || process.cwd(),
        cwd: data.cwd || process.cwd(),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        data: {
          notification_type: data.notification_type || "permission_request",
          title: requestTitle,
          message: data.message,
          tool_name: data.tool_name,
          tool_input: data.tool_input,
          permission: data.permission,
        }
      }),
      signal: AbortSignal.timeout(2e3)
    });
  } catch {}
}
main();

//#endregion
export {  };
//# sourceMappingURL=notification.mjs.map
