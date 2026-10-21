/**
 * S6 full path without funds. Start the stack first: e2e/start-local-stack.sh
 *
 *   Solana (solana-test-validator: our gateway + Circle's CCTP V2 programs/state from devnet)
 *     deposit 4 x $100 seed-derived notes -> close_epoch -> send_batch (real CCTP burn + hook)
 *   "Iris" (substituted): assign nonce + executed finality
 *   Ethereum, two runs on the *same message bytes*:
 *     (a) Sepolia fork (Foundry, GatewayMessageFork.t.sol): EclypsPortal at the address the gateway
 *         committed to, Circle's real CCTP V2 contracts (test attester) and the real Aztec
 *         testnet Inbox -> root decoded == gateway root, USDC minted, Inbox message sent
 *     (b) Aztec local network L1 (no CCTP there: mock transmitter) -> Aztec Inbox
 *   Aztec (local network 6.0.0-rc.3): register_batch -> private claim of one note to a fresh
 *     account, Merkle path built from public Solana account data (no server)
 *
 * Run from scripts/ with Node >= 24.12: pnpm exec tsx e2e/local-full.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
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
import {
  type Abi,
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
  bpsOf,
  closeEpochIx,
  computeUnitLimitIx,
  configPda,
  createAssociatedTokenIdempotentIx,
  decodeBatchHook,
  decodeConfig,
  decodeEpoch,
  depositIx,
  deriveNote,
  DEVNET,
  epochPda,
  exitAuthorityPda,
  exitCustodyPda,
  EXIT_EPOCH_BLOCKS,
  feeVaultPda,
  initializeIx,
  MIN_EXIT_BATCH,
  messageFromMessageSentAccount,
  openEpochIx,
  path as merklePath,
  randomSeed,
  root as merkleRoot,
  SEPOLIA,
  sendBatchIx,
  toBytes32,
  toHex as fieldHex,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";

const SOLANA = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const L1 = process.env.L1_RPC_URL ?? "http://127.0.0.1:8545";
const AZTEC = process.env.AZTEC_NODE_URL ?? "http://127.0.0.1:8080";
const MNEMONIC = "test test test test test test test test test test test junk"; // local anvil
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const DENOMINATION = 100_000_000n;
const NOTES = 4;
const SECRET_HASH_ZERO = "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250";
const SOLANA_TMM = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893";
const SOLANA_USDC = `0x${Buffer.from(getAddressEncoder().encode(DEVNET.usdcMint)).toString("hex")}` as Hex;

const repo = new URL("../../", import.meta.url);
const local = new URL("./.local/", import.meta.url);
const t0 = Date.now();
const step = (s: string) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] == ${s}`);
const b32 = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}` as Hex;
const forge = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(new URL(`contracts/portal/out/${file}/${name}.json`, repo), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

// ---------------- Solana helpers ----------------
const rpc = createSolanaRpc(SOLANA);

async function sendSolana(ixs: Instruction[], signers: CryptoKeyPair[], feePayer: Address) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransaction(signers, compileTransaction(msg));
  const sig = await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" })
    .send();
  for (let i = 0; i < 120; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) {
      const tx = await rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, encoding: "json" }).send();
      throw new Error(`Solana tx failed: ${JSON.stringify(st.err)}\n${tx?.meta?.logMessages?.join("\n")}`);
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout confirming ${sig}`);
}

async function accountData(a: Address): Promise<Uint8Array | undefined> {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
  return value ? new Uint8Array(Buffer.from(value.data[0], "base64")) : undefined;
}

async function main() {
  // ---------------- setup ----------------
  step("connect");
  const accounts = JSON.parse(readFileSync(new URL("accounts.json", local), "utf8"));
  const user = await createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(readFileSync(new URL("user.json", local), "utf8"))),
  );
  const userUsdc = accounts.tokenAccount as Address;
  await rpc.requestAirdrop(user.address, lamports(10_000_000_000n)).send();

  const l1Account = mnemonicToAccount(MNEMONIC, { addressIndex: 7 });
  const pub = createPublicClient({ chain: foundry, transport: http(L1) });
  const wallet = createWalletClient({ account: l1Account, chain: foundry, transport: http(L1) });
  const node = createAztecNodeClient(AZTEC);
  await waitForNode(node);
  const info = await node.getNodeInfo();
  const registry = info.l1ContractAddresses.registryAddress.toString() as Hex;
  const inboxAddr = info.l1ContractAddresses.inboxAddress.toString().toLowerCase();
  const aztecWallet = await EmbeddedWallet.create(node, {
    pxe: { proverEnabled: process.env.PROVE === "1" },
  });
  const [acc0] = await getInitialTestAccountsData();
  const admin = await aztecWallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
  const recipient = await aztecWallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  console.log(`solana ${SOLANA}  L1 ${L1} (local, chain ${await pub.getChainId()})  aztec ${AZTEC} v${info.nodeVersion}`);

  step("deploy L1 (local): mock USDC + mock CCTP transmitter + EclypsPortal");
  const config = await configPda();
  const deploy = async (art: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const usdc = await deploy(forge("MockCctp.sol", "MockUSDC"), []);
  const mt = await deploy(forge("MockCctp.sol", "MockMessageTransmitter"), [usdc]);
  const portalArt = forge("EclypsPortal.sol", "EclypsPortal");
  const portal = await deploy(portalArt, [
    mt, usdc, SOLANA_TMM, SEPOLIA.tokenMessengerV2, SOLANA_USDC,
    b32(new Uint8Array(getAddressEncoder().encode(config))), registry, SECRET_HASH_ZERO,
    // Exits (ADR 0009): the gateway's exit authority and exit custody PDAs.
    b32(new Uint8Array(getAddressEncoder().encode(await exitAuthorityPda()))),
    b32(new Uint8Array(getAddressEncoder().encode(await exitCustodyPda()))),
  ]);
  console.log(`EclypsPortal ${portal}; gateway config PDA (messageSender) ${config}`);

  step("deploy Aztec EclypsMinter + Token + EclypsClaim($100), wire the minter (ADR 0020); bind on L1");
  const { contract: minter } = await EclypsMinterContract.deploy(aztecWallet, admin.address).send({ from: admin.address });
  const { contract: token } = await TokenContract.deployWithOpts(
    { method: "constructor_with_minter", wallet: aztecWallet },
    "Eclyps test USDC", "eUSDC", 6, minter.address, AztecAddress.ZERO,
  ).send({ from: admin.address });
  const { contract: claim } = await EclypsClaimContract.deploy(aztecWallet, token.address, minter.address, EthAddress.fromString(portal), DENOMINATION, EXIT_EPOCH_BLOCKS, MIN_EXIT_BATCH).send({ from: admin.address });
  const none = AztecAddress.ZERO;
  await minter.methods.wire(token.address, [claim.address, none, none, none], [DENOMINATION, 0n, 0n, 0n]).send({ from: admin.address });
  const bindHash = await wallet.writeContract({ address: portal, abi: portalArt.abi, functionName: "bindClaimContract", args: [DENOMINATION, claim.address.toString() as Hex] });
  await pub.waitForTransactionReceipt({ hash: bindHash });

  step("Solana: initialize the gateway (portal fixed in config; 0.5 % fee, 0.3 % to the finisher)");
  const treasuryOwner = (await generateKeyPairSigner()).address;
  const treasury = await associatedTokenAddress(treasuryOwner, DEVNET.usdcMint);
  await sendSolana(
    [
      await createAssociatedTokenIdempotentIx(user.address, treasuryOwner, DEVNET.usdcMint),
      await initializeIx({
        admin: user.address, usdcMint: DEVNET.usdcMint, guardian: user.address, portal,
        denominations: [DENOMINATION, 1_000_000_000n],
        params: {
          epochLenSlots: 2_250n, minBatchSize: NOTES, perEpochCap: NOTES, feeBps: 50, finisherBps: 30,
          depositCap: 50_000_000_000n, treasury,
        },
        adminLifetimeSecs: 30n * 86_400n,
      }),
    ],
    [user.keyPair], user.address,
  );

  step(`Solana: deposit ${NOTES} x $100 seed-derived notes`);
  const seed = randomSeed();
  const notes = await Promise.all(Array.from({ length: NOTES }, (_, i) => deriveNote(seed, i)));
  const epochId = decodeConfig((await accountData(config))!).currentEpoch[0]!;
  for (const n of notes) {
    await sendSolana(
      [
        await openEpochIx(user.address, 0, epochId),
        await depositIx({ payer: user.address, authority: user.address, source: userUsdc, usdcMint: DEVNET.usdcMint, denominationIndex: 0, currentEpochId: epochId, commitment: toBytes32(n.commitment) }),
      ],
      [user.keyPair], user.address,
    );
  }

  step("Solana: close_epoch (full) and send_batch through CCTP");
  await sendSolana([computeUnitLimitIx(400_000), await closeEpochIx(0, epochId)], [user.keyPair], user.address);
  const epoch = decodeEpoch((await accountData(await epochPda(0, epochId)))!);
  console.log(`epoch ${epochId}: ${epoch.status}, ${epoch.leaves.length} leaves, root ${fieldHex(epoch.root)}`);
  if (epoch.root !== merkleRoot(notes.map((n) => n.commitment))) throw new Error("on-chain root != SDK root");
  const event = await generateKeyPairSigner();
  const burnSig = await sendSolana(
    [computeUnitLimitIx(400_000), await sendBatchIx({ payer: user.address, usdcMint: DEVNET.usdcMint, messageSentEventData: event.address, denominationIndex: 0, epochId, finisherUsdc: userUsdc, treasury })],
    [user.keyPair, event.keyPair], user.address,
  );
  const usdcOf = async (a: Address) => (await rpc.getTokenAccountBalance(a).send()).value.amount;
  const [treasuryUsdc, feeVaultUsdc] = [await usdcOf(treasury), await usdcOf(await feeVaultPda())];
  console.log(`fees: treasury ${treasuryUsdc}, fee vault ${feeVaultUsdc} USDC base units`);
  const message = messageFromMessageSentAccount((await accountData(event.address))!);
  console.log(`burn ${burnSig}; CCTP message ${message.length} B, hook root ${fieldHex(decodeBatchHook(message.subarray(376)).root)}`);

  step("Iris (substituted): assign nonce + executed finality");
  const attested = new Uint8Array(message);
  attested.set(crypto.getRandomValues(new Uint8Array(32)), 12); // nonce
  new DataView(attested.buffer).setUint32(144, 2000); // finalityThresholdExecuted

  step("Ethereum (a): Sepolia fork, real CCTP V2 + real Aztec testnet Inbox (Foundry)");
  const fixture = new URL("contracts/portal/test/fixtures/gateway-local-burn.json", repo);
  writeFileSync(fixture, `${JSON.stringify({
    _note: "Produced by scripts/e2e/local-full.ts: the gateway PDA burned through Circle's CCTP V2 programs on a local validator; nonce/finality filled as Iris would.",
    message: b32(attested), portal, gatewaySender: b32(new Uint8Array(getAddressEncoder().encode(config))),
    root: fieldHex(epoch.root), epochId: Number(epochId), denomination: Number(DENOMINATION), leafCount: epoch.leaves.length,
  }, null, 2)}\n`);
  let forkOk = false;
  try {
    const out = execFileSync("forge", ["test", "--match-contract", "GatewayMessageFork"], {
      cwd: new URL("contracts/portal/", repo), env: { ...process.env, SEPOLIA_RPC_URL }, encoding: "utf8",
    });
    forkOk = /1 passed; 0 failed/.test(out);
    console.log(out.split("\n").filter((l) => /PASS|FAIL|passed/.test(l)).join("\n"));
  } catch (e) {
    console.log(`fork test failed: ${(e as { stdout?: string }).stdout ?? e}`);
  }

  step("Ethereum (b): local L1 relay into EclypsPortal -> Aztec Inbox");
  const relayHash = await wallet.writeContract({ address: portal, abi: portalArt.abi, functionName: "relay", args: [b32(attested), "0x"] });
  const relayReceipt = await pub.waitForTransactionReceipt({ hash: relayHash });
  const relayTx = await pub.getTransaction({ hash: relayHash });
  const portalUsdc = await pub.readContract({ address: usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [portal] });
  const inboxEvent = relayReceipt.logs
    .filter((l) => l.address.toLowerCase() === inboxAddr)
    .map((l) => { try { return decodeEventLog({ abi: INBOX_ABI, data: l.data, topics: l.topics }); } catch { return undefined; } })
    .find((e) => e?.eventName === "MessageSent");
  if (!inboxEvent) throw new Error("no Inbox MessageSent");
  const leafIndex = new Fr(inboxEvent.args.message.index);
  console.log(`relay ${relayHash}: gas ${relayReceipt.gasUsed}; portal holds ${portalUsdc} USDC base units; L1->L2 leaf ${leafIndex.toBigInt()}`);

  step("Aztec: register_batch (permissionless)");
  await new Promise((r) => setTimeout(r, 13_000)); // L1->L2 messages must be >= 12 s old
  for (let i = 0; i < 2; i++) await EclypsMinterContract.deploy(aztecWallet, admin.address).send({ from: admin.address });
  await claim.methods.register_batch(new Fr(epoch.root), epochId, epoch.leaves.length, leafIndex).send({ from: admin.address });

  step("Aztec: private claim of note #2 to a fresh account (path from public Solana data)");
  const k = 2;
  const publicLeaves = decodeEpoch((await accountData(await epochPda(0, epochId)))!).leaves;
  const index = publicLeaves.indexOf(notes[k]!.commitment);
  const { receipt } = await claim.methods
    .claim(new Fr(epoch.root), new Fr(notes[k]!.nullifierKey), new Fr(notes[k]!.secret), new Fr(index), merklePath(publicLeaves, index).map((x) => new Fr(x)), recipient.address)
    .send({ from: admin.address });

  step("verify");
  const { result: priv } = await token.methods.balance_of_private(recipient.address).simulate({ from: recipient.address });
  const { result: pubBal } = await token.methods.balance_of_public(recipient.address).simulate({ from: recipient.address });
  const recipientHex = recipient.address.toString().slice(2).toLowerCase();
  const effect = JSON.stringify(await node.getTxEffect(receipt.txHash), (_k, v) => (typeof v === "bigint" ? v.toString(16) : v)).toLowerCase();
  const checks = {
    "Sepolia fork: real CCTP + real Aztec testnet Inbox accept the gateway's message": forkOk,
    "recipient private balance == $100": BigInt(priv) === DENOMINATION,
    "recipient public balance == 0": BigInt(pubBal) === 0n,
    "portal holds the batch USDC": portalUsdc === DENOMINATION * BigInt(NOTES),
    "treasury got 0.2 % of the batch, fee vault empty":
      BigInt(treasuryUsdc) === BigInt(NOTES) * (bpsOf(DENOMINATION, 50) - bpsOf(DENOMINATION, 30)) && feeVaultUsdc === "0",
    "recipient absent from L1 relay calldata": !relayTx.input.toLowerCase().includes(recipientHex),
    "recipient absent from public L2 effects": !effect.includes(recipientHex),
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? `\nS6 local full path OK in ${((Date.now() - t0) / 1000).toFixed(0)} s` : "\nS6 FAILED");
  process.exit(ok ? 0 : 1);
}

const INBOX_ABI = [
  {
    type: "event",
    name: "MessageSent",
    inputs: [
      { name: "hash", type: "bytes32", indexed: true },
      { name: "inboxRollingHash", type: "bytes32", indexed: false },
      { name: "bucketSeq", type: "uint256", indexed: false },
      {
        name: "message", type: "tuple", indexed: false,
        components: [
          { name: "sender", type: "tuple", components: [{ name: "actor", type: "address" }, { name: "chainId", type: "uint256" }] },
          { name: "recipient", type: "tuple", components: [{ name: "actor", type: "bytes32" }, { name: "version", type: "uint256" }] },
          { name: "content", type: "bytes32" },
          { name: "secretHash", type: "bytes32" },
          { name: "index", type: "uint256" },
        ],
      },
    ],
  },
] as const;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
