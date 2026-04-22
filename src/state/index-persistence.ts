import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 5000;
const RETRY_BACKOFF_MS = 15000;
const MAX_RETRY_BACKOFF_MS = 60000;

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private nextDelayMs = DEBOUNCE_MS;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private scope = KV.bm25Index,
  ) {}

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
    this.inFlight = this.saveNow();
    try {
      await this.inFlight;
      this.nextDelayMs = DEBOUNCE_MS;
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

  private async saveNow(): Promise<void> {
    await this.kv.set(this.scope, "data", this.bm25.serialize());
    if (this.vector && this.vector.size > 0) {
      await this.kv.set(this.scope, "vectors", this.vector.serialize());
    }
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    const bm25Data = await this.kv
      .get<string>(this.scope, "data")
      .catch(() => null);
    if (bm25Data && typeof bm25Data === "string") {
      bm25 = SearchIndex.deserialize(bm25Data);
    }

    const vecData = await this.kv
      .get<string>(this.scope, "vectors")
      .catch(() => null);
    if (vecData && typeof vecData === "string") {
      vector = VectorIndex.deserialize(vecData);
    }

    return { bm25, vector };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
  }
}
