/**
 * Rehearsal only: a $100 crossing on the rehearsal deployment (mainnet/rehearse.sh).
 *   Solana (local validator, Circle's mainnet CCTP V2 programs and state): 4 × $100 deposits (a full
 *     epoch), close_epoch, send_batch = the real CCTP burn with the batch hook;
 *   Iris stand-in (testnet/rehearsal/iris.ts) attests with the test attester enabled on the fork;
 *   Ethereum (anvil fork of mainnet): EclypsPortal.relay → Circle's mainnet MessageTransmitterV2 and
 *     TokenMessengerV2 mint the USDC, the portal sends the L1→L2 message to the v6 Inbox;
 *   Aztec: the sandbox cannot fork mainnet, so the same message (same sender = the portal's address,
 *     same content) is replayed into the local network's Inbox from the portal's address
 *     (impersonated on the sandbox's own anvil). Then register_batch (the admin's Fee Juice) and a
 *     private claim of one note paid by EclypsFPC (a sponsor slot of that note), as on mainnet.
 * Checks: the recipient holds exactly $100 privately and the FPC paid the fee.
 */
import { readFileSync } from "node:fs";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { ExecutionPayload } from "@aztec-labs/aztec.js/tx";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { Gas, GasFees } from "@aztec-labs/stdlib/gas";
import { address } from "@solana/kit";
import { createPublicClient, createWalletClient, type Hex, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  closeEpochIx, computeUnitLimitIx, configPda, decodeConfig, decodeEpoch, deriveNote, depositIx, epochPda, openEpochIx,
  path as merklePath, randomSeed, root as merkleRoot, SPONSORED_GAS, toBytes32,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../../aztec/artifacts/EclypsClaim.js";
import { EclypsFPCContract } from "../../../aztec/artifacts/EclypsFPC.js";
import { EclypsMinterContract } from "../../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../../aztec/artifacts/Token.js";
import { BATCH_FORWARDED, connectAztec, loadSolanaKeypair, PORTAL_ABI, readRelay, sendBatchTx, solanaClient, waitForAttestation } from "../../../finisher/src/chains.js";

const dir = process.env.ECLYPS_MAINNET_DIR!;
if (!dir?.includes(".rehearsal")) throw new Error("rehearsal only");
const rec = JSON.parse(readFileSync(process.env.ECLYPS_RECORD!, "utf8"));
const priv = JSON.parse(readFileSync(`${dir}/state.json`, "utf8"));
const SOLANA = "http://127.0.0.1:8899", FORK = "http://127.0.0.1:8546", AZTEC_L1 = "http://127.0.0.1:8545", AZTEC = "http://127.0.0.1:8080";
const IRIS = process.env.IRIS_URL ?? "http://127.0.0.1:8547";
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const D = 100_000_000n;
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
const timings: Record<string, number> = {};
const mark = (k: string) => (timings[k] = Math.round((Date.now() - t0) / 1000));

// ---- Solana: a full epoch of $100 notes ----
const { rpc, send, accountData } = solanaClient(SOLANA, log);
const user = await loadSolanaKeypair(`${dir}/depositor.json`);
const source = address(JSON.parse(readFileSync(`${dir}/depositor-usdc.json`, "utf8")).pubkey);
const cfg = decodeConfig((await accountData(await configPda()))!);
const epochId = cfg.currentEpoch[0]!;
const seed = randomSeed();
const notes = await Promise.all([0, 1, 2, 3].map((i) => deriveNote(seed, i)));
for (const [i, n] of notes.entries()) {
  const sig = await send([
    await openEpochIx(user.address, 0, epochId),
    await depositIx({ payer: user.address, authority: user.address, source, usdcMint: USDC, denominationIndex: 0, currentEpochId: epochId, commitment: toBytes32(n.commitment) }),
  ], [user.keyPair], user.address);
  log(`deposit #${i} ($100.50) ${sig}`);
}
mark("deposited");
const epochAddr = await epochPda(0, epochId);
await send([computeUnitLimitIx(400_000), await closeEpochIx(0, epochId)], [user.keyPair], user.address);
const epoch = decodeEpoch((await accountData(epochAddr))!);
if (epoch.status !== "Closed" || epoch.root !== merkleRoot(epoch.leaves)) throw new Error(`epoch ${epoch.status}, root mismatch?`);
const { ixs, event } = await sendBatchTx({ payer: user.address, usdcMint: USDC, treasury: cfg.params.treasury, denominationIndex: 0, epochId });
const burnSig = await send(ixs, [user.keyPair, event.keyPair], user.address);
mark("burned");
log(`send_batch (Circle's mainnet CCTP V2 burn, 4 × $100) ${burnSig}`);
const treasuryBal = await rpc.getTokenAccountBalance(address(rec.solana.treasury)).send();
log(`treasury received ${treasuryBal.value.uiAmountString} USDC (0.2 % × 4)`);

// ---- Ethereum fork: relay through Circle's mainnet contracts into the v6 Inbox ----
const m = await waitForAttestation(IRIS, burnSig, log);
const key = privateKeyToAccount(readFileSync(`${dir}/ethereum.key`, "utf8").trim() as Hex);
const fork = createPublicClient({ transport: http(FORK) });
const forkWallet = createWalletClient({ account: key, transport: http(FORK), chain: { id: 1, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [FORK] } } } });
const hash = await forkWallet.writeContract({ address: rec.l1.portal, abi: PORTAL_ABI, functionName: "relay", args: [m.message, m.attestation] });
const receipt = await fork.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`relay reverted ${hash}`);
const r = readRelay(receipt.logs)!;
const [fwd] = parseEventLogs({ abi: [BATCH_FORWARDED], logs: receipt.logs });
if (BigInt(r.root) !== epoch.root) throw new Error("portal decoded another root");
mark("relayed");
log(`relay ${hash} (gas ${receipt.gasUsed}): v6 Inbox message ${r.l1ToL2Hash} at leaf ${r.l1ToL2Index}`);

// ---- Aztec sandbox: replay the portal's message into the local Inbox ----
const node = createAztecNodeClient(AZTEC);
const info = await node.getNodeInfo();
const aztecL1 = createPublicClient({ transport: http(AZTEC_L1) });
const portal = rec.l1.portal as Hex;
await aztecL1.request({ method: "anvil_impersonateAccount" as never, params: [portal] as never });
await aztecL1.request({ method: "anvil_setBalance" as never, params: [portal, "0x56BC75E2D63100000"] as never });
const INBOX = parseAbi(["function sendL2Message((bytes32 actor, uint256 version) recipient, bytes32 content, bytes32 secretHash) returns (bytes32, uint256)"]);
const inbox = info.l1ContractAddresses.inboxAddress.toString() as Hex;
const claimAddr = rec.aztec.claims[D.toString()] as Hex;
const args = [{ actor: claimAddr, version: BigInt(info.rollupVersion) }, fwd!.args.content!, "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250"] as const;
const { result: [msgKey, msgIndex] } = await aztecL1.simulateContract({ address: inbox, abi: INBOX, functionName: "sendL2Message", args, account: portal });
const localWallet = createWalletClient({ transport: http(AZTEC_L1) });
const mirrorTx = await localWallet.writeContract({ address: inbox, abi: INBOX, functionName: "sendL2Message", args, account: portal, chain: null });
await aztecL1.waitForTransactionReceipt({ hash: mirrorTx });
log(`replayed into the sandbox Inbox from the portal's address: message ${msgKey} at leaf ${msgIndex}`);
if (!(await waitForL1ToL2MessageReady(node, Fr.fromString(msgKey), { timeoutSeconds: 600 }))) throw new Error("L1→L2 message not ready");

// ---- register_batch (the admin pays with its Fee Juice) ----
const { wallet, account: admin, register } = await connectAztec(AZTEC, `${dir}/pxe`, priv.aztecAdmin, "feeJuice");
await register(rec.aztec.token, TokenContract.artifact);
await register(rec.aztec.minter!, EclypsMinterContract.artifact); // the claim mints through it (ADR 0020)
await register(claimAddr, EclypsClaimContract.artifact);
await register(rec.fees.eclypsFpc.address, EclypsFPCContract.artifact);
const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(claimAddr), wallet);
const reg = await claim.methods.register_batch(new Fr(epoch.root), epochId, epoch.leaves.length, new Fr(msgIndex)).send({ from: admin.address, wait: { timeout: 600, interval: 2 } });
mark("registered");
log(`register_batch ${reg.receipt.txHash} (fee ${reg.receipt.transactionFee})`);

// ---- a private claim of note #2, paid by EclypsFPC (slot 0 of that note) ----
const fpc = AztecAddress.fromStringUnsafe(rec.fees.eclypsFpc.address);
const fpcBefore = await getFeeJuiceBalance(fpc, node);
const recipient = await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
const k = 2;
const note = notes[k]!;
const index = epoch.leaves.indexOf(note.commitment);
const p = merklePath(epoch.leaves, index).map((x) => new Fr(x));
const sponsor = await EclypsFPCContract.at(fpc, wallet)
  .methods.sponsor(AztecAddress.fromStringUnsafe(claimAddr), new Fr(epoch.root), new Fr(note.nullifierKey), new Fr(note.secret), new Fr(index), p, 0)
  .getFunctionCall();
const paymentMethod = {
  getAsset: async () => fpc,
  getFeePayer: async () => fpc,
  getGasSettings: () => undefined,
  getExecutionPayload: async () => new ExecutionPayload([sponsor], [], [], [], fpc),
};
const gasSettings = { gasLimits: new Gas(SPONSORED_GAS.daGas, SPONSORED_GAS.l2Gas), teardownGasLimits: Gas.empty(), maxPriorityFeesPerGas: GasFees.empty() };
const { receipt: claimReceipt } = await claim.methods
  .claim(new Fr(epoch.root), new Fr(note.nullifierKey), new Fr(note.secret), new Fr(index), p, recipient.address)
  .send({ from: recipient.address, fee: { paymentMethod, gasSettings } as never, wait: { timeout: 600, interval: 2 } });
mark("claimed");
const token = TokenContract.at(AztecAddress.fromStringUnsafe(rec.aztec.token), wallet);
const { result: bal } = await token.methods.balance_of_private(recipient.address).simulate({ from: recipient.address });
const fpcAfter = await getFeeJuiceBalance(fpc, node);
const checks = {
  "recipient holds exactly $100 privately": BigInt(bal) === D,
  "EclypsFPC paid the claim's fee": fpcBefore - fpcAfter === claimReceipt.transactionFee && fpcAfter < fpcBefore,
  "relay gas recorded": receipt.gasUsed > 0n,
};
for (const [name, ok] of Object.entries(checks)) log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(JSON.stringify({
  crossing: { burnSig, relayTx: hash, relayGas: receipt.gasUsed.toString(), registerTx: reg.receipt.txHash.toString(), claimTx: claimReceipt.txHash.toString(), claimFee: claimReceipt.transactionFee?.toString(), timings },
}));
if (!Object.values(checks).every(Boolean)) process.exit(1);
log("rehearsal crossing OK: $100 from Solana (mainnet CCTP) to a private Aztec balance, fee paid by EclypsFPC");
process.exit(0);
