/**
 * Fresh keys for a hosted finisher (finisher/RAILWAY.md). Writes them to
 * ~/.config/eclyps/finisher-railway/railway.env (mode 600, outside the repo) as NAME=value lines to
 * paste into Railway's variables. Prints only the public addresses, never a private key.
 *
 *   pnpm --filter @eclyps/finisher new-keys                 # testnet
 *   pnpm --filter @eclyps/finisher new-keys -- --mainnet    # mainnet: ~/.config/eclyps/finisher-mainnet/
 *
 * Refuses to overwrite an existing file (delete it by hand to start over).
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { newAztecKeys } from "../src/chains.js";

const MAINNET = process.argv.includes("--mainnet");
const dir = process.env.NEW_KEYS_DIR ?? `${homedir()}/.config/eclyps/${MAINNET ? "finisher-mainnet" : "finisher-railway"}`;
const file = `${dir}/railway.env`;
if (existsSync(file)) {
  console.error(`${file} already exists: keys are kept, not replaced. Delete it by hand to start over.`);
  process.exit(1);
}

// ed25519: the 32-byte seed is the tail of the PKCS#8 DER, the public key the tail of the SPKI DER.
const kp = generateKeyPairSync("ed25519");
const seed = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const solBytes = [...seed, ...pub];
const sol = await createKeyPairSignerFromBytes(Uint8Array.from(solBytes));

const ethKey = generatePrivateKey();
const eth = privateKeyToAccount(ethKey);
const az = newAztecKeys();

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(
  file,
  [
    `FINISHER_SOLANA_KEY=${JSON.stringify(solBytes)}`,
    `${MAINNET ? "FINISHER_ETHEREUM_PRIVATE_KEY" : "FINISHER_SEPOLIA_PRIVATE_KEY"}=${ethKey}`,
    `FINISHER_AZTEC_SECRET=${az.secret}`,
    `FINISHER_AZTEC_SALT=${az.salt}`,
    `FINISHER_AZTEC_SIGNING_KEY=${az.signingKey}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

console.log(`keys written to ${file} (private; paste its lines into Railway, never commit)`);
console.log(`Solana ${MAINNET ? "mainnet" : "devnet"} address: ${sol.address}`);
console.log(`${MAINNET ? "Ethereum" : "Sepolia"} address:       ${eth.address}`);
