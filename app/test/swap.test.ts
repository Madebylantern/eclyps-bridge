/**
 * Pay with SOL (src/lib/swap.ts). Run with `pnpm --filter @eclyps/app test`. No network: Jupiter's
 * answers are the recorded fixtures in test/fixtures/ (keyless api.jup.ag/swap/v1, 2026-10-13):
 * - jupiter-quote-exactout.json: SOL → exactly $1,310 USDC, ExactOut, 50 bps, maxAccounts 48;
 * - jupiter-swap.json: /swap for that quote, built for a fresh address that never held funds, so
 *   Jupiter's own simulation reports the missing SOL (nothing was signed or sent);
 * - jupiter-quote-error.json: a quote for a mint with no mainnet market.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  checkSwapTransaction,
  DEPOSIT_LAMPORTS,
  explainSwapError,
  fetchQuote,
  fetchSwapTransaction,
  JUPITER_PROGRAM,
  maxInWithSlippage,
  parseQuote,
  parseSwap,
  parseSwapResponse,
  PRIORITY_MAX_LAMPORTS,
  quoteUrl,
  solNeeded,
  solText,
  SwapError,
  swapFor,
  swapRequest,
  TOKEN_ACCOUNT_RENT,
  WSOL_MINT,
} from "../src/lib/swap.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const QUOTE = fixture("jupiter-quote-exactout.json");
const SWAP = fixture("jupiter-swap.json");
const QUOTE_ERROR = fixture("jupiter-quote-error.json");

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NEED = 1_310_000_000n; // $1,310
/** The address jupiter-swap.json was built for. */
const TAKER = "WTmN2BWzYU3ncpkCmZnbeujSf9iXj9P8y215jQMb3ai";
const CFG = parseSwap({ provider: "jupiter", api: "https://api.jup.ag/swap/v1" })!;
const WANT = { usdcMint: USDC, usdc: NEED, slippageBps: 50 };

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("parseSwap", () => {
  it("accepts Jupiter's keyless API with defaults", () => {
    assert.deepEqual(CFG, { provider: "jupiter", api: "https://api.jup.ag/swap/v1", slippageBps: 50, maxAccounts: 48 });
    assert.equal(parseSwap({ provider: "jupiter", api: "https://api.jup.ag/swap/v1/", slippageBps: 100, maxAccounts: 64 })?.api, "https://api.jup.ag/swap/v1");
  });
  it("refuses anything that could carry a key or is not https", () => {
    const base = { provider: "jupiter", api: "https://api.jup.ag/swap/v1" };
    for (const bad of [
      { ...base, api: "http://api.jup.ag/swap/v1" },
      { ...base, api: "https://api.jup.ag/swap/v1?api-key=abc" },
      { ...base, api: "https://user:pass@api.jup.ag/swap/v1" },
      { ...base, api: "https://api.jup.ag/swap/v1#k" },
      { ...base, apiKey: "jup_123" },
      { ...base, "x-api-key": "jup_123" },
      { ...base, token: "abc" },
    ]) {
      assert.equal(parseSwap(bad), undefined, JSON.stringify(bad));
    }
  });
  it("refuses other providers, bad numbers and non-objects", () => {
    const base = { provider: "jupiter", api: "https://api.jup.ag/swap/v1" };
    for (const bad of [
      null,
      undefined,
      [],
      "jupiter",
      { api: base.api },
      { ...base, provider: "other" },
      { ...base, api: "not a url" },
      { ...base, slippageBps: 0 },
      { ...base, slippageBps: 301 },
      { ...base, slippageBps: 12.5 },
      { ...base, slippageBps: "50" },
      { ...base, maxAccounts: 8 },
      { ...base, maxAccounts: 65 },
    ]) {
      assert.equal(parseSwap(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("swapFor", () => {
  const swap = { provider: "jupiter" as const, api: "https://api.jup.ag/swap/v1" };
  const solana = (cluster?: "mainnet" | "devnet" | "localnet") => ({ rpc: "", gateway: "", usdcMint: USDC, config: "", cluster });
  it("offers SOL only on Solana mainnet with a valid swap config", () => {
    assert.deepEqual(swapFor({ solana: solana("mainnet"), swap }), CFG);
    assert.equal(swapFor({ solana: solana("mainnet") }), undefined);
    assert.equal(swapFor({ solana: solana("mainnet"), swap: { ...swap, api: "http://x" } }), undefined);
    assert.equal(swapFor({ solana: solana("devnet"), swap }), undefined);
    assert.equal(swapFor({ solana: solana("localnet"), swap }), undefined);
    assert.equal(swapFor({ solana: solana(), swap }), undefined);
  });
  it("stays hidden on the testnet deployment", () => {
    const testnet = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8"));
    assert.equal(testnet.swap, undefined);
    assert.equal(swapFor(testnet), undefined);
  });
});

describe("amounts", () => {
  it("adds slippage to the SOL in, rounding up", () => {
    assert.equal(maxInWithSlippage(BigInt(QUOTE.inAmount), 50), BigInt(QUOTE.otherAmountThreshold));
    assert.equal(maxInWithSlippage(1_000_000_000n, 50), 1_005_000_000n);
    assert.equal(maxInWithSlippage(1n, 50), 2n);
    assert.equal(maxInWithSlippage(0n, 50), 0n);
  });
  it("keeps SOL for the fees, a USDC account when missing, and the deposits after", () => {
    const fees = 5_000n + PRIORITY_MAX_LAMPORTS + TOKEN_ACCOUNT_RENT;
    assert.equal(solNeeded({ maxIn: 10n, hasUsdcAccount: true, deposits: 0 }), 10n + fees);
    assert.equal(solNeeded({ maxIn: 10n, hasUsdcAccount: false, deposits: 5 }), 10n + fees + TOKEN_ACCOUNT_RENT + 5n * DEPOSIT_LAMPORTS);
  });
  it("writes SOL briefly", () => {
    assert.equal(solText(BigInt(QUOTE.inAmount)), "12.13");
    assert.equal(solText(BigInt(QUOTE.otherAmountThreshold), true), "12.20");
    assert.equal(solText(12_000_000_000n), "12.00");
    assert.equal(solText(92_640_000n), "0.0926");
    assert.equal(solText(450_000n), "0.00045");
    assert.equal(solText(1_213_400_000_000n), "1,213");
    assert.equal(solText(0n), "0");
  });
});

describe("quote", () => {
  it("asks for exactly the USDC needed, paid in SOL", () => {
    const u = new URL(quoteUrl(CFG, USDC, NEED));
    assert.equal(`${u.origin}${u.pathname}`, "https://api.jup.ag/swap/v1/quote");
    assert.deepEqual(Object.fromEntries(u.searchParams), {
      inputMint: WSOL_MINT,
      outputMint: USDC,
      amount: "1310000000",
      swapMode: "ExactOut",
      slippageBps: "50",
      maxAccounts: "48",
      restrictIntermediateTokens: "true",
    });
  });
  it("reads the recorded quote", () => {
    const q = parseQuote(QUOTE, WANT);
    assert.equal(q.usdc, NEED);
    assert.equal(q.inLamports, 12_132_646_728n);
    assert.equal(q.maxInLamports, 12_193_309_962n);
    assert.equal(q.response, QUOTE);
  });
  it("refuses a quote that is not what was asked", () => {
    const cases: [string, unknown, Partial<typeof WANT>?][] = [
      ["this network's USDC", QUOTE, { usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }],
      ["not for SOL", { ...QUOTE, inputMint: USDC }],
      ["not an exact amount", { ...QUOTE, swapMode: "ExactIn" }],
      ["less USDC than needed", QUOTE, { usdc: NEED + 1n }],
      ["other slippage", QUOTE, { slippageBps: 100 }],
      ["the SOL limit is off", { ...QUOTE, otherAmountThreshold: String(BigInt(QUOTE.inAmount) * 2n) }],
      ["the SOL limit is off", { ...QUOTE, otherAmountThreshold: String(BigInt(QUOTE.inAmount) - 1n) }],
      ["missing amounts", { ...QUOTE, inAmount: "12.5" }],
      ["missing amounts", { ...QUOTE, inAmount: "0" }],
      ["no route", { ...QUOTE, routePlan: [] }],
      ["an extra fee", { ...QUOTE, platformFee: { amount: "1000", feeBps: 10 } }],
      ["no quote", null],
    ];
    for (const [why, raw, want] of cases) {
      assert.throws(() => parseQuote(raw, { ...WANT, ...want }), (e: unknown) => e instanceof SwapError && e.message.includes(why), why);
    }
  });
  it("fetches and checks a quote without an API key", async () => {
    let asked: { url: string; init?: RequestInit } | undefined;
    const q = await fetchQuote(CFG, USDC, NEED, async (url, init) => {
      asked = { url, init };
      return response(QUOTE);
    });
    assert.equal(q.inLamports, 12_132_646_728n);
    assert.equal(asked?.url, quoteUrl(CFG, USDC, NEED));
    assert.equal(asked?.init, undefined);
  });
  it("says why there is no price", async () => {
    const said = (f: () => Promise<Response>) => fetchQuote(CFG, USDC, NEED, f).then(() => "", explainSwapError);
    assert.equal(await said(async () => response(QUOTE_ERROR, 400)), "Jupiter found no route for this amount.");
    assert.equal(await said(async () => response({ error: "Too many requests" }, 429)), "Jupiter is busy. Try again in a moment.");
    assert.equal(await said(async () => response({}, 500)), "Jupiter answered 500.");
    assert.equal(await said(async () => new Response("<html>", { status: 200 })), "Jupiter's answer was unreadable.");
    assert.equal(await said(async () => Promise.reject(new TypeError("Failed to fetch"))), "Can't reach Jupiter.");
  });
});

describe("swap transaction", () => {
  const ok = { ...SWAP, simulationError: null };
  const QUOTED = parseQuote(QUOTE, WANT);

  it("asks Jupiter to build the quote for the wallet, with capped priority fees", () => {
    const { url, init } = swapRequest(CFG, QUOTED, TAKER);
    assert.equal(url, "https://api.jup.ag/swap/v1/swap");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("x-api-key"), null);
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.quoteResponse, QUOTE);
    assert.equal(body.userPublicKey, TAKER);
    assert.equal(body.wrapAndUnwrapSol, true);
    assert.equal(body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports, Number(PRIORITY_MAX_LAMPORTS));
  });
  it("refuses a transaction Jupiter's own simulation says would fail", async () => {
    assert.throws(() => parseSwapResponse(SWAP), /Not enough SOL for this swap and its fees\./);
    assert.throws(() => parseSwapResponse({ ...SWAP, simulationError: { errorCode: "TRANSACTION_ERROR", error: "custom program error: 0x1771" } }), /would fail right now/);
    assert.throws(() => parseSwapResponse({ ...ok, swapTransaction: undefined }), /no transaction/);
    await assert.rejects(fetchSwapTransaction(CFG, QUOTED, TAKER, async () => response(SWAP)), /Not enough SOL/);
  });
  it("accepts the recorded transaction for its wallet and quote", async () => {
    const wire = parseSwapResponse(ok);
    assert.ok(wire.length > 0 && wire.length <= 1232);
    assert.deepEqual(await fetchSwapTransaction(CFG, QUOTED, TAKER, async () => response(ok)), wire);
    await checkSwapTransaction(wire, { user: TAKER, maxInLamports: QUOTED.maxInLamports });
  });
  it("refuses it for another wallet, a lower SOL limit, or when unreadable", async () => {
    const wire = parseSwapResponse(ok);
    await assert.rejects(checkSwapTransaction(wire, { user: "11111111111111111111111111111112", maxInLamports: QUOTED.maxInLamports }), /another signer/);
    await assert.rejects(checkSwapTransaction(wire, { user: TAKER, maxInLamports: QUOTED.maxInLamports - 1n }), /more SOL than quoted/);
    await assert.rejects(checkSwapTransaction(new Uint8Array(1233), { user: TAKER, maxInLamports: QUOTED.maxInLamports }), /too large/);
    await assert.rejects(checkSwapTransaction(new Uint8Array([1, 2, 3]), { user: TAKER, maxInLamports: QUOTED.maxInLamports }), /unreadable/);
  });

  // Transactions a tampered answer could carry, signed by the same wallet.
  const tampered = (ixs: Instruction[]) =>
    new Uint8Array(getTransactionEncoder().encode(compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(TAKER as Address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "686KEAoVMap52sGfTxFnUvvM8vU2iaw7N9JxUeSRC7Pd" as never, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ))));
  const swapIx: Instruction = { programAddress: JUPITER_PROGRAM as Address, accounts: [], data: new Uint8Array([1]) };
  const signer = { address: TAKER as Address, role: 3 };
  const thief = "11111111111111111111111111111112" as Address;
  const transfer = (to: Address, lamports: bigint): Instruction => {
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    new DataView(data.buffer).setBigUint64(4, lamports, true);
    return { programAddress: "11111111111111111111111111111111" as Address, accounts: [signer, { address: to, role: 1 }], data };
  };
  const limits = { user: TAKER, maxInLamports: 1_000_000_000n };

  it("refuses SOL sent anywhere but the wallet's own wrapped-SOL account", async () => {
    await assert.rejects(checkSwapTransaction(tampered([transfer(thief, 1n), swapIx]), limits), /SOL sent elsewhere/);
  });
  it("refuses token transfers, unknown programs, high fees, and no swap at all", async () => {
    const tokenTransfer: Instruction = { programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address, accounts: [{ address: thief, role: 1 }, { address: thief, role: 1 }, signer], data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]) };
    await assert.rejects(checkSwapTransaction(tampered([tokenTransfer, swapIx]), limits), /a token transfer/);
    const memo: Instruction = { programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address, data: new Uint8Array([104, 105]) };
    await assert.rejects(checkSwapTransaction(tampered([memo, swapIx]), limits), /an unexpected program/);
    const price = new Uint8Array(9);
    price[0] = 3;
    new DataView(price.buffer).setBigUint64(1, 10_000_000n, true); // µlamports per CU: 0.014 SOL at 1.4M CU, over the cap
    await assert.rejects(checkSwapTransaction(tampered([{ programAddress: "ComputeBudget111111111111111111111111111111" as Address, data: price }, swapIx]), limits), /a high fee/);
    await assert.rejects(checkSwapTransaction(tampered([{ programAddress: "ComputeBudget111111111111111111111111111111" as Address, data: new Uint8Array([2, 0, 0, 0, 0]) }]), limits), /no swap in it/);
  });
});

describe("explainSwapError", () => {
  it("says what happened in one line", () => {
    assert.equal(explainSwapError(new SwapError("Can't reach Jupiter.")), "Can't reach Jupiter.");
    assert.equal(explainSwapError(new Error("User rejected the request.")), "You declined the swap in your wallet. Nothing was sent.");
    assert.equal(explainSwapError(new Error('Transaction failed on chain: {"InstructionError":[6,{"Custom":6001}]}')), "The SOL price moved past the limit. Nothing was swapped; try again.");
    assert.equal(explainSwapError(Object.assign(new Error("Transaction simulation failed"), { context: { logs: ["Program log: Error Code: SlippageToleranceExceeded"] } })), "The SOL price moved past the limit. Nothing was swapped; try again.");
    assert.equal(explainSwapError(new Error("Attempt to debit an account but found no record of a prior credit.")), "Not enough SOL for this swap and its fees.");
    assert.equal(explainSwapError(new Error("Blockhash not found")), "The swap expired before it landed. Nothing was swapped; try again.");
    assert.equal(explainSwapError({ message: '{"InstructionError":[3,"InvalidAccountData"]}' }), 'The swap failed: {"InstructionError":[3,"InvalidAccountData"]}');
    const long = explainSwapError(new Error("x".repeat(400)));
    assert.ok(long.startsWith("The swap failed: ") && long.length < 170);
  });
});
