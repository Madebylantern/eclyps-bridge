/**
 * The round trip on the local stack (ADR 0006, 0009, 0014 §4), one run, no funds:
 *
 *   Solana     deposit 4 × $100 and 4 × $10 seed-derived notes from the user's wallet
 *   finisher   close_epoch, send_batch (Circle's real CCTP programs), relay (mock transmitter),
 *              register_batch                      — the finisher itself, running in the background
 *   Aztec      private claims of all 8 notes to a fresh account (paths from public Solana data)
 *   Aztec      leave to Solana: 4 × exit($100), each committing to a fresh Solana address
 *              leave to Ethereum: 1 × exit_to_ethereum($10), committing to a fresh Ethereum address
 *   finisher   close_exit_epoch -> (Aztec epoch proven) exitBatch through Aztec's real Outbox into
 *              the recording TokenMessengerV2 -> local Iris attests -> receive_exit through
 *              Circle's real Solana programs (v0 transaction with the lookup table)
 *   Solana     claim_exit to each fresh address; a replay is refused
 *   Ethereum   claimToEthereum by a relayer to the fresh address; a replay is refused
 *
 * Checks: exact amounts at every destination, exit custody back to 0, the portal's USDC, and no
 * destination (nor the Aztec account) in any exit transaction's public effects on Aztec.
 *
 * Prereqs: e2e/start-local-stack.sh, then e2e/deploy-local.ts (features.exit on), `forge build` in
 * contracts/portal. Run from scripts/ with Node >= 24.12: pnpm exec tsx e2e/local-roundtrip.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  type Instruction,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { createPublicClient, createWalletClient, type Hex, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  associatedTokenAddress,
  CLAIM_EXIT_COMPUTE_UNITS,
  claimExitIx,
  computeUnitLimitIx,
  configPda,
  decodeConfig,
  decodeEpoch,
  decodeExitBatch,
  depositIx,
  deriveEthereumExit,
  deriveExit,
  deriveNote,
  epochPda,
  ethereumExitContent,
  exitBatchPda,
  exitClaimed,
  exitClaimInputs,
  exitCustodyPda,
  openEpochIx,
  path as merklePath,
  randomSeed,
  toBytes32,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";
import { l2ToL1Proof, PORTAL_EXIT_ABI } from "../../finisher/src/exits.js";

const local = new URL("./.local/", import.meta.url);
const repo = new URL("../../", import.meta.url);
const dep = JSON.parse(readFileSync(new URL("deployment.json", local), "utf8"));
const MNEMONIC = "test test test test test test test test test test test junk"; // local anvil
const $100 = 100_000_000n;
const $10 = 10_000_000n;
const PHASE_TIMEOUT_MS = Number(process.env.PHASE_TIMEOUT_MS ?? 20 * 60_000);

const t0 = Date.now();
const timings: [string, number][] = [];
let mark = Date.now();
const step = (s: string) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] == ${s}`);
const lap = (name: string) => {
  timings.push([name, (Date.now() - mark) / 1000]);
  mark = Date.now();
};
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString(16) : v)).toLowerCase();

if (dep.network !== "local" || dep.features?.exit !== true || !dep.l1.tokenMessenger) {
  throw new Error("run e2e/deploy-local.ts first (a local deployment with features.exit and the recording TokenMessengerV2)");
}

// ---------------- Solana ----------------
const rpc = createSolanaRpc(dep.solana.rpc as string);
async function sendSolana(ixs: Instruction[], signers: CryptoKeyPair[], feePayer: Address) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransaction(signers, compileTransaction(msg));
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  for (let i = 0; i < 120; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) {
      const tx = await rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, encoding: "json" }).send();
      throw new Error(`Solana tx failed: ${JSON.stringify(st.err)}\n${tx?.meta?.logMessages?.join("\n")}`);
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await sleep(400);
  }
  throw new Error(`timeout confirming ${sig}`);
}
async function accountData(a: Address): Promise<Uint8Array | undefined> {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
  return value ? new Uint8Array(Buffer.from(value.data[0], "base64")) : undefined;
}
const usdcOf = async (a: Address) => BigInt((await rpc.getTokenAccountBalance(a).send().catch(() => ({ value: { amount: "0" } }))).value.amount);

// ---------------- the finisher, as an independent party ----------------
let finisher: ChildProcess | undefined;
function startFinisher() {
  finisher = spawn("pnpm", ["-s", "exec", "tsx", "src/main.ts"], {
    cwd: new URL("finisher/", repo),
    env: { ...process.env, DEPLOYMENT: new URL("deployment.json", local).pathname },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const relay = (b: Buffer) => {
    for (const line of b.toString().split("\n")) if (/close_|send_batch|relay|register_batch|exitBatch|iris|receive_exit|lookup table|failed|error|exits:/.test(line)) console.log(`  [finisher] ${line.trim()}`);
  };
  finisher.stdout!.on("data", relay);
  finisher.stderr!.on("data", relay);
}
function stopFinisher() {
  // pnpm -> tsx -> node: stop the whole group by the child's pid.
  if (finisher?.pid) {
    try {
      process.kill(-finisher.pid, "SIGTERM");
    } catch {
      finisher.kill("SIGTERM");
    }
  }
}
async function until<T>(what: string, f: () => Promise<T | undefined | false>, everyMs = 3_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - start > PHASE_TIMEOUT_MS) throw new Error(`timed out: ${what}`);
    await sleep(everyMs);
  }
}

async function main() {
  step("connect");
  const accounts = JSON.parse(readFileSync(new URL("accounts.json", local), "utf8"));
  const user = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(new URL("user.json", local), "utf8"))));
  await rpc.requestAirdrop(user.address, lamports(10_000_000_000n)).send();
  const pub = createPublicClient({ chain: foundry, transport: http(dep.l1.rpc) });
  const relayer = createWalletClient({ account: mnemonicToAccount(MNEMONIC, { addressIndex: 6 }), chain: foundry, transport: http(dep.l1.rpc) });
  const node = createAztecNodeClient(dep.aztec.node);
  await waitForNode(node);
  const info = await node.getNodeInfo();
  const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: process.env.PROVE === "1" } });
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
  const [acc0] = await getInitialTestAccountsData();
  const sender = await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
  const holder = await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const register = async (addr: string, artifact: Parameters<typeof wallet.registerContract>[1]) => {
    const instance = await node.getContract(AztecAddress.fromStringUnsafe(addr));
    if (!instance) throw new Error(`contract ${addr} not on the node`);
    await wallet.registerContract(instance, artifact);
  };
  await register(dep.aztec.token, TokenContract.artifact);
  await register(dep.aztec.minter, EclypsMinterContract.artifact); // claims mint through it (ADR 0020)
  for (const a of Object.values(dep.aztec.claims) as string[]) await register(a, EclypsClaimContract.artifact);
  const token = TokenContract.at(AztecAddress.fromStringUnsafe(dep.aztec.token), wallet);
  const claimOf = (d: bigint) => EclypsClaimContract.at(AztecAddress.fromStringUnsafe(dep.aztec.claims[d.toString()]), wallet);
  const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const l1Usdc = (who: Hex) => pub.readContract({ address: dep.l1.usdc, abi: usdcAbi, functionName: "balanceOf", args: [who] });
  console.log(`solana ${dep.solana.rpc}  L1 ${dep.l1.rpc}  aztec ${dep.aztec.node} v${info.nodeVersion}\nholder (fresh Aztec account) ${holder.address}`);
  startFinisher();
  lap("connect");

  step("Solana: deposit 4 × $100 and 4 × $10 seed-derived notes from the user's wallet");
  const seed = randomSeed();
  const denoms: bigint[] = dep.denominations.map(BigInt);
  const plan = [$100, $100, $100, $100, $10, $10, $10, $10];
  const notes = await Promise.all(plan.map((d, i) => deriveNote(seed, i).then((n) => ({ ...n, d, idx: denoms.indexOf(d) }))));
  const config = await configPda();
  for (const n of notes) {
    const epochId = decodeConfig((await accountData(config))!).currentEpoch[n.idx]!;
    await sendSolana(
      [
        await openEpochIx(user.address, n.idx, epochId),
        await depositIx({ payer: user.address, authority: user.address, source: accounts.tokenAccount as Address, usdcMint: dep.solana.usdcMint, denominationIndex: n.idx, currentEpochId: epochId, commitment: toBytes32(n.commitment) }),
      ],
      [user.keyPair], user.address,
    );
    Object.assign(n, { epochId });
  }
  lap("deposit 8 notes on Solana");

  step("finisher: close, send (CCTP burn), relay, register both batches");
  for (const d of [$100, $10]) {
    const n = notes.find((x) => x.d === d)! as (typeof notes)[number] & { epochId: bigint };
    await until(`the ${d} batch registered on Aztec`, async () => {
      const e = decodeEpoch((await accountData(await epochPda(n.idx, n.epochId)))!);
      if (e.status === "Open") return false;
      const { result } = await claimOf(d).methods.is_registered(new Fr(e.root)).simulate({ from: sender.address });
      return result ? true : false;
    });
  }
  const portalBefore = await l1Usdc(dep.l1.portal);
  check("the portal holds the two batches' USDC ($440)", portalBefore === 4n * $100 + 4n * $10);
  lap("forward: finisher carries 2 batches to Aztec");

  step("Aztec: claim all 8 notes privately to the fresh account (paths from public Solana data)");
  for (const n of notes as ((typeof notes)[number] & { epochId: bigint })[]) {
    const e = decodeEpoch((await accountData(await epochPda(n.idx, n.epochId)))!);
    const i = e.leaves.indexOf(n.commitment);
    await claimOf(n.d).methods
      .claim(new Fr(e.root), new Fr(n.nullifierKey), new Fr(n.secret), new Fr(i), merklePath(e.leaves, i).map((x) => new Fr(x)), holder.address)
      .send({ from: sender.address });
  }
  const privateBalance = async () => BigInt((await token.methods.balance_of_private(holder.address).simulate({ from: holder.address })).result);
  check("the fresh account holds $440 privately", (await privateBalance()) === 4n * $100 + 4n * $10);
  lap("claim 8 notes on Aztec");

  step("Aztec: leave to Solana (4 × exit, $100) and to Ethereum (1 × exit_to_ethereum, $10)");
  const destinations = await Promise.all([0, 1, 2, 3].map(async () => (await generateKeyPairSigner()).address));
  const solExits = await Promise.all(destinations.map((dst, i) => deriveExit(seed, i, dst)));
  const recipient = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}` as Hex;
  const ethExit = await deriveEthereumExit(seed, 0, recipient);
  const burnVia = async (d: bigint, method: "exit" | "exit_to_ethereum", commitment: bigint, nonce: bigint) => {
    const claim = claimOf(d);
    const call = await token.methods.burn_private(holder.address, d, new Fr(nonce)).getFunctionCall();
    const witness = await wallet.createAuthWit(holder.address, { caller: claim.address, call });
    const { receipt } = await claim.methods[method](new Fr(commitment), new Fr(nonce)).with({ authWitnesses: [witness] }).send({ from: holder.address, fee });
    return receipt;
  };
  const exitTxs = [];
  for (const [i, e] of solExits.entries()) exitTxs.push(await burnVia($100, "exit", e.commitment, 100n + BigInt(i)));
  const ethTx = await burnVia($10, "exit_to_ethereum", ethExit.commitment, 200n);
  check("the account's private balance fell by $410", (await privateBalance()) === 30_000_000n);
  lap("5 exits on Aztec");

  step("finisher: close_exit_epoch, exitBatch (real Outbox), Iris (local), receive_exit (real CCTP)");
  const exitBatch = await exitBatchPda(denoms.indexOf($100), 0n);
  const custody = await exitCustodyPda();
  const custodyBefore = await usdcOf(custody);
  const batch = await until("the $100 exit batch on Solana", async () => {
    const raw = await accountData(exitBatch);
    return raw ? decodeExitBatch(raw) : undefined;
  });
  lap("exit: finisher carries the batch to Solana");
  check("ExitBatch: $100, exit epoch 0, 4 exits", batch.denomination === $100 && batch.exitEpochId === 0n && batch.count === 4);
  check("exit custody received exactly $400", (await usdcOf(custody)) - custodyBefore === 4n * $100);

  step("Solana: claim_exit to each fresh address (sent by the user's wallet)");
  const { result: leavesBv } = await claimOf($100).methods.get_exit_leaves(0n).simulate({ from: sender.address });
  const leaves = (leavesBv.storage as bigint[]).slice(0, Number(leavesBv.len)).map(BigInt);
  check("the exit epoch's public leaves are the 4 commitments", leaves.length === 4 && solExits.every((e) => leaves.includes(e.commitment)));
  const claimTx = async (e: (typeof solExits)[number]) => {
    const inputs = exitClaimInputs(leaves, e.destination, e.secret);
    return [
      computeUnitLimitIx(CLAIM_EXIT_COMPUTE_UNITS),
      await claimExitIx({ payer: user.address, usdcMint: dep.solana.usdcMint, denominationIndex: denoms.indexOf($100), exitEpochId: 0n, leafIndex: inputs.leafIndex, path: inputs.path, destination: e.destination, secret: e.secret }),
    ];
  };
  for (const e of solExits) await sendSolana(await claimTx(e), [user.keyPair], user.address);
  const paid = await Promise.all(destinations.map(async (d) => usdcOf(await associatedTokenAddress(d, dep.solana.usdcMint))));
  check("each fresh Solana address holds exactly $100", paid.every((x) => x === $100));
  const after = decodeExitBatch((await accountData(exitBatch))!);
  check("all 4 leaves marked paid; exit custody back to 0", leaves.every((_, i) => exitClaimed(after, i)) && (await usdcOf(custody)) === custodyBefore);
  let replay = true;
  try {
    await sendSolana(await claimTx(solExits[0]!), [user.keyPair], user.address);
  } catch {
    replay = false;
  }
  check("a second claim_exit of the same exit is refused", !replay);
  lap("4 claims on Solana");

  step("Ethereum: claimToEthereum through the real Outbox, sent by a relayer");
  const ethMsg = computeL2ToL1MessageHash({
    l2Sender: claimOf($10).address, l1Recipient: EthAddress.fromString(dep.l1.portal),
    content: new Fr(await ethereumExitContent(ethExit.commitment, $10)),
    rollupVersion: new Fr(BigInt(info.rollupVersion)), chainId: new Fr(BigInt(info.l1ChainId)),
  });
  check("exit_to_ethereum sent exactly this L2->L1 message", (await node.getTxEffect(ethTx.txHash))?.data.l2ToL1Msgs.some((m) => m.equals(ethMsg)) === true);
  const outbox = info.l1ContractAddresses.outboxAddress.toString() as Hex;
  // The $100 exit batch went through the Outbox already, so the epoch holding this exit is proven
  // too or will be soon; the finisher keeps the local network producing blocks.
  const proof = await until("the Ethereum exit's Outbox proof", () => l2ToL1Proof(node, pub, outbox, ethMsg, ethTx.txHash.toString()));
  const claimEth = async () => {
    const hash = await relayer.writeContract({ address: dep.l1.portal, abi: PORTAL_EXIT_ABI, functionName: "claimToEthereum", args: [$10, recipient, `0x${ethExit.secret.toString(16).padStart(64, "0")}`, proof] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("claimToEthereum reverted");
    return r;
  };
  const ethReceipt = await claimEth();
  check("the fresh Ethereum address holds exactly $10", (await l1Usdc(recipient)) === $10);
  let ethReplay = true;
  try {
    await claimEth();
  } catch {
    ethReplay = false;
  }
  check("a second claimToEthereum of the same exit is refused", !ethReplay);
  check("the portal paid out exactly $410", portalBefore - (await l1Usdc(dep.l1.portal)) === 4n * $100 + $10);
  lap("claim on Ethereum");

  step("privacy: what Aztec published");
  const closeTxs = [];
  const closed = await claimOf($100).methods.get_closed_exit_epoch(0n).simulate({ from: sender.address });
  const closeBlock = await node.getBlock(Number(closed.result.closed_at) as never, { includeTransactions: true });
  for (const fx of closeBlock?.body.txEffects ?? []) if (fx.l2ToL1Msgs.length) closeTxs.push(fx);
  const effects = json([...(await Promise.all([...exitTxs, ethTx].map((r) => node.getTxEffect(r.txHash)))), ...closeTxs]);
  const hexOf = (a: Address) => Buffer.from(getAddressEncoder().encode(a)).toString("hex");
  check("no Solana destination (nor either half) in the exits' or the close's public effects",
    destinations.every((d) => !effects.includes(hexOf(d)) && !effects.includes(hexOf(d).slice(0, 32)) && !effects.includes(hexOf(d).slice(32))));
  check("no Ethereum recipient in them", !effects.includes(recipient.slice(2).toLowerCase()));
  check("no Aztec account in them", !effects.includes(holder.address.toString().slice(2).toLowerCase()));
  console.log(`claimToEthereum gas ${ethReceipt.gasUsed} (Outbox path of ${proof.path.length})`);
  lap("privacy checks");

  stopFinisher();
  console.log("\ntimings (s):");
  for (const [n, s] of timings) console.log(`  ${s.toFixed(1).padStart(7)}  ${n}`);
  const ok = checks.every(([, v]) => v);
  console.log(ok ? `\nROUND TRIP OK (${checks.length} checks) in ${((Date.now() - t0) / 1000).toFixed(0)} s` : "\nROUND TRIP FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  stopFinisher();
  process.exit(1);
});
