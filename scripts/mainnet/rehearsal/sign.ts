/**
 * Rehearsal only: plays the owner's external signer. Signs the unsigned transaction the kit wrote
 * (`--from` mode) with the rehearsal key and writes the 0x raw signed transaction.
 *   pnpm exec tsx mainnet/rehearsal/sign.ts <unsigned.json> <out.raw>
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: sign.ts <unsigned.json> <out.raw>");
const dir = process.env.ECLYPS_MAINNET_DIR;
if (!dir?.includes(".rehearsal")) throw new Error("rehearsal only");
const u = JSON.parse(readFileSync(inFile, "utf8"));
const account = privateKeyToAccount(readFileSync(`${dir}/ethereum.key`, "utf8").trim() as Hex);
const raw = await account.signTransaction({
  type: "eip1559", chainId: Number(u.chainId), nonce: Number(u.nonce), to: u.to ?? undefined, data: u.data, value: BigInt(u.value),
  gas: BigInt(u.gas), maxFeePerGas: BigInt(u.maxFeePerGas), maxPriorityFeePerGas: BigInt(u.maxPriorityFeePerGas),
});
writeFileSync(outFile, raw, { mode: 0o600 });
console.log(`signed ${inFile} as ${account.address}`);
