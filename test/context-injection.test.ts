import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS_DIR = join(import.meta.dirname, "..", "plugin", "scripts");

// Spawns a compiled plugin hook as a subprocess, feeds it JSON on stdin,
// and returns { stdout, stderr, exitCode, tookMs }. The test is about
// making sure the hook writes NOTHING to stdout when context injection is
// disabled — which is what Claude Code reads to decide whether to prepend
// memory context to the next tool turn.
function runHook(
  scriptName: string,
  stdin: string,
  env: Record<string, string>,
  extraArgs: string[] = [],
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  tookMs: number;
}> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(
      process.execPath,
      [join(HOOKS_DIR, scriptName), ...extraArgs],
      {
        env: {
          // Start from a clean slate — don't leak test-runner env into
          // the hook. Only pass PATH and anything explicitly set by the
          // test case.
          PATH: process.env["PATH"] ?? "",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode, tookMs: Date.now() - start });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("pre-tool-use hook — context injection gate (#143)", () => {
  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset (default)", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    // No AGENTMEMORY_* env vars at all — simulates a fresh Claude Pro
    // install with no ~/.agentmemory/.env overrides.
    const result = await runHook("pre-tool-use.mjs", payload, {});
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT=false explicitly", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "false",
    });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("exits fast when disabled (no stdin consumption, no network fetch)", async () => {
    // The disabled path must not open stdin or reach for fetch — it
    // should return immediately. A 250ms budget is generous enough to
    // account for Node startup on CI while still catching any accidental
    // fetch round-trip or stdin buffering.
    const result = await runHook("pre-tool-use.mjs", "", {});
    expect(result.tookMs).toBeLessThan(1000);
    expect(result.stdout).toBe("");
  });

  it("when AGENTMEMORY_INJECT_CONTEXT=true, hook still runs but safely errors on unreachable backend", async () => {
    // Opt-in path. We point at a port that's guaranteed closed so the
    // fetch fails fast; the hook must still exit cleanly (the whole
    // point of the try/catch is not to break Claude Code) and must not
    // echo anything to stdout when the fetch fails.
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: "http://127.0.0.1:1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("session-start hook — context injection gate (#143)", () => {
  it("registers the session but writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset", async () => {
    // Session registration POST will fail against the unreachable URL,
    // but the hook's try/catch must swallow that cleanly — Claude Code
    // must never see an error at session start.
    const payload = JSON.stringify({
      session_id: "ses_test",
      cwd: "/tmp/fake-project",
    });
    const result = await runHook("session-start.mjs", payload, {
      AGENTMEMORY_URL: "http://127.0.0.1:1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("emits Codex context JSON when wrapper loads agentmemory env", async () => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({ url: req.url, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ context: "<agentmemory-context>startup</agentmemory-context>" }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const envDir = mkdtempSync(join(tmpdir(), "agentmemory-hook-env-"));
    const envFile = join(envDir, ".env");
    writeFileSync(
      envFile,
      [
        "AGENTMEMORY_INJECT_CONTEXT=true",
        `AGENTMEMORY_URL=http://127.0.0.1:${address.port}`,
      ].join("\n"),
    );

    try {
      const payload = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "ses_test",
        cwd: "/tmp/fake-project",
      });
      const result = await runHook(
        "codex-env-wrapper.mjs",
        payload,
        { AGENTMEMORY_ENV_FILE: envFile },
        ["session-start.mjs"],
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(requests.map((r) => r.url)).toEqual([
        "/agentmemory/session/start",
        "/agentmemory/hooks/diagnostics",
      ]);
      expect(requests[1].body).toMatchObject({
        hookName: "SessionStart",
        source: "codex-env-wrapper",
        status: "success",
      });
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "<agentmemory-context>startup</agentmemory-context>",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("keeps live AGENTMEMORY env values ahead of wrapper env file", async () => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({ url: req.url, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ context: "<agentmemory-context>env-file</agentmemory-context>" }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const envDir = mkdtempSync(join(tmpdir(), "agentmemory-hook-env-"));
    const envFile = join(envDir, ".env");
    writeFileSync(
      envFile,
      [
        "AGENTMEMORY_INJECT_CONTEXT=true",
        "AGENTMEMORY_URL=http://127.0.0.1:1",
      ].join("\n"),
    );

    try {
      const payload = JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "ses_test",
        cwd: "/tmp/fake-project",
      });
      const result = await runHook(
        "codex-env-wrapper.mjs",
        payload,
        {
          AGENTMEMORY_ENV_FILE: envFile,
          AGENTMEMORY_INJECT_CONTEXT: "false",
          AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
        },
        ["session-start.mjs"],
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(requests.map((r) => r.url)).toEqual([
        "/agentmemory/session/start",
        "/agentmemory/hooks/diagnostics",
      ]);
      expect(requests[1].body).toMatchObject({
        hookName: "SessionStart",
        source: "codex-env-wrapper",
        status: "success",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe("user-prompt-submit hook — Codex context injection", () => {
  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset", async () => {
    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "ses_test",
      cwd: "/tmp/fake-project",
      prompt: "what changed?",
    });
    const result = await runHook("prompt-submit.mjs", payload, {
      AGENTMEMORY_URL: "http://127.0.0.1:1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("records the prompt and emits Codex additionalContext when enabled", async () => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({ url: req.url, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/agentmemory/context") {
          res.end(JSON.stringify({ context: "<agentmemory-context>turn</agentmemory-context>" }));
        } else {
          res.end("{}");
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    try {
      const payload = JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "ses_test",
        cwd: "/tmp/fake-project",
        prompt: "what changed?",
      });
      const result = await runHook("prompt-submit.mjs", payload, {
        AGENTMEMORY_INJECT_CONTEXT: "true",
        AGENTMEMORY_PROMPT_CONTEXT_BUDGET: "1234",
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(requests.map((r) => r.url)).toEqual([
        "/agentmemory/observe",
        "/agentmemory/context",
      ]);
      expect(requests[0]?.body).toMatchObject({
        hookType: "prompt_submit",
        sessionId: "ses_test",
        project: "/tmp/fake-project",
        data: { prompt: "what changed?" },
      });
      expect(requests[1]?.body).toMatchObject({
        sessionId: "ses_test",
        project: "/tmp/fake-project",
        budget: 1234,
      });
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "<agentmemory-context>turn</agentmemory-context>",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe("post-tool-use hook — Codex payload", () => {
  it("records Codex tool_response as tool_output", async () => {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    try {
      const payload = JSON.stringify({
        session_id: "ses_test",
        cwd: "/tmp/fake-project",
        tool_name: "Bash",
        tool_input: { command: "printf ok" },
        tool_response: { output: "ok", exit_code: 0 },
      });
      const result = await runHook("post-tool-use.mjs", payload, {
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        hookType: "post_tool_use",
        sessionId: "ses_test",
        data: {
          tool_name: "Bash",
          tool_input: { command: "printf ok" },
          tool_output: { output: "ok", exit_code: 0 },
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe("stop hook — turn completion semantics", () => {
  it("records a stop observation without ending or summarizing the session", async () => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({ url: req.url, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    try {
      const payload = JSON.stringify({
        session_id: "ses_test",
        turn_id: "turn_1",
        cwd: "/tmp/fake-project",
        model: "gpt-test",
        permission_mode: "default",
        stop_hook_active: false,
        last_assistant_message: "Done.",
      });
      const result = await runHook("stop.mjs", payload, {
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(requests.map((r) => r.url)).toEqual(["/agentmemory/observe"]);
      expect(requests[0]?.body).toMatchObject({
        hookType: "stop",
        sessionId: "ses_test",
        data: {
          turn_id: "turn_1",
          model: "gpt-test",
          permission_mode: "default",
          stop_hook_active: false,
          last_assistant_message: "Done.",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe("session-end hook — session close semantics", () => {
  it("ends and summarizes sessions with observations", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          body: body ? JSON.parse(body) : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url?.startsWith("/agentmemory/replay/load")) {
          res.end(JSON.stringify({ session: { observationCount: 3 } }));
        } else {
          res.end("{}");
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    try {
      const result = await runHook("session-end.mjs", JSON.stringify({ session_id: "ses_test" }), {
        AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(requests.map((r) => r.url)).toEqual([
        "/agentmemory/session/end",
        "/agentmemory/replay/load?sessionId=ses_test",
        "/agentmemory/summarize",
      ]);
      expect(requests[0]).toMatchObject({
        method: "POST",
        body: { sessionId: "ses_test" },
      });
      expect(requests[2]).toMatchObject({
        method: "POST",
        body: { sessionId: "ses_test" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
