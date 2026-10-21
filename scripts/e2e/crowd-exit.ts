/**
 * Other people moving out on the local stack (ADR 0009): the crowd's notes kept by e2e/crowd.ts
 * whose batch is registered on Aztec are claimed, each to a fresh Aztec account of its own, and
 * each then leaves to a fresh Solana address with `exit`, so an exit batch can fill (the minimum is
 * 4, SDK MIN_EXIT_BATCH). Claims are sent by the local network's prefunded test account; exits by
 * their owners, with the SponsoredFPC paying, as the app does.
 *   pnpm exec tsx e2e/crowd-exit.ts [denominationIndex] [count<=3]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { type Address, createSolanaRpc, generateKeyPairSigner } from "@solana/kit";
import { decodeEpoch, deriveExit, epochPda, path as merklePath, randomSeed } from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";

const local = new URL("./.local/", import.meta.url);
const dep = JSON.parse(readFileSync(new URL("deployment.json", local), "utf8"));
const notesFile = new URL("crowd-notes.json", local);
const kept: { denominationIndex: number; epochId: string; commitment: string; nullifierKey: string; secret: string; exited?: boolean }[] = JSON.parse(readFileSync(notesFile, "utf8"));
const idx = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 3);
const d = BigInt(dep.denominations[idx]);
const rpc = createSolanaRpc(dep.solana.rpc as string);

const node = createAztecNodeClient(dep.aztec.node);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: false } });
const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) };
const [acc0] = await getInitialTestAccountsData();
const sender = await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
for (const [addr, artifact] of [[dep.aztec.token, TokenContract.artifact], [dep.aztec.claims[d.toString()], EclypsClaimContract.artifact]] as const) {
  await wallet.registerContract((await node.getContract(AztecAddress.fromStringUnsafe(addr)))!, artifact);
}
const token = TokenContract.at(AztecAddress.fromStringUnsafe(dep.aztec.token), wallet);
const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(dep.aztec.claims[d.toString()]), wallet);

let done = 0;
for (const n of kept) {
  if (done >= count) break;
  if (n.exited || n.denominationIndex !== idx) continue;
  const raw = (await rpc.getAccountInfo(await epochPda(idx, BigInt(n.epochId)), { encoding: "base64" }).send()).value;
  if (!raw) continue;
  const e = decodeEpoch(new Uint8Array(Buffer.from(raw.data[0], "base64")));
  if (e.status !== "Sent" || !(await claim.methods.is_registered(new Fr(e.root)).simulate({ from: sender.address })).result) continue;
  const owner = await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const i = e.leaves.indexOf(BigInt(n.commitment));
  await claim.methods
    .claim(new Fr(e.root), new Fr(BigInt(n.nullifierKey)), new Fr(BigInt(n.secret)), new Fr(i), merklePath(e.leaves, i).map((x) => new Fr(x)), owner.address)
    .send({ from: sender.address });
  const destination: Address = (await generateKeyPairSigner()).address;
  const exit = await deriveExit(randomSeed(), 0, destination);
  const nonce = Fr.random();
  const call = await token.methods.burn_private(owner.address, d, nonce).getFunctionCall();
  const witness = await wallet.createAuthWit(owner.address, { caller: claim.address, call });
  await claim.methods.exit(new Fr(exit.commitment), nonce).with({ authWitnesses: [witness] }).send({ from: owner.address, fee });
  n.exited = true;
  writeFileSync(notesFile, JSON.stringify(kept, null, 2));
  done++;
  console.log(`a stranger claimed a $${d / 1_000_000n} note and moved out to ${destination}`);
}
if (done < count) throw new Error(`only ${done} of ${count} crowd notes could move out (are their batches registered?)`);
process.exit(0);
