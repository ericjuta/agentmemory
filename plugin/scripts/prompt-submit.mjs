#!/usr/bin/env node
//#region src/hooks/prompt-submit.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const PROMPT_CONTEXT_BUDGET = parsePositiveInt(process.env["AGENTMEMORY_PROMPT_CONTEXT_BUDGET"]);
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
function parsePositiveInt(value) {
	if (!value) return void 0;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : void 0;
}
function isCodexHook(payload) {
	return typeof payload.hook_event_name === "string";
}
function writeContext(payload, context) {
	if (isCodexHook(payload)) {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: context
		} }));
		return;
	}
	process.stdout.write(context);
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
	const sessionId = data.session_id || "unknown";
	const project = data.cwd || process.cwd();
	try {
		await fetch(`${REST_URL}/agentmemory/observe`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				hookType: "prompt_submit",
				sessionId,
				project,
				cwd: project,
				timestamp: (/* @__PURE__ */ new Date()).toISOString(),
				data: { prompt: data.prompt }
			}),
			signal: AbortSignal.timeout(3e3)
		});
	} catch {}
	if (!INJECT_CONTEXT || sessionId === "unknown") return;
	try {
		const payload = {
			sessionId,
			project
		};
		if (PROMPT_CONTEXT_BUDGET !== void 0) payload.budget = PROMPT_CONTEXT_BUDGET;
		const res = await fetch(`${REST_URL}/agentmemory/context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(3e3)
		});
		if (!res.ok) return;
		const result = await res.json();
		if (result.context) writeContext(data, result.context);
	} catch {}
}
main();

//#endregion
export {  };
//# sourceMappingURL=prompt-submit.mjs.map