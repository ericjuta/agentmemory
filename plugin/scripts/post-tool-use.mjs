#!/usr/bin/env node
// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
//#region src/hooks/post-tool-use.ts
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
				hookType: "post_tool_use",
				sessionId,
				project: data.cwd || process.cwd(),
				cwd: data.cwd || process.cwd(),
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				data: {
					turn_id: data.turn_id ?? data.turnId,
					tool_name: data.tool_name,
					tool_input: data.tool_input,
					tool_output: truncate(data.tool_output, 8e3)
				}
			}),
			signal: AbortSignal.timeout(3e3)
		});
	} catch {}
}
function truncate(value, max) {
	if (typeof value === "string" && value.length > max) return value.slice(0, max) + "\n[...truncated]";
	if (typeof value === "object" && value !== null) {
		const str = JSON.stringify(value);
		if (str.length > max) return str.slice(0, max) + "...[truncated]";
		return value;
	}
	return value;
}
main();

//#endregion
export {  };
//# sourceMappingURL=post-tool-use.mjs.map