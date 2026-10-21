/**
 * Eclyps finisher, local mode: the local stack of scripts/e2e (local validator with Circle's CCTP
 * programs, Aztec local network). Iris is substituted, the L1 transmitter is a mock, the payer is
 * airdropped and the Aztec fee payer is a prefunded test account. See main.ts and testnet.ts.
 * Exits (ADR 0009, src/exits.ts): close_exit_epoch, exitBatch through Aztec's real Outbox into the
 * recording TokenMessengerV2 at Sepolia's address, then receive_exit through Circle's real Solana
 * programs, attested by the local Iris (src/local-iris.ts). Their record is finisher-exits.json.
 *
 *   DEPLOYMENT=../scripts/e2e/.local/deployment.json pnpm --filter @eclyps/finisher local [--once]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  associatedTokenAddress,
  closeEpochIx,
  computeUnitLimitIx,
  configPda,
  createAssociatedTokenIdempotentIx,
  decodeConfig,
  decodeEpoch,
  epochPda,
  messageFromMessageSentAccount,
  sendBatchIx,
  decodeExpressEpoch,
  decodeLanes,
  EXPRESS_EPOCH_BIT,
  expressPda,
  lanesPda,
  sendExpressBatchIx,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { solanaClient } from "./chains.js";
import { aztecExitLeg, ethereumExitLeg, type ExitContext, solanaExitLeg } from "./exits.js";
import { localExitAttestation } from "./local-iris.js";
import { type ExitState, oneLine } from "./plan.js";

const DEPLOYMENT = process.env.DEPLOYMENT ?? "../scripts/e2e/.local/deployment.json";
const STATE = process.env.FINISHER_STATE ?? `${DEPLOYMENT.replace(/deployment\.json$/, "")}finisher-state.json`;
const once = process.argv.includes("--once");
const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
if (dep.network !== "local") throw new Error("local mode runs on the local stack only (testnet: pnpm --filter @eclyps/finisher testnet)");

interface BatchState {
  denomination: string;
  epochId: string;
  root?: string;
  leafCount?: number;
  messageSent?: string;
  burnSig?: string;
  l1Tx?: string;
  leafIndex?: string;
  relayedAt?: number;
  registered?: boolean;
  /** The USDC account that received this finisher's share of the batch's fees. */
  finisherUsdc?: string;
}
const state: Record<string, BatchState> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// ---------- Solana ----------
// Typed as a test cluster so requestAirdrop is available (local validator).
const rpc = createSolanaRpc(devnet(dep.solana.rpc));
const payer = await generateKeyPairSigner(); // finishers pay fees and MessageSent rent
await rpc.requestAirdrop(payer.address, lamports(5_000_000_000n)).send();
// The finisher's reward (its share of each batch's fees) lands in its own USDC account.
const finisherUsdc = await associatedTokenAddress(payer.address, dep.solana.usdcMint);

async function sendSolana(ixs: Instruction[], extra: CryptoKeyPair[] = []) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransaction([payer.keyPair, ...extra], compileTransaction(msg));
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  for (let i = 0; i < 100; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout ${sig}`);
}

async function data(a: Address) {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
  return value ? new Uint8Array(Buffer.from(value.data[0], "base64")) : undefined;
}

let rewardAccountReady = false;

async function solanaStep() {
  const cfg = decodeConfig((await data(await configPda()))!);
  if (!rewardAccountReady) {
    for (let i = 0; i < 30 && (await rpc.getBalance(payer.address).send()).value === 0n; i++) await new Promise((r) => setTimeout(r, 400));
    if (!(await data(finisherUsdc))) {
      await sendSolana([await createAssociatedTokenIdempotentIx(payer.address, payer.address, dep.solana.usdcMint)]);
      log(`created the finisher's USDC account ${finisherUsdc}`);
    }
    rewardAccountReady = true;
  }
  const slot = await rpc.getSlot().send();
  for (let idx = 0; idx < dep.denominations.length; idx++) {
    const cur = cfg.currentEpoch[idx]!;
    const open = await data(await epochPda(idx, cur));
    if (open) {
      const e = decodeEpoch(open);
      if (e.status === "Open" && (slot >= e.endSlot || e.leaves.length >= cfg.params.perEpochCap)) {
        await sendSolana([computeUnitLimitIx(400_000), await closeEpochIx(idx, cur)]);
        log(`close_epoch d=${e.denomination} epoch=${cur} (${e.leaves.length} leaves)`);
      }
    }
    const now = decodeConfig((await data(await configPda()))!).currentEpoch[idx]!;
    for (let id = 0n; id < now; id++) {
      const key = `${dep.denominations[idx]}:${id}`;
      const raw = await data(await epochPda(idx, id));
      if (!raw) continue;
      const e = decodeEpoch(raw);
      state[key] ??= { denomination: dep.denominations[idx], epochId: id.toString() };
      if (e.status === "Closed") {
        const event = await generateKeyPairSigner();
        const sig = await sendSolana(
          [computeUnitLimitIx(400_000), await sendBatchIx({ payer: payer.address, usdcMint: dep.solana.usdcMint, messageSentEventData: event.address, denominationIndex: idx, epochId: id, finisherUsdc, treasury: cfg.params.treasury })],
          [event.keyPair],
        );
        Object.assign(state[key], { root: e.root.toString(), leafCount: e.leaves.length, messageSent: event.address, burnSig: sig, finisherUsdc });
        save();
        const reward = (await rpc.getTokenAccountBalance(finisherUsdc).send()).value.uiAmountString;
        log(`send_batch d=${e.denomination} epoch=${id}: CCTP burn ${sig.slice(0, 12)}…; finisher USDC now ${reward}`);
      }
    }
  }
  // Express batches (ADR 0015), when the gateway has its V2 lanes: closed when made, sent at once.
  const lanesRaw = await data(await lanesPda());
  if (!lanesRaw) return;
  const lanes = decodeLanes(lanesRaw);
  for (let idx = 0; idx < dep.denominations.length; idx++) {
    for (let k = 0n; k < (lanes.expressNext[idx] ?? 0n); k++) {
      const id = EXPRESS_EPOCH_BIT | k;
      const key = `${dep.denominations[idx]}:${id}`;
      if (state[key]?.burnSig) continue;
      const raw = await data(await expressPda(idx, id));
      if (!raw) continue;
      const x = decodeExpressEpoch(raw);
      if (x.status !== "Closed") continue;
      state[key] ??= { denomination: dep.denominations[idx], epochId: id.toString() };
      const event = await generateKeyPairSigner();
      const sig = await sendSolana(
        [computeUnitLimitIx(400_000), await sendExpressBatchIx({ payer: payer.address, usdcMint: dep.solana.usdcMint, messageSentEventData: event.address, denominationIndex: idx, expressId: id, finisherUsdc, treasury: cfg.params.treasury })],
        [event.keyPair],
      );
      Object.assign(state[key], { root: x.root.toString(), leafCount: 1, messageSent: event.address, burnSig: sig, finisherUsdc });
      save();
      log(`send_express_batch d=${x.denomination} express=${k}: CCTP burn ${sig.slice(0, 12)}…${x.paidByPool ? " (express fee from the crossing pool)" : ""}`);
    }
  }
}

// ---------- Ethereum ----------
const pub = createPublicClient({ chain: foundry, transport: http(dep.l1.rpc) });
const l1 = createWalletClient({
  account: mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 8 }),
  chain: foundry,
  transport: http(dep.l1.rpc),
});
const portalAbi = parseAbi(["function relay(bytes message, bytes attestation) returns ((uint64,uint64,uint16,bytes32))"]);
// The portal's own event: the Inbox's `MessageSent` ABI differs between Aztec 5.x and 6.x.
const forwardedEvent = parseAbi([
  "event BatchForwarded(bytes32 indexed root, uint64 indexed denomination, uint64 indexed epochId, bytes32 content, bytes32 messageKey, uint256 messageIndex)",
]);

async function ethereumStep() {
  for (const [key, b] of Object.entries(state)) {
    if (!b.messageSent || b.l1Tx) continue;
    const raw = await data(b.messageSent as Address);
    if (!raw) continue;
    // Local stack: Iris is substituted (nonce + executed finality); the transmitter is a mock.
    const msg = new Uint8Array(messageFromMessageSentAccount(raw));
    msg.set(crypto.getRandomValues(new Uint8Array(32)), 12);
    new DataView(msg.buffer).setUint32(144, 2000);
    const hash = await l1.writeContract({ address: dep.l1.portal, abi: portalAbi, functionName: "relay", args: [`0x${Buffer.from(msg).toString("hex")}` as Hex, "0x"] });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    for (const l of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: forwardedEvent, data: l.data, topics: l.topics });
        b.leafIndex = ev.args.messageIndex.toString();
      } catch {
        /* not BatchForwarded */
      }
    }
    Object.assign(b, { l1Tx: hash, relayedAt: Date.now() });
    save();
    log(`relay ${key}: L1 tx ${hash.slice(0, 12)}…, L1->L2 leaf ${b.leafIndex}`);
  }
}

// ---------- Aztec ----------
const node = createAztecNodeClient(dep.aztec.node);
await waitForNode(node);
const aztecWallet = await EmbeddedWallet.create(node);
const [acc0] = await getInitialTestAccountsData(); // local network: prefunded fee payer
const feePayer = await aztecWallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);

async function aztecStep() {
  for (const [key, b] of Object.entries(state)) {
    if (!b.l1Tx || b.registered || b.leafIndex === undefined) continue;
    if (Date.now() - (b.relayedAt ?? 0) < 13_000) continue; // L1->L2 messages must be >= 12 s old
    const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(dep.aztec.claims[b.denomination]), aztecWallet);
    try {
      await claim.methods
        .register_batch(new Fr(BigInt(b.root!)), BigInt(b.epochId), b.leafCount!, new Fr(BigInt(b.leafIndex)))
        .send({ from: feePayer.address });
      b.registered = true;
      save();
      log(`register_batch ${key} on Aztec`);
    } catch (e) {
      // The local network only builds blocks on demand: nudge it and retry next round.
      log(`register_batch ${key} not ready (${String(e).slice(0, 80)}…); producing a block`);
      await EclypsMinterContract.deploy(aztecWallet, feePayer.address).send({ from: feePayer.address });
    }
  }
}

// ---------- exits (ADR 0009) ----------
const EXIT_STATE = STATE.replace(/finisher-state\.json$/, "finisher-exits.json");
const exitState: ExitState = existsSync(EXIT_STATE) ? JSON.parse(readFileSync(EXIT_STATE, "utf8")) : { exits: {}, exitsDoneBelow: {} };
const nudge = async () => {
  await EclypsMinterContract.deploy(aztecWallet, feePayer.address).send({ from: feePayer.address });
};
const exits: ExitContext = {
  log,
  waiting: (_key, line) => log(line),
  debug: (e) => process.env.DEBUG && console.error(e),
  stopping: () => false,
  state: exitState,
  save: () => writeFileSync(EXIT_STATE, JSON.stringify(exitState, null, 2)),
  denominations: dep.denominations.map(BigInt),
  claims: dep.aztec.claims,
  portal: dep.l1.portal,
  node,
  aztec: async () => ({ wallet: aztecWallet, from: feePayer.address }),
  waitForClose: true,
  l1: pub,
  l1w: l1,
  sol: solanaClient(dep.solana.rpc, log),
  payer,
  usdcMint: dep.solana.usdcMint,
  lookupTable: dep.solana.exitLookupTable,
  async attest(b) {
    if (!dep.l1.tokenMessenger) return { pending: "this deployment has no recording TokenMessengerV2 (redeploy with deploy-local.ts)" };
    const r = await localExitAttestation(pub, dep.l1.tokenMessenger, BigInt(b.denomination), BigInt(b.exitEpochId));
    return r ?? { pending: "no burn for this exit batch yet" };
  },
  nudge,
};
const exitsOn = dep.features?.exit === true;

do {
  try {
    await solanaStep();
    await ethereumStep();
    await aztecStep();
  } catch (e) {
    log(`error: ${e}`);
  }
  if (exitsOn) {
    for (const leg of [aztecExitLeg, ethereumExitLeg, solanaExitLeg]) {
      try {
        await leg(exits);
      } catch (e) {
        log(`exits: ${oneLine(e)}`);
        exits.debug(e);
      }
    }
  }
  if (!once) await new Promise((r) => setTimeout(r, 4000));
} while (!once);
process.exit(0);
