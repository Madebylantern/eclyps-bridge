/**
 * Open question 23, tested on the public Aztec testnet rather than asked: do the network's nodes
 * accept EclypsFPC (aztec/fpc, ADR 0018) as the fee payer of users' claims?
 *   fpc     deploy an EclypsFPC serving the testnet claim contracts, 3 slots per note (fee: the
 *           testnet's SponsoredFPC, as every testnet admin transaction)
 *   fund    mint 1,000 test Fee Juice on Sepolia (the testnet's FeeAssetHandler, open to anyone),
 *           bridge it to the FPC, and claim it on Aztec in the FPC's name
 *   claims  claim every unclaimed note the runner deposited in earlier runs, all sent at once, each
 *           paid by the FPC from slot 0 of its own note: (a) a fee payer whose setup is private only
 *           is accepted, (b) several pending transactions from one fee payer, (c) the FPC's private
 *           read of the claim contract's roots at the anchor block; then a second use of a spent
 *           slot must be refused
 * Records the results in deployments/testnet.json → fpcTest. The app keeps the SponsoredFPC
 * (`fees` unchanged). Usage: pnpm exec tsx testnet/fpc-check.mts <fpc|fund|claims|all>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts";
import { generateClaimSecret } from "@aztec-labs/aztec.js/ethereum";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging";
import { FeeJuiceContract } from "@aztec-labs/aztec.js/protocol";
import { ExecutionPayload } from "@aztec-labs/aztec.js/tx";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { Gas, GasFees } from "@aztec-labs/stdlib/gas";
import { createSolanaRpc } from "@solana/kit";
import { createPublicClient, createWalletClient, type Hex, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { decodeEpoch, deriveNote, epochPda, path as merklePath, seedFromHex, SPONSORED_GAS } from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsFPCContract } from "../../aztec/artifacts/EclypsFPC.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";
import { connectAztec } from "../../finisher/src/chains.js";

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const KEYS = process.env.ECLYPS_KEYS ?? `${homedir()}/.config/eclyps`;
const PRIVATE_DIR = `${KEYS}/testnet`;
const PUBLIC_FILE = new URL("../../deployments/testnet.json", import.meta.url);
const PRIVATE_FILE = `${PRIVATE_DIR}/state.json`;
const DENOMINATIONS = ["1000000", "10000000"];
const SLOTS = 3;
const MINT = 1_000n * 10n ** 18n;
const AZTEC_WAIT = { timeout: 1_800, interval: 5 };
const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const HANDLER = parseAbi(["function mint(address _recipient)"]);
const PORTAL = parseAbi([
  "function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash) returns (bytes32, uint256)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);

interface FpcTest {
  version?: string;
  fpc?: string;
  deployTx?: string;
  slots?: Record<string, number>;
  fund?: { amount: string; mintTx?: string; depositTx?: string; claimTx?: string };
  minFeePerMana?: string;
  claims?: { run: number; note: number; tx: string; fee?: string; block?: number; sentAtS: number; minedAtS?: number }[];
  checks?: Record<string, boolean>;
  at?: string;
}
const pubRec = JSON.parse(readFileSync(PUBLIC_FILE, "utf8"));
const priv = JSON.parse(readFileSync(PRIVATE_FILE, "utf8"));
const rec: FpcTest = (pubRec.fpcTest ??= {});
const savePublic = () => writeFileSync(PUBLIC_FILE, `${JSON.stringify(pubRec, null, 2)}\n`);
const savePrivate = () => writeFileSync(PRIVATE_FILE, JSON.stringify(priv, null, 2), { mode: 0o600 });

const conn = await connectAztec(pubRec.aztec.node, `${PRIVATE_DIR}/pxe`, priv.aztecAdmin, "sponsoredFpc");
const { node, info, wallet, account: admin, fee, register } = conn;
rec.version = info.nodeVersion;
await register(pubRec.aztec.minter, EclypsMinterContract.artifact);
await register(pubRec.aztec.token, TokenContract.artifact);
for (const c of Object.values(pubRec.aztec.claims) as string[]) await register(c, EclypsClaimContract.artifact);

async function stepFpc() {
  if (rec.fpc) return log(`EclypsFPC already deployed: ${rec.fpc}`);
  const claims = DENOMINATIONS.map((d) => AztecAddress.fromStringUnsafe(pubRec.aztec.claims[d]));
  const slots = DENOMINATIONS.map(() => SLOTS);
  while (claims.length < 4) { claims.push(AztecAddress.ZERO); slots.push(0); }
  log(`deploying EclypsFPC (real proof; ${SLOTS} slots per note)`);
  const { contract, receipt } = await EclypsFPCContract.deploy(wallet, claims, slots).send({ from: admin.address, fee, wait: AZTEC_WAIT });
  Object.assign(rec, { fpc: contract.address.toString(), deployTx: receipt.txHash.toString(), slots: Object.fromEntries(DENOMINATIONS.map((d) => [d, SLOTS])) });
  savePublic();
  log(`EclypsFPC ${rec.fpc} (tx ${rec.deployTx})`);
}

async function stepFund() {
  if (!rec.fpc) throw new Error("run the fpc step first");
  const fpc = AztecAddress.fromStringUnsafe(rec.fpc);
  if (rec.fund?.claimTx) return log(`already funded: ${(await getFeeJuiceBalance(fpc, node)) / 10n ** 18n} Fee Juice`);
  const l1 = info.l1ContractAddresses;
  const [token, portal, handler] = [l1.feeJuiceAddress, l1.feeJuicePortalAddress, l1.feeAssetHandlerAddress!].map((a) => a.toString() as Hex);
  const key = privateKeyToAccount((process.env.SEPOLIA_PRIVATE_KEY ?? readFileSync(`${KEYS}/sepolia.key`, "utf8").trim()) as Hex);
  const pub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
  const w = createWalletClient({ account: key, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const ok = async (hash: Hex, what: string) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
    return r;
  };
  rec.fund ??= { amount: MINT.toString() };
  priv.fpcTestClaim ??= {};
  const pending = priv.fpcTestClaim as { secret?: string; secretHash?: string; leafIndex?: string; messageHash?: string };
  if (!rec.fund.depositTx) {
    if (((await pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [key.address] })) as bigint) < MINT) {
      rec.fund.mintTx = await w.writeContract({ address: handler, abi: HANDLER, functionName: "mint", args: [key.address] });
      await ok(rec.fund.mintTx as Hex, "mint");
      log(`minted 1,000 test Fee Juice on Sepolia (${rec.fund.mintTx})`);
    }
    if (!pending.secret) {
      const [secret, secretHash] = await generateClaimSecret();
      Object.assign(pending, { secret: secret.toString(), secretHash: secretHash.toString() });
      savePrivate(); // before the deposit, so a crash never loses the claim secret
    }
    await ok(await w.writeContract({ address: token, abi: ERC20, functionName: "approve", args: [portal, MINT] }), "approve");
    rec.fund.depositTx = await w.writeContract({ address: portal, abi: PORTAL, functionName: "depositToAztecPublic", args: [rec.fpc as Hex, MINT, pending.secretHash as Hex] });
    const r = await ok(rec.fund.depositTx as Hex, "depositToAztecPublic");
    const ev = parseEventLogs({ abi: PORTAL, logs: r.logs, eventName: "DepositToAztecPublic" })[0]!;
    Object.assign(pending, { leafIndex: ev.args.index.toString(), messageHash: ev.args.key });
    savePrivate();
    savePublic();
    log(`bridged 1,000 Fee Juice to the FPC (Sepolia ${rec.fund.depositTx}, message leaf ${pending.leafIndex})`);
  }
  log("waiting for the L1→L2 message");
  if (!(await waitForL1ToL2MessageReady(node, Fr.fromString(pending.messageHash!), { timeoutSeconds: 1_800 }))) throw new Error("Fee Juice message not ready");
  const { receipt } = await FeeJuiceContract.withWallet(wallet).methods.claim(fpc, MINT, Fr.fromString(pending.secret!), new Fr(BigInt(pending.leafIndex!)))
    .send({ from: admin.address, fee, wait: AZTEC_WAIT });
  rec.fund.claimTx = receipt.txHash.toString();
  savePublic();
  log(`FPC holds ${(await getFeeJuiceBalance(fpc, node)) / 10n ** 18n} Fee Juice (claim ${rec.fund.claimTx})`);
}

async function stepClaims() {
  if (!rec.fund?.claimTx) throw new Error("run the fund step first");
  const fpcAddr = AztecAddress.fromStringUnsafe(rec.fpc!);
  await register(rec.fpc!, EclypsFPCContract.artifact);
  const fpc = EclypsFPCContract.at(fpcAddr, wallet);
  const solana = createSolanaRpc(pubRec.solana.rpc);
  const epochLeaves = async (denomination: string, epochId: string) => {
    const acct = await solana.getAccountInfo(await epochPda(DENOMINATIONS.indexOf(denomination), BigInt(epochId)), { encoding: "base64" }).send();
    return decodeEpoch(new Uint8Array(Buffer.from(acct.value!.data[0], "base64"))).leaves;
  };
  const gasSettings = { gasLimits: new Gas(SPONSORED_GAS.daGas, SPONSORED_GAS.l2Gas), teardownGasLimits: Gas.empty(), maxPriorityFeesPerGas: GasFees.empty() };
  const paidByFpc = async (claimAddr: string, root: Fr, note: { nullifierKey: bigint; secret: bigint }, index: number, p: Fr[], slot: number) => {
    const sponsor = await fpc.methods.sponsor(AztecAddress.fromStringUnsafe(claimAddr), root, new Fr(note.nullifierKey), new Fr(note.secret), new Fr(index), p, slot).getFunctionCall();
    const paymentMethod = {
      getAsset: async () => fpcAddr,
      getFeePayer: async () => fpcAddr,
      getGasSettings: () => undefined,
      getExecutionPayload: async () => new ExecutionPayload([sponsor], [], [], [], fpcAddr),
    };
    return { paymentMethod, gasSettings } as never;
  };

  // Every unclaimed runner note: simulated first, so notes already claimed elsewhere are skipped.
  type Job = { run: number; note: number; send: () => Promise<{ txHash: { toString(): string } }>; recipient: AztecAddress; denomination: string };
  const jobs: Job[] = [];
  for (const [r, run] of (pubRec.runs as { kind?: string; denomination: string; epochId: string; deposits: string[]; root?: string; registerTx?: string; claimedNote?: number }[]).entries()) {
    if (run.kind === "exit" || !run.registerTx || !priv.seeds[r]) continue;
    const seed = seedFromHex(priv.seeds[r]);
    const leaves = await epochLeaves(run.denomination, run.epochId);
    const claimAddr = pubRec.aztec.claims[run.denomination];
    const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(claimAddr), wallet);
    for (let k = 0; k < run.deposits.length; k++) {
      if (k === run.claimedNote) continue;
      const note = await deriveNote(seed, k);
      const index = leaves.indexOf(note.commitment);
      if (index < 0) continue;
      const p = merklePath(leaves, index).map((x) => new Fr(x));
      const root = new Fr(BigInt(run.root!));
      const recipient = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), GrumpkinScalar.random())).address;
      const call = claim.methods.claim(root, new Fr(note.nullifierKey), new Fr(note.secret), new Fr(index), p, recipient);
      try {
        await call.simulate({ from: recipient, fee: await paidByFpc(claimAddr, root, note, index, p, 0) });
      } catch (e) {
        log(`run ${r} note #${k}: skipped (${String(e).split("\n")[0]!.slice(0, 100)})`);
        continue;
      }
      jobs.push({ run: r, note: k, recipient, denomination: run.denomination, send: async () => call.send({ from: recipient, fee: await paidByFpc(claimAddr, root, note, index, p, 0), wait: NO_WAIT }) as never });
    }
  }
  if (jobs.length === 0) throw new Error("no unclaimed runner notes left: deposit a new run first (run.ts deposit, finish)");
  rec.minFeePerMana = (await node.getCurrentMinFees()).feePerL2Gas.toString();
  const before = await getFeeJuiceBalance(fpcAddr, node);
  log(`sending ${jobs.length} claims at once, each paid by EclypsFPC (real proofs; FPC holds ${before / 10n ** 18n} Fee Juice)`);
  const sent = await Promise.all(jobs.map(async (j) => {
    const { txHash } = await j.send();
    const sentAtS = Math.round((Date.now() - t0) / 1000);
    log(`run ${j.run} note #${j.note}: sent ${txHash}`);
    return { ...j, tx: txHash.toString(), sentAtS };
  }));
  const mined = await Promise.all(sent.map(async (s) => {
    for (;;) {
      const r = await node.getTxReceipt(s.tx as never);
      if (r.isMined()) {
        const minedAtS = Math.round((Date.now() - t0) / 1000);
        log(`run ${s.run} note #${s.note}: ${r.executionResult} in block ${r.blockNumber}, fee ${r.transactionFee}`);
        return { ...s, status: String(r.executionResult), block: Number(r.blockNumber), fee: r.transactionFee?.toString() ?? "0", minedAtS };
      }
      if (r.isDropped()) throw new Error(`run ${s.run} note #${s.note}: dropped (${r.error ?? r.status})`);
      await new Promise((ok) => setTimeout(ok, 5_000));
    }
  }));
  rec.claims = mined.map(({ run, note, tx, fee: f, block, sentAtS, minedAtS }) => ({ run, note, tx, fee: f, block, sentAtS, minedAtS }));
  const after = await getFeeJuiceBalance(fpcAddr, node);
  const paid = mined.reduce((s, m) => s + BigInt(m.fee), 0n);
  const token = TokenContract.at(AztecAddress.fromStringUnsafe(pubRec.aztec.token), wallet);
  const balances = await Promise.all(mined.map(async (m) => BigInt((await token.methods.balance_of_private(m.recipient).simulate({ from: m.recipient })).result)));
  const firstMined = Math.min(...mined.map((m) => m.minedAtS));
  const overlapping = mined.filter((m) => m.sentAtS < firstMined).length;

  // Slot 0 of a claimed note again, paying for a harmless call (the FPC's own config), so only the
  // spent slot can be the reason for a refusal.
  let replayRefused = false;
  const j = mined[0]!;
  const run = pubRec.runs[j.run];
  const leaves = await epochLeaves(run.denomination, run.epochId);
  const note = await deriveNote(seedFromHex(priv.seeds[j.run]), j.note);
  const index = leaves.indexOf(note.commitment);
  const p = merklePath(leaves, index).map((x) => new Fr(x));
  try {
    await fpc.methods.get_config()
      .send({ from: j.recipient, fee: await paidByFpc(pubRec.aztec.claims[run.denomination], new Fr(BigInt(run.root)), note, index, p, 0), wait: AZTEC_WAIT });
  } catch (e) {
    replayRefused = true;
    log(`spent slot refused: ${String(e).split("\n")[0]!.slice(0, 160)}`);
  }

  rec.checks = {
    "every claim paid by EclypsFPC was included and succeeded": mined.every((m) => m.status === "success"),
    "each recipient holds exactly one note privately": mined.every((m, i) => balances[i] === BigInt(m.denomination)),
    "the FPC paid exactly the claims' fees": before - after === paid && paid > 0n,
    "two or more claims were pending at once from the one fee payer": overlapping >= 2,
    "a spent sponsor slot is refused": replayRefused,
  };
  rec.at = new Date().toISOString();
  savePublic();
  for (const [name, okay] of Object.entries(rec.checks)) log(`${okay ? "PASS" : "FAIL"}  ${name}`);
  log(`${mined.length} claims, ${overlapping} pending at once, blocks ${[...new Set(mined.map((m) => m.block))].join(", ")}; fees ${mined.map((m) => (Number(BigInt(m.fee) / 10n ** 12n) / 1e6).toFixed(3)).join(", ")} Fee Juice; min fee per mana ${rec.minFeePerMana}`);
  if (!Object.values(rec.checks).every(Boolean)) throw new Error("checks failed");
}

const steps: Record<string, () => Promise<unknown>> = { fpc: stepFpc, fund: stepFund, claims: stepClaims };
const which = process.argv[2] ?? "";
try {
  if (which === "all") for (const s of ["fpc", "fund", "claims"]) await steps[s]!();
  else if (steps[which]) await steps[which]();
  else throw new Error("usage: fpc-check.mts <fpc|fund|claims|all>");
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
