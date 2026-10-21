/**
 * A poll that never overlaps itself: the next look is scheduled only after the last one settles,
 * a failing look backs off (doubling, up to `maxMs`), and `stop()` cancels the timer and drops the
 * result of a look still in flight. Pure (no React, no DOM), so `node --test` runs it.
 *
 * Slow public nodes made a plain `setInterval` pile looks on top of each other (each one many
 * requests) until the browser ran out of sockets (net::ERR_INSUFFICIENT_RESOURCES).
 */

export interface PollerOptions {
  /** Delay between the end of one look and the start of the next (ms). */
  intervalMs: number;
  /** Ceiling for the delay after failures (ms). Default: 8 × `intervalMs`. */
  maxMs?: number;
  /** Called with each failure (the poll goes on). */
  onError?: (e: unknown) => void;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface Poller {
  stop(): void;
}

/** `n` reads, at most `width` at a time, results in order. */
export async function inChunks<T>(n: number, width: number, read: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i += width) out.push(...(await Promise.all(Array.from({ length: Math.min(width, n - i) }, (_, k) => read(i + k)))));
  return out;
}

/** The delay after `failures` consecutive failed looks. */
export function backoffDelay(intervalMs: number, failures: number, maxMs = intervalMs * 8): number {
  return Math.min(maxMs, intervalMs * 2 ** Math.max(0, failures));
}

/**
 * Starts polling `look` right away. `look` receives `live()`, false once stopped, to skip writing
 * results nobody wants.
 */
export function startPoller(look: (live: () => boolean) => Promise<unknown>, o: PollerOptions): Poller {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  let running = false;
  let failures = 0;
  let timer: unknown;
  const live = () => !stopped;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimer(run, ms);
  };
  async function run() {
    timer = undefined;
    if (stopped || running) return;
    running = true;
    try {
      await look(live);
      failures = 0;
    } catch (e) {
      failures++;
      if (!stopped) o.onError?.(e);
    } finally {
      running = false;
    }
    schedule(failures ? backoffDelay(o.intervalMs, failures, o.maxMs) : o.intervalMs);
  }

  void run();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
