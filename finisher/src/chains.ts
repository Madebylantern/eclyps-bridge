/**
 * Public-network helpers shared by the testnet finisher (src/testnet.ts) and the testnet run
 * (scripts/testnet/run.ts): Solana transactions that survive an expired blockhash, the portal
 * and Inbox ABIs, Circle's Iris API, and an Aztec wallet whose fees the SponsoredFPC pays (testnet)
 * or, on mainnet, its own Fee Juice (ADR 0018).
 * Nothing here prints a key.
 */
import { readFileSync } from "node:fs";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import type { OperatorFeeMode } from "@eclyps/sdk";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { type Hex, type Log, parseAbi, parseAbiItem, parseEventLogs } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import {
  associatedTokenAddress,
  CCTP,
  computeUnitLimitIx,
  createAssociatedTokenIdempotentIx,
  sendBatchIx,
  sendExpressBatchIx,
} from "@eclyps/sdk";
import { type IrisReply, readIris } from "./plan.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- keys ----------------

/** A Solana keypair file (64-byte JSON array, as `solana-keygen` writes it). */
export async function loadSolanaKeypair(path: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A Solana secret key from an env value: a JSON array of 64 bytes, or base58 (64 bytes, as Phantom exports). */
export async function solanaKeypairFromString(value: string): Promise<KeyPairSigner> {
  const v = value.trim();
  let bytes: number[];
  if (v.startsWith("[")) bytes = JSON.parse(v);
  else {
    let n = 0n;
    for (const c of v) {
      const i = B58.indexOf(c);
      if (i < 0) throw new Error("the Solana key is neither a JSON array nor base58");
      n = n * 58n + BigInt(i);
    }
    bytes = [];
    for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
    const zeros = v.length - v.replace(/^1+/, "").length;
    bytes = [...Array(zeros).fill(0), ...bytes];
  }
  if (bytes.length !== 64) throw new Error(`the Solana key must be 64 bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}

/** An Ethereum private key from an env value (0x prefix optional). */
export function sepoliaAccountFromString(value: string): PrivateKeyAccount {
  const k = value.trim();
  const key = k.startsWith("0x") ? k : `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the Ethereum key is not 32 bytes of hex");
  return privateKeyToAccount(key as Hex);
}

/** A file holding one 0x-prefixed Ethereum private key. */
export function loadSepoliaAccount(path: string): PrivateKeyAccount {
  const key = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} does not hold a 0x-prefixed private key`);
  return privateKeyToAccount(key as Hex);
}

// ---------------- Solana ----------------

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

export function solanaClient(url: string, log: (s: string) => void = () => {}) {
  const rpc = createSolanaRpc(url);

  /**
   * Signs and sends; re-signs with a fresh blockhash if it expires (up to 4 times). `tables` are
   * address lookup tables (address -> its addresses) the v0 message may use (receive_exit needs one).
   */
  async function send(ixs: Instruction[], signers: CryptoKeyPair[], feePayer: Address, tables?: Record<Address, Address[]>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const plain = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      );
      const msg = tables ? compressTransactionMessageUsingAddressLookupTables(plain, tables) : plain;
      const signed = await signTransaction(signers, compileTransaction(msg));
      const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
      for (let i = 0; i < 180; i++) {
        // The transaction is out: a failed poll (devnet's public RPC answers 429 under load) only
        // waits longer, it never sends again before the blockhash has expired.
        const st = await rpc.getSignatureStatuses([sig]).send().then((r) => r.value[0], () => undefined);
        if (st?.err) {
          const tx = await rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, encoding: "json" }).send();
          throw new Error(`Solana tx ${sig} failed: ${JSON.stringify(st.err)}\n${tx?.meta?.logMessages?.join("\n")}`);
        }
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
        const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send().catch(() => 0n);
        if (height > blockhash.lastValidBlockHeight) break; // expired: re-sign with a fresh blockhash
        await sleep(500);
      }
      // Expired: unless it landed after all (a missed poll), sign again with a fresh blockhash.
      const late = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send().then((r) => r.value[0], () => undefined);
      if (late && !late.err && late.confirmationStatus !== "processed") return sig;
      if (attempt >= 3) throw new Error("Solana tx expired 4 times");
      log("solana tx expired; retrying");
    }
  }

  async function accountData(a: Address): Promise<Uint8Array | undefined> {
    const { value } = await rpc.getAccountInfo(a, { encoding: "base64", commitment: "confirmed" }).send();
    return value ? new Uint8Array(Buffer.from(value.data[0], "base64")) : undefined;
  }

  return { rpc, send, accountData };
}

/**
 * send_batch for a closed epoch: the CCTP burn carrying the batch hook. The finisher's share of
 * the fees goes to the payer's USDC account, created here if missing (ADR 0012); `event` is the
 * fresh MessageSent account, which must sign too.
 */
export async function sendBatchTx(a: {
  payer: Address;
  usdcMint: Address;
  treasury: Address;
  denominationIndex: number;
  epochId: bigint;
}) {
  const event = await generateKeyPairSigner();
  const finisherUsdc = await associatedTokenAddress(a.payer, a.usdcMint);
  const ixs = [
    computeUnitLimitIx(400_000),
    await createAssociatedTokenIdempotentIx(a.payer, a.payer, a.usdcMint),
    await sendBatchIx({
      payer: a.payer, usdcMint: a.usdcMint, messageSentEventData: event.address,
      denominationIndex: a.denominationIndex, epochId: a.epochId, finisherUsdc, treasury: a.treasury,
    }),
  ];
  return { ixs, event, finisherUsdc };
}

/** send_express_batch (ADR 0015): the same transaction shape for an express epoch. */
export async function sendExpressBatchTx(a: {
  payer: Address;
  usdcMint: Address;
  treasury: Address;
  denominationIndex: number;
  expressId: bigint;
}) {
  const event = await generateKeyPairSigner();
  const finisherUsdc = await associatedTokenAddress(a.payer, a.usdcMint);
  const ixs = [
    computeUnitLimitIx(400_000),
    await createAssociatedTokenIdempotentIx(a.payer, a.payer, a.usdcMint),
    await sendExpressBatchIx({
      payer: a.payer, usdcMint: a.usdcMint, messageSentEventData: event.address,
      denominationIndex: a.denominationIndex, expressId: a.expressId, finisherUsdc, treasury: a.treasury,
    }),
  ];
  return { ixs, event, finisherUsdc };
}

/**
 * The send_batch transaction of an epoch that is Sent, when this finisher did not send it (or
 * lost its record): the newest successful transaction touching the epoch account that ran
 * SendBatch. Returns its signature and fee payer.
 */
export async function findSendBatch(rpc: SolanaRpc, epoch: Address): Promise<{ sig: string; feePayer: string } | undefined> {
  const sigs = await rpc.getSignaturesForAddress(epoch, { limit: 25, commitment: "confirmed" }).send();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }).send();
    // send_batch, or send_express_batch for an express epoch (ADR 0015).
    if (!tx?.meta?.logMessages?.some((l) => l.includes("Instruction: SendBatch") || l.includes("Instruction: SendExpressBatch"))) continue;
    const keys: readonly string[] = tx.transaction.message.accountKeys;
    if (!keys.includes(CCTP.messageTransmitterV2)) continue;
    return { sig: s.signature, feePayer: keys[0]! };
  }
  return undefined;
}

// ---------------- Sepolia ----------------

/** The portal calls a finisher makes; a human-readable ABI, so no Foundry build is needed. */
export const PORTAL_ABI = parseAbi([
  "function relay(bytes message, bytes attestation) returns ((uint64 denomination, uint64 epochId, uint16 leafCount, bytes32 root))",
  "function received(uint64 denomination, uint64 epochId) view returns (bool)",
  "function claimContract(uint64 denomination) view returns (bytes32)",
]);
export const BATCH_RECEIVED = parseAbiItem(
  "event BatchReceived(bytes32 indexed root, uint64 indexed denomination, uint64 indexed epochId, uint16 leafCount, uint256 amount, bytes32 cctpNonce)",
);
/** The portal's L1->L2 message for a batch: `messageKey` is its hash, `messageIndex` its Inbox leaf. */
export const BATCH_FORWARDED = parseAbiItem(
  "event BatchForwarded(bytes32 indexed root, uint64 indexed denomination, uint64 indexed epochId, bytes32 content, bytes32 messageKey, uint256 messageIndex)",
);
export const PORTAL_EVENTS = [BATCH_RECEIVED, BATCH_FORWARDED] as const;

/**
 * What a relay receipt says: the root the portal decoded and the L1->L2 message it sent. Read from
 * the portal's own events, not the Inbox's `MessageSent`, whose ABI differs between Aztec 5.x and
 * 6.x. `messageIndex` is whatever `Inbox.sendL2Message` returned, which is the index that version's
 * `consume_l1_to_l2_message` expects.
 */
export function readRelay(logs: Log[]) {
  const [received] = parseEventLogs({ abi: PORTAL_EVENTS, logs, eventName: "BatchReceived" });
  const [sent] = parseEventLogs({ abi: PORTAL_EVENTS, logs, eventName: "BatchForwarded" });
  if (!received || !sent) return undefined;
  return {
    root: received.args.root,
    denomination: received.args.denomination,
    epochId: received.args.epochId,
    cctpNonce: received.args.cctpNonce,
    l1ToL2Hash: sent.args.messageKey,
    l1ToL2Index: sent.args.messageIndex,
  };
}

// ---------------- Iris ----------------

/**
 * One lookup of a burn in Circle's Iris API (V2), by its transaction: a Solana burn (send_batch,
 * the default) or an Ethereum one (`domain` 0: EclypsPortal.exitBatch, ADR 0009).
 */
export async function irisLookup(iris: string, burnTx: string, domain: number = CCTP.domains.solana): Promise<IrisReply> {
  const res = await fetch(`${iris}/v2/messages/${domain}?transactionHash=${burnTx}`, {
    headers: { "user-agent": "eclyps-finisher/0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => undefined);
  return readIris(res.status, body, res.headers.get("retry-after"));
}

/** Polls Iris every 5 s (well under Circle's 35 requests per second) until the burn is attested. */
export async function waitForAttestation(iris: string, burnSig: string, log: (s: string) => void, timeoutMs = 3_600_000) {
  const until = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < until; i++) {
    const r = await irisLookup(iris, burnSig).catch((e) => ({ kind: "error", status: 0, detail: String(e) }) as IrisReply);
    if (r.kind === "attested") return r;
    if (r.kind === "rate-limited") {
      log(`iris: rate limited; waiting ${Math.round(r.retryAfterMs / 1000)} s`);
      await sleep(r.retryAfterMs);
      continue;
    }
    if (i % 6 === 0) log(`iris: ${r.kind === "pending" ? r.status : `HTTP ${r.status}`}`);
    await sleep(5_000);
  }
  throw new Error("timed out waiting for Circle's attestation");
}

// ---------------- Aztec testnet ----------------

export interface AztecKeys {
  secret: string;
  salt: string;
  signingKey: string;
}

export const newAztecKeys = (): AztecKeys => ({
  secret: Fr.random().toString(),
  salt: Fr.random().toString(),
  signingKey: GrumpkinScalar.random().toString(),
});

/**
 * An embedded wallet on an Aztec network with real proofs and an initializerless Schnorr account
 * from `keys` (it needs no deployment transaction). Fees (ADR 0018, the deployment's
 * `fees.operator`): the SponsoredFPC (zero salt; testnet, the default) or, with "feeJuice", the
 * account's own Fee Juice (mainnet: bridged from L1 to `account.address` beforehand).
 */
export async function connectAztec(nodeUrl: string, pxeDir: string, keys: AztecKeys, feeMode: OperatorFeeMode = "sponsoredFpc") {
  // Public testnet nodes (drpc's free tier) refuse JSON-RPC batches of more than 3 requests.
  const node = createAztecNodeClient(nodeUrl, { maxBatchSize: 3 });
  await waitForNode(node);
  const info = await node.getNodeInfo();
  const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: true, dataDirectory: pxeDir } });
  const fpcInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  let fee: { paymentMethod?: SponsoredFeePaymentMethod } = {};
  if (feeMode === "sponsoredFpc") {
    await wallet.registerContract(fpcInstance, SponsoredFPCContract.artifact);
    fee = { paymentMethod: new SponsoredFeePaymentMethod(fpcInstance.address) };
  }
  const account = await wallet.createSchnorrInitializerlessAccount(
    Fr.fromString(keys.secret), Fr.fromString(keys.salt), GrumpkinScalar.fromString(keys.signingKey),
  );
  /** The account's Fee Juice (base units, 18 decimals): what it pays with in "feeJuice" mode. */
  const feeJuice = () => getFeeJuiceBalance(account.address, node);
  /** Registers a deployed contract with the wallet (instance read from the node). */
  const register = async (addr: string, artifact: Parameters<typeof wallet.registerContract>[1]) => {
    const instance = await node.getContract(AztecAddress.fromStringUnsafe(addr));
    if (!instance) throw new Error(`contract ${addr} not found on the Aztec node`);
    await wallet.registerContract(instance, artifact);
  };
  return { node, info, wallet, account, fee, feeMode, feeJuice, fpc: fpcInstance.address, register };
}
