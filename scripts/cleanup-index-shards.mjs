#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_DATA_DIR = "/data/state_store.db";
const TARGETS = {
  all: ["mem:index:bm25", "mem:index:retrieval-blocks"],
  observation: ["mem:index:bm25"],
  retrieval: ["mem:index:retrieval-blocks"],
};

function usage() {
  return [
    "Usage: cleanup-index-shards.mjs [--apply] [--data-dir DIR] [--backup-dir DIR] [--target all|observation|retrieval] [--max-delete N]",
    "",
    "Dry-run is the default. --apply requires --backup-dir.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    apply: false,
    dataDir: DEFAULT_DATA_DIR,
    backupDir: undefined,
    target: "all",
    maxDelete: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--data-dir") {
      options.dataDir = argv[++i];
    } else if (arg === "--backup-dir") {
      options.backupDir = argv[++i];
    } else if (arg === "--target") {
      options.target = argv[++i];
    } else if (arg === "--max-delete") {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--max-delete must be a non-negative integer");
      }
      options.maxDelete = parsed;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!TARGETS[options.target]) {
    throw new Error("--target must be all, observation, or retrieval");
  }
  if (options.apply && !options.backupDir) {
    throw new Error("--apply requires --backup-dir");
  }
  return options;
}

function scopeFileName(scope) {
  return `${encodeURIComponent(scope)}.bin`;
}

function scopeFromFileName(fileName) {
  if (!fileName.endsWith(".bin")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -4));
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  return JSON.parse(jsonPrefix(content));
}

function jsonPrefix(content) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (!started) {
      if (/\s/.test(char)) continue;
      if (char !== "{" && char !== "[") {
        throw new Error("StateKV file does not start with JSON");
      }
      started = true;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return content.slice(0, i + 1);
    }
  }
  throw new Error("StateKV JSON prefix is incomplete");
}

function loadManifest(dataDir, parentScope) {
  const filePath = path.join(dataDir, scopeFileName(`${parentScope}:manifest`));
  if (!existsSync(filePath)) {
    throw new Error(`missing manifest scope file: ${filePath}`);
  }
  const record = readJsonFile(filePath);
  const manifest = record?.manifest;
  if (manifest?.schemaVersion !== 2 || manifest?.mode !== "sharded") {
    throw new Error(`manifest is not a v2 sharded manifest: ${filePath}`);
  }
  return manifest;
}

function collectReferencedShardScopes(manifest) {
  const scopes = new Set();
  for (const payload of [manifest.bm25, manifest.vector].filter(Boolean)) {
    for (const shard of payload.shards ?? []) {
      if (typeof shard.scope === "string" && typeof shard.key === "string") {
        scopes.add(shard.scope);
      }
    }
  }
  return scopes;
}

function collectRetainedStableSlotScopes(manifest) {
  const scopes = new Set();
  for (const payload of [manifest.bm25, manifest.vector].filter(Boolean)) {
    for (const shard of payload.shards ?? []) {
      const paired = stablePairScope(shard);
      if (paired) scopes.add(paired);
    }
  }
  return scopes;
}

function stablePairScope(shard) {
  if (
    typeof shard?.scope !== "string" ||
    (shard.generation !== "stable-a" && shard.generation !== "stable-b") ||
    (shard.kind !== "bm25" && shard.kind !== "vector") ||
    typeof shard.index !== "number"
  ) {
    return null;
  }
  const index = String(shard.index).padStart(5, "0");
  const suffix = `:shard:${shard.kind}:${shard.generation}:${index}`;
  if (!shard.scope.endsWith(suffix)) return null;
  const other = shard.generation === "stable-a" ? "stable-b" : "stable-a";
  return `${shard.scope.slice(0, -suffix.length)}:shard:${shard.kind}:${other}:${index}`;
}

function listPhysicalShardFiles(dataDir, parentScope) {
  const prefix = `${parentScope}:shard:`;
  return readdirSync(dataDir)
    .map((fileName) => {
      const scope = scopeFromFileName(fileName);
      if (!scope?.startsWith(prefix)) return null;
      const filePath = path.join(dataDir, fileName);
      const stat = statSync(filePath);
      return { fileName, filePath, scope, bytes: stat.size };
    })
    .filter(Boolean);
}

function summarizeBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function copyForBackup(file, backupDir) {
  const target = path.join(backupDir, file.fileName);
  cpSync(file.filePath, target, { preserveTimestamps: true });
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const parentScopes = TARGETS[options.target];
  if (!existsSync(options.dataDir)) {
    throw new Error(`data dir does not exist: ${options.dataDir}`);
  }
  if (options.apply) mkdirSync(options.backupDir, { recursive: true });

  const keptScopes = new Set();
  const referencedScopes = new Set();
  const retainedStableSlotScopes = new Set();
  const manifests = {};
  for (const parentScope of parentScopes) {
    const manifest = loadManifest(options.dataDir, parentScope);
    manifests[parentScope] = {
      savedAt: manifest.savedAt,
      bm25Shards: manifest.bm25?.shards?.length ?? 0,
      vectorShards: manifest.vector?.shards?.length ?? 0,
    };
    for (const scope of collectReferencedShardScopes(manifest)) {
      referencedScopes.add(scope);
      keptScopes.add(scope);
    }
    for (const scope of collectRetainedStableSlotScopes(manifest)) {
      retainedStableSlotScopes.add(scope);
      keptScopes.add(scope);
    }
  }

  const physicalFiles = parentScopes.flatMap((scope) =>
    listPhysicalShardFiles(options.dataDir, scope),
  );
  const orphanFiles = physicalFiles
    .filter((file) => !keptScopes.has(file.scope))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  const orphanBytes = orphanFiles.reduce((sum, file) => sum + file.bytes, 0);

  if (options.maxDelete !== undefined && orphanFiles.length > options.maxDelete) {
    throw new Error(
      `refusing to delete ${orphanFiles.length} files; max-delete is ${options.maxDelete}`,
    );
  }

  if (options.apply) {
    for (const file of orphanFiles) {
      copyForBackup(file, options.backupDir);
      rmSync(file.filePath);
    }
  }

  const result = {
    applied: options.apply,
    dataDir: options.dataDir,
    target: options.target,
    manifests,
    referencedShardScopes: referencedScopes.size,
    retainedStableSlotScopes: retainedStableSlotScopes.size,
    physicalShardFiles: physicalFiles.length,
    orphanShardFiles: orphanFiles.length,
    orphanBytes,
    orphanBytesHuman: summarizeBytes(orphanBytes),
    backupDir: options.apply ? options.backupDir : undefined,
    deletedFiles: options.apply ? orphanFiles.length : 0,
    sampleOrphans: orphanFiles.slice(0, 20).map((file) => ({
      scope: file.scope,
      bytes: file.bytes,
      fileName: file.fileName,
    })),
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
