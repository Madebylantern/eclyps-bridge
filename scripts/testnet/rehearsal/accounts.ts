/**
 * Rehearsal only: writes throwaway keys into $ECLYPS_KEYS (devnet.json, sepolia.key) and a
 * devnet-USDC token account for the Solana key as a `solana-test-validator --account` file.
 * Nothing here is funded on any real network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createKeyPairSignerFromBytes, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { DEVNET } from "@eclyps/sdk";

const dir = process.env.ECLYPS_KEYS;
if (!dir) throw new Error("ECLYPS_KEYS is required");
mkdirSync(dir, { recursive: true });

const secret = ed25519.utils.randomSecretKey();
const kp = new Uint8Array(64);
kp.set(secret, 0);
kp.set(ed25519.getPublicKey(secret), 32);
writeFileSync(`${dir}/devnet.json`, JSON.stringify(Array.from(kp)), { mode: 0o600 });
const owner = (await createKeyPairSignerFromBytes(kp)).address;

const pk = generatePrivateKey();
writeFileSync(`${dir}/sepolia.key`, pk, { mode: 0o600 });

const tokenAccount = getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const data = new Uint8Array(165); // SPL Token account
data.set(getAddressEncoder().encode(DEVNET.usdcMint), 0);
data.set(getAddressEncoder().encode(owner), 32);
new DataView(data.buffer).setBigUint64(64, 20_000_000n, true); // 20 USDC, as the faucet gives
data[108] = 1; // Initialized
writeFileSync(`${dir}/usdc-account.json`, JSON.stringify({
  pubkey: tokenAccount,
  account: { lamports: 2_039_280, data: [Buffer.from(data).toString("base64"), "base64"], owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false, rentEpoch: 0, space: 165 },
}));
console.log(JSON.stringify({ solana: owner, sepolia: privateKeyToAddress(pk), tokenAccount }));
