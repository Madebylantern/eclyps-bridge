/**
 * S1, Solana side: burn devnet USDC through CCTP V2 `deposit_for_burn_with_hook`, carrying an
 * Eclyps batch hook (root, epoch, denomination, leaf count) to a Sepolia BatchReceiver.
 *
 *   # No keys, no funds: simulate on devnet as an existing USDC holder (sigVerify off) and
 *   # read back the MessageSent account to check that the hook sits inside the message.
 *   NODE_USE_ENV_PROXY=1 pnpm --filter @eclyps/scripts exec tsx s1-cctp/burn-with-hook.ts --simulate
 *
 *   # Real devnet burn (owner asked first; see scripts/s1-cctp/README.md):
 *   SOLANA_KEYPAIR=~/.config/solana/eclyps-devnet.json RECEIVER=0x... \
 *     NODE_USE_ENV_PROXY=1 pnpm --filter @eclyps/scripts exec tsx s1-cctp/burn-with-hook.ts --send
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import {
  CCTP,
  DEVNET,
  decodeBatchHook,
  depositForBurnWithHookIx,
  encodeBatchHook,
  evmAddressToBytes32,
  messageFromMessageSentAccount,
  root as merkleRoot,
  toHex,
} from "@eclyps/sdk";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
// Placeholder receiver for simulation only; a real run needs the deployed BatchReceiver.
const RECEIVER = process.env.RECEIVER ?? "0x00000000000000000000000000000000000ec175";
const mode = process.argv.includes("--send") ? "send" : "simulate";

// Spike batch: one 1-USDC "note" (faucet gives 20 USDC). Production uses $100 / $1,000.
const vectors = JSON.parse(
  readFileSync(new URL("../../circuits/vectors/merkle.json", import.meta.url), "utf8"),
);
const leaves: bigint[] = vectors.notes.map((n: { commitment: string }) => BigInt(n.commitment));
const batch = {
  denomination: 1_000_000n,
  epochId: BigInt(process.env.EPOCH_ID ?? Math.floor(Date.now() / 1000)),
  leafCount: 1,
  root: merkleRoot(leaves.slice(0, 1)),
};
const amount = batch.denomination * BigInt(batch.leafCount);

const rpc = createSolanaRpc(RPC_URL);

async function findHolder(): Promise<{ owner: Address; tokenAccount: Address }> {
  if (process.env.HOLDER) {
    const owner = address(process.env.HOLDER);
    return { owner, tokenAccount: await ataOf(owner) };
  }
  // Public devnet RPC disables getTokenLargestAccounts; scan recent USDC transactions instead.
  const sigs = await rpc.getSignaturesForAddress(DEVNET.usdcMint, { limit: 25 }).send();
  for (const { signature } of sigs) {
    const tx = await rpc
      .getTransaction(signature, { maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint !== DEVNET.usdcMint || !b.owner || BigInt(b.uiTokenAmount.amount) < amount) continue;
      const ownerInfo = await rpc.getAccountInfo(b.owner, { encoding: "base64" }).send();
      // Needs to pay ~0.0042 SOL rent for MessageSent: a funded system account.
      if (
        ownerInfo.value &&
        ownerInfo.value.owner === CCTP.systemProgram &&
        ownerInfo.value.lamports > 50_000_000n
      ) {
        return { owner: b.owner, tokenAccount: await ataOf(b.owner) };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("no suitable devnet USDC holder found; set HOLDER=<wallet>");
}

async function ataOf(owner: Address): Promise<Address> {
  const { value } = await rpc
    .getTokenAccountsByOwner(owner, { mint: DEVNET.usdcMint }, { encoding: "base64" })
    .send();
  if (value.length === 0) throw new Error(`${owner} has no devnet USDC token account`);
  return value[0]!.pubkey;
}

async function main() {
  const hookData = encodeBatchHook(batch);
  console.log(`mode=${mode} rpc=${RPC_URL}`);
  console.log(`hook (${hookData.length} B): 0x${Buffer.from(hookData).toString("hex")}`);
  console.log(`  root=${toHex(batch.root)} epoch=${batch.epochId} denom=${batch.denomination}`);

  let owner: Address;
  let tokenAccount: Address;
  let ownerSigner: KeyPairSigner | undefined;
  if (mode === "send") {
    const path = process.env.SOLANA_KEYPAIR;
    if (!path) throw new Error("SOLANA_KEYPAIR is required for --send");
    ownerSigner = await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
    );
    owner = ownerSigner.address;
    tokenAccount = await ataOf(owner);
  } else {
    ({ owner, tokenAccount } = await findHolder());
  }
  const eventAccount = await generateKeyPairSigner();
  console.log(`owner=${owner} burnFrom=${tokenAccount} messageSent=${eventAccount.address}`);

  const ix = await depositForBurnWithHookIx({
    owner,
    eventRentPayer: owner,
    burnTokenAccount: tokenAccount,
    messageSentEventData: eventAccount.address,
    usdcMint: DEVNET.usdcMint,
    amount,
    destinationDomain: CCTP.domains.ethereum,
    mintRecipient: evmAddressToBytes32(RECEIVER),
    destinationCaller: evmAddressToBytes32(RECEIVER),
    maxFee: 0n,
    minFinalityThreshold: CCTP.finality.standard,
    hookData,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const compiled = compileTransaction(message);

  if (mode === "simulate") {
    const wire = getBase64EncodedWireTransaction(compiled);
    const sim = await rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { addresses: [eventAccount.address], encoding: "base64" },
      })
      .send();
    const v = sim.value;
    console.log(`simulation err=${JSON.stringify(v.err)} units=${v.unitsConsumed}`);
    for (const l of v.logs ?? []) console.log(`  ${l}`);
    if (v.err) process.exit(1);
    const acc = v.accounts?.[0];
    if (!acc) throw new Error("MessageSent account not returned");
    const data = Buffer.from(acc.data[0], "base64");
    const cctpMessage = messageFromMessageSentAccount(data);
    const hookInMessage = cctpMessage.subarray(376);
    const decoded = decodeBatchHook(hookInMessage);
    console.log(`MessageSent: ${data.length} B, CCTP message ${cctpMessage.length} B`);
    console.log(`message: 0x${Buffer.from(cctpMessage).toString("hex")}`);
    const ok =
      Buffer.from(hookInMessage).equals(Buffer.from(hookData)) && decoded.root === batch.root;
    console.log(ok ? "OK: hook data is inside the burn message" : "MISMATCH");
    if (ok && process.argv.includes("--write-fixture")) {
      // Consumed by contracts/portal/test/SolanaToSepoliaFork.t.sol.
      const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
      const fixture = {
        _note:
          "CCTP message produced by simulating deposit_for_burn_with_hook against the real devnet " +
          "CCTP V2 programs (scripts/s1-cctp/burn-with-hook.ts). nonce/finalityThresholdExecuted " +
          "are zero, exactly as stored on Solana; Iris fills them in.",
        simulatedAt: new Date().toISOString(),
        message: hex(cctpMessage),
        receiver: RECEIVER,
        gatewaySender: hex(new Uint8Array(getAddressEncoder().encode(owner))),
        root: toHex(batch.root),
        epochId: batch.epochId.toString(),
        denomination: batch.denomination.toString(),
        leafCount: batch.leafCount,
      };
      const out = new URL(
        "../../contracts/portal/test/fixtures/solana-devnet-simulated-burn.json",
        import.meta.url,
      );
      writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`wrote ${out.pathname}`);
    }
    process.exit(ok ? 0 : 1);
  }

  const signed = await signTransaction([ownerSigner!.keyPair, eventAccount.keyPair], compiled);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  console.log(`sent ${sig}; polling confirmation (no websockets through the proxy)`);
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`tx failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`finalized. next: tsx s1-cctp/relay.ts ${sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
