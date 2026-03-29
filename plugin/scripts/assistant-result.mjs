#!/usr/bin/env node
//#region src/hooks/assistant-result.ts
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
				hookType: "assistant_result",
				sessionId,
				project: data.cwd || process.cwd(),
				cwd: data.cwd || process.cwd(),
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				data: {
					turn_id: data.turn_id ?? data.turnId,
					assistant_text: typeof data.assistant_text === "string" ? data.assistant_text.slice(0, 4e3) : typeof data.assistant_message === "string" ? data.assistant_message.slice(0, 4e3) : typeof data.message === "string" ? data.message.slice(0, 4e3) : "",
					is_final: data.is_final ?? true
				}
			}),
			signal: AbortSignal.timeout(3e3)
		});
	} catch {}
}
main();

//#endregion
export {  };
//# sourceMappingURL=assistant-result.mjs.map