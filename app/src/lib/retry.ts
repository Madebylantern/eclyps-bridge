/**
 * Errors from public Aztec nodes that pass on their own, and the retry the wallet makes for them.
 * Pure (no Aztec imports), so `node --test` runs it.
 *
 * A testnet node behind a load balancer can lag, or prune blocks in a reorg; a transaction proven
 * against a block it no longer has is refused ("Invalid tx: Block header not found"). Syncing the
 * PXE again moves its anchor to a block the node has; then the transaction is simulated and proven
 * again. Only the steps before the node accepts the transaction are retried, so a burn or a claim
 * is never sent twice.
 */

/** Every message in an error and its causes. */
export function messages(e: unknown): string {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    out.push(cur instanceof Error ? cur.message : typeof cur === "string" ? cur : String(cur));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return out.join(" | ");
}

const TRANSIENT = [
  /block header not found/i,
  /\bblock (?:number |hash )?(?:0x[0-9a-f]+ |\d+ )?not found/i,
  /\bheader (?:for block .* )?not found/i,
  /archive (?:root )?.*not (?:found|in)/i,
  /\breorg/i,
  /\bprun(?:ed|ing)\b/i,
  /invalid tx:.*(?:header|archive|anchor)/i,
];

/** A reorg or a lagging node: worth a resync and another try. */
export function isTransientChainError(e: unknown): boolean {
  const m = messages(e);
  return TRANSIENT.some((r) => r.test(m));
}

/** The in-page wallet's store is broken (closed, crashed, or its table gone): reopen the wallet. */
export function isBrokenStoreError(e: unknown): boolean {
  return /SQLITE_ERROR|no such table|SQLite store (?:closed|deleted)|SQLite worker|no database open/i.test(messages(e));
}

export interface RetryOptions {
  /** Tries in all (default 4: the first and three more). */
  attempts?: number;
  /** First wait (ms), doubled after each try (default 2 s: 2, 4, 8 s). */
  baseMs?: number;
  /** Which errors are worth another try (default: reorgs and lagging nodes). */
  retryable?: (e: unknown) => boolean;
  /** Before each new try (after the wait): resync the PXE here. */
  onRetry?: (attempt: number, e: unknown) => Promise<void> | void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `fn`, and again on a retryable error, with waits that double, up to `attempts` tries. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? 4;
  const base = o.baseMs ?? 2_000;
  const retryable = o.retryable ?? isTransientChainError;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= attempts || !retryable(e)) throw e;
      await sleep(base * 2 ** (attempt - 1));
      await o.onRetry?.(attempt + 1, e);
    }
  }
}
