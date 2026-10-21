/**
 * Phase 0 gate on public testnets: Solana devnet -> Sepolia -> Aztec testnet (SPEC §8).
 *
 * Every phase is idempotent and resumable: it records what it did and is skipped once done.
 *   private (keys, note seed, PXE db): ~/.config/eclyps/testnet/   never in the repo
 *   public (addresses, tx hashes):     deployments/testnet.json    committed
 *
 * Keys: SOLANA_KEYPAIR (default ~/.config/eclyps/devnet.json), SEPOLIA_PRIVATE_KEY (default
 * ~/.config/eclyps/sepolia.key). Aztec fees are paid by the testnet's SponsoredFPC; proofs are real.
 *
 * Run from scripts/ with Node >= 24.12 (behind a proxy: NODE_USE_ENV_PROXY=1):
 *   pnpm exec tsx testnet/run.ts <phase>
 *     aztec    Aztec admin account + EclypsMinter + Token (AIP-20, ADR 0020)   (no funds needed)
 *     portal   EclypsPortal on Sepolia (real CCTP V2, Aztec testnet registry)
 *     claims   EclypsClaim per denomination, the minter wired to them; bindClaimContract on Sepolia
 *     program  deploy the gateway to devnet (solana CLI) and initialize it
 *     deposit [n]  deposit n seed-derived notes (default: a full batch) into the current epoch
 *     finish   burn (close_epoch, send_batch = CCTP burn) -> relay (Iris, Sepolia) -> register (Aztec);
 *              each step can also run alone: burn | relay | register
 *     claim    private claim of one note to a fresh seed-derived Aztec account; verify
 *     all      every phase in order
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { EthAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { type Address, address, getAddressEncoder } from "@solana/kit";
import { type Abi, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  associatedTokenAddress,
  closeEpochIx,
  computeUnitLimitIx,
  configPda,
  createAssociatedTokenIdempotentIx,
  decodeBatchHook,
  decodeConfig,
  decodeEpoch,
  depositCost,
  depositFeeBps,
  depositIx,
  deriveNote,
  DEVNET,
  epochPda,
  exitAuthorityPda,
  exitCustodyPda,
  EXIT_EPOCH_BLOCKS,
  GATEWAY_PROGRAM_ID,
  initializeIx,
  MIN_EXIT_BATCH,
  openEpochIx,
  path as merklePath,
  randomSeed,
  resolveFees,
  type FeesConfig,
  root as merkleRoot,
  SEPOLIA,
  seedFromHex,
  seedToHex,
  toBytes32,
  toHex as fieldHex,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";
// Shared with the testnet finisher: Solana sends, portal/Inbox ABIs, Iris, the Aztec testnet wallet.
import {
  connectAztec,
  loadSolanaKeypair,
  newAztecKeys,
  PORTAL_ABI,
  readRelay,
  sendBatchTx,
  sleep,
  solanaClient,
  waitForAttestation,
} from "../../finisher/src/chains.js";

// ---------------- configuration ----------------
const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const AZTEC_NODE = process.env.AZTEC_NODE_URL ?? "https://aztec-testnet.drpc.org";
const KEYS = process.env.ECLYPS_KEYS ?? `${homedir()}/.config/eclyps`;
const PRIVATE_DIR = `${KEYS}/testnet`;
// The Circle faucet gives 20 devnet USDC per request, so testnet notes are $1 / $10 (mainnet: $100+).
const DENOMINATIONS = [1_000_000n, 10_000_000n];
// Fee 0.5 % (0.3 % to whoever sends the batch, 0.2 % to the treasury) and a $1,000 deposit cap
// (ADR 0012). The treasury is the admin key's devnet-USDC associated account.
const PARAMS = { epochLenSlots: 2_250n, minBatchSize: 4, perEpochCap: 4, feeBps: 50, finisherBps: 30, depositCap: 1_000_000_000n };
const ADMIN_LIFETIME_SECS = 30n * 86_400n;
const SECRET_HASH_ZERO = "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250";
const SOLANA_TMM = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893";
const AZTEC_WAIT = { timeout: 1_800, interval: 5 };

const repo = new URL("../../", import.meta.url);
const PUBLIC_FILE = process.env.ECLYPS_RECORD ? new URL(`file://${process.env.ECLYPS_RECORD}`) : new URL("deployments/testnet.json", repo);
const IRIS = process.env.IRIS_URL ?? DEVNET.iris;
const PRIVATE_FILE = `${PRIVATE_DIR}/state.json`;

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex;

// ---------------- records ----------------
interface PublicRecord {
  network: "testnet";
  solana: { rpc: string; gateway: string; usdcMint: string; config: string; admin?: string; treasury?: string; deploySig?: string; initializeSig?: string };
  l1: { rpc: string; chainId: number; portal: string; deployer?: string; deployTx?: string; bindTxs: Record<string, string> };
  aztec: {
    node: string;
    version?: string;
    rollupVersion?: number;
    sponsoredFpc?: string;
    admin?: string;
    /** EclypsMinter, the token's only minter (ADR 0020). */
    minter?: string;
    minterDeployTx?: string;
    token: string;
    tokenDeployTx?: string;
    claims: Record<string, string>;
    claimDeployTxs: Record<string, string>;
    /** EclypsMinter.wire(token, claims): once, after every claim contract is deployed. */
    wireTx?: string;
    /** Before ADR 0020: Token.set_minter(claim, true) per denomination. */
    minterTxs?: Record<string, string>;
  };
  denominations: string[];
  params: { minBatchSize: number; perEpochCap: number; epochLenSlots: number; feeBps?: number; finisherBps?: number; depositCap?: string };
  runs: Run[];
  /** Who pays Aztec fees (ADR 0018); absent: the SponsoredFPC. */
  fees?: FeesConfig;
}
interface Run {
  /** "exit": the exits' record (testnet/exits.ts); the phases here skip it. */
  kind?: "exit";
  denomination: string;
  epochId: string;
  /** Notes this run deposits; other depositors (e.g. the UI) may fill the rest of the epoch. */
  notes: number;
  deposits: string[];
  root?: string;
  leafCount?: number;
  closeSig?: string;
  burnSig?: string;
  messageSent?: string;
  cctpNonce?: string;
  relayTx?: string;
  relayGas?: string;
  l1ToL2Hash?: string;
  l1ToL2Index?: string;
  registerTx?: string;
  claimTx?: string;
  claimedNote?: number;
  checks?: Record<string, boolean>;
  timings?: Record<string, number>;
}
interface PrivateState {
  aztecAdmin?: { secret: string; salt: string; signingKey: string };
  /** Note seed per run (index into PublicRecord.runs). */
  seeds: Record<string, string>;
}

const pubRec: PublicRecord = existsSync(PUBLIC_FILE)
  ? JSON.parse(readFileSync(PUBLIC_FILE, "utf8"))
  : {
      network: "testnet",
      solana: { rpc: SOLANA_RPC, gateway: GATEWAY_PROGRAM_ID, usdcMint: DEVNET.usdcMint, config: await configPda() },
      l1: { rpc: SEPOLIA_RPC, chainId: SEPOLIA.chainId, portal: "", bindTxs: {} },
      aztec: { node: AZTEC_NODE, token: "", claims: {}, claimDeployTxs: {} },
      denominations: DENOMINATIONS.map(String),
      params: {
        minBatchSize: PARAMS.minBatchSize, perEpochCap: PARAMS.perEpochCap, epochLenSlots: Number(PARAMS.epochLenSlots),
        feeBps: PARAMS.feeBps, finisherBps: PARAMS.finisherBps, depositCap: PARAMS.depositCap.toString(),
      },
      runs: [],
    };
mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
const priv: PrivateState = existsSync(PRIVATE_FILE) ? JSON.parse(readFileSync(PRIVATE_FILE, "utf8")) : { seeds: {} };
const savePublic = () => {
  mkdirSync(new URL("deployments/", repo), { recursive: true });
  writeFileSync(PUBLIC_FILE, `${JSON.stringify(pubRec, null, 2)}\n`);
};
const savePrivate = () => writeFileSync(PRIVATE_FILE, JSON.stringify(priv, null, 2), { mode: 0o600 });

// ---------------- Solana ----------------
const { rpc, send: sendSolana, accountData } = solanaClient(SOLANA_RPC, log);
const solanaKeyPath = process.env.SOLANA_KEYPAIR ?? `${KEYS}/devnet.json`;
const solanaSigner = () => loadSolanaKeypair(solanaKeyPath);

async function usdcAccount(owner: Address) {
  const { value } = await rpc
    .getTokenAccountsByOwner(owner, { mint: DEVNET.usdcMint }, { encoding: "jsonParsed", commitment: "confirmed" })
    .send();
  const best = value
    .map((a) => ({ address: a.pubkey, amount: BigInt((a.account.data as unknown as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount) }))
    .sort((x, y) => (y.amount > x.amount ? 1 : -1))[0];
  return best;
}

// ---------------- Sepolia ----------------
const sepoliaKey = () =>
  (process.env.SEPOLIA_PRIVATE_KEY ?? readFileSync(`${KEYS}/sepolia.key`, "utf8").trim()) as Hex;
const l1Pub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const l1Wallet = () => createWalletClient({ account: privateKeyToAccount(sepoliaKey()), chain: sepolia, transport: http(SEPOLIA_RPC) });
const forgeArtifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(new URL(`contracts/portal/out/${file}/${name}.json`, repo), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

// ---------------- Aztec ----------------
const seedScalar = (seed: Uint8Array, label: string) =>
  createHash("sha256").update(seed).update(`eclyps/aztec/${label}`).digest();

async function aztec() {
  if (!priv.aztecAdmin) {
    priv.aztecAdmin = newAztecKeys();
    savePrivate();
  }
  const feeMode = resolveFees(pubRec).operator;
  const { node, info, wallet, account: admin, fee, fpc, register } = await connectAztec(AZTEC_NODE, `${PRIVATE_DIR}/pxe`, priv.aztecAdmin, feeMode);
  if (pubRec.aztec.minter) await register(pubRec.aztec.minter, EclypsMinterContract.artifact);
  if (pubRec.aztec.token) await register(pubRec.aztec.token, TokenContract.artifact);
  for (const c of Object.values(pubRec.aztec.claims)) await register(c, EclypsClaimContract.artifact);
  Object.assign(pubRec.aztec, {
    version: info.nodeVersion,
    rollupVersion: info.rollupVersion,
    ...(feeMode === "sponsoredFpc" ? { sponsoredFpc: fpc.toString() } : {}),
    admin: admin.address.toString(),
  });
  return { node, info, wallet, admin, fee };
}

// ---------------- phases ----------------
async function phaseAztec() {
  const { wallet, admin, fee, info } = await aztec();
  log(`aztec ${AZTEC_NODE} v${info.nodeVersion}, rollup ${info.rollupVersion}; admin ${admin.address}`);
  if (!pubRec.aztec.minter) {
    log(`deploying EclypsMinter with a real proof; fees: ${fee.paymentMethod ? "SponsoredFPC" : "the admin's Fee Juice"}`);
    const { contract, receipt } = await EclypsMinterContract.deploy(wallet, admin.address)
      .send({ from: admin.address, fee, wait: AZTEC_WAIT });
    pubRec.aztec.minter = contract.address.toString();
    pubRec.aztec.minterDeployTx = receipt.txHash.toString();
    savePublic();
  }
  if (!pubRec.aztec.token) {
    log("deploying Token (eUSDC, AIP-20; its only minter is EclypsMinter)");
    const { contract, receipt } = await TokenContract.deployWithOpts(
      { method: "constructor_with_minter", wallet },
      "Eclyps Bridged USDC (test)", "eUSDC", 6, AztecAddress.fromStringUnsafe(pubRec.aztec.minter), AztecAddress.ZERO,
    ).send({ from: admin.address, fee, wait: AZTEC_WAIT });
    pubRec.aztec.token = contract.address.toString();
    pubRec.aztec.tokenDeployTx = receipt.txHash.toString();
    savePublic();
  }
  log(`minter ${pubRec.aztec.minter}; token ${pubRec.aztec.token}`);
}

async function phasePortal() {
  if (pubRec.l1.portal) return log(`portal ${pubRec.l1.portal} (already deployed)`);
  const node = createAztecNodeClient(AZTEC_NODE);
  const registry = (await node.getNodeInfo()).l1ContractAddresses.registryAddress.toString() as Hex;
  const wallet = l1Wallet();
  const balance = await l1Pub.getBalance({ address: wallet.account.address });
  log(`Sepolia deployer ${wallet.account.address}: ${Number(balance) / 1e18} ETH`);
  if (balance === 0n) throw new Error("fund the Sepolia key first");
  const art = forgeArtifact("EclypsPortal.sol", "EclypsPortal");
  const config = address(pubRec.solana.config);
  const args = [
    SEPOLIA.messageTransmitterV2, SEPOLIA.usdc, SOLANA_TMM, SEPOLIA.tokenMessengerV2,
    hex(new Uint8Array(getAddressEncoder().encode(DEVNET.usdcMint))),
    hex(new Uint8Array(getAddressEncoder().encode(config))),
    registry, SECRET_HASH_ZERO,
    // Exits (ADR 0009): the gateway's exit authority (CCTP destinationCaller) and exit custody
    // (mintRecipient), derived from GATEWAY_PROGRAM_ID. A new program id needs a new portal.
    hex(new Uint8Array(getAddressEncoder().encode(await exitAuthorityPda()))),
    hex(new Uint8Array(getAddressEncoder().encode(await exitCustodyPda()))),
  ];
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const receipt = await l1Pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`portal deploy failed: ${hash}`);
  Object.assign(pubRec.l1, { portal: receipt.contractAddress, deployer: wallet.account.address, deployTx: hash });
  savePublic();
  log(`EclypsPortal ${receipt.contractAddress} (tx ${hash}, gas ${receipt.gasUsed}); gatewaySender = config PDA ${config}; exits to ${await exitCustodyPda()}`);
}

async function phaseClaims() {
  if (!pubRec.l1.portal) throw new Error("run the portal phase first");
  if (!pubRec.aztec.minter) throw new Error("run the aztec phase first");
  const { wallet, admin, fee } = await aztec();
  const token = AztecAddress.fromStringUnsafe(pubRec.aztec.token);
  const minter = EclypsMinterContract.at(AztecAddress.fromStringUnsafe(pubRec.aztec.minter), wallet);
  const portalAbi = forgeArtifact("EclypsPortal.sol", "EclypsPortal").abi;
  const l1 = l1Wallet();
  for (const d of DENOMINATIONS) {
    const key = d.toString();
    if (!pubRec.aztec.claims[key]) {
      log(`deploying EclypsClaim($${Number(d) / 1e6})`);
      const { contract, receipt } = await EclypsClaimContract.deploy(wallet, token, minter.address, EthAddress.fromString(pubRec.l1.portal), d, EXIT_EPOCH_BLOCKS, MIN_EXIT_BATCH)
        .send({ from: admin.address, fee, wait: AZTEC_WAIT });
      pubRec.aztec.claims[key] = contract.address.toString();
      pubRec.aztec.claimDeployTxs[key] = receipt.txHash.toString();
      savePublic();
    }
  }
  if (!pubRec.aztec.wireTx) {
    // Once: the minter learns the token and lists every claim contract (ADR 0020).
    const none = AztecAddress.ZERO;
    const claims = DENOMINATIONS.map((d) => AztecAddress.fromStringUnsafe(pubRec.aztec.claims[d.toString()]!));
    const pad = <T>(xs: T[], z: T) => [...xs, ...Array(4 - xs.length).fill(z)] as T[];
    log(`EclypsMinter.wire(${token}, ${claims.join(", ")})`);
    const { receipt } = await minter.methods.wire(token, pad(claims, none), pad([...DENOMINATIONS], 0n))
      .send({ from: admin.address, fee, wait: AZTEC_WAIT });
    pubRec.aztec.wireTx = receipt.txHash.toString();
    savePublic();
  }
  for (const d of DENOMINATIONS) {
    const key = d.toString();
    if (!pubRec.l1.bindTxs[key]) {
      const hash = await l1.writeContract({
        address: pubRec.l1.portal as Hex, abi: portalAbi, functionName: "bindClaimContract", args: [d, pubRec.aztec.claims[key] as Hex],
      });
      await l1Pub.waitForTransactionReceipt({ hash });
      pubRec.l1.bindTxs[key] = hash;
      savePublic();
      log(`bindClaimContract($${Number(d) / 1e6}) tx ${hash}`);
    }
  }
}

async function phaseProgram() {
  const admin = await solanaSigner();
  const exists = await rpc.getAccountInfo(GATEWAY_PROGRAM_ID, { encoding: "base64" }).send();
  if (!exists.value) {
    const bal = (await rpc.getBalance(admin.address).send()).value;
    log(`deploying gateway ${GATEWAY_PROGRAM_ID} from ${admin.address} (${Number(bal) / 1e9} SOL)`);
    // The CLI always prints the write buffer's recovery phrase on stderr. Keep it out of the logs; if
    // the deploy fails, save it privately so the buffer's rent (about 2 SOL) can be recovered.
    let out: string;
    try {
      out = execFileSync("solana", [
        "program", "deploy", "target/deploy/eclyps_gateway.so",
        "--program-id", "target/deploy/eclyps_gateway-keypair.json",
        "--keypair", solanaKeyPath, "--url", SOLANA_RPC, "--use-rpc",
        "--with-compute-unit-price", "10000", "--max-sign-attempts", "50", "--output", "json",
      ], { cwd: new URL(".", repo), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      writeFileSync(`${PRIVATE_DIR}/deploy-error.txt`, String((e as { stderr?: string }).stderr ?? e), { mode: 0o600 });
      throw new Error(`solana program deploy failed; buffer recovery details in ${PRIVATE_DIR}/deploy-error.txt`);
    }
    pubRec.solana.deploySig = JSON.parse(out).signature;
    savePublic();
    // A program deployed in slot N can only be invoked from slot N+1 on ("Program is not deployed").
    const deployedAt = await rpc.getSlot({ commitment: "confirmed" }).send();
    while ((await rpc.getSlot({ commitment: "confirmed" }).send()) < deployedAt + 2n) await sleep(400);
    log(`deployed (${pubRec.solana.deploySig})`);
  }
  if (!(await accountData(address(pubRec.solana.config)))) {
    if (!pubRec.l1.portal) throw new Error("run the portal phase first (the gateway fixes the portal at initialize)");
    const treasury = await associatedTokenAddress(admin.address, DEVNET.usdcMint);
    const sig = await sendSolana([
      await createAssociatedTokenIdempotentIx(admin.address, admin.address, DEVNET.usdcMint),
      await initializeIx({
        admin: admin.address, usdcMint: DEVNET.usdcMint, guardian: admin.address, portal: pubRec.l1.portal,
        denominations: DENOMINATIONS, params: { ...PARAMS, treasury }, adminLifetimeSecs: ADMIN_LIFETIME_SECS,
      }),
    ], [admin.keyPair], admin.address);
    Object.assign(pubRec.solana, { admin: admin.address, treasury, initializeSig: sig });
    Object.assign(pubRec.params, { feeBps: PARAMS.feeBps, finisherBps: PARAMS.finisherBps, depositCap: PARAMS.depositCap.toString() });
    savePublic();
    log(`initialize ${sig}`);
  }
  const cfg = decodeConfig((await accountData(address(pubRec.solana.config)))!);
  log(`gateway config: portal ${hex(cfg.portal)}, denominations ${cfg.denominations.filter((d) => d > 0n).join(", ")}, fee ${cfg.params.feeBps} bps (finisher ${cfg.params.finisherBps}), cap ${cfg.params.depositCap}, treasury ${cfg.params.treasury}`);
}

/** Deposits `count` notes of denomination 0 into the current epoch (default: a full batch). */
async function phaseDeposit(countArg?: string) {
  const count = countArg ? Number(countArg) : PARAMS.perEpochCap;
  let runIndex = pubRec.runs.findIndex((r) => r.kind !== "exit" && !r.burnSig);
  if (runIndex >= 0 && pubRec.runs[runIndex]!.deposits.length >= pubRec.runs[runIndex]!.notes) return log(`run ${runIndex} already deposited`);
  const user = await solanaSigner();
  const source = await usdcAccount(user.address);
  const d = DENOMINATIONS[0]!;
  const cfg = decodeConfig((await accountData(address(pubRec.solana.config)))!);
  const epochId = cfg.currentEpoch[0]!;
  // Each note costs its denomination plus the epoch's fee (ADR 0012).
  const openRaw = await accountData(await epochPda(0, epochId));
  const need = depositCost(d, depositFeeBps(cfg, openRaw ? decodeEpoch(openRaw) : undefined)) * BigInt(count);
  if (!source || source.amount < need) {
    throw new Error(`need ${Number(need) / 1e6} devnet USDC at ${user.address} (have ${Number(source?.amount ?? 0n) / 1e6})`);
  }
  if (runIndex < 0) {
    const open = await accountData(await epochPda(0, epochId));
    const already = open ? decodeEpoch(open).leaves.length : 0;
    if (already + count > PARAMS.perEpochCap) throw new Error(`epoch ${epochId} has ${already} leaves; ${count} more exceed the cap`);
    pubRec.runs.push({ denomination: d.toString(), epochId: epochId.toString(), notes: count, deposits: [], timings: { start: Date.now() } });
    runIndex = pubRec.runs.length - 1;
    priv.seeds[runIndex] = seedToHex(randomSeed());
    savePrivate();
    savePublic();
  }
  const run = pubRec.runs[runIndex]!;
  if (run.epochId !== epochId.toString()) throw new Error(`epoch moved from ${run.epochId} to ${epochId} mid-run`);
  const seed = seedFromHex(priv.seeds[runIndex]!);
  for (let i = run.deposits.length; i < run.notes; i++) {
    const note = await deriveNote(seed, i);
    const sig = await sendSolana([
      await openEpochIx(user.address, 0, epochId),
      await depositIx({ payer: user.address, authority: user.address, source: source.address, usdcMint: DEVNET.usdcMint, denominationIndex: 0, currentEpochId: epochId, commitment: toBytes32(note.commitment) }),
    ], [user.keyPair], user.address);
    run.deposits.push(sig);
    savePublic();
    log(`deposit #${i} ($${Number(d) / 1e6}) ${sig}`);
  }
  run.timings!.deposited = Date.now();
  savePublic();
}

/** The oldest run whose batch has not finished crossing, with its epoch (public account data). */
async function pendingRun() {
  const runIndex = pubRec.runs.findIndex((r) => r.kind !== "exit" && !r.registerTx);
  if (runIndex < 0) return undefined;
  const run = pubRec.runs[runIndex]!;
  const idx = DENOMINATIONS.findIndex((d) => d.toString() === run.denomination);
  const epochId = BigInt(run.epochId);
  const epochAddr = await epochPda(idx, epochId);
  const epoch = decodeEpoch((await accountData(epochAddr))!);
  return { runIndex, run, idx, epochId, epochAddr, epoch };
}

/** Solana: close_epoch, then send_batch (the CCTP burn carrying the batch hook). */
async function phaseBurn() {
  const p = await pendingRun();
  if (!p) return log("nothing to burn");
  const { runIndex, run, idx, epochId, epochAddr } = p;
  let { epoch } = p;
  const payer = await solanaSigner(); // any funded key can finish; the gateway checks nothing about it
  if (epoch.status === "Open") {
    run.closeSig = await sendSolana([computeUnitLimitIx(400_000), await closeEpochIx(idx, epochId)], [payer.keyPair], payer.address);
    epoch = decodeEpoch((await accountData(epochAddr))!);
    if (epoch.status === "Open") throw new Error("epoch rolled over instead of closing (fewer than min_batch_size leaves)");
    Object.assign(run, { root: fieldHex(epoch.root), leafCount: epoch.leaves.length });
    savePublic();
    log(`close_epoch ${run.closeSig}: ${epoch.leaves.length} leaves, root ${run.root}`);
  }
  // The root must match the public leaves, and this run's notes must be among them.
  const seed = seedFromHex(priv.seeds[runIndex]!);
  const own = await Promise.all(run.deposits.map((_, i) => deriveNote(seed, i)));
  if (epoch.root !== merkleRoot(epoch.leaves)) throw new Error("on-chain root != SDK root of the public leaves");
  if (!own.every((n) => epoch.leaves.includes(n.commitment))) throw new Error("a note of this run is missing from the epoch");

  if (epoch.status === "Closed") {
    // The finisher's share of the fees lands in the payer's USDC account (created if missing); the
    // rest goes to the treasury the config names (ADR 0012).
    const { treasury } = decodeConfig((await accountData(address(pubRec.solana.config)))!).params;
    const { ixs, event } = await sendBatchTx({ payer: payer.address, usdcMint: DEVNET.usdcMint, treasury, denominationIndex: idx, epochId });
    run.burnSig = await sendSolana(ixs, [payer.keyPair, event.keyPair], payer.address);
    run.messageSent = event.address;
    run.timings!.burned = Date.now();
    savePublic();
    log(`send_batch (CCTP burn + hook) ${run.burnSig}`);
  }
}

/** Ethereum: wait for Circle's attestation, then EclypsPortal.relay (-> Aztec Inbox). */
async function phaseRelay() {
  const p = await pendingRun();
  if (!p?.run.burnSig) return log("nothing to relay");
  const { run, epoch } = p;
  if (run.relayTx) return log(`relayed in ${run.relayTx}`);
  const m = await waitForAttestation(IRIS, run.burnSig!, log);
  const hook = decodeBatchHook(Buffer.from(m.message.slice(2), "hex").subarray(376));
  if (hook.root !== epoch.root) throw new Error("attested hook root != epoch root");
  run.timings!.attested = Date.now();
  log(`Circle attestation received (${((run.timings!.attested - run.timings!.burned!) / 1000).toFixed(0)} s after burn)`);
  const hash = await l1Wallet().writeContract({ address: pubRec.l1.portal as Hex, abi: PORTAL_ABI, functionName: "relay", args: [m.message, m.attestation] });
  const receipt = await l1Pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`relay reverted: ${hash}`);
  const r = readRelay(receipt.logs);
  if (!r) throw new Error(`relay ${hash}: missing BatchReceived/MessageSent`);
  if (BigInt(r.root) !== epoch.root) throw new Error("portal decoded a different root");
  Object.assign(run, {
    relayTx: hash, relayGas: receipt.gasUsed.toString(), cctpNonce: r.cctpNonce,
    l1ToL2Hash: r.l1ToL2Hash, l1ToL2Index: r.l1ToL2Index.toString(),
  });
  run.timings!.relayed = Date.now();
  savePublic();
  log(`relay ${hash} (gas ${receipt.gasUsed}): root decoded == root sent; L1->L2 message ${r.l1ToL2Hash} at leaf ${run.l1ToL2Index}`);
}

/** Aztec: register_batch once the L1->L2 message is in an Aztec block. */
async function phaseRegister() {
  const p = await pendingRun();
  if (!p?.run.relayTx) return log("nothing to register");
  const { run, epochId, epoch } = p;
  const { node, wallet, admin, fee } = await aztec();
  log("waiting for the L1->L2 message to land in an Aztec block");
  if (!(await waitForL1ToL2MessageReady(node, Fr.fromString(run.l1ToL2Hash!), { timeoutSeconds: 3_600 }))) {
    throw new Error("L1->L2 message not ready after 1 h");
  }
  run.timings!.l1ToL2Ready = Date.now();
  const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(pubRec.aztec.claims[run.denomination]!), wallet);
  const { receipt } = await claim.methods
    .register_batch(new Fr(epoch.root), epochId, epoch.leaves.length, new Fr(BigInt(run.l1ToL2Index!)))
    .send({ from: admin.address, fee, wait: AZTEC_WAIT });
  run.registerTx = receipt.txHash.toString();
  run.timings!.registered = Date.now();
  savePublic();
  log(`register_batch ${run.registerTx}`);
}

/** What a finisher does for one batch: burn, relay, register. */
async function phaseFinish() {
  await phaseBurn();
  await phaseRelay();
  await phaseRegister();
}

async function phaseClaim() {
  const runIndex = pubRec.runs.findIndex((r) => r.kind !== "exit" && r.registerTx && !r.claimTx);
  if (runIndex < 0) return log("nothing to claim");
  const run = pubRec.runs[runIndex]!;
  const seed = seedFromHex(priv.seeds[runIndex]!);
  const { node, wallet, fee } = await aztec();
  // The recipient is a fresh account derived from the note seed. It sends its own claim (fees by
  // the SponsoredFPC), so no other account is linked to it.
  const recipient = await wallet.createSchnorrInitializerlessAccount(
    Fr.fromBufferReduce(seedScalar(seed, "secret")),
    Fr.fromBufferReduce(seedScalar(seed, "salt")),
    GrumpkinScalar.fromBufferReduce(seedScalar(seed, "signing")),
  );
  const idx = DENOMINATIONS.findIndex((d) => d.toString() === run.denomination);
  const leaves = decodeEpoch((await accountData(await epochPda(idx, BigInt(run.epochId))))!).leaves; // public data only
  const k = Math.min(2, run.deposits.length - 1);
  const note = await deriveNote(seed, k);
  const index = leaves.indexOf(note.commitment);
  if (index < 0) throw new Error("note not in the epoch");
  const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(pubRec.aztec.claims[run.denomination]!), wallet);
  const token = TokenContract.at(AztecAddress.fromStringUnsafe(pubRec.aztec.token), wallet);
  log(`claiming note #${k} privately (real proof)`);
  const started = Date.now();
  const { receipt } = await claim.methods
    .claim(new Fr(BigInt(run.root!)), new Fr(note.nullifierKey), new Fr(note.secret), new Fr(index), merklePath(leaves, index).map((x) => new Fr(x)), recipient.address)
    .send({ from: recipient.address, fee, wait: AZTEC_WAIT });
  Object.assign(run, { claimTx: receipt.txHash.toString(), claimedNote: k });
  run.timings!.claimed = Date.now();
  log(`claim ${run.claimTx} (${((Date.now() - started) / 1000).toFixed(0)} s incl. proving and inclusion)`);

  const { result: privBal } = await token.methods.balance_of_private(recipient.address).simulate({ from: recipient.address });
  const { result: pubBal } = await token.methods.balance_of_public(recipient.address).simulate({ from: recipient.address });
  const recipientHex = recipient.address.toString().slice(2).toLowerCase();
  const effect = JSON.stringify(await node.getTxEffect(receipt.txHash), (_k, v) => (typeof v === "bigint" ? v.toString(16) : v)).toLowerCase();
  const relayTx = await l1Pub.getTransaction({ hash: run.relayTx as Hex });
  // A second claim of the same note must be refused (its nullifier already exists).
  let doubleClaimRejected = false;
  try {
    await claim.methods
      .claim(new Fr(BigInt(run.root!)), new Fr(note.nullifierKey), new Fr(note.secret), new Fr(index), merklePath(leaves, index).map((x) => new Fr(x)), recipient.address)
      .send({ from: recipient.address, fee, wait: AZTEC_WAIT });
  } catch (e) {
    doubleClaimRejected = true;
    log(`second claim refused: ${String(e).split("\n")[0]!.slice(0, 120)}`);
  }
  run.checks = {
    "recipient private balance == one note": BigInt(privBal) === BigInt(run.denomination),
    "recipient public balance == 0": BigInt(pubBal) === 0n,
    "recipient absent from the Sepolia relay calldata": !relayTx.input.toLowerCase().includes(recipientHex),
    "recipient absent from the claim's public effects": !effect.includes(recipientHex),
    "second claim of the same note refused": doubleClaimRejected,
  };
  savePublic();
  for (const [name, ok] of Object.entries(run.checks)) log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!Object.values(run.checks).every(Boolean)) throw new Error("checks failed");
  const t = run.timings!;
  log(`testnet path OK: deposit -> claim ${(((t.claimed ?? 0) - (t.deposited ?? 0)) / 60_000).toFixed(1)} min`);
}

const phases: Record<string, (...args: string[]) => Promise<unknown>> = {
  aztec: phaseAztec,
  portal: phasePortal,
  claims: phaseClaims,
  program: phaseProgram,
  deposit: phaseDeposit,
  finish: phaseFinish,
  claim: phaseClaim,
  // finish, step by step
  burn: phaseBurn,
  relay: phaseRelay,
  register: phaseRegister,
};
const which = process.argv[2] ?? "";
try {
  if (which === "all") for (const p of ["aztec", "portal", "claims", "program", "deposit", "finish", "claim"]) await phases[p]!();
  else if (phases[which]) await phases[which](...process.argv.slice(3));
  else throw new Error(`usage: run.ts <${[...Object.keys(phases), "all"].join("|")}>`);
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
