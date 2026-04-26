#!/usr/bin/env node
//#region src/hooks/post-tool-use.ts
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
const OPERATOR_DIAGNOSTIC_ENDPOINTS = [
	"/agentmemory/health",
	"/agentmemory/livez",
	"/agentmemory/retrieval-proof",
	"/agentmemory/retrieval-blocks/diagnostics",
	"/agentmemory/retrieval-index/verify",
	"/agentmemory/retrieval-vector/backfill",
	"/agentmemory/retrieval-blocks/retry",
	"/agentmemory/compress-retry"
];
const OPERATOR_DIAGNOSTIC_PATTERNS = [
	/docker\s+compose\s+(?:ps|logs)\b/i,
	/git\s+status\s+--short\s+--branch\b/i,
	/git\s+log\s+--oneline\b/i
];
function stringifyForDiagnosticScan(value) {
	if (value === void 0 || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
function isOperatorDiagnosticToolUse(data) {
	const haystack = `${typeof data.tool_name === "string" ? data.tool_name : ""}\n${stringifyForDiagnosticScan(data.tool_input).slice(0, 2e4)}`.toLowerCase();
	if (!haystack.trim()) return false;
	if (OPERATOR_DIAGNOSTIC_ENDPOINTS.some((endpoint) => haystack.includes(endpoint))) return true;
	return OPERATOR_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(haystack));
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
	const operatorDiagnostic = isOperatorDiagnosticToolUse(data);
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
				...operatorDiagnostic ? {
					persistenceClass: "diagnostics_only",
					capabilities: ["operator_diagnostic"]
				} : {},
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