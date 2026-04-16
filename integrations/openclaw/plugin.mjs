/**
 * agentmemory plugin for OpenClaw gateway
 *
 * Hooks into the OpenClaw agent loop:
 * - onSessionStart: starts a session on the memory server and injects any returned context
 * - onPreLlmCall:   captures prompt submissions and injects query-aware context before each LLM call
 * - onPostToolUse:  records tool success/failure after execution
 * - onSessionEnd:   summarizes, closes the session, and runs maintenance flows
 *
 * Requires the agentmemory server running on localhost:3111.
 * Start it with: npx @agentmemory/agentmemory
 */

const DEFAULT_BASE_URL = "http://localhost:3111";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAINTENANCE_TIMEOUT_MS = 30000;

function extractPromptFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && typeof part.text === "string") {
            return part.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

export class AgentmemoryPlugin {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.baseUrl = config.base_url ?? DEFAULT_BASE_URL;
    this.tokenBudget = config.token_budget ?? 2000;
    this.minConfidence = config.min_confidence ?? 0.5;
    this.injectContext = config.inject_context !== false;
    this.queryAwareRefresh = config.query_aware_refresh !== false;
    this.runSessionEndMaintenance =
      config.run_session_end_maintenance !== false;
    this.fallbackOnError = config.fallback_on_error !== false;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.maintenanceTimeoutMs =
      config.maintenance_timeout_ms ?? DEFAULT_MAINTENANCE_TIMEOUT_MS;
    this.secret = process.env.AGENTMEMORY_SECRET;
    this.lastPromptBySession = new Map();
  }

  get name() {
    return "agentmemory";
  }

  async postJson(path, payload, timeoutMs = this.timeoutMs) {
    const headers = { "Content-Type": "application/json" };
    if (this.secret) headers["Authorization"] = `Bearer ${this.secret}`;

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (this.fallbackOnError) return null;
        const body = await res.text().catch(() => "");
        throw new Error(
          `agentmemory POST ${path} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        );
      }
      return await res.json();
    } catch (err) {
      if (!this.fallbackOnError) throw err;
      return null;
    }
  }

  getProject(ctx) {
    return ctx.project ?? ctx.cwd ?? process.cwd();
  }

  getCwd(ctx) {
    return ctx.cwd ?? ctx.project ?? process.cwd();
  }

  injectIfPresent(ctx, result) {
    if (
      this.injectContext &&
      result?.context &&
      typeof ctx.injectContext === "function"
    ) {
      ctx.injectContext(result.context);
    }
  }

  extractPrompt(ctx) {
    const direct =
      (typeof ctx.prompt === "string" && ctx.prompt) ||
      (typeof ctx.userPrompt === "string" && ctx.userPrompt) ||
      (typeof ctx.input === "string" && ctx.input) ||
      "";
    if (direct) return direct;
    return extractPromptFromMessages(ctx.messages);
  }

  async observe(ctx, hookType, data) {
    return this.postJson("/agentmemory/observe", {
      hookType,
      sessionId: ctx.sessionId,
      project: this.getProject(ctx),
      cwd: this.getCwd(ctx),
      timestamp: new Date().toISOString(),
      data,
    });
  }

  async onSessionStart(ctx) {
    if (!this.enabled) return;
    this.lastPromptBySession.delete(ctx.sessionId);
    const result = await this.postJson("/agentmemory/session/start", {
      sessionId: ctx.sessionId,
      project: this.getProject(ctx),
      cwd: this.getCwd(ctx),
    });
    this.injectIfPresent(ctx, result);
  }

  async onPreLlmCall(ctx) {
    if (!this.enabled) return;
    const project = this.getProject(ctx);
    const query = this.extractPrompt(ctx).trim();

    if (query) {
      const lastPrompt = this.lastPromptBySession.get(ctx.sessionId);
      if (lastPrompt !== query) {
        this.lastPromptBySession.set(ctx.sessionId, query);
        void this.observe(ctx, "prompt_submit", {
          turn_id: ctx.turnId ?? ctx.turn_id,
          prompt: query,
        }).catch(() => {});
      }
    }

    if (!this.injectContext) return;

    let result = null;
    if (this.queryAwareRefresh && query.length > 10) {
      result = await this.postJson("/agentmemory/context/refresh", {
        sessionId: ctx.sessionId,
        project,
        query,
      });
    }

    if (!result?.context) {
      result = await this.postJson("/agentmemory/context", {
        sessionId: ctx.sessionId,
        project,
        budget: this.tokenBudget,
      });
    }

    this.injectIfPresent(ctx, result);
  }

  async onPostToolUse(ctx) {
    if (!this.enabled) return;
    const error = ctx.error ?? ctx.toolError ?? ctx.toolOutput?.error;
    const hookType = error ? "post_tool_failure" : "post_tool_use";
    await this.observe(ctx, hookType, {
      turn_id: ctx.turnId ?? ctx.turn_id,
      tool_name: ctx.toolName,
      tool_input: ctx.toolInput,
      tool_output: ctx.toolOutput,
      error,
      decision: ctx.decision,
    });
  }

  async onSessionEnd(ctx) {
    if (!this.enabled) return;
    await this.postJson(
      "/agentmemory/summarize",
      { sessionId: ctx.sessionId },
      this.maintenanceTimeoutMs,
    );
    await this.postJson("/agentmemory/session/end", {
      sessionId: ctx.sessionId,
    });

    if (this.runSessionEndMaintenance) {
      await this.postJson(
        "/agentmemory/crystals/auto",
        { olderThanDays: 0 },
        this.maintenanceTimeoutMs,
      );
      await this.postJson(
        "/agentmemory/consolidate-pipeline",
        { tier: "all", force: true },
        this.maintenanceTimeoutMs,
      );
    }

    this.lastPromptBySession.delete(ctx.sessionId);
  }
}

export default AgentmemoryPlugin;
