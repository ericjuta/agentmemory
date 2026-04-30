// Fork note: modified in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { renderViewerDocument } from "./document.js";
import { getDeferredWorkStatus } from "../functions/deferred-work.js";
import {
  getDerivedKvWritePauseReason,
  getGraphExtractionPauseReason,
  getIndexPersistencePauseReason,
  getLlmWorkPauseReason,
} from "../health/write-gate.js";
import { getLatestHealth } from "../health/monitor.js";
import type { StateKV } from "../state/kv.js";
import type { HealthSnapshot } from "../types.js";
import { VERSION } from "../version.js";

const ALLOWED_ORIGINS = (
  process.env.VIEWER_ALLOWED_ORIGINS ||
  "http://localhost:3111,http://localhost:3113,http://127.0.0.1:3111,http://127.0.0.1:3113"
)
  .split(",")
  .map((o) => o.trim());
const VIEWER_PROXY_TIMEOUT_MS = Number.parseInt(
  process.env.VIEWER_PROXY_TIMEOUT_MS || "60000",
  10,
);

type ServingStatus = "healthy" | "degraded" | "critical";

type BoundedResult<T> = {
  status: "ok" | "timeout" | "error";
  value: T;
};

function getViewerListenHost(): string {
  return process.env["VIEWER_HOST"] || "127.0.0.1";
}

function servingStatusFromHealth(
  health: HealthSnapshot | null | undefined,
): ServingStatus {
  if (!health) return "healthy";
  if (
    health.connectionState === "disconnected" ||
    health.connectionState === "failed"
  ) {
    return "critical";
  }
  if (health.connectionState === "reconnecting") return "degraded";
  if (health.kvConnectivity?.status === "error") {
    return (health.kvConnectivity.consecutiveFailures ?? 1) >= 3
      ? "critical"
      : "degraded";
  }
  if (health.snapshotPersistence?.status === "error") {
    return (health.snapshotPersistence.consecutiveFailures ?? 1) >= 3
      ? "critical"
      : "degraded";
  }
  const alerts = health.alerts ?? [];
  if (
    alerts.some(
      (alert) =>
        alert.startsWith("event_loop_lag_critical_") ||
        alert.startsWith("memory_critical_"),
    )
  ) {
    return "critical";
  }
  if (
    alerts.some(
      (alert) =>
        alert.startsWith("event_loop_lag_warn_") ||
        alert.startsWith("memory_warn_"),
    )
  ) {
    return "degraded";
  }
  return "healthy";
}

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<BoundedResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timeout", value: fallback() });
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "ok", value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "error", value: fallback() });
      },
    );
  });
}

async function buildViewerHealth(kv: StateKV): Promise<{ status: number; body: unknown }> {
  const health = (
    await settleWithin(getLatestHealth(kv), 1000, () => null)
  ).value;
  const [deferredResult, writeGateResult] = await Promise.all([
    settleWithin(
      getDeferredWorkStatus(kv, { lightweight: true }),
      1500,
      () => ({
        error: "viewer_health_deferred_work_timeout",
      }),
    ),
    settleWithin(
      Promise.all([
        getLlmWorkPauseReason(kv),
        getDerivedKvWritePauseReason(kv),
        getGraphExtractionPauseReason(kv),
        getIndexPersistencePauseReason(kv),
      ]).then(([llmWork, derivedKvWrites, graphExtraction, indexPersistence]) => ({
        llmWork,
        derivedKvWrites,
        graphExtraction,
        indexPersistence,
      })),
      1500,
      () => ({
        error: "viewer_health_write_gate_timeout",
      }),
    ),
  ]);

  const deferredWork = deferredResult.value;
  const writeGates = writeGateResult.value;
  const deferredTotalQueued =
    deferredWork &&
    typeof deferredWork === "object" &&
    "totalQueued" in deferredWork &&
    typeof deferredWork.totalQueued === "number"
      ? deferredWork.totalQueued
      : null;
  const writeGateValues =
    writeGates && typeof writeGates === "object" && !("error" in writeGates)
      ? Object.values(writeGates)
      : [];
  const maintenancePaused = writeGateValues.some(Boolean);
  const maintenanceStatus = maintenancePaused
    ? "paused"
    : deferredTotalQueued && deferredTotalQueued > 0
      ? "behind"
      : deferredTotalQueued === 0
        ? "caught_up"
        : "unknown";
  const servingStatus = servingStatusFromHealth(health);
  const runtimeStatus = health?.status || "healthy";

  return {
    status: servingStatus === "critical" ? 503 : 200,
    body: {
      status: servingStatus,
      runtimeStatus,
      servingStatus,
      maintenanceStatus,
      service: "agentmemory",
      version: VERSION,
      health: health || null,
      functionMetrics: [],
      circuitBreaker: null,
      deferredWork,
      writeGates,
      maintenance: {
        status: maintenanceStatus,
        totalQueued: deferredTotalQueued,
        paused: maintenancePaused,
      },
      source: "viewer-direct",
    },
  };
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function json(
  res: ServerResponse,
  status: number,
  data: unknown,
  req?: IncomingMessage,
): void {
  const body = JSON.stringify(data);
  const cors = req
    ? corsHeaders(req)
    : { "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0], Vary: "Origin" };
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(new Error("too large"));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function getViewerUpstreamBase(restPort: number): string {
  return (
    process.env.VIEWER_UPSTREAM_URL ||
    process.env.AGENTMEMORY_URL ||
    `http://127.0.0.1:${restPort}`
  ).replace(/\/$/, "");
}
export function startViewerServer(
  port: number,
  _kv: unknown,
  _sdk: unknown,
  secret?: string,
  restPort?: number,
): Server {
  const resolvedRestPort = restPort ?? port - 2;
  const listenHost = getViewerListenHost();

  const server = createServer(async (req, res) => {
    const raw = req.url || "/";
    const qIdx = raw.indexOf("?");
    const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const qs = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders(req),
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/livez") {
      json(res, 200, { status: "ok", service: "agentmemory" }, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/health" && _kv) {
      const health = await buildViewerHealth(_kv as StateKV);
      json(res, health.status, health.body, req);
      return;
    }

    if (
      method === "GET" &&
      (pathname === "/" ||
        pathname === "/viewer" ||
        pathname === "/agentmemory/viewer")
    ) {
      const rendered = renderViewerDocument();
      if (rendered.found) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": rendered.csp,
          "Cache-Control": "no-cache",
        });
        res.end(rendered.html);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("viewer not found");
      return;
    }

    try {
      await proxyToRestApi(
        getViewerUpstreamBase(resolvedRestPort),
        pathname,
        qs,
        method,
        req,
        res,
        secret,
      );
    } catch (err) {
      console.error(`[viewer] proxy error on ${method} ${pathname}:`, err);
      json(res, 502, { error: "upstream error" }, req);
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[agentmemory] Viewer port ${port} already in use, skipping viewer.`);
    } else {
      console.error(`[agentmemory] Viewer error:`, err.message);
    }
  });

  server.listen(port, listenHost, () => {
    console.log(`[agentmemory] Viewer: http://localhost:${port}`);
  });

  return server;
}

async function proxyToRestApi(
  upstreamBase: string,
  pathname: string,
  qs: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  secret?: string,
): Promise<void> {
  const upstreamPath = pathname.startsWith("/agentmemory/")
    ? pathname
    : `/agentmemory${pathname.startsWith("/") ? pathname : "/" + pathname}`;

  const upstreamUrl = `${upstreamBase}${upstreamPath}${qs ? "?" + qs : ""}`;

  const headers: Record<string, string> = {};
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }
  const ct = req.headers["content-type"];
  if (ct) {
    headers["Content-Type"] = ct;
  }

  let body: string | undefined;
  if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
    body = await readBody(req);
  }

  const controller = new AbortController();
  const fetchTimeout = setTimeout(
    () => controller.abort(),
    Number.isFinite(VIEWER_PROXY_TIMEOUT_MS) && VIEWER_PROXY_TIMEOUT_MS > 0
      ? VIEWER_PROXY_TIMEOUT_MS
      : 60000,
  );
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    });
    clearTimeout(fetchTimeout);
  } catch (err) {
    clearTimeout(fetchTimeout);
    if (err instanceof Error && err.name === "AbortError") {
      json(res, 504, { error: "upstream timeout" }, req);
      return;
    }
    throw err;
  }

  const cors = corsHeaders(req);
  const responseBody = await upstream.text();
  const responseHeaders: Record<string, string> = {
    ...cors,
  };
  const upstreamCt = upstream.headers.get("content-type");
  if (upstreamCt) {
    responseHeaders["Content-Type"] = upstreamCt;
  }

  res.writeHead(upstream.status, responseHeaders);
  res.end(responseBody);
}
