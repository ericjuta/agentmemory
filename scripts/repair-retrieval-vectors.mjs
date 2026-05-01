#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3113";
const DEFAULT_TARGET = 0.98;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_SCAN_LIMIT = 2500;
const DEFAULT_TIME_BUDGET_MS = 6000;
const DEFAULT_COOLDOWN_MS = 15000;
const DEFAULT_MAX_RUNS = 40;
const DEFAULT_STALL_LIMIT = 3;
const DEFAULT_FLUSH_WAIT_MS = 90000;

function usage() {
  return `Usage:
  npm run repair:retrieval-vectors -- [options]

Options:
  --base-url <url>          AgentMemory REST base URL (default: ${DEFAULT_BASE_URL})
  --project <path>          Project scope for verification (default: cwd)
  --target <ratio>          Coverage target between 0 and 1 (default: ${DEFAULT_TARGET})
  --batch-size <n>          Backfill batch size per healthy pass (default: ${DEFAULT_BATCH_SIZE})
  --scan-limit <n>          Candidate scan limit per pass (default: ${DEFAULT_SCAN_LIMIT})
  --time-budget-ms <n>      Backfill time budget per pass (default: ${DEFAULT_TIME_BUDGET_MS})
  --cooldown-ms <n>         Wait after closed gates or each pass (default: ${DEFAULT_COOLDOWN_MS})
  --max-runs <n>            Max backfill passes before exiting (default: ${DEFAULT_MAX_RUNS})
  --max-checks <n>          Max health/verify checks before exiting (default: max-runs * 4)
  --stall-limit <n>         Stop after N no-progress passes (default: ${DEFAULT_STALL_LIMIT})
  --flush-wait-ms <n>       Max wait for scheduled persistence flush at end, 0 disables (default: ${DEFAULT_FLUSH_WAIT_MS})
  --reset-cursor            Reset vector backfill cursor on the first pass (default)
  --no-reset-cursor         Continue from existing vector backfill cursor
  --dry-run                 Inspect and gate, but do not write vectors
  --once                    Run at most one healthy backfill pass
  --json                    Emit JSON lines instead of readable logs
  --help                    Show this help

Environment:
  AGENTMEMORY_REPAIR_BASE_URL
  AGENTMEMORY_REPAIR_PROJECT
  AGENTMEMORY_REPAIR_TARGET
  AGENTMEMORY_REPAIR_BATCH_SIZE
  AGENTMEMORY_REPAIR_SCAN_LIMIT
  AGENTMEMORY_REPAIR_TIME_BUDGET_MS
  AGENTMEMORY_REPAIR_COOLDOWN_MS
  AGENTMEMORY_REPAIR_MAX_RUNS
  AGENTMEMORY_REPAIR_FLUSH_WAIT_MS`;
}

function readArgValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function ratio(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be > 0 and <= 1`);
  }
  return parsed;
}

function parseConfig(argv) {
  const config = {
    baseUrl: process.env.AGENTMEMORY_REPAIR_BASE_URL || DEFAULT_BASE_URL,
    project: process.env.AGENTMEMORY_REPAIR_PROJECT || process.cwd(),
    target: ratio(
      process.env.AGENTMEMORY_REPAIR_TARGET,
      DEFAULT_TARGET,
      "AGENTMEMORY_REPAIR_TARGET",
    ),
    batchSize: positiveInteger(
      process.env.AGENTMEMORY_REPAIR_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      "AGENTMEMORY_REPAIR_BATCH_SIZE",
    ),
    scanLimit: positiveInteger(
      process.env.AGENTMEMORY_REPAIR_SCAN_LIMIT,
      DEFAULT_SCAN_LIMIT,
      "AGENTMEMORY_REPAIR_SCAN_LIMIT",
    ),
    timeBudgetMs: positiveInteger(
      process.env.AGENTMEMORY_REPAIR_TIME_BUDGET_MS,
      DEFAULT_TIME_BUDGET_MS,
      "AGENTMEMORY_REPAIR_TIME_BUDGET_MS",
    ),
    cooldownMs: positiveInteger(
      process.env.AGENTMEMORY_REPAIR_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
      "AGENTMEMORY_REPAIR_COOLDOWN_MS",
    ),
    maxRuns: positiveInteger(
      process.env.AGENTMEMORY_REPAIR_MAX_RUNS,
      DEFAULT_MAX_RUNS,
      "AGENTMEMORY_REPAIR_MAX_RUNS",
    ),
    maxChecks: undefined,
    stallLimit: DEFAULT_STALL_LIMIT,
    flushWaitMs: nonNegativeInteger(
      process.env.AGENTMEMORY_REPAIR_FLUSH_WAIT_MS,
      DEFAULT_FLUSH_WAIT_MS,
      "AGENTMEMORY_REPAIR_FLUSH_WAIT_MS",
    ),
    resetCursor: true,
    dryRun: false,
    once: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--base-url") config.baseUrl = readArgValue(argv, i++, arg);
    else if (arg === "--project") config.project = readArgValue(argv, i++, arg);
    else if (arg === "--target") {
      config.target = ratio(readArgValue(argv, i++, arg), config.target, arg);
    } else if (arg === "--batch-size") {
      config.batchSize = positiveInteger(
        readArgValue(argv, i++, arg),
        config.batchSize,
        arg,
      );
    } else if (arg === "--scan-limit") {
      config.scanLimit = positiveInteger(
        readArgValue(argv, i++, arg),
        config.scanLimit,
        arg,
      );
    } else if (arg === "--time-budget-ms") {
      config.timeBudgetMs = positiveInteger(
        readArgValue(argv, i++, arg),
        config.timeBudgetMs,
        arg,
      );
    } else if (arg === "--cooldown-ms") {
      config.cooldownMs = positiveInteger(
        readArgValue(argv, i++, arg),
        config.cooldownMs,
        arg,
      );
    } else if (arg === "--max-runs") {
      config.maxRuns = positiveInteger(
        readArgValue(argv, i++, arg),
        config.maxRuns,
        arg,
      );
    } else if (arg === "--max-checks") {
      config.maxChecks = positiveInteger(
        readArgValue(argv, i++, arg),
        config.maxChecks,
        arg,
      );
    } else if (arg === "--stall-limit") {
      config.stallLimit = positiveInteger(
        readArgValue(argv, i++, arg),
        config.stallLimit,
        arg,
      );
    } else if (arg === "--flush-wait-ms") {
      config.flushWaitMs = nonNegativeInteger(
        readArgValue(argv, i++, arg),
        config.flushWaitMs,
        arg,
      );
    } else if (arg === "--reset-cursor") config.resetCursor = true;
    else if (arg === "--no-reset-cursor") config.resetCursor = false;
    else if (arg === "--dry-run") config.dryRun = true;
    else if (arg === "--once") config.once = true;
    else if (arg === "--json") config.json = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  config.baseUrl = config.baseUrl.replace(/\/$/, "");
  config.maxChecks =
    config.maxChecks ?? Math.max(config.maxRuns * 4, config.once ? 1 : 4);
  return config;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(config, path, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    const response = await fetch(config.baseUrl + path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return { http: response.status, ms: Date.now() - startedAt, body };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt };
  }
}

function summarizeHealth(result) {
  const body = result.body || {};
  return {
    http: result.http,
    ms: result.ms,
    error: result.error,
    status: body.status,
    runtimeStatus: body.runtimeStatus,
    servingStatus: body.servingStatus,
    maintenanceStatus: body.maintenanceStatus,
    paused: body.maintenance?.paused,
    totalQueued: body.maintenance?.totalQueued,
    alerts: body.health?.alerts ?? body.runtime?.alerts ?? body.alerts ?? [],
    gates: body.writeGates || {},
  };
}

function gateOpen(health) {
  return (
    health.http === 200 &&
    health.status === "healthy" &&
    health.runtimeStatus === "healthy" &&
    health.servingStatus === "healthy" &&
    health.paused !== true &&
    Object.values(health.gates || {}).every((value) => value === null || value === undefined)
  );
}

function closedGateReason(health) {
  if (health.error) return health.error;
  if (health.http !== 200) return `http_${health.http}`;
  const gateReason = Object.values(health.gates || {}).find(Boolean);
  if (gateReason) return String(gateReason);
  if (health.paused) return "maintenance_paused";
  if (health.runtimeStatus && health.runtimeStatus !== "healthy") {
    return `runtime_${health.runtimeStatus}`;
  }
  if (health.status && health.status !== "healthy") return `status_${health.status}`;
  return "gate_closed";
}

async function health(config) {
  return summarizeHealth(
    await requestJson(config, "/agentmemory/health", {
      method: "GET",
      timeoutMs: 9000,
    }),
  );
}

async function verify(config, scheduleSave = false) {
  const result = await requestJson(config, "/agentmemory/retrieval-index/verify", {
    method: "POST",
    timeoutMs: 20000,
    body: JSON.stringify({
      project: config.project,
      scheduleSave,
      vectorBackfill: false,
    }),
  });
  const body = result.body || {};
  return {
    http: result.http,
    ms: result.ms,
    error: result.error,
    vectorCoverageRatio: body.vectorCoverageRatio,
    vectorIndexedCount: body.vectorIndexedCount,
    vectorEligibleCount: body.vectorEligibleCount,
    vectorMissingCount: body.vectorMissingCount,
    persistence: body.persistence,
    writeGates: body.writeGates,
  };
}

async function backfill(config, resetCursor) {
  const result = await requestJson(config, "/agentmemory/retrieval-vector/backfill", {
    method: "POST",
    timeoutMs: Math.max(30000, config.timeBudgetMs + 10000),
    body: JSON.stringify({
      project: config.project,
      batchSize: config.batchSize,
      candidateScanLimit: config.scanLimit,
      timeBudgetMs: config.timeBudgetMs,
      concurrency: 1,
      coverageTarget: config.target,
      scheduleSave: !config.dryRun,
      resetCursor,
      dryRun: config.dryRun,
    }),
  });
  const body = result.body || {};
  return {
    http: result.http,
    ms: result.ms,
    error: result.error,
    success: body.success,
    source: body.source,
    attempted: body.attempted,
    backfilled: body.backfilled,
    failed: body.failed,
    pauseReason: body.pauseReason,
    vectorPresentBefore: body.vectorPresentBefore,
    vectorPresentAfter: body.vectorPresentAfter,
    vectorCoverageRatioAfter: body.vectorCoverageRatioAfter,
    complete: body.complete,
    elapsedMs: body.elapsedMs,
  };
}

function formatPercent(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "unknown";
}

function emit(config, event, data) {
  if (config.json) {
    console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
    return;
  }
  if (event === "verify") {
    console.log(
      `verify coverage=${formatPercent(data.vectorCoverageRatio)} indexed=${data.vectorIndexedCount ?? "?"}/${data.vectorEligibleCount ?? "?"} missing=${data.vectorMissingCount ?? "?"}`,
    );
  } else if (event === "wait") {
    console.log(`wait reason=${data.reason} cooldownMs=${data.cooldownMs}`);
  } else if (event === "backfill") {
    console.log(
      `backfill source=${data.source ?? "?"} attempted=${data.attempted ?? 0} backfilled=${data.backfilled ?? 0} failed=${data.failed ?? 0} coverage=${formatPercent(data.vectorCoverageRatioAfter)} ms=${data.ms}`,
    );
  } else if (event === "done") {
    console.log(`done reason=${data.reason} coverage=${formatPercent(data.coverage)} runs=${data.runs}`);
  } else if (event === "persistence") {
    console.log(
      `persistence pending=${data.pendingSave} inFlight=${data.inFlight} manifestVectors=${data.manifestVectorCount ?? "?"} savedAt=${data.savedAt ?? "?"}`,
    );
  }
}

async function waitForPersistence(config) {
  if (config.dryRun || config.flushWaitMs <= 0) return null;
  const deadline = Date.now() + config.flushWaitMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await verify(config, false);
    const persistence = latest.persistence;
    emit(config, "persistence", {
      pendingSave: persistence?.pendingSave,
      inFlight: persistence?.inFlight,
      manifestVectorCount: persistence?.manifest?.vectorCount,
      savedAt: persistence?.lastSuccessfulSaveAt,
    });
    if (!persistence?.pendingSave && !persistence?.inFlight) return latest;
    await wait(Math.min(config.cooldownMs, 10000));
  }
  return latest;
}

async function main() {
  const config = parseConfig(process.argv.slice(2));
  let resetCursor = config.resetCursor;
  let runs = 0;
  let checks = 0;
  let stalls = 0;
  let lastIndexed = -1;

  while (runs < config.maxRuns && checks < config.maxChecks) {
    checks++;
    const current = await verify(config, false);
    emit(config, "verify", current);
    if (current.error || current.http !== 200) {
      emit(config, "wait", {
        reason: current.error || `verify_http_${current.http}`,
        cooldownMs: config.cooldownMs,
      });
      await wait(config.cooldownMs);
      continue;
    }
    if ((current.vectorCoverageRatio ?? 0) >= config.target) {
      await waitForPersistence(config);
      emit(config, "done", {
        reason: "target_reached",
        coverage: current.vectorCoverageRatio,
        runs,
      });
      return;
    }

    const h = await health(config);
    if (!gateOpen(h)) {
      emit(config, "wait", {
        reason: closedGateReason(h),
        cooldownMs: config.cooldownMs,
      });
      if (config.once) break;
      await wait(config.cooldownMs);
      continue;
    }

    const result = await backfill(config, resetCursor);
    resetCursor = false;
    runs++;
    emit(config, "backfill", result);
    if (result.error || result.http !== 200 || result.pauseReason) {
      emit(config, "wait", {
        reason: result.error || result.pauseReason || `backfill_http_${result.http}`,
        cooldownMs: config.cooldownMs,
      });
      await wait(config.cooldownMs);
      continue;
    }

    const after = await verify(config, !config.dryRun);
    emit(config, "verify", after);
    if ((after.vectorIndexedCount ?? 0) <= lastIndexed) {
      stalls++;
    } else {
      stalls = 0;
    }
    lastIndexed = after.vectorIndexedCount ?? lastIndexed;

    if ((after.vectorCoverageRatio ?? 0) >= config.target) {
      await waitForPersistence(config);
      emit(config, "done", {
        reason: "target_reached",
        coverage: after.vectorCoverageRatio,
        runs,
      });
      return;
    }
    if (config.once) {
      await waitForPersistence(config);
      emit(config, "done", {
        reason: "once",
        coverage: after.vectorCoverageRatio,
        runs,
      });
      return;
    }
    if (stalls >= config.stallLimit) {
      await waitForPersistence(config);
      emit(config, "done", {
        reason: "stalled",
        coverage: after.vectorCoverageRatio,
        runs,
      });
      process.exitCode = 2;
      return;
    }
    await wait(config.cooldownMs);
  }

  const final = await waitForPersistence(config);
  emit(config, "done", {
    reason: runs >= config.maxRuns ? "max_runs" : "max_checks",
    coverage: final?.vectorCoverageRatio,
    runs,
  });
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
