/**
 * S2 end to end on a local Aztec network (anvil L1 + Aztec node, `aztec start --local-network`):
 *
 *   L1: a CCTP-format batch message (mock transmitter; S1 covers real CCTP) is relayed into
 *       EclypsPortal, which keeps the USDC and sends one L1->L2 message with the batch root.
 *   L2: anyone calls EclypsClaim.register_batch (consumes the message); a note holder then
 *       claims privately to a *fresh* recipient whose address never appears on L1.
 *
 * Prereqs: `aztec start --local-network` running; `forge build` in contracts/portal;
 * `aztec compile` in aztec/; `aztec codegen aztec/target -o aztec/artifacts`.
 * Run from scripts/ with Node >= 24.12:  pnpm exec tsx s2-aztec/local-e2e.ts
 * PROVE=1 generates real client-side proofs (the local node accepts fake ones by default) and
 * reports proving time; the claim's gate profile is always printed.
 */
import { readFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { createExtendedL1Client } from "@aztec-labs/ethereum/client";
import { deployL1Contract } from "@aztec-labs/ethereum/deploy-l1-contract";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { type Abi, decodeEventLog, encodePacked, type Hex, keccak256, toHex } from "@aztec/viem";
import { getAddressEncoder } from "@solana/kit";
import {
  encodeBatchHook,
  exitAuthorityPda,
  exitCustodyPda,
  EXIT_EPOCH_BLOCKS,
  MIN_EXIT_BATCH,
  path as merklePath,
  root as merkleRoot,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";

const L1_RPC = process.env.L1_RPC_URL ?? "http://127.0.0.1:8545";
const AZTEC_NODE = process.env.AZTEC_NODE_URL ?? "http://127.0.0.1:8080";
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil default
const DENOMINATION = 100_000_000n; // $100
const EPOCH = 7n;
const SECRET_HASH_ZERO = "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250";
// CCTP constants (ADR 0002). Only the mock transmitter is local; message layout is the real one.
const SOLANA_TMM = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893";
const SOLANA_USDC = "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const GATEWAY_SENDER = keccak256(toHex("eclyps gateway PDA (local e2e)"));

const repo = new URL("../../", import.meta.url);
const forgeArtifact = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(new URL(`contracts/portal/out/${file}/${name}.json`, repo), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};
const vectors = JSON.parse(readFileSync(new URL("circuits/vectors/merkle.json", repo), "utf8"));
const step = (s: string) => console.log(`\n== ${s}`);
const b32 = (addr: string) => `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;

/** CCTP V2 burn message exactly as Iris would return it (MessageV2 + BurnMessageV2 + hook). */
function cctpMessage(portal: string, amount: bigint, hook: Uint8Array): Hex {
  const nonce = keccak256(toHex(`local nonce ${EPOCH}`));
  return encodePacked(
    [
      "uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32",
      "uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256", "bytes",
    ],
    [
      1, 5, 0, nonce, SOLANA_TMM, b32(TOKEN_MESSENGER_V2), b32(portal), 2000, 2000,
      1, SOLANA_USDC, b32(portal), amount, GATEWAY_SENDER, 0n, 0n, 0n, toHex(hook),
    ],
  );
}

async function main() {
  step("connect");
  const l1 = createExtendedL1Client([L1_RPC], MNEMONIC);
  const node = createAztecNodeClient(AZTEC_NODE);
  await waitForNode(node);
  const info = await node.getNodeInfo();
  const registry = info.l1ContractAddresses.registryAddress.toString();
  const prove = process.env.PROVE === "1";
  const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: prove } });
  const [acc0] = await getInitialTestAccountsData();
  const admin = await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
  // Fresh recipient: never used on L1, created only on the claimer's device.
  const recipient = await wallet.createSchnorrInitializerlessAccount(
    Fr.random(),
    Fr.random(),
    GrumpkinScalar.random(),
  );
  console.log(`L1 ${L1_RPC} (registry ${registry}); Aztec node ${AZTEC_NODE} v${info.nodeVersion}`);
  console.log(`claimer/admin ${admin.address}\nrecipient     ${recipient.address}`);

  step("deploy L1: mock USDC + mock CCTP transmitter + EclypsPortal");
  const usdcArt = forgeArtifact("MockCctp.sol", "MockUSDC");
  const mtArt = forgeArtifact("MockCctp.sol", "MockMessageTransmitter");
  const portalArt = forgeArtifact("EclypsPortal.sol", "EclypsPortal");
  const { address: usdc } = await deployL1Contract(l1, usdcArt.abi, usdcArt.bytecode);
  const { address: mt } = await deployL1Contract(l1, mtArt.abi, mtArt.bytecode, [usdc.toString()]);
  const { address: portal } = await deployL1Contract(l1, portalArt.abi, portalArt.bytecode, [
    mt.toString(), usdc.toString(), SOLANA_TMM, TOKEN_MESSENGER_V2, SOLANA_USDC, GATEWAY_SENDER,
    registry, SECRET_HASH_ZERO,
    // Exits (ADR 0009): the gateway's exit authority and exit custody PDAs, as bytes32.
    toHex(new Uint8Array(getAddressEncoder().encode(await exitAuthorityPda()))),
    toHex(new Uint8Array(getAddressEncoder().encode(await exitCustodyPda()))),
  ]);
  const portalHex = portal.toString() as Hex;
  console.log(`EclypsPortal ${portalHex}`);

  step("deploy L2: EclypsMinter + Token + EclypsClaim($100), the claim listed with the minter");
  const { contract: minter } = await EclypsMinterContract.deploy(wallet, admin.address).send({ from: admin.address });
  const { contract: token } = await TokenContract.deployWithOpts(
    { method: "constructor_with_minter", wallet },
    "Eclyps test USDC", "eUSDC", 6, minter.address, AztecAddress.ZERO,
  ).send({ from: admin.address });
  const { contract: claim } = await EclypsClaimContract.deploy(
    wallet, token.address, minter.address, EthAddress.fromString(portalHex), DENOMINATION, EXIT_EPOCH_BLOCKS, MIN_EXIT_BATCH,
  ).send({ from: admin.address });
  const none = AztecAddress.ZERO;
  await minter.methods.wire(token.address, [claim.address, none, none, none], [DENOMINATION, 0n, 0n, 0n]).send({ from: admin.address });
  const bindHash = await l1.writeContract({
    address: portalHex, abi: portalArt.abi, functionName: "bindClaimContract",
    args: [DENOMINATION, claim.address.toString() as Hex],
  });
  await l1.waitForTransactionReceipt({ hash: bindHash });
  console.log(`Token ${token.address}\nEclypsClaim ${claim.address}`);

  step("L1: relay the batch (16 x $100) into the portal");
  const leaves: bigint[] = vectors.notes.map((n: { commitment: string }) => BigInt(n.commitment));
  const root = merkleRoot(leaves);
  const amount = DENOMINATION * BigInt(leaves.length);
  const hook = encodeBatchHook({ denomination: DENOMINATION, epochId: EPOCH, leafCount: leaves.length, root });
  const relayHash = await l1.writeContract({
    address: portalHex, abi: portalArt.abi, functionName: "relay",
    args: [cctpMessage(portalHex, amount, hook), "0x"],
  });
  const relayReceipt = await l1.waitForTransactionReceipt({ hash: relayHash });
  // The portal's BatchForwarded, not the Inbox's MessageSent: that ABI differs between Aztec 5.x and 6.x.
  const sent = relayReceipt.logs
    .filter((l) => l.address.toLowerCase() === portalHex.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: FORWARDED_ABI, data: l.data, topics: l.topics });
      } catch {
        return undefined;
      }
    })
    .find((e) => e?.eventName === "BatchForwarded");
  if (!sent) throw new Error("no portal BatchForwarded in relay receipt");
  const leafIndex = new Fr(sent.args.messageIndex);
  console.log(`relay tx ${relayHash}; L1->L2 leaf index ${leafIndex.toBigInt()}`);
  const relayTx = await l1.getTransaction({ hash: relayHash });

  step("L2: wait for the message to be included, then register_batch (public, permissionless)");
  // Local network only produces blocks on demand; messages must be >= 12 s old (ADR 0003).
  await new Promise((r) => setTimeout(r, 13_000));
  for (let i = 0; i < 2; i++) {
    await EclypsMinterContract.deploy(wallet, admin.address).send({ from: admin.address });
  }
  await claim.methods
    .register_batch(new Fr(root), EPOCH, leaves.length, leafIndex)
    .send({ from: admin.address });
  const { result: registered } = await claim.methods.is_registered(new Fr(root)).simulate({ from: admin.address });
  console.log(`root registered: ${registered}`);

  step("L2: private claim of note #5 to the fresh recipient");
  const i = 5;
  const claimCall = (k: number) =>
    claim.methods.claim(
      new Fr(root),
      new Fr(BigInt(vectors.notes[k].nullifier_key)),
      new Fr(BigInt(vectors.notes[k].secret)),
      new Fr(k),
      merklePath(leaves, k).map((x) => new Fr(x)),
      recipient.address,
    );
  const t0 = Date.now();
  const { receipt } = await claimCall(i).send({ from: admin.address });
  console.log(`claim tx ${receipt.txHash} (block ${receipt.blockNumber}); ${prove ? "real proof" : "fake proof"} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  step("gate profile of a claim (note #6, not sent)");
  const profile = await claimCall(6).profile({ from: admin.address, profileMode: "gates" });
  let totalGates = 0;
  for (const s of profile.executionSteps) {
    totalGates += s.gateCount ?? 0;
    console.log(`  ${s.functionName.padEnd(60)} ${String(s.gateCount ?? "-").padStart(9)}`);
  }
  console.log(`  ${"total".padEnd(60)} ${String(totalGates).padStart(9)}`);

  step("verify");
  const priv = await balance(token, recipient.address, "private");
  const pub = await balance(token, recipient.address, "public");
  const recipientHex = recipient.address.toString().slice(2).toLowerCase();
  const l1Mentions = relayTx.input.toLowerCase().includes(recipientHex);
  // Everything the claim tx made public on L2 (nullifiers, note hashes, logs, public writes).
  const effect = await node.getTxEffect(receipt.txHash);
  const l2Public = JSON.stringify(effect, (_k, v) => (typeof v === "bigint" ? v.toString(16) : v)).toLowerCase();
  const l2Mentions = l2Public.includes(recipientHex);
  console.log(`recipient private balance ${priv} (expected ${DENOMINATION})`);
  console.log(`recipient public balance  ${pub} (expected 0)`);
  console.log(`recipient appears in L1 relay calldata: ${l1Mentions}`);
  console.log(`recipient appears in the claim's public L2 tx effects: ${l2Mentions}`);
  const ok = registered === true && priv === DENOMINATION && pub === 0n && !l1Mentions && !l2Mentions;
  console.log(ok ? "\nS2 OK: private note delivered; neither L1 data nor public L2 effects contain the recipient" : "\nS2 FAILED");
  process.exit(ok ? 0 : 1);
}

async function balance(token: TokenContract, who: AztecAddress, kind: "private" | "public") {
  const m = kind === "private" ? token.methods.balance_of_private(who) : token.methods.balance_of_public(who);
  const { result } = await m.simulate({ from: who });
  return BigInt(result);
}

const FORWARDED_ABI = [
  {
    type: "event",
    name: "BatchForwarded",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "denomination", type: "uint64", indexed: true },
      { name: "epochId", type: "uint64", indexed: true },
      { name: "content", type: "bytes32", indexed: false },
      { name: "messageKey", type: "bytes32", indexed: false },
      { name: "messageIndex", type: "uint256", indexed: false },
    ],
  },
] as const;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
