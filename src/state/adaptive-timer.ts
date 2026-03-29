/**
 * Adaptive timer that adjusts interval based on workload.
 * Backs off when idle, speeds up when busy, doubles on error.
 */
export interface AdaptiveTimerOptions {
  baseMs: number;
  minMs: number;
  maxMs: number;
  label: string;
}

export interface AdaptiveTimerHandle {
  stop: () => void;
  currentInterval: () => number;
}

export function createAdaptiveTimer(
  fn: () => Promise<number>,
  opts: AdaptiveTimerOptions,
): AdaptiveTimerHandle {
  let interval = opts.baseMs;
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const workDone = await fn();
      if (workDone > 0) {
        interval = Math.max(opts.minMs, interval * 0.75);
      } else {
        interval = Math.min(opts.maxMs, interval * 1.5);
      }
    } catch (err) {
      console.error(`[agentmemory] ${opts.label} failed:`, err);
      interval = Math.min(opts.maxMs, interval * 2);
    }
    if (!stopped) {
      timer = setTimeout(tick, interval);
      timer.unref();
    }
  };

  timer = setTimeout(tick, interval);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    currentInterval: () => interval,
  };
}
