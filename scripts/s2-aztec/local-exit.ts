/**
 * Exits end to end on a local Aztec network (anvil L1 + Aztec node, `aztec start --local-network`):
 * the L2->L1 messages the claim contract really sends, consumed through Aztec's real Outbox.
 *
 *   Leave to Ethereum (ADR 0014 §4): a holder burns a note with exit_to_ethereum; once the Aztec
 *       epoch is proven, anyone calls EclypsPortal.claimToEthereum and the committed recipient is
 *       paid one denomination of the portal's USDC.
 *   Leave to Solana (ADR 0009): two exits, close_exit_epoch sends the root; EclypsPortal.exitBatch
 *       consumes it and burns through CCTP. The local L1 has no CCTP, so a mock TokenMessengerV2
 *       (contracts/portal/test/mocks) is placed at the address the portal names; it records the
 *       burn. Receiving it on Solana is the gateway's part (ADR 0009, tested in LiteSVM).
 *
 * TXE drops L2->L1 messages, so this is where their exact content, sender and recipient are checked
 * (aztec/claim_test covers the rest). It also checks that the exiting account appears in none of
 * the exit transactions' public effects, and prints the public gas of each step and the L1 gas of
 * both portal calls with the real Outbox.
 *
 * Prereqs: as local-e2e.ts (`aztec start --local-network`, `forge build` in contracts/portal,
 * `aztec compile` + codegen). Run from scripts/: pnpm exec tsx s2-aztec/local-exit.ts
 */
import { readFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { createExtendedL1Client } from "@aztec-labs/ethereum/client";
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash";
import { computeL2ToL1MembershipWitness, type L2ToL1MembershipWitness } from "@aztec-labs/stdlib/messaging";
import type { TxHash } from "@aztec-labs/stdlib/tx";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { type Abi, type Hex, keccak256, toHex } from "@aztec/viem";
import { generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import {
  deriveEthereumExit,
  deriveExit,
  ethereumExitContent,
  exitAuthorityPda,
  exitBatchContent,
  exitCustodyPda,
  randomSeed,
  root as merkleRoot,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";

const L1_RPC = process.env.L1_RPC_URL ?? "http://127.0.0.1:8545";
const AZTEC_NODE = process.env.AZTEC_NODE_URL ?? "http://127.0.0.1:8080";
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil default
const DENOMINATION = 100_000_000n; // $100
const SECRET_HASH_ZERO = "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250";
const SOLANA_TMM = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893";
const SOLANA_USDC = "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const GATEWAY_SENDER = keccak256(toHex("eclyps gateway PDA (local exit)"));
const PROOF_TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS ?? 15 * 60_000);

const repo = new URL("../../", import.meta.url);
const forgeArtifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(new URL(`contracts/portal/out/${file}/${name}.json`, repo), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex, runtime: j.deployedBytecode.object as Hex };
};
const step = (s: string) => console.log(`\n== ${s}`);
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  checks.push([name, ok]);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const hex32 = (x: bigint | Fr) => `0x${(typeof x === "bigint" ? x : x.toBigInt()).toString(16).padStart(64, "0")}` as Hex;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString(16) : v)).toLowerCase();

async function main() {
  step("connect");
  const l1 = createExtendedL1Client([L1_RPC], MNEMONIC);
  const node = createAztecNodeClient(AZTEC_NODE);
  await waitForNode(node);
  const info = await node.getNodeInfo();
  const registry = info.l1ContractAddresses.registryAddress.toString();
  const outboxAddr = info.l1ContractAddresses.outboxAddress.toString() as Hex;
  // The Outbox's roots per epoch (slot i: the proof covering i + 1 checkpoints), as OutboxContract
  // reads them; that class's module pulls in an export this workspace cannot resolve.
  const outbox = {
    getRoots: async (epoch: bigint | number) =>
      Promise.all(
        Array.from({ length: 32 }, async (_, i) =>
          Fr.fromHexString((await l1.readContract({ address: outboxAddr, abi: OUTBOX_ABI, functionName: "getRootData", args: [BigInt(epoch), BigInt(i + 1)] })) as Hex),
        ),
      ),
  };
  const chainId = new Fr(BigInt(info.l1ChainId));
  const rollupVersion = new Fr(BigInt(info.rollupVersion));
  const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: false } });
  const [acc0, acc1] = await getInitialTestAccountsData();
  const admin = await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
  const holder = await wallet.createSchnorrInitializerlessAccount(acc1!.secret, acc1!.salt, acc1!.signingKey);
  console.log(`Aztec node v${info.nodeVersion}, rollup ${rollupVersion.toBigInt()}, L1 chain ${chainId.toBigInt()}`);
  console.log(`admin ${admin.address}\nholder ${holder.address}`);

  step("deploy L1: mock USDC + mock CCTP + EclypsPortal (real registry, so the real Outbox)");
  const usdcArt = forgeArtifact("MockCctp.sol", "MockUSDC");
  const mtArt = forgeArtifact("MockCctp.sol", "MockMessageTransmitter");
  const tmArt = forgeArtifact("MockCctp.sol", "MockTokenMessengerV2");
  const portalArt = forgeArtifact("EclypsPortal.sol", "EclypsPortal");
  // viem directly: @aztec-labs/ethereum/deploy-l1-contract does not resolve in this workspace
  // (@noble/curves/bn254 export).
  const deploy = async (art: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => {
    const hash = await l1.deployContract({ abi: art.abi, bytecode: art.bytecode, args } as never);
    const { contractAddress } = await l1.waitForTransactionReceipt({ hash });
    return contractAddress! as Hex;
  };
  const usdcHex = await deploy(usdcArt);
  const mt = await deploy(mtArt, [usdcHex]);
  await l1.request({ method: "anvil_setCode" as never, params: [TOKEN_MESSENGER_V2, tmArt.runtime] as never });
  const portal = await deploy(portalArt, [
    mt, usdcHex, SOLANA_TMM, TOKEN_MESSENGER_V2, SOLANA_USDC, GATEWAY_SENDER,
    registry, SECRET_HASH_ZERO,
    toHex(new Uint8Array(getAddressEncoder().encode(await exitAuthorityPda()))),
    toHex(new Uint8Array(getAddressEncoder().encode(await exitCustodyPda()))),
  ]);
  const l1Write = async (address: Hex, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await l1.writeContract({ address, abi, functionName, args } as never);
    const receipt = await l1.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  };
  const usdcBalance = async (who: Hex) =>
    (await l1.readContract({ address: usdcHex, abi: usdcArt.abi, functionName: "balanceOf", args: [who] })) as bigint;
  console.log(`EclypsPortal ${portal}; Outbox ${outboxAddr}`);

  step("deploy L2: EclypsMinter + Token + EclypsClaim($100, exit epochs of 2 blocks, at least 1 exit); bind");
  const { contract: minter } = await EclypsMinterContract.deploy(wallet, admin.address).send({ from: admin.address });
  const { contract: token } = await TokenContract.deployWithOpts(
    { method: "constructor_with_minter", wallet },
    "Eclyps test USDC", "eUSDC", 6, minter.address, AztecAddress.ZERO,
  ).send({ from: admin.address });
  const { contract: claim } = await EclypsClaimContract.deploy(wallet, token.address, minter.address, EthAddress.fromString(portal), DENOMINATION, 2, 1).send({ from: admin.address });
  // The admin is listed too: it mints the notes the holder would have claimed.
  const none = AztecAddress.ZERO;
  await minter.methods.wire(token.address, [claim.address, admin.address, none, none], [DENOMINATION, DENOMINATION, 0n, 0n]).send({ from: admin.address });
  await l1Write(portal, portalArt.abi, "bindClaimContract", [DENOMINATION, claim.address.toString()]);
  // Notes the holder would have claimed, and the USDC backing them in the portal.
  for (let i = 0; i < 4; i++) await minter.methods.mint_to_private(holder.address, DENOMINATION).send({ from: admin.address });
  await l1Write(usdcHex, usdcArt.abi, "mint", [portal, 3n * DENOMINATION]);
  console.log(`Token ${token.address}\nEclypsClaim ${claim.address}`);

  const holderHex = holder.address.toString().slice(2).toLowerCase();
  const messageHash = (content: bigint) =>
    computeL2ToL1MessageHash({ l2Sender: claim.address, l1Recipient: EthAddress.fromString(portal), content: new Fr(content), rollupVersion, chainId });
  /** Burns one denomination through `method` with the holder's authwit for the claim contract. */
  const burnVia = async (method: "exit" | "exit_to_ethereum", commitment: bigint, nonce: bigint) => {
    const call = await token.methods.burn_private(holder.address, DENOMINATION, new Fr(nonce)).getFunctionCall();
    const witness = await wallet.createAuthWit(holder.address, { caller: claim.address, call });
    const action = claim.methods[method](new Fr(commitment), new Fr(nonce)).with({ authWitnesses: [witness] });
    const { gasUsed } = await action.simulate({ from: holder.address, includeMetadata: true });
    const { receipt } = await action.send({ from: holder.address });
    return { receipt, gasUsed };
  };
  const privateBalance = async (who: AztecAddress) =>
    BigInt((await token.methods.balance_of_private(who).simulate({ from: who })).result);

  step("leave to Ethereum: exit_to_ethereum (private)");
  const seed = randomSeed();
  const recipient = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}` as Hex;
  const eth = await deriveEthereumExit(seed, 0, recipient);
  const ethTx = await burnVia("exit_to_ethereum", eth.commitment, 1n);
  const ethContent = await ethereumExitContent(eth.commitment, DENOMINATION);
  const ethEffect = await node.getTxEffect(ethTx.receipt.txHash);
  const ethMsg = messageHash(ethContent);
  console.log(`tx ${ethTx.receipt.txHash} (block ${ethTx.receipt.blockNumber}); gas ${json(ethTx.gasUsed)}`);
  check("exit_to_ethereum: one L2->L1 message, from the claim contract to the portal, content = SDK ethereumExitContent",
    ethEffect?.data.l2ToL1Msgs.length === 1 && ethEffect.data.l2ToL1Msgs[0]!.equals(ethMsg));
  check("exit_to_ethereum: the holder's address is in none of the tx's public effects", !json(ethEffect).includes(holderHex));
  check("exit_to_ethereum: the holder's private balance fell by one denomination", (await privateBalance(holder.address)) === 3n * DENOMINATION);

  step("leave to Solana: two exits, then close_exit_epoch (public, permissionless)");
  const destinations = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
  const solExits = [await deriveExit(seed, 0, destinations[0]!), await deriveExit(seed, 1, destinations[1]!)];
  const exitTxs = [];
  for (const [i, e] of solExits.entries()) exitTxs.push(await burnVia("exit", e.commitment, 10n + BigInt(i)));
  for (const t of exitTxs) console.log(`exit tx ${t.receipt.txHash}; gas ${json(t.gasUsed)}`);
  for (const t of exitTxs) {
    const fx = await node.getTxEffect(t.receipt.txHash);
    check(`exit ${t.receipt.txHash.toString().slice(0, 10)}: no L2->L1 message, no holder address in public effects`,
      fx?.data.l2ToL1Msgs.length === 0 && !json(fx).includes(holderHex));
  }
  const { result: leavesBv } = await claim.methods.get_exit_leaves(0n).simulate({ from: admin.address });
  const leaves = (leavesBv.storage as bigint[]).slice(0, Number(leavesBv.len)).map(BigInt);
  check("the exit epoch's public leaves are the two commitments, in order",
    leaves.length === 2 && leaves[0] === solExits[0]!.commitment && leaves[1] === solExits[1]!.commitment);
  // The epoch ends 2 blocks after deployment: long past by now.
  const close = claim.methods.close_exit_epoch();
  const { gasUsed: closeGas } = await close.simulate({ from: admin.address, includeMetadata: true });
  const { receipt: closeReceipt } = await close.send({ from: admin.address });
  const root = merkleRoot(leaves);
  const batchContent = await exitBatchContent(root, 2, 0n, DENOMINATION);
  const closeEffect = await node.getTxEffect(closeReceipt.txHash);
  const batchMsg = messageHash(batchContent);
  console.log(`close tx ${closeReceipt.txHash} (block ${closeReceipt.blockNumber}); gas ${json(closeGas)}`);
  check("close: one L2->L1 message, content = SDK exitBatchContent(SDK root of the leaves, 2, 0, $100)",
    closeEffect?.data.l2ToL1Msgs.length === 1 && closeEffect.data.l2ToL1Msgs[0]!.equals(batchMsg));
  const { result: closed } = await claim.methods.get_closed_exit_epoch(0n).simulate({ from: admin.address });
  check("close: the recorded root and content are the SDK's", BigInt(closed.root) === root && BigInt(closed.content) === batchContent);

  step("wait for the Aztec epoch to be proven and its L2->L1 root to reach the Outbox");
  const witnessFor = async (msg: Fr, tx: TxHash): Promise<L2ToL1MembershipWitness> => {
    const t0 = Date.now();
    for (;;) {
      const w = await computeL2ToL1MembershipWitness(node, outbox, msg, tx);
      if (w) return w;
      if (Date.now() - t0 > PROOF_TIMEOUT_MS) throw new Error(`no proven root for ${msg} after ${PROOF_TIMEOUT_MS} ms`);
      // The local network builds blocks on demand: keep it moving so epochs end and get proven.
      await EclypsMinterContract.deploy(wallet, admin.address).send({ from: admin.address });
      await new Promise((r) => setTimeout(r, 4_000));
    }
  };
  const t0 = Date.now();
  const ethWitness = await witnessFor(ethMsg, ethTx.receipt.txHash);
  const batchWitness = await witnessFor(batchMsg, closeReceipt.txHash);
  console.log(`proven after ${((Date.now() - t0) / 1000).toFixed(0)} s: epochs ${ethWitness.epochNumber} and ${batchWitness.epochNumber}`);
  const proof = (w: L2ToL1MembershipWitness) => ({
    epoch: BigInt(w.epochNumber),
    numCheckpointsInEpoch: BigInt(w.numCheckpointsInEpoch),
    leafIndex: w.leafIndex,
    path: w.siblingPath.toBufferArray().map((b) => toHex(b)),
  });

  step("L1: claimToEthereum through the real Outbox, sent by a relayer (not the recipient)");
  const before = await usdcBalance(recipient);
  const ethClaim = await l1Write(portal, portalArt.abi, "claimToEthereum", [DENOMINATION, recipient, hex32(eth.secret), proof(ethWitness)]);
  console.log(`claimToEthereum gas ${ethClaim.gasUsed} (path of ${ethWitness.siblingPath.pathSize})`);
  check("claimToEthereum pays the recipient exactly one denomination", (await usdcBalance(recipient)) - before === DENOMINATION);
  let replayed = true;
  try {
    await l1Write(portal, portalArt.abi, "claimToEthereum", [DENOMINATION, recipient, hex32(eth.secret), proof(ethWitness)]);
  } catch {
    replayed = false;
  }
  check("a second claimToEthereum of the same exit is refused", !replayed);

  step("L1: exitBatch through the real Outbox (burn into the mock TokenMessengerV2)");
  const batch = await l1Write(portal, portalArt.abi, "exitBatch", [hex32(root), 2, 0n, DENOMINATION, proof(batchWitness)]);
  console.log(`exitBatch gas ${batch.gasUsed} (path of ${batchWitness.siblingPath.pathSize})`);
  const exited = (await l1.readContract({ address: portal, abi: portalArt.abi, functionName: "exited", args: [DENOMINATION, 0n] })) as boolean;
  check("exitBatch consumed the close's message and burned 2 x $100", exited && (await usdcBalance(portal)) === 0n);

  step("gate profiles of an exit and an exit to Ethereum (the holder's fourth note, not sent)");
  for (const method of ["exit", "exit_to_ethereum"] as const) {
    const call = await token.methods.burn_private(holder.address, DENOMINATION, new Fr(99n)).getFunctionCall();
    const witness = await wallet.createAuthWit(holder.address, { caller: claim.address, call });
    const profile = await claim.methods[method](new Fr(eth.commitment), new Fr(99n))
      .with({ authWitnesses: [witness] })
      .profile({ from: holder.address, profileMode: "gates" });
    let total = 0;
    for (const s of profile.executionSteps) {
      total += s.gateCount ?? 0;
      console.log(`  ${s.functionName.padEnd(60)} ${String(s.gateCount ?? "-").padStart(9)}`);
    }
    console.log(`  ${`total (${method})`.padEnd(60)} ${String(total).padStart(9)}`);
  }

  const ok = checks.every(([, v]) => v);
  console.log(ok ? `\nEXITS OK (${checks.length} checks)` : "\nEXITS FAILED");
  process.exit(ok ? 0 : 1);
}

const OUTBOX_ABI = [
  {
    type: "function",
    name: "getRootData",
    stateMutability: "view",
    inputs: [{ name: "_epoch", type: "uint256" }, { name: "_numCheckpointsInEpoch", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
