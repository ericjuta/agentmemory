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
  const project = (data.cwd as string) || process.cwd();
  const prompt = (data.prompt as string) || "";

  // Fire observation ingestion in the background (don't await)
  const observePromise = fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "prompt_submit",
      sessionId,
      project,
      cwd: project,
      timestamp: new Date().toISOString(),
      data: {
        turn_id: data.turn_id ?? data.turnId,
        prompt,
      },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  // Query-aware context refresh: re-rank memory blocks using the user's prompt
  if (prompt.trim().length > 10) {
    try {
      const res = await fetch(`${REST_URL}/agentmemory/context/refresh`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, project, query: prompt }),
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const result = (await res.json()) as {
          context?: string;
          skipped?: boolean;
        };
        if (result.context && !result.skipped) {
          process.stdout.write(result.context);
        }
      }
    } catch {
      // don't block prompt submission
    }
  }

  // Ensure observe finishes before exit
  await observePromise;
}

main();
