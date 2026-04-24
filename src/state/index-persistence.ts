import { createHash } from "node:crypto";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 5000;
const RETRY_BACKOFF_MS = 15000;
const MAX_RETRY_BACKOFF_MS = 60000;
const DEFAULT_SHARD_BYTES = 256 * 1024;
const SHARDED_MANIFEST_KEY = "manifest";
const LEGACY_BM25_KEY = "data";
const LEGACY_VECTOR_KEY = "vectors";

export type IndexPersistenceMode = "legacy" | "sharded";

export interface IndexPersistenceOptions {
  mode?: IndexPersistenceMode;
  shardSizeBytes?: number;
  now?: () => string;
  shouldDeferSave?: (() => boolean | Promise<boolean>) | undefined;
}

export interface IndexPersistenceStatus {
  scope: string;
  mode: IndexPersistenceMode;
  status: "idle" | "ok" | "error" | "incomplete";
  lastSuccessfulSaveAt?: string;
  lastFailureAt?: string;
  error?: string;
  manifest?: {
    savedAt: string;
    bm25Shards: number;
    vectorShards: number;
    bm25Bytes: number;
    vectorBytes: number;
    documentCount: number;
    vectorCount: number;
    incomplete?: boolean;
  };
}

type PayloadKind = "bm25" | "vector";

interface ShardDescriptor {
  key: string;
  byteLength: number;
  sha256: string;
}

interface PayloadManifest {
  kind: PayloadKind;
  byteLength: number;
  count: number;
  sha256: string;
  shards: ShardDescriptor[];
}

interface ShardedIndexManifest {
  schemaVersion: 1;
  mode: "sharded";
  savedAt: string;
  bm25: PayloadManifest;
  vector: PayloadManifest | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function chunkStringByBytes(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of value) {
    const charBytes = byteLength(char);
    if (current && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function isShardDescriptor(value: unknown): value is ShardDescriptor {
  const row = value as ShardDescriptor;
  return (
    !!row &&
    typeof row.key === "string" &&
    typeof row.byteLength === "number" &&
    typeof row.sha256 === "string"
  );
}

function isPayloadManifest(value: unknown, kind: PayloadKind): value is PayloadManifest {
  const row = value as PayloadManifest;
  return (
    !!row &&
    row.kind === kind &&
    typeof row.byteLength === "number" &&
    typeof row.count === "number" &&
    typeof row.sha256 === "string" &&
    Array.isArray(row.shards) &&
    row.shards.every(isShardDescriptor)
  );
}

function isShardedIndexManifest(value: unknown): value is ShardedIndexManifest {
  const row = value as ShardedIndexManifest;
  return (
    !!row &&
    row.schemaVersion === 1 &&
    row.mode === "sharded" &&
    typeof row.savedAt === "string" &&
    isPayloadManifest(row.bm25, "bm25") &&
    (row.vector === null || isPayloadManifest(row.vector, "vector"))
  );
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private nextDelayMs = DEBOUNCE_MS;
  private readonly mode: IndexPersistenceMode;
  private readonly shardSizeBytes: number;
  private readonly now: () => string;
  private readonly shouldDeferSave: () => boolean | Promise<boolean>;
  private completeManifest: ShardedIndexManifest | null = null;
  private status: IndexPersistenceStatus;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private scope = KV.bm25Index,
    options: IndexPersistenceOptions = {},
  ) {
    this.mode = options.mode ?? "legacy";
    this.shardSizeBytes = positiveInteger(
      options.shardSizeBytes,
      DEFAULT_SHARD_BYTES,
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.shouldDeferSave = options.shouldDeferSave ?? (() => false);
    this.status = {
      scope: this.scope,
      mode: this.mode,
      status: "idle",
    };
  }

  scheduleSave(): void {
    this.dirty = true;
    if (this.inFlight) return;
    this.armTimer(this.nextDelayMs);
  }

  async save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    await this.saveNow();
    this.nextDelayMs = DEBOUNCE_MS;
  }

  private armTimer(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushDeferredSave();
    }, delayMs);
  }

  private async flushDeferredSave(): Promise<void> {
    if (this.inFlight || !this.dirty) return;
    this.dirty = false;
    this.inFlight = this.saveDeferred();
    try {
      const result = await this.inFlight;
      if (result === "saved") {
        this.nextDelayMs = DEBOUNCE_MS;
      }
    } catch (error) {
      this.dirty = true;
      this.nextDelayMs = Math.min(
        MAX_RETRY_BACKOFF_MS,
        Math.max(RETRY_BACKOFF_MS, this.nextDelayMs * 2),
      );
      logger.warn("Failed to persist index", {
        scope: this.scope,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = null;
      if (this.dirty) this.armTimer(this.nextDelayMs);
    }
  }

  private async saveDeferred(): Promise<"saved" | "deferred"> {
    if (await this.shouldDeferSave()) {
      this.dirty = true;
      this.nextDelayMs = Math.min(
        MAX_RETRY_BACKOFF_MS,
        Math.max(RETRY_BACKOFF_MS, this.nextDelayMs * 2),
      );
      logger.warn("Index persistence deferred while health is unhealthy", {
        scope: this.scope,
      });
      return "deferred";
    }
    await this.saveNow();
    return "saved";
  }

  private async saveNow(): Promise<void> {
    try {
      if (this.mode === "sharded") {
        await this.saveSharded();
      } else {
        await this.saveLegacy();
      }
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    if (this.mode === "sharded") {
      const loaded = await this.loadSharded();
      if (loaded) return loaded;
    }

    return this.loadLegacy();
  }

  getStatus(): IndexPersistenceStatus {
    return {
      ...this.status,
      manifest: this.status.manifest ? { ...this.status.manifest } : undefined,
    };
  }

  private async saveLegacy(): Promise<void> {
    await this.kv.set(this.scope, LEGACY_BM25_KEY, this.bm25.serialize());
    if (this.vector && this.vector.size > 0) {
      await this.kv.set(this.scope, LEGACY_VECTOR_KEY, this.vector.serialize());
    }
    this.recordSuccess(null);
  }

  private async saveSharded(): Promise<void> {
    const savedAt = this.now();
    const generation = `${Date.parse(savedAt) || Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const previous = this.completeManifest;
    const bm25 = await this.writePayloadShards(
      "bm25",
      this.bm25.serialize(),
      this.bm25.size,
      previous?.bm25,
      generation,
    );
    const vector =
      this.vector && this.vector.size > 0
        ? await this.writePayloadShards(
            "vector",
            this.vector.serialize(),
            this.vector.size,
            previous?.vector ?? undefined,
            generation,
          )
        : null;

    const manifest: ShardedIndexManifest = {
      schemaVersion: 1,
      mode: "sharded",
      savedAt,
      bm25,
      vector,
    };

    await this.kv.set(this.scope, SHARDED_MANIFEST_KEY, manifest);
    this.completeManifest = manifest;
    this.recordSuccess(manifest);
    await this.deleteUnreferencedShards(previous, manifest);
    await Promise.all([
      this.kv.delete(this.scope, LEGACY_BM25_KEY).catch(() => {}),
      this.kv.delete(this.scope, LEGACY_VECTOR_KEY).catch(() => {}),
    ]);
  }

  private async writePayloadShards(
    kind: PayloadKind,
    serialized: string,
    count: number,
    previous: PayloadManifest | undefined,
    generation: string,
  ): Promise<PayloadManifest> {
    const chunks = chunkStringByBytes(serialized, this.shardSizeBytes);
    const previousByHash = new Map(
      (previous?.shards ?? []).map((shard) => [
        `${shard.sha256}:${shard.byteLength}`,
        shard,
      ]),
    );
    const shards: ShardDescriptor[] = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const descriptor = {
        byteLength: byteLength(chunk),
        sha256: sha256(chunk),
      };
      const existing = previousByHash.get(
        `${descriptor.sha256}:${descriptor.byteLength}`,
      );
      if (existing) {
        shards.push(existing);
        continue;
      }

      const key = `${kind}:shard:${generation}:${String(index).padStart(5, "0")}`;
      await this.kv.set(this.scope, key, chunk);
      shards.push({ key, ...descriptor });
    }

    return {
      kind,
      byteLength: byteLength(serialized),
      count,
      sha256: sha256(serialized),
      shards,
    };
  }

  private async deleteUnreferencedShards(
    previous: ShardedIndexManifest | null,
    next: ShardedIndexManifest,
  ): Promise<void> {
    if (!previous) return;
    const nextKeys = new Set([
      ...next.bm25.shards.map((shard) => shard.key),
      ...(next.vector?.shards.map((shard) => shard.key) ?? []),
    ]);
    const previousKeys = [
      ...previous.bm25.shards.map((shard) => shard.key),
      ...(previous.vector?.shards.map((shard) => shard.key) ?? []),
    ];
    await Promise.all(
      previousKeys
        .filter((key) => !nextKeys.has(key))
        .map((key) => this.kv.delete(this.scope, key).catch(() => {})),
    );
  }

  private async loadSharded(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  } | null> {
    const manifest = await this.kv
      .get<unknown>(this.scope, SHARDED_MANIFEST_KEY)
      .catch(() => null);
    if (!isShardedIndexManifest(manifest)) return null;

    let incomplete = false;
    const bm25Data = await this.loadPayload(manifest.bm25);
    if (!bm25Data.complete) incomplete = true;
    const vectorData = manifest.vector
      ? await this.loadPayload(manifest.vector)
      : { complete: true, value: null };
    if (!vectorData.complete) incomplete = true;

    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    if (bm25Data.value !== null) {
      bm25 = SearchIndex.deserialize(bm25Data.value);
    }
    if (vectorData.value !== null) {
      vector = VectorIndex.deserialize(vectorData.value);
    }

    if (incomplete) {
      this.status = {
        scope: this.scope,
        mode: this.mode,
        status: "incomplete",
        error: "persisted index shards are missing or stale",
        manifest: this.statusFromManifest(manifest, true),
      };
    } else {
      this.completeManifest = manifest;
      this.status = {
        scope: this.scope,
        mode: this.mode,
        status: "ok",
        lastSuccessfulSaveAt: manifest.savedAt,
        manifest: this.statusFromManifest(manifest),
      };
    }

    return { bm25, vector };
  }

  private async loadPayload(
    payload: PayloadManifest,
  ): Promise<{ complete: boolean; value: string | null }> {
    const chunks: string[] = [];
    for (const shard of payload.shards) {
      const chunk = await this.kv
        .get<string>(this.scope, shard.key)
        .catch(() => null);
      if (
        typeof chunk !== "string" ||
        byteLength(chunk) !== shard.byteLength ||
        sha256(chunk) !== shard.sha256
      ) {
        return { complete: false, value: null };
      }
      chunks.push(chunk);
    }
    const value = chunks.join("");
    if (byteLength(value) !== payload.byteLength || sha256(value) !== payload.sha256) {
      return { complete: false, value: null };
    }
    return { complete: true, value };
  }

  private async loadLegacy(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    const bm25Data = await this.kv
      .get<string>(this.scope, LEGACY_BM25_KEY)
      .catch(() => null);
    if (bm25Data && typeof bm25Data === "string") {
      bm25 = SearchIndex.deserialize(bm25Data);
    }

    const vecData = await this.kv
      .get<string>(this.scope, LEGACY_VECTOR_KEY)
      .catch(() => null);
    if (vecData && typeof vecData === "string") {
      vector = VectorIndex.deserialize(vecData);
    }

    if (bm25 || vector) {
      this.status = {
        scope: this.scope,
        mode: this.mode,
        status: "ok",
      };
    }
    return { bm25, vector };
  }

  private recordSuccess(manifest: ShardedIndexManifest | null): void {
    const savedAt = manifest?.savedAt ?? this.now();
    this.status = {
      scope: this.scope,
      mode: this.mode,
      status: "ok",
      lastSuccessfulSaveAt: savedAt,
      manifest: manifest ? this.statusFromManifest(manifest) : undefined,
    };
  }

  private recordFailure(error: unknown): void {
    this.status = {
      ...this.status,
      scope: this.scope,
      mode: this.mode,
      status: "error",
      lastFailureAt: this.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private statusFromManifest(
    manifest: ShardedIndexManifest,
    incomplete = false,
  ): NonNullable<IndexPersistenceStatus["manifest"]> {
    return {
      savedAt: manifest.savedAt,
      bm25Shards: manifest.bm25.shards.length,
      vectorShards: manifest.vector?.shards.length ?? 0,
      bm25Bytes: manifest.bm25.byteLength,
      vectorBytes: manifest.vector?.byteLength ?? 0,
      documentCount: manifest.bm25.count,
      vectorCount: manifest.vector?.count ?? 0,
      incomplete: incomplete || undefined,
    };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
  }
}
