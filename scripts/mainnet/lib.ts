/**
 * Mainnet deployment kit: configuration, the send gate, signers, records and cost helpers
 * (scripts/mainnet/deploy.ts, docs/mainnet-checklist.md).
 *
 * The gate (the owner approves every mainnet transaction and all spending):
 *   - every step is a dry run unless `--send` is given;
 *   - on mainnet `--send` also needs `--mainnet`, and a confirmation file the owner writes:
 *     `<private dir>/confirm/<step>.ok` holding the plan digest the dry run printed. The digest
 *     covers what would be sent (targets, calldata hashes, parameters, signer addresses), so a
 *     confirmation never carries over to a different plan. A file is used once (renamed `.done`);
 *   - `--rehearsal` points every endpoint at local stand-ins and refuses any non-local URL, so a
 *     rehearsal can never reach a public network. It uses the same gate and confirmation files.
 * Nothing here prints a key.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getAddressEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  type Abi,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CCTP } from "@eclyps/sdk";

// ---------------- flags ----------------
export const argv = process.argv.slice(2);
export const has = (f: string) => argv.includes(f);
export const opt = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
export const REHEARSAL = has("--rehearsal");
export const SEND = has("--send");
export const MAINNET_FLAG = has("--mainnet");
if (REHEARSAL && MAINNET_FLAG) throw new Error("--rehearsal and --mainnet contradict each other");

// ---------------- mainnet addresses (verified on chain by `preflight`) ----------------
export const MAINNET = {
  solana: {
    rpc: "https://api.mainnet-beta.solana.com",
    genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    usdcMint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    iris: "https://iris-api.circle.com",
  },
  ethereum: {
    rpc: "https://ethereum-rpc.publicnode.com",
    chainId: 1,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex,
    messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Hex,
    tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Hex,
    tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002" as Hex,
  },
  aztec: {
    /** Aztec governance; owns the Registry and executes AZUP-3 (proposal 5). */
    governance: "0x1102471Eb3378FEE427121c9EfcEa452E4B6B75e" as Hex,
    registry: "0x35b22e09Ee0390539439E24f06Da43D83f90e298" as Hex,
    /** v6 (AZUP-3, Registry.addRollup in the payload). The portal binds whatever is canonical. */
    rollup: "0xE37A2663Cc9c119BA41572C40fAb0bbb23a5402f" as Hex,
    rollupVersion: 2070860440n,
    inbox: "0x603B06cEcC1d537Aad83f1d46651e32014c5B6aD" as Hex,
    outbox: "0xFD2a12658A82d7156DA56c7A8d49A69fC966c8D1" as Hex,
    feeJuicePortal: "0x534361be805CA30Bdb6404eC5E6cDAFFB3E9f3b3" as Hex,
    /** The AZTEC token, Fee Juice on L1 (FeeJuicePortal.UNDERLYING). */
    feeJuiceToken: "0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2" as Hex,
    /** What the v6 rollup's kernels commit to; the installed packages must match (gate b). */
    vkTreeRoot: "0x22fff5de6ce590153df4468f7f0b152188a803d91b3c9c648b91d93d5913f219" as Hex,
  },
} as const;

/** Circle's Solana TokenMessengerMinterV2 as bytes32 (the portal's remote token messenger). */
export const SOLANA_TMM = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893" as Hex;
/** The register_batch secret hash of Fr(0) (ADR 0003). */
export const SECRET_HASH_ZERO = "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250" as Hex;

/** Launch parameters (owner, 2026-10-17; ADR 0012). The cap is raise-only: start low. */
export const LAUNCH = {
  denominations: [100_000_000n, 1_000_000_000n],
  params: { epochLenSlots: 2_250n, minBatchSize: 4, perEpochCap: 4, feeBps: 50, finisherBps: 30 },
  /** $5,000 of principal in total until audits land (ADR 0012: raise in steps). */
  depositCap: 5_000_000_000n,
  /** Admin sunset (SPEC §5.8: 24 months; the program's maximum). */
  adminLifetimeSecs: 730n * 86_400n,
  /** EclypsFPC sponsor slots per note (ADR 0018). */
  fpcSlots: { "100000000": 3, "1000000000": 12 } as Record<string, number>,
  /** The token (ADR 0020; name per open question 28, Circle's naming for bridged USDC). Fixed for good at deploy. */
  token: { name: "Eclyps Bridged USDC", symbol: "eUSDC", decimals: 6 },
};

// ---------------- endpoints and paths ----------------
const isLocal = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u);
const endpoint = (env: string, rehearsal: string, mainnet: string) => {
  const u = process.env[env] ?? (REHEARSAL ? rehearsal : mainnet);
  if (REHEARSAL && u && !isLocal(u)) throw new Error(`--rehearsal refuses the non-local ${env}=${u}`);
  return u;
};
export const SOLANA_RPC = endpoint("SOLANA_RPC_URL", "http://127.0.0.1:8899", MAINNET.solana.rpc);
export const ETH_RPC = endpoint("ETH_RPC_URL", "http://127.0.0.1:8546", MAINNET.ethereum.rpc);
/** The Aztec v6 mainnet node. None is public yet (v6 research §2): set AZTEC_NODE_URL. */
export const AZTEC_NODE = endpoint("AZTEC_NODE_URL", "http://127.0.0.1:8080", "");
/** The L1 the Aztec network settles on (Fee Juice bridge). Mainnet: Ethereum itself. Rehearsal:
 * the local Aztec network's own anvil, since the sandbox cannot fork mainnet. */
export const AZTEC_L1_RPC = endpoint("AZTEC_L1_RPC_URL", "http://127.0.0.1:8545", ETH_RPC);

export const REPO = new URL("../../", import.meta.url);
const here = new URL("./", import.meta.url).pathname;
export const PRIVATE_DIR = process.env.ECLYPS_MAINNET_DIR ?? (REHEARSAL ? `${here}.rehearsal/private` : `${homedir()}/.config/eclyps/mainnet`);
export const CONFIRM_DIR = `${PRIVATE_DIR}/confirm`;
export const RECORD_FILE = process.env.ECLYPS_RECORD ?? (REHEARSAL ? `${here}.rehearsal/mainnet.json` : new URL("deployments/mainnet.json", REPO).pathname);
mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });

const t0 = Date.now();
export const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex;
export const b32 = (a: Address) => hex(new Uint8Array(getAddressEncoder().encode(a)));

// ---------------- records ----------------
/** deployments/mainnet.json: the template's shape plus what each step records. Public. */
export interface MainnetRecord {
  network: "mainnet";
  rehearsal?: boolean;
  solana: {
    rpc: string; cluster: string; gateway: string; usdcMint: string; config: string; admin: string; treasury: string;
    guardian?: string; programDataLen?: number; deploySig?: string; initializeSig?: string; screeningSig?: string;
    [k: string]: unknown;
  };
  l1: { rpc: string; chainId: number; portal: string; deployer?: string; deployTx?: string; deployGas?: string; bindTxs?: Record<string, string>; bindGas?: Record<string, string>; [k: string]: unknown };
  aztec: {
    node: string; token: string; claims: Record<string, string>; version: string; rollupVersion: number; admin: string;
    /** EclypsMinter, the token's only minter (ADR 0020); `minterWireTx`: its one wiring call. */
    minter?: string; minterDeployTx?: string; minterWireTx?: string; minterRenounceTx?: string;
    tokenDeployTx?: string; claimDeployTxs?: Record<string, string>; fpcDeployTx?: string;
    feeJuiceBridges?: { to: string; amount: string; l1Tx: string; claimTx?: string }[];
    /** Fee each Aztec transaction of the kit paid (Fee Juice base units, from its receipt). */
    txFees?: Record<string, string>;
    [k: string]: unknown;
  };
  denominations: string[];
  params: Record<string, unknown>;
  fees: Record<string, unknown> & { eclypsFpc: { address: string; slots: Record<string, number> } };
  features: Record<string, unknown>;
  checks?: Record<string, boolean>;
  [k: string]: unknown;
}

export function loadRecord(): MainnetRecord {
  if (existsSync(RECORD_FILE)) return JSON.parse(readFileSync(RECORD_FILE, "utf8"));
  const t = JSON.parse(readFileSync(new URL("deployments/mainnet.template.json", REPO), "utf8"));
  delete t._template;
  t.solana.rpc = SOLANA_RPC;
  t.l1.rpc = ETH_RPC;
  t.aztec.node = AZTEC_NODE;
  t.params.depositCap = LAUNCH.depositCap.toString();
  if (REHEARSAL) t.rehearsal = true;
  return t;
}
export function saveRecord(r: MainnetRecord) {
  mkdirSync(new URL(".", `file://${RECORD_FILE}`).pathname, { recursive: true });
  writeFileSync(RECORD_FILE, `${JSON.stringify(r, null, 2)}\n`);
}

/** Private state (never committed): Aztec keys, Fee Juice claim secrets. */
export interface PrivateState {
  aztecAdmin?: { secret: string; salt: string; signingKey: string };
  /** Bridged Fee Juice not yet claimed on L2 (claim secret: private until claimed). */
  feeJuiceClaims?: { to: string; amount: string; secret: string; secretHash: string; leafIndex: string; l1Tx: string; claimed?: string }[];
}
const PRIVATE_FILE = `${PRIVATE_DIR}/state.json`;
export const loadPrivate = (): PrivateState => (existsSync(PRIVATE_FILE) ? JSON.parse(readFileSync(PRIVATE_FILE, "utf8")) : {});
export const savePrivate = (p: PrivateState) => writeFileSync(PRIVATE_FILE, JSON.stringify(p, null, 2), { mode: 0o600 });

// ---------------- the gate ----------------
const canon = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString()
    : Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]))
        : v;
export const digestOf = (plan: unknown) => createHash("sha256").update(JSON.stringify(canon(plan))).digest("hex").slice(0, 16);

/**
 * Prints the plan and decides whether to send. Dry run (no --send): prints and returns false.
 * --send: requires --mainnet (unless --rehearsal) and `<CONFIRM_DIR>/<step>.ok` holding the digest.
 * Call `consumeConfirmation(step)` after the step has sent everything.
 */
export function gate(step: string, plan: unknown, costs: string[]): boolean {
  const digest = digestOf(plan);
  console.log(`\n=== ${step}: plan (${REHEARSAL ? "REHEARSAL, local stand-ins" : "MAINNET"}) ===`);
  console.log(JSON.stringify(canon(plan), null, 2));
  if (costs.length) console.log(`--- estimated cost ---\n${costs.map((c) => `  ${c}`).join("\n")}`);
  const file = `${CONFIRM_DIR}/${step}.ok`;
  console.log(`--- plan digest: ${digest} ---`);
  if (!SEND) {
    console.log(`dry run: nothing sent. To send, the owner writes the digest to ${file}\n  (mkdir -p ${CONFIRM_DIR} && echo ${digest} > ${file})\n  and reruns with --send${REHEARSAL ? " --rehearsal" : " --mainnet"}.`);
    return false;
  }
  if (!REHEARSAL && !MAINNET_FLAG) throw new Error("refusing to send on mainnet without --mainnet (and the confirmation file)");
  if (!existsSync(file)) throw new Error(`refusing to send: ${file} does not exist (the owner writes the digest ${digest} there after reading the dry run)`);
  const got = readFileSync(file, "utf8").trim();
  if (got !== digest) throw new Error(`refusing to send: ${file} holds ${got}, but this plan's digest is ${digest} (the plan changed since it was confirmed; read the dry run again)`);
  console.log(`confirmed by ${file}: sending`);
  return true;
}
export function consumeConfirmation(step: string) {
  const file = `${CONFIRM_DIR}/${step}.ok`;
  if (existsSync(file)) renameSync(file, `${CONFIRM_DIR}/${step}.done-${Date.now()}`);
}

// ---------------- prices and costs (estimates only) ----------------
export const PRICES = {
  ethUsd: Number(opt("--eth-usd") ?? 2400),
  solUsd: Number(opt("--sol-usd") ?? 103),
  fjUsd: Number(opt("--fj-usd") ?? 0.0135),
};
const usd = (x: number) => `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}`;
export const solanaCost = (lamports: bigint, what: string) => `${what}: ${(Number(lamports) / 1e9).toFixed(4)} SOL (≈ ${usd((Number(lamports) / 1e9) * PRICES.solUsd)} at $${PRICES.solUsd}/SOL)`;
/** Gas at the current price and at a few others (`--gwei a,b,c`). */
export function ethCost(gas: bigint, what: string, currentWei?: bigint): string {
  const gweis = (opt("--gwei") ?? "1,5,20").split(",").map(Number);
  const parts = [...(currentWei !== undefined ? [Number(currentWei) / 1e9] : []), ...gweis].map((g) => {
    const eth = (Number(gas) * g) / 1e9;
    return `${eth.toFixed(5)} ETH ≈ ${usd(eth * PRICES.ethUsd)} at ${g.toPrecision(2)} gwei`;
  });
  return `${what}: ${gas.toLocaleString("en-US")} gas → ${parts.join(" · ")} (ETH $${PRICES.ethUsd})`;
}
export const fjCost = (mana: bigint, feePerMana: bigint, what: string) => {
  const fj = Number((mana * feePerMana) / 10n ** 12n) / 1e6;
  return `${what}: ${mana.toLocaleString("en-US")} mana × ${feePerMana} → ${fj.toFixed(2)} Fee Juice (≈ ${usd(fj * PRICES.fjUsd)} at $${PRICES.fjUsd})`;
};

// ---------------- Solana ----------------
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
/** Priority fee (micro-lamports per CU): `--cu-price`, default 20,000 on mainnet, 0 in rehearsal. */
export const CU_PRICE = BigInt(opt("--cu-price") ?? (REHEARSAL ? "0" : "20000"));
export function computeUnitPriceIx(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET, accounts: [], data };
}
export const solanaKeypairPath = (role: "admin" | "guardian") =>
  opt(role === "admin" ? "--solana-keypair" : "--guardian-keypair") ?? process.env[role === "admin" ? "SOLANA_KEYPAIR" : "GUARDIAN_KEYPAIR"] ?? `${PRIVATE_DIR}/solana-${role}.json`;

/** Public key of a keypair file, without loading the secret into anything that prints. */
export async function solanaPubkey(path: string): Promise<Address> {
  const { loadSolanaKeypair } = await import("../../finisher/src/chains.js");
  return (await loadSolanaKeypair(path)).address;
}

/** Simulates without signatures; returns logs, units and the post-state lamports of `watch`. */
export async function simulateSolana(ixs: Instruction[], feePayer: Address, watch: Address[]) {
  const rpc = createSolanaRpc(SOLANA_RPC);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(msg));
  const { value } = await rpc.simulateTransaction(wire, {
    encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { encoding: "base64", addresses: watch },
  }).send();
  const lamports = (value.accounts ?? []).map((a) => (a ? BigInt(a.lamports) : 0n));
  return { err: value.err, logs: value.logs ?? [], units: value.unitsConsumed ?? 0n, lamports };
}

export async function solanaGenesisHash() {
  return createSolanaRpc(SOLANA_RPC).getGenesisHash().send();
}

const utf8 = (s: string) => new TextEncoder().encode(s);
async function cctpPda(program: Address, seeds: (string | Uint8Array)[]) {
  const [a] = await getProgramDerivedAddress({ programAddress: program, seeds: seeds.map((s) => (typeof s === "string" ? utf8(s) : s)) });
  return a;
}
/** The CCTP V2 state accounts a Solana -> Ethereum burn reads (same PDAs as on devnet). */
export async function cctpBurnAccounts(usdcMint: Address) {
  const tmm = CCTP.tokenMessengerMinterV2;
  return {
    messageTransmitter: await cctpPda(CCTP.messageTransmitterV2, ["message_transmitter"]),
    tokenMessenger: await cctpPda(tmm, ["token_messenger"]),
    remoteTokenMessengerEthereum: await cctpPda(tmm, ["remote_token_messenger", "0"]),
    tokenMinter: await cctpPda(tmm, ["token_minter"]),
    localTokenUsdc: await cctpPda(tmm, ["local_token", new Uint8Array(getAddressEncoder().encode(usdcMint))]),
  };
}

// ---------------- Ethereum ----------------
export const l1Chain = (chainId: number, rpc: string): Chain =>
  defineChain({ id: chainId, name: chainId === 1 ? "Ethereum" : `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

export function forgeArtifact(file: string, name: string) {
  const p = new URL(`contracts/portal/out/${file}/${name}.json`, REPO);
  if (!existsSync(p)) throw new Error(`${p.pathname} is missing: run forge build in contracts/portal`);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

export interface EthTx { to?: Hex; data: Hex; value?: bigint }
/** Signer modes (docs/mainnet-checklist.md, keys):
 *  --eth-key <file>              a 0x private key file (rehearsal; a hot key on mainnet is not advised)
 *  --ledger [--hd-path <path>]   a Ledger through Foundry's `cast` (address and every send on the device)
 *  --from <addr> [--signed <f>]  an external signer: the kit writes the unsigned transaction to
 *                                <private dir>/unsigned-<label>.json and stops; the owner signs it
 *                                elsewhere (any wallet that signs a raw EIP-1559 tx) and reruns with
 *                                --signed <file holding the 0x raw signed transaction>. */
export interface EthSigner { address: Hex; mode: "key" | "ledger" | "external"; send(tx: EthTx, label: string): Promise<TransactionReceipt> }

/** Thrown when an external signature is needed: the step stops cleanly and resumes on rerun. */
export class AwaitSignature extends Error {}

export async function ethSigner(rpc: string, chainId: number, defaultKeyFile: string): Promise<EthSigner> {
  const chain = l1Chain(chainId, rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const maxGwei = Number(opt("--max-gwei") ?? 30);
  const fees = async () => {
    const f = await pub.estimateFeesPerGas();
    if (Number(f.maxFeePerGas) / 1e9 > maxGwei) throw new Error(`gas is above --max-gwei ${maxGwei} (now ${(Number(f.maxFeePerGas) / 1e9).toFixed(2)} gwei); wait or raise it`);
    return f;
  };
  const gasFor = async (from: Hex, tx: EthTx) => ((await pub.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value })) * 12n) / 10n;
  const wait = async (hash: Hex, label: string) => {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    return receipt;
  };

  if (has("--ledger")) {
    const hd = opt("--hd-path") ?? "m/44'/60'/0'/0/0";
    const addr = execFileSync("cast", ["wallet", "address", "--ledger", "--mnemonic-derivation-path", hd], { encoding: "utf8" }).trim() as Hex;
    return {
      address: addr, mode: "ledger",
      async send(tx, label) {
        const gas = await gasFor(addr, tx);
        const f = await fees();
        const a = ["send", "--ledger", "--mnemonic-derivation-path", hd, "--rpc-url", rpc, "--chain", String(chainId), "--gas-limit", gas.toString(),
          "--gas-price", f.maxFeePerGas.toString(), "--priority-gas-price", f.maxPriorityFeePerGas.toString(), "--json", "--async"];
        if (tx.value) a.push("--value", tx.value.toString());
        a.push(...(tx.to ? [tx.to, tx.data] : ["--create", tx.data]));
        log(`${label}: confirm on the Ledger (${addr})`);
        const out = execFileSync("cast", a, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }).trim();
        const hash = (out.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? "") as Hex;
        if (!hash) throw new Error(`${label}: cast send returned no hash`);
        return wait(hash, label);
      },
    };
  }

  const from = opt("--from") as Hex | undefined;
  if (from) {
    return {
      address: from, mode: "external",
      async send(tx, label) {
        const unsignedFile = `${PRIVATE_DIR}/unsigned-${label}.json`;
        const signedFile = opt("--signed");
        if (signedFile && existsSync(signedFile)) {
          const raw = readFileSync(signedFile, "utf8").trim() as Hex;
          const parsed = parseTransaction(raw);
          const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
          const same = (parsed.to ?? undefined)?.toLowerCase() === tx.to?.toLowerCase() && (parsed.data ?? "0x").toLowerCase() === tx.data.toLowerCase()
            && (parsed.value ?? 0n) === (tx.value ?? 0n) && parsed.chainId === chainId && signer.toLowerCase() === from.toLowerCase();
          if (same) {
            const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
            log(`${label}: broadcast the externally signed tx ${hash}`);
            const receipt = await wait(hash, label);
            renameSync(signedFile, `${signedFile}.sent-${Date.now()}`);
            return receipt;
          }
          // A signed file for another transaction (an earlier one of this step): fall through.
        }
        const gas = await gasFor(from, tx);
        const f = await fees();
        const nonce = await pub.getTransactionCount({ address: from, blockTag: "pending" });
        const unsigned = { type: "eip1559" as const, chainId, nonce, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
        writeFileSync(unsignedFile, JSON.stringify({ ...canon(unsigned) as object, serializedUnsigned: serializeTransaction(unsigned), dataKeccak: keccak256(tx.data) }, null, 2));
        throw new AwaitSignature(`${label}: unsigned transaction written to ${unsignedFile} (from ${from}, nonce ${nonce}). Sign it with your signer, save the 0x raw signed tx to a file, and rerun this step with --signed <file>.`);
      },
    };
  }

  const keyFile = opt("--eth-key") ?? process.env.ETH_KEY_FILE ?? defaultKeyFile;
  if (!existsSync(keyFile)) {
    return {
      address: "0x0000000000000000000000000000000000000000", mode: "key",
      async send() { throw new Error(`no Ethereum signer: pass --ledger, --from <address> (external signer) or --eth-key <file> (${keyFile} does not exist)`); },
    };
  }
  const key = readFileSync(keyFile, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 0x-prefixed private key`);
  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  return {
    address: account.address, mode: "key",
    async send(tx, label) {
      const gas = await gasFor(account.address, tx);
      const f = await fees();
      const hash = await wallet.sendTransaction({ to: tx.to ?? null, data: tx.data, value: tx.value, gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas } as never);
      log(`${label}: ${hash}`);
      return wait(hash, label);
    },
  };
}

// ---------------- Aztec ----------------
/** VK tree root of the installed Aztec packages (what our PXE's kernel proofs commit to). */
export async function installedVkTreeRoot(): Promise<{ root: string; version: string }> {
  const pnpmDir = new URL("node_modules/.pnpm/", REPO).pathname;
  const { readdirSync } = await import("node:fs");
  const version = JSON.parse(readFileSync(new URL("scripts/node_modules/@aztec-labs/aztec.js/package.json", REPO), "utf8")).version as string;
  const dir = readdirSync(pnpmDir).find((d) => d.startsWith(`@aztec-labs+noir-protocol-circuits-types@${version}`));
  if (!dir) throw new Error(`@aztec-labs/noir-protocol-circuits-types@${version} is not installed`);
  const m = await import(`${pnpmDir}${dir}/node_modules/@aztec-labs/noir-protocol-circuits-types/dest/entrypoint/vk-tree.js`);
  return { root: m.getVKTreeRoot().toString(), version };
}

// ---------------- checks ----------------
export type Check = { name: string; ok: boolean; detail?: string; tolerated?: boolean };
export function report(checks: Check[]) {
  for (const c of checks) console.log(`${c.ok ? "PASS" : c.tolerated ? "WARN" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  const failed = checks.filter((c) => !c.ok && !c.tolerated);
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : `\nall checks pass${checks.some((c) => !c.ok) ? " (rehearsal stand-ins tolerated, marked WARN)" : ""}`);
  return failed.length === 0;
}
