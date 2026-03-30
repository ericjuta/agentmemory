// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
#!/usr/bin/env node

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
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

  const sessionId = (data.session_id as string) || "unknown";

  try {
    await fetch(`${REST_URL}/agentmemory/observe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hookType: "stop",
        sessionId,
        project: data.cwd || process.cwd(),
        cwd: data.cwd || process.cwd(),
        timestamp: new Date().toISOString(),
        data: {
          turn_id: data.turn_id ?? data.turnId,
          last_assistant_message:
            typeof data.last_assistant_message === "string"
              ? data.last_assistant_message.slice(0, 4000)
              : "",
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // observe is best-effort
  }

  try {
    await fetch(`${REST_URL}/agentmemory/summarize`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    // summarize is best-effort
  }
}

main();
