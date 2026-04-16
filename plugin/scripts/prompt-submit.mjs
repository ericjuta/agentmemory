#!/usr/bin/env node
//#region src/hooks/prompt-submit.ts
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
	const project = data.cwd || process.cwd();
	const prompt = data.prompt || "";
	const observePromise = fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "prompt_submit",
			sessionId,
			project,
			cwd: project,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				turn_id: data.turn_id ?? data.turnId,
				prompt
			}
		}),
		signal: AbortSignal.timeout(3e3)
	}).catch(() => {});
	if (prompt.trim().length > 10) try {
		const res = await fetch(`${REST_URL}/agentmemory/context/refresh`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				project,
				query: prompt
			}),
			signal: AbortSignal.timeout(4e3)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context && !result.skipped) process.stdout.write(result.context);
		}
	} catch {}
	await observePromise;
}
main();

//#endregion
export {  };
//# sourceMappingURL=prompt-submit.mjs.map