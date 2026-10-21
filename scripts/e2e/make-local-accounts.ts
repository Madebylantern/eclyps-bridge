/**
 * Writes the local e2e fixtures into scripts/e2e/.local/ (git-ignored):
 * a throwaway user keypair and a devnet-USDC token account holding 10,000 USDC for it, in the
 * JSON format `solana-test-validator --account` expects. Local validator only; never funded on
 * any real network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { type Address, createKeyPairSignerFromBytes, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { DEVNET } from "@eclyps/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";

const dir = new URL("./.local/", import.meta.url);
mkdirSync(dir, { recursive: true });

async function keypairFile(name: string): Promise<Address> {
  const secret = ed25519.utils.randomSecretKey();
  const bytes = new Uint8Array(64);
  bytes.set(secret, 0);
  bytes.set(ed25519.getPublicKey(secret), 32);
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(Array.from(bytes)), { mode: 0o600 });
  return (await createKeyPairSignerFromBytes(bytes)).address;
}

/** A devnet-USDC token account holding 10,000 USDC for `owner`, as a validator --account file. */
function usdcAccount(owner: Address, file: string): Address {
  const tokenAccount = getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const data = new Uint8Array(165); // SPL Token account layout
  const dv = new DataView(data.buffer);
  data.set(getAddressEncoder().encode(DEVNET.usdcMint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  dv.setBigUint64(64, 10_000_000_000n, true); // 10,000 USDC
  data[108] = 1; // AccountState::Initialized
  writeFileSync(
    new URL(file, dir),
    JSON.stringify({
      pubkey: tokenAccount,
      account: {
        lamports: 2_039_280,
        data: [Buffer.from(data).toString("base64"), "base64"],
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        executable: false,
        rentEpoch: 0,
        space: 165,
      },
    }),
  );
  return tokenAccount;
}

// user: the demo user (the UI's dev wallet). crowd-1..3: other depositors, so a batch can fill.
const user = await keypairFile("user");
const tokenAccount = usdcAccount(user, "user-usdc.json");
const crowd = [];
for (let i = 1; i <= 3; i++) {
  const owner = await keypairFile(`crowd-${i}`);
  crowd.push({ owner, tokenAccount: usdcAccount(owner, `crowd-${i}-usdc.json`) });
}
writeFileSync(new URL("accounts.json", dir), JSON.stringify({ user, tokenAccount, crowd }, null, 2));
console.log(JSON.stringify({ user, tokenAccount, crowd }));
