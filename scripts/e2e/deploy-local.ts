/**
 * Deploys a fresh Eclyps instance onto the local stack (e2e/start-local-stack.sh) and writes
 * scripts/e2e/.local/deployment.json (+ app/public/deployment.json for the UI):
 *   L1:    no CCTP on the local L1, so mocks stand in: a mock USDC and a recording TokenMessengerV2
 *          at Sepolia's USDC and TokenMessengerV2 addresses (the portal burns exactly what it would
 *          burn on Sepolia, and Solana's CCTP pairs that USDC with its own), a mock transmitter
 *          for the forward relay, and EclypsPortal
 *   Aztec: EclypsMinter, Token (eUSDC, AIP-20, minted only through EclypsMinter) and one
 *          EclypsClaim per denomination, wired to the minter (ADR 0020); bound on L1
 *   Solana: gateway initialized with the portal, $10 / $100 / $1,000 / $10,000, min batch 4, cap 4,
 *           fee 0.5 % (0.3 % to the finisher), a $50,000 deposit cap and a treasury USDC account of
 *           its own (ADR 0012)
 * Run from scripts/ with Node >= 24.12: pnpm exec tsx e2e/deploy-local.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { type Abi, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  associatedTokenAddress,
  configPda,
  createAssociatedTokenIdempotentIx,
  DEVNET,
  exitAuthorityPda,
  exitCustodyPda,
  EXIT_EPOCH_BLOCKS,
  GATEWAY_PROGRAM_ID,
  initializeIx,
  MIN_EXIT_BATCH,
  type Params,
  SEPOLIA,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";

const SOLANA = "http://127.0.0.1:8899";
const L1 = "http://127.0.0.1:8545";
const AZTEC = "http://127.0.0.1:8080";
const MNEMONIC = "test test test test test test test test test test test junk";
const DENOMINATIONS = [10_000_000n, 100_000_000n, 1_000_000_000n, 10_000_000_000n];
const SECRET_HASH_ZERO = "0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250";
const SOLANA_TMM = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893";

const repo = new URL("../../", import.meta.url);
const local = new URL("./.local/", import.meta.url);
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex;
const forge = (file: string, name: string) => {
  const j = JSON.parse(readFileSync(new URL(`contracts/portal/out/${file}/${name}.json`, repo), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

const accounts = JSON.parse(readFileSync(new URL("accounts.json", local), "utf8"));
const user = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(new URL("user.json", local), "utf8"))),
);
const rpc = createSolanaRpc(SOLANA);
for (const a of [user.address, ...accounts.crowd.map((c: { owner: string }) => c.owner)]) {
  await rpc.requestAirdrop(a, lamports(10_000_000_000n)).send();
}

// ---- L1 ----
const l1Account = mnemonicToAccount(MNEMONIC, { addressIndex: 7 });
const pub = createPublicClient({ chain: foundry, transport: http(L1) });
const wallet = createWalletClient({ account: l1Account, chain: foundry, transport: http(L1) });
const deploy = async (art: { abi: Abi; bytecode: Hex }, args: unknown[]) => {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
};
const node = createAztecNodeClient(AZTEC);
await waitForNode(node);
const info = await node.getNodeInfo();
const config = await configPda();
// Exits (ADR 0009): the portal burns through the TokenMessengerV2 it names; the local Iris
// (finisher/src/local-iris.ts) turns the recorded burn into the message Circle would attest.
const runtime = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`contracts/portal/out/${file}/${name}.json`, repo), "utf8")).deployedBytecode.object as Hex;
const usdc = SEPOLIA.usdc as Hex;
await pub.request({ method: "anvil_setCode" as never, params: [usdc, runtime("MockCctp.sol", "MockUSDC")] as never });
await pub.request({ method: "anvil_setCode" as never, params: [SEPOLIA.tokenMessengerV2, runtime("MockCctp.sol", "MockTokenMessengerV2")] as never });
const mt = await deploy(forge("MockCctp.sol", "MockMessageTransmitter"), [usdc]);
const portalArt = forge("EclypsPortal.sol", "EclypsPortal");
const solanaUsdc = hex(new Uint8Array(getAddressEncoder().encode(DEVNET.usdcMint)));
const portal = await deploy(portalArt, [
  mt, usdc, SOLANA_TMM, SEPOLIA.tokenMessengerV2, solanaUsdc,
  hex(new Uint8Array(getAddressEncoder().encode(config))),
  info.l1ContractAddresses.registryAddress.toString(), SECRET_HASH_ZERO,
  // Exits (ADR 0009): the gateway's exit authority (CCTP destinationCaller) and exit custody
  // (mintRecipient).
  hex(new Uint8Array(getAddressEncoder().encode(await exitAuthorityPda()))),
  hex(new Uint8Array(getAddressEncoder().encode(await exitCustodyPda()))),
]);
console.log(`L1: usdc ${usdc} transmitter ${mt} portal ${portal}`);

// ---- Aztec ----
const aztecWallet = await EmbeddedWallet.create(node);
const [acc0] = await getInitialTestAccountsData();
const admin = await aztecWallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
// ADR 0020: the minter, then the token naming it as its only minter, then the claims; one wiring
// call gives the minter the token and the claims.
const { contract: minter } = await EclypsMinterContract.deploy(aztecWallet, admin.address).send({ from: admin.address });
const { contract: token } = await TokenContract.deployWithOpts(
  { method: "constructor_with_minter", wallet: aztecWallet },
  "Eclyps test USDC", "eUSDC", 6, minter.address, AztecAddress.ZERO,
).send({ from: admin.address });
const claims: string[] = [];
for (const d of DENOMINATIONS) {
  const { contract: claim } = await EclypsClaimContract.deploy(aztecWallet, token.address, minter.address, EthAddress.fromString(portal), d, EXIT_EPOCH_BLOCKS, MIN_EXIT_BATCH).send({ from: admin.address });
  const h = await wallet.writeContract({ address: portal, abi: portalArt.abi, functionName: "bindClaimContract", args: [d, claim.address.toString() as Hex] });
  await pub.waitForTransactionReceipt({ hash: h });
  claims.push(claim.address.toString());
}
const pad = <T>(xs: T[], z: T) => [...xs, ...Array(4 - xs.length).fill(z)] as T[];
await minter.methods.wire(
  token.address,
  pad(claims.map((c) => AztecAddress.fromStringUnsafe(c)), AztecAddress.ZERO),
  pad([...DENOMINATIONS], 0n),
).send({ from: admin.address });
console.log(`Aztec: minter ${minter.address} token ${token.address} claims ${claims.join(", ")}`);

// ---- Solana ----
// The treasury is a USDC account of a key of its own, so its fees stay apart from the demo user's.
const treasuryOwner = (await generateKeyPairSigner()).address;
const treasury = await associatedTokenAddress(treasuryOwner, DEVNET.usdcMint);
const params: Params = {
  epochLenSlots: 2_250n, minBatchSize: 4, perEpochCap: 4,
  feeBps: 50, finisherBps: 30, // 0.5 %: 0.3 % to whoever sends the batch, 0.2 % to the treasury
  depositCap: 50_000_000_000n, // $50,000: more than the local wallets hold
  treasury,
};
const ixs = [
  await createAssociatedTokenIdempotentIx(user.address, treasuryOwner, DEVNET.usdcMint),
  await initializeIx({
    admin: user.address,
    usdcMint: DEVNET.usdcMint,
    guardian: user.address,
    portal,
    denominations: DENOMINATIONS,
    params,
    adminLifetimeSecs: 30n * 86_400n,
  }),
];
const { value: blockhash } = await rpc.getLatestBlockhash().send();
const msg = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(user.address, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstructions(ixs, m),
);
const signed = await signTransaction([user.keyPair], compileTransaction(msg));
const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
for (let i = 0; i < 60; i++) {
  const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
  if (st?.err) throw new Error(`initialize failed: ${JSON.stringify(st.err)}`);
  if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
  await new Promise((r) => setTimeout(r, 400));
}

const deployment = {
  network: "local",
  solana: { rpc: SOLANA, gateway: GATEWAY_PROGRAM_ID, usdcMint: DEVNET.usdcMint, config, treasury },
  l1: { rpc: L1, chainId: 31337, portal, usdc, transmitter: mt, tokenMessenger: SEPOLIA.tokenMessengerV2, mock: true },
  aztec: {
    node: AZTEC,
    token: token.address.toString(),
    minter: minter.address.toString(),
    claims: Object.fromEntries(DENOMINATIONS.map((d, i) => [d.toString(), claims[i]])),
  },
  denominations: DENOMINATIONS.map(String),
  // As initialized; the app reads the live values (fee, cap) from the gateway config.
  params: {
    minBatchSize: 4, perEpochCap: 4, epochLenSlots: 2250,
    feeBps: params.feeBps, finisherBps: params.finisherBps, depositCap: params.depositCap.toString(),
  },
  features: { exit: true, exitEthereum: true }, // ADR 0009 / 0014 §4: the round trip runs locally
  // Totality (ADR 0007): the weekly crossing window, Sundays 20:00-21:00 UTC from Totality #1.
  totality: { weekday: 0, hourUtc: 20, minutes: 60, first: "2026-10-18T20:00:00Z" },
};
writeFileSync(new URL("deployment.json", local), JSON.stringify(deployment, null, 2));
mkdirSync(new URL("app/public/", repo), { recursive: true });
writeFileSync(new URL("app/public/deployment.json", repo), JSON.stringify(deployment, null, 2));
console.log("wrote scripts/e2e/.local/deployment.json and app/public/deployment.json");
process.exit(0);
