/**
 * Simulates other depositors on the local stack: each crowd wallet deposits one random note of
 * the given denomination index (see deployment.json; local: 0 = $10, 1 = $100), so a batch can fill
 * (min batch size 4). Their notes are kept in .local/crowd-notes.json, so the same strangers can
 * later claim them on Aztec and move out too (e2e/crowd-exit.ts).
 *   pnpm exec tsx e2e/crowd.ts [denominationIndex] [count<=3]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { configPda, decodeConfig, depositIx, deriveNote, openEpochIx, randomSeed, toBytes32 } from "@eclyps/sdk";

const local = new URL("./.local/", import.meta.url);
const dep = JSON.parse(readFileSync(new URL("deployment.json", local), "utf8"));
const accounts = JSON.parse(readFileSync(new URL("accounts.json", local), "utf8"));
const idx = Number(process.argv[2] ?? 0);
const count = Math.min(Number(process.argv[3] ?? 3), accounts.crowd.length);
const rpc = createSolanaRpc(dep.solana.rpc as string);
const notesFile = new URL("crowd-notes.json", local);
const kept: { denominationIndex: number; epochId: string; commitment: string; nullifierKey: string; secret: string }[] =
  existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, "utf8")) : [];

for (let i = 0; i < count; i++) {
  const kp = await createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(readFileSync(new URL(`crowd-${i + 1}.json`, local), "utf8"))),
  );
  const cfgRaw = (await rpc.getAccountInfo(await configPda(), { encoding: "base64" }).send()).value!;
  const epochId = decodeConfig(new Uint8Array(Buffer.from(cfgRaw.data[0], "base64"))).currentEpoch[idx]!;
  const note = await deriveNote(randomSeed(), 0); // a stranger's note (crowd-exit.ts may claim it)
  const ixs = [
    await openEpochIx(kp.address, idx, epochId),
    await depositIx({ payer: kp.address, authority: kp.address, source: accounts.crowd[i].tokenAccount as Address, usdcMint: dep.solana.usdcMint, denominationIndex: idx, currentEpochId: epochId, commitment: toBytes32(note.commitment) }),
  ];
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(kp.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransaction([kp.keyPair], compileTransaction(msg));
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  for (let t = 0; t < 60; t++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(`crowd deposit failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    await new Promise((r) => setTimeout(r, 400));
  }
  kept.push({ denominationIndex: idx, epochId: epochId.toString(), commitment: note.commitment.toString(), nullifierKey: note.nullifierKey.toString(), secret: note.secret.toString() });
  writeFileSync(notesFile, JSON.stringify(kept, null, 2));
  console.log(`crowd-${i + 1} deposited into epoch ${epochId}`);
}
