import type { ISdk } from 'iii-sdk'

import { getEnvVar } from '../config.js'
import {
  KV,
  retrievalBlockShardScope,
  retrievalBlockShardScopes,
} from './schema.js'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_FAILURE_THRESHOLD = 2
const DEFAULT_FAILURE_WINDOW_MS = 15_000
const DEFAULT_COOLDOWN_MS = 10_000

export interface StateKVOptions {
  timeoutMs?: number
  failureThreshold?: number
  failureWindowMs?: number
  cooldownMs?: number
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return parsePositiveInt(getEnvVar('STATE_KV_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS)
  }
  return timeoutMs > 0 ? timeoutMs : 0
}

function normalizeOption(
  value: number | undefined,
  envKey: string,
  fallback: number,
): number {
  if (value === undefined) return parsePositiveInt(getEnvVar(envKey), fallback)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export class StateKV {
  private readonly timeoutMs: number
  private readonly failureThreshold: number
  private readonly failureWindowMs: number
  private readonly cooldownMs: number
  private failureStreak = 0
  private lastFailureAt = 0
  private cooldownUntil = 0
  private lastFailureMessage: string | undefined

  constructor(
    private sdk: ISdk,
    options?: StateKVOptions,
  ) {
    this.timeoutMs = normalizeTimeoutMs(options?.timeoutMs)
    this.failureThreshold = normalizeOption(
      options?.failureThreshold,
      'STATE_KV_FAILURE_THRESHOLD',
      DEFAULT_FAILURE_THRESHOLD,
    )
    this.failureWindowMs = normalizeOption(
      options?.failureWindowMs,
      'STATE_KV_FAILURE_WINDOW_MS',
      DEFAULT_FAILURE_WINDOW_MS,
    )
    this.cooldownMs = normalizeOption(
      options?.cooldownMs,
      'STATE_KV_COOLDOWN_MS',
      DEFAULT_COOLDOWN_MS,
    )
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    if (scope === KV.retrievalBlocks) {
      return this.getRetrievalBlock<T>(key)
    }
    return this.trigger<{ scope: string; key: string }, T | null>(
      'state::get',
      { scope, key },
    )
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    if (scope === KV.retrievalBlocks) {
      return this.setRetrievalBlock(key, value)
    }
    return this.trigger<{ scope: string; key: string; value: T }, T>(
      'state::set',
      { scope, key, value },
    )
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    return this.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >(
      'state::update',
      { scope, key, ops },
    )
  }

  async delete(scope: string, key: string): Promise<void> {
    if (scope === KV.retrievalBlocks) {
      return this.deleteRetrievalBlock(key)
    }
    return this.trigger<{ scope: string; key: string }, void>(
      'state::delete',
      { scope, key },
    )
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    if (scope === KV.retrievalBlocks) {
      return this.listRetrievalBlocks<T>()
    }
    return this.trigger<{ scope: string }, T[]>(
      'state::list',
      { scope },
    )
  }

  async getRaw<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.trigger<{ scope: string; key: string }, T | null>(
      'state::get',
      { scope, key },
    )
  }

  async setRaw<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.trigger<{ scope: string; key: string; value: T }, T>(
      'state::set',
      { scope, key, value },
    )
  }

  async deleteRaw(scope: string, key: string): Promise<void> {
    return this.trigger<{ scope: string; key: string }, void>(
      'state::delete',
      { scope, key },
    )
  }

  async listRaw<T = unknown>(scope: string): Promise<T[]> {
    return this.trigger<{ scope: string }, T[]>(
      'state::list',
      { scope },
    )
  }

  private async getRetrievalBlock<T = unknown>(key: string): Promise<T | null> {
    const shardValue = await this.trigger<{ scope: string; key: string }, T | null>(
      'state::get',
      { scope: retrievalBlockShardScope(key), key },
    )
    if (shardValue !== null) return shardValue
    return this.trigger<{ scope: string; key: string }, T | null>(
      'state::get',
      { scope: KV.retrievalBlocks, key },
    )
  }

  private async setRetrievalBlock<T = unknown>(
    key: string,
    value: T,
  ): Promise<T> {
    return this.trigger<{ scope: string; key: string; value: T }, T>(
      'state::set',
      { scope: retrievalBlockShardScope(key), key, value },
    )
  }

  private async deleteRetrievalBlock(key: string): Promise<void> {
    await this.trigger<{ scope: string; key: string }, void>(
      'state::delete',
      { scope: retrievalBlockShardScope(key), key },
    ).catch(() => {})
    await this.trigger<{ scope: string; key: string }, void>(
      'state::delete',
      { scope: KV.retrievalBlocks, key },
    ).catch(() => {})
  }

  private async listRetrievalBlocks<T = unknown>(): Promise<T[]> {
    const scopes = [KV.retrievalBlocks, ...retrievalBlockShardScopes()]
    const rows = await Promise.all(
      scopes.map((scope) =>
        this.trigger<{ scope: string }, T[]>(
          'state::list',
          { scope },
        ),
      ),
    )
    const byId = new Map<string, T>()
    const anonymous: T[] = []
    for (const row of rows.flat()) {
      const id = this.rowId(row)
      if (id) byId.set(id, row)
      else anonymous.push(row)
    }
    return [...byId.values(), ...anonymous]
  }

  private rowId(row: unknown): string | null {
    if (!row || typeof row !== 'object') return null
    const id = (row as { id?: unknown }).id
    return typeof id === 'string' && id ? id : null
  }

  private async trigger<TInput, TOutput>(
    operation: string,
    data: TInput,
  ): Promise<TOutput> {
    const now = Date.now()
    if (now < this.cooldownUntil) {
      const retryInMs = this.cooldownUntil - now
      const detail = this.lastFailureMessage ? `; last error: ${this.lastFailureMessage}` : ''
      throw new Error(
        `StateKV temporarily unavailable for ${operation}; retry in ${retryInMs}ms${detail}`,
      )
    }

    try {
      const result = await this.withTimeout(
        operation,
        this.sdk.trigger<TInput, TOutput>({
          function_id: operation,
          payload: data,
        }),
      )
      this.resetFailures()
      return result
    } catch (err) {
      this.recordFailure(this.getErrorMessage(err))
      throw err
    }
  }

  private async withTimeout<T>(operation: string, work: Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0) return work

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(`StateKV ${operation} timed out after ${this.timeoutMs}ms`),
            )
          }, this.timeoutMs)
        }),
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private resetFailures(): void {
    this.failureStreak = 0
    this.lastFailureAt = 0
    this.cooldownUntil = 0
    this.lastFailureMessage = undefined
  }

  private recordFailure(message: string): void {
    const now = Date.now()
    if (
      this.lastFailureAt === 0 ||
      now - this.lastFailureAt > this.failureWindowMs
    ) {
      this.failureStreak = 0
    }

    this.failureStreak += 1
    this.lastFailureAt = now
    this.lastFailureMessage = message

    if (this.failureStreak >= this.failureThreshold) {
      this.cooldownUntil = now + this.cooldownMs
    }
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}
