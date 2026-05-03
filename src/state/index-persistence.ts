import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 5000;
const FAILURE_LOG_THROTTLE_MS = 60_000;
const METADATA_TIMEOUT_MS = 2000;
const SNAPSHOT_VERSION = 1;

interface IndexSnapshotMetadata {
  version: typeof SNAPSHOT_VERSION;
  savedAt: string;
  bm25: SnapshotFileMetadata | null;
  vector: SnapshotFileMetadata | null;
}

interface SnapshotFileMetadata {
  file: string;
  bytes: number;
  sha256: string;
  entries: number;
}

interface IndexPersistenceOptions {
  cacheDir?: string;
}

interface IndexPersistenceStatus {
  lastSaveStartedAt: number | null;
  lastSaveCompletedAt: number | null;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
  pending: boolean;
}

const status: IndexPersistenceStatus = {
  lastSaveStartedAt: null,
  lastSaveCompletedAt: null,
  lastFailureAt: null,
  lastFailureMessage: null,
  pending: false,
};

export function getIndexPersistenceStatus(): IndexPersistenceStatus {
  return { ...status };
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;
  private cacheDir: string;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    options: IndexPersistenceOptions = {},
  ) {
    this.cacheDir =
      options.cacheDir ?? join(process.cwd(), "data", "index-cache");
  }

  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    status.pending = true;
    this.timer = setTimeout(() => {
      this.save().catch((err) => this.logFailure(err));
    }, DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    status.pending = true;
    status.lastSaveStartedAt = Date.now();
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const savedAt = new Date().toISOString();
      const bm25 = await this.writeSnapshotFile(
        "bm25.json",
        this.bm25.serialize(),
        this.bm25.size,
      );
      const vector =
        this.vector && this.vector.size > 0
          ? await this.writeSnapshotFile(
              "vectors.json",
              this.vector.serialize(),
              this.vector.size,
            )
          : null;
      if (!vector) {
        await rm(this.path("vectors.json"), { force: true }).catch(() => {});
      }
      const metadata: IndexSnapshotMetadata = {
        version: SNAPSHOT_VERSION,
        savedAt,
        bm25,
        vector,
      };
      await this.writeManifest(metadata);
      await this.saveMetadata(metadata);
      status.lastSaveCompletedAt = Date.now();
      status.lastFailureAt = null;
      status.lastFailureMessage = null;
    } catch (err) {
      this.logFailure(err);
    } finally {
      status.pending = false;
    }
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    const fileLoaded = await this.loadFromSnapshot().catch((err) => {
      this.logFailure(err);
      return null;
    });
    if (fileLoaded) return fileLoaded;

    const bm25Data = await this.kv
      .get<string>(KV.bm25Index, "data")
      .catch(() => null);
    const vecData = await this.kv
      .get<string>(KV.bm25Index, "vectors")
      .catch(() => null);

    const bm25 =
      bm25Data && typeof bm25Data === "string"
        ? SearchIndex.deserialize(bm25Data)
        : null;
    const vector =
      vecData && typeof vecData === "string"
        ? VectorIndex.deserialize(vecData)
        : null;
    return { bm25, vector };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    status.pending = false;
  }

  private async loadFromSnapshot(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  } | null> {
    const manifest = await readFile(this.path("manifest.json"), "utf-8").catch(
      () => null,
    );
    if (!manifest) return null;
    const metadata = JSON.parse(manifest) as IndexSnapshotMetadata;
    if (metadata.version !== SNAPSHOT_VERSION) return null;

    const bm25 = metadata.bm25
      ? SearchIndex.deserialize(await this.readSnapshotFile(metadata.bm25))
      : null;
    const vector = metadata.vector
      ? VectorIndex.deserialize(await this.readSnapshotFile(metadata.vector))
      : null;
    const usableBm25 = bm25 && bm25.size > 0 ? bm25 : null;
    const usableVector = vector && vector.size > 0 ? vector : null;
    if (!usableBm25 && !usableVector) return null;
    return { bm25: usableBm25, vector: usableVector };
  }

  private async writeSnapshotFile(
    file: string,
    contents: string,
    entries: number,
  ): Promise<SnapshotFileMetadata> {
    await this.writeAtomic(file, contents);
    return {
      file,
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
      entries,
    };
  }

  private async readSnapshotFile(metadata: SnapshotFileMetadata): Promise<string> {
    const contents = await readFile(this.path(metadata.file), "utf-8");
    const actual = sha256(contents);
    if (actual !== metadata.sha256) {
      throw new Error("index snapshot checksum mismatch: " + metadata.file);
    }
    return contents;
  }

  private async writeManifest(metadata: IndexSnapshotMetadata): Promise<void> {
    await this.writeAtomic("manifest.json", JSON.stringify(metadata, null, 2));
  }

  private async writeAtomic(file: string, contents: string): Promise<void> {
    const tmpFile = this.path(
      file +
        ".tmp-" +
        process.pid +
        "-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2),
    );
    const target = this.path(file);
    await writeFile(tmpFile, contents, "utf-8");
    await rename(tmpFile, target).catch(async (err) => {
      await rm(tmpFile, { force: true }).catch(() => {});
      throw err;
    });
  }

  private async saveMetadata(metadata: IndexSnapshotMetadata): Promise<void> {
    const write = this.kv.set(KV.bm25Index, "metadata", metadata);
    write.catch(() => {});
    await Promise.race([
      write,
      new Promise<void>((resolve) =>
        setTimeout(resolve, METADATA_TIMEOUT_MS),
      ),
    ]);
  }

  private path(file: string): string {
    return join(this.cacheDir, file);
  }

  private logFailure(err: unknown): void {
    status.lastFailureAt = Date.now();
    status.lastFailureMessage = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    logger.warn("index persistence: failed to save BM25/vector snapshot", {
      code,
      message: status.lastFailureMessage,
      hint:
        code === "TIMEOUT"
          ? "iii-engine metadata write timed out; index snapshots remain file-backed and will retry on the next debounce flush"
          : undefined,
    });
  }
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
