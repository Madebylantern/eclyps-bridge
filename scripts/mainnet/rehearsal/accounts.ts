/**
 * Rehearsal only: throwaway keys in $ECLYPS_MAINNET_DIR (solana-admin.json, depositor.json,
 * ethereum.key) and a mainnet-USDC token account for the depositor as a `solana-test-validator
 * --account` file ($1,000). Nothing here is funded on any real network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createKeyPairSignerFromBytes, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const dir = process.env.ECLYPS_MAINNET_DIR;
if (!dir || !dir.includes(".rehearsal")) throw new Error("ECLYPS_MAINNET_DIR must be the rehearsal's private dir");
mkdirSync(dir, { recursive: true, mode: 0o700 });

async function solanaKey(file: string) {
  const secret = ed25519.utils.randomSecretKey();
  const kp = new Uint8Array(64);
  kp.set(secret, 0);
  kp.set(ed25519.getPublicKey(secret), 32);
  writeFileSync(`${dir}/${file}`, JSON.stringify(Array.from(kp)), { mode: 0o600 });
  return (await createKeyPairSignerFromBytes(kp)).address;
}
const admin = await solanaKey("solana-admin.json");
const guardian = await solanaKey("solana-guardian.json");
const depositor = await solanaKey("depositor.json");
const pk = generatePrivateKey();
writeFileSync(`${dir}/ethereum.key`, pk, { mode: 0o600 });

const tokenAccount = getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const data = new Uint8Array(165); // SPL Token account
data.set(getAddressEncoder().encode(USDC as never), 0);
data.set(getAddressEncoder().encode(depositor), 32);
new DataView(data.buffer).setBigUint64(64, 1_000_000_000n, true); // $1,000
data[108] = 1; // Initialized
writeFileSync(`${dir}/depositor-usdc.json`, JSON.stringify({
  pubkey: tokenAccount,
  account: { lamports: 2_039_280, data: [Buffer.from(data).toString("base64"), "base64"], owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false, rentEpoch: 0, space: 165 },
}));
// Circle's CCTP V2 state a Solana -> Ethereum burn reads (same PDAs as on devnet), and the USDC mint.
const enc = getAddressEncoder();
const pda = async (program: string, seeds: (string | Uint8Array)[]) =>
  (await getProgramDerivedAddress({ programAddress: program as never, seeds: seeds.map((s) => (typeof s === "string" ? new TextEncoder().encode(s) : s)) }))[0];
const TMM = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", MT = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const cctpAccounts = [
  await pda(MT, ["message_transmitter"]), await pda(TMM, ["token_messenger"]), await pda(TMM, ["remote_token_messenger", "0"]),
  await pda(TMM, ["token_minter"]), await pda(TMM, ["local_token", new Uint8Array(enc.encode(USDC as never))]), USDC,
];
console.log(JSON.stringify({ admin, guardian, depositor, ethereum: privateKeyToAddress(pk), tokenAccount, cctpAccounts }));
