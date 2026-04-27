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
const STABLE_SHARD_GENERATIONS = ["stable-a", "stable-b"] as const;

export type IndexPersistenceMode = "legacy" | "sharded";

export interface IndexPersistenceOptions {
  mode?: IndexPersistenceMode;
  shardSizeBytes?: number;
  now?: () => string;
  shouldDeferSave?: (() => boolean | string | null | Promise<boolean | string | null>) | undefined;
}

export interface IndexPersistenceStatus {
  scope: string;
  manifestScope?: string;
  manifestSource?: "manifest-scope" | "parent-scope" | "legacy-payload";
  mode: IndexPersistenceMode;
  status: "idle" | "ok" | "error" | "incomplete";
  lastSuccessfulSaveAt?: string;
  lastFailureAt?: string;
  error?: string;
  pendingSave?: boolean;
  inFlight?: boolean;
  nextDelayMs?: number;
  deferredCount?: number;
  lastDeferredAt?: string;
  deferReason?: string;
  manifest?: {
    manifestVersion?: number;
    physicalScopeMode?: "same-scope" | "physical-scope";
    legacyPayloadPresent?: boolean;
    legacySameScopeShardCount?: number;
    physicalShardScopeCount?: number;
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

export interface IndexPersistenceSaveOptions {
  allowShrink?: boolean;
}

type PayloadKind = "bm25" | "vector";
type StableShardGeneration = (typeof STABLE_SHARD_GENERATIONS)[number];

interface BaseShardDescriptor {
  key: string;
  byteLength: number;
  sha256: string;
}

interface PhysicalShardDescriptor extends BaseShardDescriptor {
  scope: string;
  kind: PayloadKind;
  generation: string;
  index: number;
}

type ShardDescriptor = BaseShardDescriptor | PhysicalShardDescriptor;

interface BasePayloadManifest {
  kind: PayloadKind;
  byteLength: number;
  count: number;
  sha256: string;
  shards: ShardDescriptor[];
}

interface PayloadManifestV1 extends BasePayloadManifest {
  shards: BaseShardDescriptor[];
}

interface PayloadManifestV2 extends BasePayloadManifest {
  shards: PhysicalShardDescriptor[];
}

type PayloadManifest = PayloadManifestV1 | PayloadManifestV2;

type ManifestSource = "manifest-scope" | "parent-scope";

interface StoredManifest {
  manifest: ShardedIndexManifest;
  source: ManifestSource;
}

interface ShardedIndexManifestV1 {
  schemaVersion: 1;
  mode: "sharded";
  savedAt: string;
  bm25: PayloadManifestV1;
  vector: PayloadManifestV1 | null;
}

interface ShardedIndexManifestV2 {
  schemaVersion: 2;
  mode: "sharded";
  savedAt: string;
  bm25: PayloadManifestV2;
  vector: PayloadManifestV2 | null;
}

type ShardedIndexManifest = ShardedIndexManifestV1 | ShardedIndexManifestV2;

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

function isBaseShardDescriptor(value: unknown): value is BaseShardDescriptor {
  const row = value as BaseShardDescriptor;
  return (
    !!row &&
    typeof row.key === "string" &&
    typeof row.byteLength === "number" &&
    typeof row.sha256 === "string"
  );
}

function isPhysicalShardDescriptor(
  value: unknown,
  kind: PayloadKind,
): value is PhysicalShardDescriptor {
  const row = value as PhysicalShardDescriptor;
  return (
    isBaseShardDescriptor(value) &&
    typeof row.scope === "string" &&
    row.kind === kind &&
    typeof row.generation === "string" &&
    typeof row.index === "number"
  );
}

function isPayloadManifestV1(
  value: unknown,
  kind: PayloadKind,
): value is PayloadManifestV1 {
  const row = value as PayloadManifestV1;
  return (
    !!row &&
    row.kind === kind &&
    typeof row.byteLength === "number" &&
    typeof row.count === "number" &&
    typeof row.sha256 === "string" &&
    Array.isArray(row.shards) &&
    row.shards.every(isBaseShardDescriptor)
  );
}

function isPayloadManifestV2(
  value: unknown,
  kind: PayloadKind,
): value is PayloadManifestV2 {
  const row = value as PayloadManifestV2;
  return (
    !!row &&
    row.kind === kind &&
    typeof row.byteLength === "number" &&
    typeof row.count === "number" &&
    typeof row.sha256 === "string" &&
    Array.isArray(row.shards) &&
    row.shards.every((shard) => isPhysicalShardDescriptor(shard, kind))
  );
}

function isShardedIndexManifestV1(
  value: unknown,
): value is ShardedIndexManifestV1 {
  const row = value as ShardedIndexManifestV1;
  return (
    !!row &&
    row.schemaVersion === 1 &&
    row.mode === "sharded" &&
    typeof row.savedAt === "string" &&
    isPayloadManifestV1(row.bm25, "bm25") &&
    (row.vector === null || isPayloadManifestV1(row.vector, "vector"))
  );
}

function isShardedIndexManifestV2(
  value: unknown,
): value is ShardedIndexManifestV2 {
  const row = value as ShardedIndexManifestV2;
  return (
    !!row &&
    row.schemaVersion === 2 &&
    row.mode === "sharded" &&
    typeof row.savedAt === "string" &&
    isPayloadManifestV2(row.bm25, "bm25") &&
    (row.vector === null || isPayloadManifestV2(row.vector, "vector"))
  );
}

function isShardedIndexManifest(value: unknown): value is ShardedIndexManifest {
  return isShardedIndexManifestV2(value) || isShardedIndexManifestV1(value);
}

function isPhysicalPayloadManifest(
  payload: PayloadManifest,
): payload is PayloadManifestV2 {
  return payload.shards.every((shard) => "scope" in shard);
}

function isStableShardGeneration(
  generation: string | undefined,
): generation is StableShardGeneration {
  return generation === "stable-a" || generation === "stable-b";
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private nextDelayMs = DEBOUNCE_MS;
  private readonly mode: IndexPersistenceMode;
  private readonly shardSizeBytes: number;
  private readonly manifestScope: string;
  private readonly now: () => string;
  private readonly shouldDeferSave: () => boolean | string | null | Promise<boolean | string | null>;
  private deferredCount = 0;
  private lastDeferredAt: string | undefined;
  private deferReason: string | undefined;
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
    this.manifestScope = KV.indexManifest(this.scope);
    this.shardSizeBytes = positiveInteger(
      options.shardSizeBytes,
      DEFAULT_SHARD_BYTES,
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.shouldDeferSave = options.shouldDeferSave ?? (() => false);
    this.status = {
      scope: this.scope,
      manifestScope: this.manifestScope,
      mode: this.mode,
      status: "idle",
    };
  }

  scheduleSave(): void {
    this.dirty = true;
    if (this.inFlight) return;
    this.armTimer(this.nextDelayMs);
  }

  async save(options: IndexPersistenceSaveOptions = {}): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    await this.saveNow(options);
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
    const deferResult = await this.shouldDeferSave();
    if (deferResult) {
      this.deferredCount++;
      this.lastDeferredAt = this.now();
      this.deferReason =
        typeof deferResult === "string" ? deferResult : "health_unhealthy";
      this.dirty = true;
      this.nextDelayMs = Math.min(
        MAX_RETRY_BACKOFF_MS,
        Math.max(RETRY_BACKOFF_MS, this.nextDelayMs * 2),
      );
      logger.warn("Index persistence deferred while health is unhealthy", {
        scope: this.scope,
        reason: this.deferReason,
      });
      return "deferred";
    }
    await this.saveNow();
    return "saved";
  }

  private async saveNow(options: IndexPersistenceSaveOptions = {}): Promise<void> {
    try {
      if (this.mode === "sharded") {
        await this.saveSharded(options);
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
      pendingSave: this.dirty,
      inFlight: Boolean(this.inFlight),
      nextDelayMs: this.nextDelayMs,
      deferredCount: this.deferredCount,
      lastDeferredAt: this.lastDeferredAt,
      deferReason: this.deferReason,
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

  private async saveSharded(options: IndexPersistenceSaveOptions = {}): Promise<void> {
    const savedAt = this.now();
    const previous = this.completeManifest ?? (await this.loadStoredManifest());
    const bm25 =
      !options.allowShrink && previous?.bm25 && this.bm25.size < previous.bm25.count
        ? await this.preserveOrMigratePayload("bm25", previous.bm25)
        : await this.writePayloadShards(
            "bm25",
            this.bm25.serialize(),
            this.bm25.size,
            previous?.bm25,
          );
    const vector = await this.resolveVectorPayload(previous, options);

    const manifest: ShardedIndexManifestV2 = {
      schemaVersion: 2,
      mode: "sharded",
      savedAt,
      bm25,
      vector,
    };

    await this.kv.set(this.manifestScope, SHARDED_MANIFEST_KEY, manifest);
    this.completeManifest = manifest;
    await this.deleteUnreferencedShards(previous, manifest);
    this.recordSuccess(manifest, false);
  }

  private async resolveVectorPayload(
    previous: ShardedIndexManifest | null,
    options: IndexPersistenceSaveOptions = {},
  ): Promise<PayloadManifestV2 | null> {
    if (!this.vector || this.vector.size === 0) {
      if (!previous?.vector) return null;
      return this.preserveOrMigratePayload("vector", previous.vector);
    }

    if (
      !options.allowShrink &&
      previous?.vector &&
      this.vector.size < previous.vector.count
    ) {
      return this.preserveOrMigratePayload("vector", previous.vector);
    }

    return this.writePayloadShards(
      "vector",
      this.vector.serialize(),
      this.vector.size,
      previous?.vector ?? undefined,
    );
  }

  private async preserveOrMigratePayload(
    kind: PayloadKind,
    payload: PayloadManifest,
  ): Promise<PayloadManifestV2> {
    if (isPhysicalPayloadManifest(payload)) return payload;

    const loaded = await this.loadPayload(payload);
    if (!loaded.complete || loaded.value === null) {
      throw new Error(`previous ${kind} shards are missing or stale`);
    }

    return this.writePayloadShards(
      kind,
      loaded.value,
      payload.count,
      undefined,
    );
  }

  private async loadStoredManifest(): Promise<ShardedIndexManifest | null> {
    return (await this.loadStoredManifestWithSource())?.manifest ?? null;
  }

  private async loadStoredManifestWithSource(): Promise<StoredManifest | null> {
    const manifest = await this.loadManifestFrom(this.manifestScope);
    if (manifest) return { manifest, source: "manifest-scope" };
    const parentManifest = await this.loadManifestFrom(this.scope);
    if (parentManifest) {
      return { manifest: parentManifest, source: "parent-scope" };
    }
    return null;
  }

  private async loadManifestFrom(
    scope: string,
  ): Promise<ShardedIndexManifest | null> {
    const manifest = await this.kv
      .get<unknown>(scope, SHARDED_MANIFEST_KEY)
      .catch(() => null);
    return isShardedIndexManifest(manifest) ? manifest : null;
  }

  private async writePayloadShards(
    kind: PayloadKind,
    serialized: string,
    count: number,
    previous: PayloadManifest | undefined,
  ): Promise<PayloadManifestV2> {
    const chunks = chunkStringByBytes(serialized, this.shardSizeBytes);
    const previousByIndex = new Map(
      (previous && isPhysicalPayloadManifest(previous) ? previous.shards : []).map(
        (shard) => [shard.index, shard],
      ),
    );
    const shards: PhysicalShardDescriptor[] = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const descriptor = {
        byteLength: byteLength(chunk),
        sha256: sha256(chunk),
      };
      const previousShard = previousByIndex.get(index);
      if (
        previousShard &&
        isStableShardGeneration(previousShard.generation) &&
        this.shardMatches(previousShard, descriptor)
      ) {
        shards.push(previousShard);
        continue;
      }

      const key = "data";
      const generation = this.nextShardGeneration(previousShard);
      const scope = KV.indexShard(this.scope, kind, generation, index);
      const shard: PhysicalShardDescriptor = {
        scope,
        key,
        kind,
        generation,
        index,
        ...descriptor,
      };
      await this.kv.set(scope, key, chunk);
      await this.verifyShard(shard);
      shards.push(shard);
    }

    await Promise.all(shards.map((shard) => this.verifyShard(shard)));

    return {
      kind,
      byteLength: byteLength(serialized),
      count,
      sha256: sha256(serialized),
      shards,
    };
  }

  private shardMatches(
    shard: PhysicalShardDescriptor,
    descriptor: Pick<PhysicalShardDescriptor, "byteLength" | "sha256">,
  ): boolean {
    return (
      shard.byteLength === descriptor.byteLength &&
      shard.sha256 === descriptor.sha256
    );
  }

  private nextShardGeneration(
    previous: PhysicalShardDescriptor | undefined,
  ): StableShardGeneration {
    if (!isStableShardGeneration(previous?.generation)) return "stable-a";
    return previous.generation === "stable-a" ? "stable-b" : "stable-a";
  }

  private async verifyShard(shard: PhysicalShardDescriptor): Promise<void> {
    const chunk = await this.kv.get<string>(shard.scope, shard.key);
    if (
      typeof chunk !== "string" ||
      byteLength(chunk) !== shard.byteLength ||
      sha256(chunk) !== shard.sha256
    ) {
      throw new Error(`StateKV shard verification failed for ${shard.scope}`);
    }
  }

  private async deleteUnreferencedShards(
    previous: ShardedIndexManifest | null,
    next: ShardedIndexManifest,
  ): Promise<void> {
    if (!previous) return;
    const nextRefs = new Set(this.shardRefs(next));
    const previousShards = [
      ...previous.bm25.shards,
      ...(previous.vector?.shards ?? []),
    ];
    await Promise.all(
      previousShards
        .filter((shard) => !nextRefs.has(this.shardRef(shard)))
        .filter((shard): shard is PhysicalShardDescriptor => "scope" in shard)
        .map((shard) => {
          return this.kv.delete(shard.scope, shard.key).catch(() => {});
        }),
    );
  }

  private shardRefs(manifest: ShardedIndexManifest): string[] {
    return [
      ...manifest.bm25.shards.map((shard) => this.shardRef(shard)),
      ...(manifest.vector?.shards.map((shard) => this.shardRef(shard)) ?? []),
    ];
  }

  private shardRef(shard: ShardDescriptor): string {
    const storage = this.shardStorage(shard);
    return `${storage.scope}\0${storage.key}`;
  }

  private shardStorage(shard: ShardDescriptor): { scope: string; key: string } {
    return "scope" in shard
      ? { scope: shard.scope, key: shard.key }
      : { scope: this.scope, key: shard.key };
  }

  private async loadSharded(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  } | null> {
    const stored = await this.loadStoredManifestWithSource();
    if (!stored) return null;
    const { manifest, source } = stored;

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
        manifestScope: this.manifestScope,
        manifestSource: source,
        mode: this.mode,
        status: "incomplete",
        error: "persisted index shards are missing or stale",
        manifest: this.statusFromManifest(
          manifest,
          true,
          source === "manifest-scope" ? false : undefined,
        ),
      };
    } else {
      this.completeManifest = manifest;
      this.status = {
        scope: this.scope,
        manifestScope: this.manifestScope,
        manifestSource: source,
        mode: this.mode,
        status: "ok",
        lastSuccessfulSaveAt: manifest.savedAt,
        manifest: this.statusFromManifest(
          manifest,
          false,
          source === "manifest-scope" ? false : undefined,
        ),
      };
    }

    return { bm25, vector };
  }

  private async loadPayload(
    payload: PayloadManifest,
  ): Promise<{ complete: boolean; value: string | null }> {
    const chunks: string[] = [];
    for (const shard of payload.shards) {
      const storage = this.shardStorage(shard);
      const chunk = await this.kv
        .get<string>(storage.scope, storage.key)
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
        manifestScope: this.manifestScope,
        manifestSource: "legacy-payload",
        mode: this.mode,
        status: "ok",
      };
    }
    return { bm25, vector };
  }

  private recordSuccess(
    manifest: ShardedIndexManifest | null,
    legacyPayloadPresent?: boolean,
  ): void {
    const savedAt = manifest?.savedAt ?? this.now();
    this.status = {
      scope: this.scope,
      manifestScope: this.manifestScope,
      manifestSource: manifest ? "manifest-scope" : this.status.manifestSource,
      mode: this.mode,
      status: "ok",
      lastSuccessfulSaveAt: savedAt,
      manifest: manifest
        ? this.statusFromManifest(manifest, false, legacyPayloadPresent)
        : undefined,
    };
  }

  private recordFailure(error: unknown): void {
    this.status = {
      ...this.status,
      scope: this.scope,
      manifestScope: this.manifestScope,
      mode: this.mode,
      status: "error",
      lastFailureAt: this.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private statusFromManifest(
    manifest: ShardedIndexManifest,
    incomplete = false,
    legacyPayloadPresent?: boolean,
  ): NonNullable<IndexPersistenceStatus["manifest"]> {
    const physicalScopes = new Set(
      this.allShards(manifest)
        .filter((shard): shard is PhysicalShardDescriptor => "scope" in shard)
        .map((shard) => shard.scope),
    );
    const legacySameScopeShardCount = this.allShards(manifest).filter(
      (shard) => !("scope" in shard),
    ).length;
    return {
      manifestVersion: manifest.schemaVersion,
      physicalScopeMode:
        manifest.schemaVersion === 2 ? "physical-scope" : "same-scope",
      legacyPayloadPresent,
      legacySameScopeShardCount,
      physicalShardScopeCount: physicalScopes.size,
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

  private allShards(manifest: ShardedIndexManifest): ShardDescriptor[] {
    return [
      ...manifest.bm25.shards,
      ...(manifest.vector?.shards ?? []),
    ];
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
  }
}
