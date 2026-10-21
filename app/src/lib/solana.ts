/**
 * Solana side of the app: Wallet Standard wallets (Phantom, Solflare, Backpack, …) sign in the
 * browser; on the local stack a pasted dev keypair can be used instead. Transactions are built
 * with @solana/kit and the SDK's gateway client; confirmations are polled (no websockets needed).
 */
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransaction,
} from "@solana/kit";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  blockedPda,
  computeUnitLimitIx,
  configPda,
  crossingPoolPda,
  decodeConfig,
  decodeEpoch,
  decodeExpressEpoch,
  decodeLanes,
  decodeLiquidity,
  DEPOSIT_EXPRESS_COMPUTE_UNITS,
  depositExpressIx,
  depositIx,
  epochPda,
  type EpochAccount,
  expressAsEpoch,
  expressPda,
  isBlockedRecord,
  type LanesAccount,
  lanesPda,
  liquidityPda,
  type LiquidityAccount,
  nextExpressId,
  openEpochIx,
  refundDepositIx,
  toBytes32,
} from "@eclyps/sdk";
import { type Deployment, hostOf } from "./deployment";

export interface SolanaSigner {
  address: Address;
  label: string;
  /** Returns the signed wire transaction (base64). */
  sign(wire: Uint8Array): Promise<string>;
  /**
   * The wallet's ed25519 signature (64 bytes) over `message`, for "Use my wallet instead" (ADR
   * 0016, amended); absent when the wallet cannot sign messages.
   */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

/** The 32 bytes of a Solana address (its ed25519 public key), to check a signature against. */
export const addressBytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));

export const rpcFor = (dep: Deployment) => createSolanaRpc(dep.solana.rpc);

/** Wallet Standard wallets that can sign Solana transactions. */
export function standardWallets(): Wallet[] {
  return getWallets()
    .get()
    .filter((w) => "standard:connect" in w.features && "solana:signTransaction" in w.features);
}

export async function connectStandardWallet(w: Wallet, chain: string): Promise<SolanaSigner> {
  const connect = w.features["standard:connect"] as { connect(): Promise<{ accounts: readonly WalletAccount[] }> };
  const { accounts } = await connect.connect();
  const account = accounts[0];
  if (!account) throw new Error(`${w.name}: no account`);
  const feature = w.features["solana:signTransaction"] as {
    signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]>;
  };
  const messages = w.features["solana:signMessage"] as
    | { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array }[]> }
    | undefined;
  return {
    address: address(account.address),
    label: w.name,
    async sign(wire) {
      const [out] = await feature.signTransaction({ account, transaction: wire, chain });
      return btoa(String.fromCharCode(...out!.signedTransaction));
    },
    ...(messages && {
      async signMessage(message: Uint8Array) {
        const [out] = await messages.signMessage({ account, message });
        return new Uint8Array(out!.signature);
      },
    }),
  };
}

/** Local stack only: a pasted 64-byte keypair (JSON array), e.g. scripts/e2e/.local/user.json. */
export async function devKeypairSigner(json: string): Promise<SolanaSigner> {
  const kp = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(json)));
  return {
    address: kp.address,
    label: "Dev keypair (test networks)",
    async sign(wire) {
      const tx = getTransactionDecoder().decode(wire) as ReturnType<typeof compileTransaction>;
      return getBase64EncodedWireTransaction(await signTransaction([kp.keyPair], tx));
    },
    async signMessage(message) {
      return new Uint8Array(await signBytes(kp.keyPair.privateKey, message));
    },
  };
}

export async function sendWith(dep: Deployment, signer: SolanaSigner, ixs: Instruction[]): Promise<string> {
  const rpc = rpcFor(dep);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(signer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return signAndSend(dep, signer, new Uint8Array(getTransactionEncoder().encode(compileTransaction(msg))));
}

/**
 * Signs a wire transaction with the wallet (or the dev keypair), sends it and waits until it is
 * `finality` (default confirmed). `explain` turns failures into plain words; deposits and refunds
 * use the gateway's errors, the SOL swap its own. A transaction built elsewhere (the swap) is
 * preflighted against confirmed state, where its blockhash is known.
 */
export async function signAndSend(
  dep: Deployment,
  signer: SolanaSigner,
  wire: Uint8Array,
  opts: { explain?: (e: unknown) => string | undefined; finality?: "confirmed" | "finalized"; preflight?: "confirmed" } = {},
): Promise<string> {
  const rpc = rpcFor(dep);
  const explain = opts.explain ?? explainTxError;
  let sig: Awaited<ReturnType<ReturnType<typeof rpc.sendTransaction>["send"]>>;
  try {
    const signed = await signer.sign(wire);
    sig = await rpc.sendTransaction(signed as never, { encoding: "base64", ...(opts.preflight && { preflightCommitment: opts.preflight }) }).send();
  } catch (e) {
    const plain = explain(e);
    throw plain ? new Error(plain, { cause: e }) : e;
  }
  const done = opts.finality === "finalized" ? ["finalized"] : ["confirmed", "finalized"];
  for (let i = 0; i < (opts.finality === "finalized" ? 180 : 120); i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) {
      const raw = JSON.stringify(st.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      throw new Error(explain({ message: raw }) ?? `Transaction failed on chain: ${raw}`);
    }
    if (st?.confirmationStatus && done.includes(st.confirmationStatus)) return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${sig}`);
}

export async function accountBytes(dep: Deployment, a: Address): Promise<Uint8Array | undefined> {
  const { value } = await rpcFor(dep).getAccountInfo(a, { encoding: "base64" }).send();
  return value ? Uint8Array.from(atob(value.data[0]), (c) => c.charCodeAt(0)) : undefined;
}

/** The one line the app shows when the connected wallet is on the gateway's screening list (ADR 0019). */
export const SCREENED = "This wallet is on a sanctions or stolen-funds list, so it can't deposit.";

/** Whether the gateway refuses deposits from `wallet` (its screening record exists, ADR 0019). */
export async function walletScreened(dep: Deployment, wallet: Address): Promise<boolean> {
  return isBlockedRecord(await accountBytes(dep, await blockedPda(wallet)));
}

export async function readConfig(dep: Deployment) {
  const raw = await accountBytes(dep, await configPda());
  if (!raw) throw new Error(`No Eclyps gateway at ${hostOf(dep.solana.rpc)}: the RPC answered, but the gateway config account does not exist there. Check that deployment.json names the right network.`);
  return decodeConfig(raw);
}

/**
 * Gateway program errors a user can hit, by Anchor name (found in preflight logs) with the custom
 * error number as a fallback (programs/gateway/src/error.rs order; ConstraintTokenOwner is Anchor's).
 */
const PROGRAM_ERRORS: { name: string; code: number; message: string }[] = [
  { name: "NotRefundable", code: 6022, message: "This deposit can't be taken back yet: its epoch has to stay open for about 24 hours and roll over at least once. The note shows when that is." },
  { name: "LeafNotFound", code: 6023, message: "The gateway found no deposit of this note by the connected wallet in that epoch. Connect the wallet that made the deposit." },
  { name: "ConstraintTokenOwner", code: 2015, message: "The refund has to go to a USDC account owned by the wallet that deposited. Connect that wallet and try again." },
  { name: "DuplicateLeaf", code: 6020, message: "This note is already in that epoch, so it was not deposited again. Nothing was charged." },
  { name: "DepositsPaused", code: 6005, message: "Deposits are paused by the guardian right now. Claims and refunds still work; try the deposit later." },
  { name: "EpochFull", code: 6008, message: "That epoch filled up just before your deposit. Try again: the next epoch opens right away." },
  { name: "DepositCapReached", code: 6027, message: "The gateway's deposit cap is reached. Nothing was deposited." },
  { name: "DepositorBlocked", code: 6051, message: `${SCREENED} Nothing was deposited.` },
];

function errorText(e: unknown): string {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth = 0): string => {
    if (x === null || x === undefined || depth > 4 || seen.has(x)) return "";
    if (typeof x !== "object") return String(x);
    seen.add(x);
    const o = x as { message?: unknown; context?: unknown; cause?: unknown };
    let ctx = "";
    try {
      ctx = JSON.stringify(o.context ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      // context not serialisable
    }
    return [o.message, ctx, walk(o.cause, depth + 1)].filter(Boolean).join(" ");
  };
  return walk(e);
}

/** A failed Solana transaction in plain words, or undefined when it is not a known program error. */
export function explainTxError(e: unknown): string | undefined {
  const text = errorText(e);
  for (const p of PROGRAM_ERRORS) if (text.includes(p.name)) return p.message;
  for (const p of PROGRAM_ERRORS) if (new RegExp(`"Custom"\\s*:\\s*${p.code}\\b|custom program error: 0x${p.code.toString(16)}\\b`).test(text)) return p.message;
  if (/User rejected|rejected the request|declined/i.test(text)) return "You declined the signature in your wallet. Nothing was sent.";
  if (/insufficient (funds|lamports)|custom program error: 0x1\b/i.test(text)) return "The wallet doesn't have enough SOL for the fee, or enough USDC for the note and its fee. Top it up and try again.";
  return undefined;
}

/** Turns an RPC failure into something a user can act on. */
export function describeChainError(e: unknown, dep: Deployment): { kind: "unreachable" | "no-gateway" | "other"; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("No Eclyps gateway")) return { kind: "no-gateway", message: msg };
  if (/fetch|network|ECONNREFUSED|ENOTFOUND|HTTP error|timed? ?out|Load failed|CORS/i.test(msg)) {
    return { kind: "unreachable", message: `Can't reach the Solana RPC at ${hostOf(dep.solana.rpc)}.` };
  }
  return { kind: "other", message: msg };
}

export async function readEpoch(dep: Deployment, idx: number, id: bigint): Promise<EpochAccount | undefined> {
  const raw = await accountBytes(dep, await epochPda(idx, id));
  return raw ? decodeEpoch(raw) : undefined;
}

/** Reads many epoch accounts in batches of 100 (one RPC call per batch). */
export async function readEpochs(dep: Deployment, keys: { idx: number; id: bigint }[]): Promise<(EpochAccount | undefined)[]> {
  const out: (EpochAccount | undefined)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const addrs = await Promise.all(chunk.map((k) => epochPda(k.idx, k.id)));
    const { value } = await rpcFor(dep).getMultipleAccounts(addrs, { encoding: "base64" }).send();
    for (const acc of value) {
      out.push(acc ? decodeEpoch(Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0))) : undefined);
    }
  }
  return out;
}

export async function currentSlot(dep: Deployment): Promise<bigint> {
  return BigInt(await rpcFor(dep).getSlot().send());
}

/** The wallet's SOL, in lamports. */
export async function solBalanceOf(dep: Deployment, owner: Address): Promise<bigint> {
  return BigInt((await rpcFor(dep).getBalance(owner).send()).value);
}

export async function usdcAccountOf(dep: Deployment, owner: Address): Promise<{ address: Address; amount: bigint } | undefined> {
  const { value } = await rpcFor(dep)
    .getTokenAccountsByOwner(owner, { mint: address(dep.solana.usdcMint) }, { encoding: "jsonParsed" })
    .send();
  const a = value[0];
  if (!a) return undefined;
  const parsed = a.account.data as unknown as { parsed: { info: { tokenAmount: { amount: string } } } };
  return { address: a.pubkey, amount: BigInt(parsed.parsed.info.tokenAmount.amount) };
}

/**
 * Returns a deposit that could not cross (ADR 0010). Signed by the wallet that deposited; pays to
 * `destination`, a USDC token account that wallet owns.
 */
export async function refundNote(
  dep: Deployment,
  signer: SolanaSigner,
  destination: Address,
  denominationIndex: number,
  epochId: bigint,
  commitment: bigint,
): Promise<string> {
  return sendWith(dep, signer, [
    await refundDepositIx({
      authority: signer.address,
      destination,
      usdcMint: address(dep.solana.usdcMint),
      denominationIndex,
      currentEpochId: epochId,
      commitment: toBytes32(commitment),
    }),
  ]);
}

/**
 * The V2 lanes (ADR 0015, 0017), public: the express fee and what the crossing pool holds, and
 * the liquidity pool that funds fast exits. Undefined while the gateway has no V2 lanes.
 */
export interface LanesView {
  lanes: LanesAccount;
  /** USDC in the crossing pool: Cross now is "on us" while it holds one express fee. */
  crossingPool: bigint;
  liquidity?: LiquidityAccount;
}

export async function readLanesView(dep: Deployment): Promise<LanesView | undefined> {
  const [lanesAddr, poolAddr, liqAddr] = await Promise.all([lanesPda(), crossingPoolPda(), liquidityPda()]);
  const { value } = await rpcFor(dep).getMultipleAccounts([lanesAddr, poolAddr, liqAddr], { encoding: "base64" }).send();
  const bytes = (i: number) => (value[i] ? Uint8Array.from(atob(value[i]!.data[0]), (c) => c.charCodeAt(0)) : undefined);
  const lanesRaw = bytes(0);
  if (!lanesRaw) return undefined;
  const pool = bytes(1);
  // An SPL token account: the amount is the u64 at byte 64.
  const crossingPool = pool && pool.length >= 72 ? new DataView(pool.buffer, pool.byteOffset).getBigUint64(64, true) : 0n;
  const liq = bytes(2);
  return { lanes: decodeLanes(lanesRaw), crossingPool, liquidity: liq ? decodeLiquidity(liq) : undefined };
}

/** Reads express epoch accounts (as batches of one) in batches of 100. */
export async function readExpressEpochs(dep: Deployment, keys: { idx: number; id: bigint }[]): Promise<(EpochAccount | undefined)[]> {
  const out: (EpochAccount | undefined)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const addrs = await Promise.all(chunk.map((k) => expressPda(k.idx, k.id)));
    const { value } = await rpcFor(dep).getMultipleAccounts(addrs, { encoding: "base64" }).send();
    for (const acc of value) {
      out.push(acc ? expressAsEpoch(decodeExpressEpoch(Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0)))) : undefined);
    }
  }
  return out;
}

/**
 * Cross now (ADR 0015): deposits one note in its own express epoch, closed at once. The express
 * fee comes from the crossing pool while it can pay; otherwise from the wallet, never more than
 * `maxExpressFee` (0: only if it is on us). Returns (signature, express id).
 */
export async function depositExpressNote(
  dep: Deployment,
  signer: SolanaSigner,
  source: Address,
  denominationIndex: number,
  commitment: bigint,
  maxExpressFee: bigint,
): Promise<{ sig: string; expressId: bigint }> {
  // The id is the Lanes counter at execution; someone crossing at the same moment takes it first,
  // and the transaction then fails without moving anything: read again and retry once.
  for (let attempt = 0; ; attempt++) {
    const v = await readLanesView(dep);
    if (!v) throw new Error("Cross now is not on this gateway yet.");
    const expressId = nextExpressId(v.lanes, denominationIndex);
    try {
      const sig = await sendWith(dep, signer, [
        computeUnitLimitIx(DEPOSIT_EXPRESS_COMPUTE_UNITS),
        await depositExpressIx({
          payer: signer.address, authority: signer.address, source, usdcMint: address(dep.solana.usdcMint),
          denominationIndex, expressId, commitment: toBytes32(commitment), maxExpressFee,
        }),
      ]);
      return { sig, expressId };
    } catch (e) {
      if (attempt >= 1 || !/ConstraintSeeds|2006|already in use/.test(String(e))) throw e;
    }
  }
}

/** Deposits one note into the current epoch of `denominationIndex`; returns (signature, epochId). */
export async function depositNote(
  dep: Deployment,
  signer: SolanaSigner,
  source: Address,
  denominationIndex: number,
  commitment: bigint,
): Promise<{ sig: string; epochId: bigint }> {
  const epochId = (await readConfig(dep)).currentEpoch[denominationIndex]!;
  const sig = await sendWith(dep, signer, [
    await openEpochIx(signer.address, denominationIndex, epochId),
    await depositIx({
      payer: signer.address,
      authority: signer.address,
      source,
      usdcMint: address(dep.solana.usdcMint),
      denominationIndex,
      currentEpochId: epochId,
      commitment: toBytes32(commitment),
    }),
  ]);
  return { sig, epochId };
}
