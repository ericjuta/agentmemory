// Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
/**
 * Per-session inflight compression counter with drain support.
 * Used to ensure all compressions complete before summarization.
 */
export class CompressionTracker {
  private readonly sessions = new Map<
    string,
    { inflight: number; waiters: Array<() => void> }
  >();

  private getOrCreate(sessionId: string) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { inflight: 0, waiters: [] };
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }

  increment(sessionId: string): void {
    const entry = this.getOrCreate(sessionId);
    entry.inflight++;
  }

  decrement(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.inflight = Math.max(0, entry.inflight - 1);
    if (entry.inflight === 0) {
      const waiters = entry.waiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  drain(sessionId: string, timeoutMs = 30_000): Promise<void> {
    const entry = this.getOrCreate(sessionId);
    if (entry.inflight === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = entry.waiters.indexOf(waiter);
        if (idx !== -1) entry.waiters.splice(idx, 1);
        reject(new Error(`Drain timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      entry.waiters.push(waiter);
    });
  }

  inflightCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.inflight ?? 0;
  }

  totalInflight(): number {
    let total = 0;
    for (const entry of this.sessions.values()) {
      total += entry.inflight;
    }
    return total;
  }
}
