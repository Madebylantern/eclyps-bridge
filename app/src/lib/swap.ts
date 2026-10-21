/**
 * Pay with SOL (ADR 0011): any coin in, one crowd inside. SOL is swapped to exactly the USDC a
 * plan needs, in one transaction the user signs, and then the plan proceeds as it does with USDC.
 * This file holds the pure parts: the deployment's `swap` config, request URLs and bodies, quote
 * validation, amounts in base units, and the checks a returned transaction must pass before
 * anything is signed. The two network calls take `fetch` as a parameter, so tests run on recorded
 * fixtures (test/fixtures/jupiter-*.json) without the network.
 *
 * Jupiter's keyless Metis Swap API (v1) on api.jup.ag, 0.5 requests a second per caller:
 *   GET  {api}/quote?swapMode=ExactOut&…   the SOL needed for an exact USDC amount
 *   POST {api}/swap                         that quote as a versioned transaction for the wallet
 * Swap API v2 (/order, /build) only does ExactIn, so it cannot ask for an exact USDC total. No API
 * key is ever sent or shipped (SPEC §1.2.5). Jupiter sees the wallet, the amount and the IP.
 *
 * Only `import type` from local files, so `node --test` runs this file as it is.
 */
import {
  type Address,
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from "@solana/kit";
import type { Deployment } from "./deployment";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const BPS = 10_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** The most the swap may pay in priority fees: sent to Jupiter, and checked in its transaction. */
export const PRIORITY_MAX_LAMPORTS = 500_000n;
/** One signature. */
const BASE_FEE_LAMPORTS = 5_000n;
/** Rent for a token account: the swap's temporary wrapped-SOL account (returned in the same
 * transaction) and, when the wallet has none, its USDC account. */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;
/** Each deposit's Solana fee and the rent for the 64 bytes it adds to its epoch (ADR 0010). */
export const DEPOSIT_LAMPORTS = 450_000n;
/** Solana's packet limit for one transaction. */
const MAX_TX_BYTES = 1232;
/** Waits this long after the amount stops changing before asking for a price (keyless: 0.5/s). */
export const QUOTE_DEBOUNCE_MS = 700;

/** A failure said in one short line, safe to show as it is. */
export class SwapError extends Error {
  name = "SwapError";
}

// ---------------------------------------------------------------- configuration

export interface SwapConfig {
  provider: "jupiter";
  /** Base URL without a trailing slash. */
  api: string;
  slippageBps: number;
  maxAccounts: number;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validates `deployment.swap`. Anything unexpected returns undefined and the SOL choice stays
 * hidden: another provider, a URL that is not https, a URL carrying credentials, a query or a
 * fragment (where a key could hide), a field that looks like a secret, slippage outside 0.01–3 %
 * or a route size outside 16–64 accounts.
 */
export function parseSwap(raw: unknown): SwapConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (c.provider !== "jupiter" || typeof c.api !== "string") return undefined;
  if (Object.keys(c).some((k) => /key|secret|token|auth|jwt|pass/i.test(k))) return undefined;
  let u: URL;
  try {
    u = new URL(c.api);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return undefined;
  const slippageBps = c.slippageBps ?? 50;
  const maxAccounts = c.maxAccounts ?? 48;
  if (!isInt(slippageBps, 1, 300) || !isInt(maxAccounts, 16, 64)) return undefined;
  return { provider: "jupiter", api: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, slippageBps, maxAccounts };
}

/** The swap config when paying with SOL is offered: configured, valid, and on Solana mainnet only
 * (Jupiter routes mainnet liquidity). Local and devnet deployments never show it. */
export function swapFor(dep: Pick<Deployment, "solana" | "swap">): SwapConfig | undefined {
  return dep.solana.cluster === "mainnet" ? parseSwap(dep.swap) : undefined;
}

// ---------------------------------------------------------------- amounts

/** ExactOut: the most SOL the swap may take, `inAmount` plus slippage, rounded up. */
export function maxInWithSlippage(inAmount: bigint, slippageBps: number): bigint {
  return (inAmount * (BPS + BigInt(slippageBps)) + BPS - 1n) / BPS;
}

/**
 * Lamports the wallet needs before signing: the most the swap may take, its fees (one signature,
 * the priority fee cap, the temporary wrapped-SOL account's rent, a USDC account if there is none)
 * and the deposits that follow.
 */
export function solNeeded(o: { maxIn: bigint; hasUsdcAccount: boolean; deposits: number }): bigint {
  return o.maxIn + BASE_FEE_LAMPORTS + PRIORITY_MAX_LAMPORTS + TOKEN_ACCOUNT_RENT + (o.hasUsdcAccount ? 0n : TOKEN_ACCOUNT_RENT) + BigInt(o.deposits) * DEPOSIT_LAMPORTS;
}

/** "12.13", "0.0926", "1,213". `up` rounds up (for limits), otherwise to the nearest. */
export function solText(lamports: bigint, up = false): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const digits = whole >= 1000n ? 0 : whole >= 1n ? 2 : lamports >= 10_000_000n ? 4 : 6;
  const unit = 10n ** BigInt(9 - digits);
  const n = up ? (lamports + unit - 1n) / unit : (lamports + unit / 2n) / unit;
  const scale = 10n ** BigInt(digits);
  let frac = digits ? `.${(n % scale).toString().padStart(digits, "0")}` : "";
  // Below one SOL, trailing zeros carry nothing ("0.0926", not "0.092600").
  if (digits > 2) frac = frac.replace(/0+$/, "").replace(/\.$/, "");
  return `${(n / scale).toLocaleString("en-US")}${frac}`;
}

// ---------------------------------------------------------------- quote

export function quoteUrl(cfg: SwapConfig, usdcMint: string, usdc: bigint): string {
  const q = new URLSearchParams({
    inputMint: WSOL_MINT,
    outputMint: usdcMint,
    amount: usdc.toString(),
    swapMode: "ExactOut",
    slippageBps: String(cfg.slippageBps),
    // Keeps the route small enough for one transaction with its setup (wrap SOL, a USDC account).
    maxAccounts: String(cfg.maxAccounts),
    restrictIntermediateTokens: "true",
  });
  return `${cfg.api}/quote?${q}`;
}

export interface SwapQuote {
  /** USDC out, exactly (ExactOut), in base units. */
  usdc: bigint;
  /** SOL the route expects to take. */
  inLamports: bigint;
  /** The most it may take, after slippage: the transaction fails rather than take more. */
  maxInLamports: bigint;
  slippageBps: number;
  /** As Jupiter sent it: /swap takes it back verbatim. */
  response: Record<string, unknown>;
}

const uint = (v: unknown): bigint | undefined => (typeof v === "string" && /^\d{1,20}$/.test(v) ? BigInt(v) : undefined);

/**
 * Checks Jupiter's quote against what was asked: SOL in, this deployment's USDC out, ExactOut,
 * at least the USDC needed, the slippage asked for, and a SOL limit that matches it.
 */
export function parseQuote(raw: unknown, want: { usdcMint: string; usdc: bigint; slippageBps: number }): SwapQuote {
  const bad = (why: string) => new SwapError(`Jupiter's price didn't check out: ${why}.`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("no quote");
  const q = raw as Record<string, unknown>;
  if (q.inputMint !== WSOL_MINT) throw bad("it is not for SOL");
  if (q.outputMint !== want.usdcMint) throw bad("it is not this network's USDC");
  if (q.swapMode !== "ExactOut") throw bad("not an exact amount");
  const inLamports = uint(q.inAmount);
  const out = uint(q.outAmount);
  const limit = uint(q.otherAmountThreshold);
  if (inLamports === undefined || out === undefined || limit === undefined || inLamports === 0n) throw bad("missing amounts");
  if (out < want.usdc) throw bad("less USDC than needed");
  if (q.slippageBps !== want.slippageBps) throw bad("other slippage");
  if (limit < inLamports || limit > maxInWithSlippage(inLamports, want.slippageBps)) throw bad("the SOL limit is off");
  if (!Array.isArray(q.routePlan) || q.routePlan.length === 0) throw bad("no route");
  const fee = q.platformFee as { amount?: unknown } | null | undefined;
  if (fee && uint(fee.amount) !== 0n) throw bad("an extra fee");
  return { usdc: out, inLamports, maxInLamports: limit, slippageBps: want.slippageBps, response: q };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const globalFetch: Fetch = (url, init) => fetch(url, init);

async function jupiter(fetchFn: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  let r: Response;
  try {
    r = await fetchFn(url, init);
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new SwapError("Can't reach Jupiter.", { cause: e });
  }
  if (r.status === 429) throw new SwapError("Jupiter is busy. Try again in a moment.");
  if (!r.ok) {
    const body = (await r.json().catch(() => undefined)) as { errorCode?: unknown } | undefined;
    const code = typeof body?.errorCode === "string" ? body.errorCode : "";
    if (/ROUTE|NOT_TRADABLE|LIQUIDITY/.test(code)) throw new SwapError("Jupiter found no route for this amount.");
    throw new SwapError(`Jupiter answered ${r.status}${code ? ` (${code})` : ""}.`);
  }
  return r.json().catch(() => {
    throw new SwapError("Jupiter's answer was unreadable.");
  });
}

/** Asks Jupiter how much SOL buys exactly `usdc`, and checks the answer. */
export async function fetchQuote(cfg: SwapConfig, usdcMint: string, usdc: bigint, fetchFn: Fetch = globalFetch): Promise<SwapQuote> {
  return parseQuote(await jupiter(fetchFn, quoteUrl(cfg, usdcMint, usdc)), { usdcMint, usdc, slippageBps: cfg.slippageBps });
}

// ---------------------------------------------------------------- swap transaction

export function swapRequest(cfg: SwapConfig, quote: SwapQuote, user: string): { url: string; init: RequestInit } {
  return {
    url: `${cfg.api}/swap`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote.response,
        userPublicKey: user,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Number(PRIORITY_MAX_LAMPORTS), priorityLevel: "high" } },
      }),
    },
  };
}

/** Jupiter's /swap answer: the unsigned transaction, refused when its own simulation failed. */
export function parseSwapResponse(raw: unknown): Uint8Array {
  if (!raw || typeof raw !== "object") throw new SwapError("Jupiter sent no transaction.");
  const r = raw as { swapTransaction?: unknown; simulationError?: { error?: unknown } | null };
  if (r.simulationError) {
    const why = String(r.simulationError.error ?? "");
    throw new SwapError(/no record of a prior credit|insufficient/i.test(why) ? "Not enough SOL for this swap and its fees." : "The swap would fail right now. Nothing was signed.");
  }
  if (typeof r.swapTransaction !== "string" || !r.swapTransaction) throw new SwapError("Jupiter sent no transaction.");
  try {
    return new Uint8Array(getBase64Encoder().encode(r.swapTransaction));
  } catch {
    throw new SwapError("Jupiter sent no transaction.");
  }
}

/** Gets the transaction for a quote, for `user` to sign. */
export async function fetchSwapTransaction(cfg: SwapConfig, quote: SwapQuote, user: string, fetchFn: Fetch = globalFetch): Promise<Uint8Array> {
  const { url, init } = swapRequest(cfg, quote, user);
  return parseSwapResponse(await jupiter(fetchFn, url, init));
}

async function associatedTokenAccount(owner: string, mint: string): Promise<string> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM as Address,
    seeds: [enc.encode(owner as Address), enc.encode(TOKEN_PROGRAM as Address), enc.encode(mint as Address)],
  });
  return pda;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u32 = (d: Uint8Array, at: number) => (d.length >= at + 4 ? view(d).getUint32(at, true) : undefined);
const u64 = (d: Uint8Array, at: number) => (d.length >= at + 8 ? view(d).getBigUint64(at, true) : undefined);

/**
 * Checks Jupiter's transaction before the wallet signs it, so a wrong or tampered answer is
 * refused even when a dev keypair signs without a wallet preview:
 * - it fits in one packet, the user is the only signer and pays the fee;
 * - it calls only compute budget, System, token, associated token account and Jupiter programs;
 * - SOL moves at the top level only into the user's own wrapped-SOL account, at most `maxIn`;
 * - token instructions at the top level only sync wrapped SOL or close an account to the user;
 * - the priority fee stays under its cap.
 * What Jupiter's own instruction does inside the route is enforced on chain by its program; the
 * USDC that arrives is checked after the transaction lands.
 */
export async function checkSwapTransaction(wire: Uint8Array, o: { user: string; maxInLamports: bigint }): Promise<void> {
  const refuse = (why: string) => new SwapError(`Refused Jupiter's transaction: ${why}. Nothing was signed.`);
  if (wire.length > MAX_TX_BYTES) throw refuse("too large");
  let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    tx = getTransactionDecoder().decode(wire);
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    throw refuse("unreadable");
  }
  // Jupiter's v1 API builds v0 transactions; any other layout is refused rather than half-read.
  if (!("instructions" in msg)) throw refuse("an unexpected format");
  const signers = Object.keys(tx.signatures);
  if (signers.length !== 1 || signers[0] !== o.user || msg.staticAccounts[0] !== o.user || msg.header.numSignerAccounts !== 1) throw refuse("another signer");

  const wsol = await associatedTokenAccount(o.user, WSOL_MINT);
  const key = (i: number | undefined) => (i === undefined ? undefined : msg.staticAccounts[i]);
  let sent = 0n;
  let jupiter = false;
  let cuLimit: number | undefined;
  let cuPrice: bigint | undefined;
  for (const ix of msg.instructions) {
    const program = key(ix.programAddressIndex);
    const data = new Uint8Array(ix.data ?? []);
    const acc = ix.accountIndices ?? [];
    switch (program) {
      case JUPITER_PROGRAM:
        jupiter = true;
        break;
      case ATA_PROGRAM:
        break; // creates the user's own token accounts; only the user signs and pays
      case COMPUTE_BUDGET_PROGRAM:
        if (data[0] === 2) cuLimit = u32(data, 1);
        else if (data[0] === 3) cuPrice = u64(data, 1);
        else if (data[0] !== 1 && data[0] !== 4) throw refuse("an unknown fee setting");
        break;
      case SYSTEM_PROGRAM: {
        const lamports = u64(data, 4);
        if (u32(data, 0) !== 2 || lamports === undefined || key(acc[0]) !== o.user || key(acc[1]) !== wsol) throw refuse("SOL sent elsewhere");
        sent += lamports;
        break;
      }
      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM:
        if (data[0] === 17) break; // SyncNative
        if (data[0] === 9 && key(acc[1]) === o.user && key(acc[2]) === o.user) break; // CloseAccount to the user
        throw refuse("a token transfer");
      default:
        throw refuse("an unexpected program");
    }
  }
  if (!jupiter) throw refuse("no swap in it");
  if (sent > o.maxInLamports) throw refuse("more SOL than quoted");
  if (cuPrice !== undefined && (cuPrice * BigInt(cuLimit ?? 1_400_000) + 999_999n) / 1_000_000n > PRIORITY_MAX_LAMPORTS) throw refuse("a high fee");
}

// ---------------------------------------------------------------- words

/** A failed quote, build or swap in one short line. */
export function explainSwapError(e: unknown): string {
  if (e instanceof SwapError) return e.message;
  const parts: string[] = [];
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    const o = x as { message?: unknown; context?: unknown };
    parts.push(typeof x === "object" ? String(o.message ?? "") : String(x));
    try {
      if (typeof x === "object" && o.context) parts.push(JSON.stringify(o.context, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    } catch {
      // context not serialisable
    }
  }
  const text = parts.join(" ");
  if (/User rejected|rejected the request|declined/i.test(text)) return "You declined the swap in your wallet. Nothing was sent.";
  if (/SlippageToleranceExceeded|ExactOutAmountNotMatched|0x1771\b|0x1781\b|"Custom"\s*:\s*60(01|17)\b/.test(text)) return "The SOL price moved past the limit. Nothing was swapped; try again.";
  if (/insufficient (funds|lamports)|no record of a prior credit/i.test(text)) return "Not enough SOL for this swap and its fees.";
  if (/blockhash not found|block height exceeded|expired/i.test(text)) return "The swap expired before it landed. Nothing was swapped; try again.";
  const m = String((e as { message?: unknown } | null)?.message ?? e).trim();
  return `The swap failed: ${m.length > 140 ? `${m.slice(0, 139)}…` : m}`;
}
