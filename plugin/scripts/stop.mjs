#!/usr/bin/env node
// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
//#region src/hooks/stop.ts
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
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
	const sessionId = data.session_id || "unknown";
	try {
		await fetch(`${REST_URL}/agentmemory/observe`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				hookType: "stop",
				sessionId,
				project: data.cwd || process.cwd(),
				cwd: data.cwd || process.cwd(),
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				data: {
					turn_id: data.turn_id ?? data.turnId,
					last_assistant_message: typeof data.last_assistant_message === "string" ? data.last_assistant_message.slice(0, 4e3) : ""
				}
			}),
			signal: AbortSignal.timeout(3e3)
		});
	} catch {}
	try {
		await fetch(`${REST_URL}/agentmemory/summarize`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ sessionId }),
			signal: AbortSignal.timeout(3e4)
		});
	} catch {}
}
main();

//#endregion
export {  };
//# sourceMappingURL=stop.mjs.map