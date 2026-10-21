/**
 * Vault keys without a phrase (ADR 0016). Pure WebCrypto, no browser APIs beyond `crypto`, so it
 * runs in Node for the unit tests (test/keys.test.ts). Nothing here leaves the device.
 *
 * - The WebAuthn PRF extension is evaluated with the fixed input `eclyps-seed-v1` (the browser
 *   hashes it again with the "WebAuthn PRF" prefix before it reaches the authenticator).
 * - The first passkey's 32-byte PRF output is the input key material of two HKDF-SHA256 calls
 *   (empty salt): info "eclyps seed" gives the vault seed, info "eclyps vault key" gives the key
 *   that wraps the vault's data key. The same synced passkey gives the same seed on every device.
 * - The vault data (seed, notes, settings) is encrypted with AES-GCM-256 under a random 32-byte data
 *   key. Each way in (a passkey, or the passphrase of an older vault) is a "slot" holding the data
 *   key wrapped under its own key-encryption key. Adding a passkey adds a slot; the seed does not
 *   change.
 * - "Use my wallet instead" (ADR 0016, amended 2026-10-19): the Solana wallet signs one fixed,
 *   domain-bound message; its 64-byte ed25519 signature (deterministic, RFC 8032) is the input key
 *   material of the same two HKDF-SHA256 calls with their own labels ("eclyps wallet seed",
 *   "eclyps wallet vault key"). The same wallet gives the same seed on every device. Unlike a
 *   passkey it is not bound to the site: a copy of Eclyps could ask for the same signature.
 */

export const PRF_INPUT = "eclyps-seed-v1";
const SEED_INFO = "eclyps seed";
const KEK_INFO = "eclyps vault key";
export const PASSPHRASE_ITERATIONS = 600_000;

/** The PRF input as bytes (what goes into `extensions.prf.eval.first`). */
export const prfInput = () => new TextEncoder().encode(PRF_INPUT);

const enc = (s: string) => new TextEncoder().encode(s);
const buf = (b: Uint8Array) => Uint8Array.from(b);
export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function hkdf(ikm: Uint8Array, info: string, size = 32): Promise<Uint8Array> {
  if (ikm.length !== size) throw new RangeError(size === 32 ? "the passkey's PRF output must be 32 bytes" : "an ed25519 signature must be 64 bytes");
  const base = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc(info) }, base, 256);
  return new Uint8Array(bits);
}

/** The vault seed from the first passkey's PRF output. */
export const seedFromPrf = (prf: Uint8Array) => hkdf(prf, SEED_INFO);
/** The key that wraps the data key, from any passkey's PRF output. */
export const kekFromPrf = (prf: Uint8Array) => hkdf(prf, KEK_INFO);

/**
 * The message the wallet signs for "Use my wallet instead". Fixed: another message would give every
 * wallet user a different, empty vault. It names the one site that may ask for it. Off mainnet the
 * network is in it too, so a test network's signature never opens mainnet notes.
 */
export const WALLET_MESSAGE = "Eclyps keys v1 · eclyps.xyz — sign only on eclyps.xyz";
export const walletMessage = (network: string) =>
  network === "mainnet" ? WALLET_MESSAGE : `Eclyps ${network} keys v1 · eclyps.xyz — sign only on eclyps.xyz`;
const WALLET_SEED_INFO = "eclyps wallet seed";
const WALLET_KEK_INFO = "eclyps wallet vault key";
/** The vault seed from the wallet's signature over `walletMessage`. */
export const seedFromSignature = (sig: Uint8Array) => hkdf(sig, WALLET_SEED_INFO, 64);
/** The key that wraps the data key, from the same signature. */
export const kekFromSignature = (sig: Uint8Array) => hkdf(sig, WALLET_KEK_INFO, 64);

/**
 * Whether `signature` is the wallet's ed25519 signature over exactly `message` (`publicKey`: the 32
 * bytes of its Solana address). A wallet that signs a wrapped or prefixed message instead fails here,
 * so its signature never becomes keys.
 */
export async function verifyWalletSignature(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", buf(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, buf(signature), buf(message));
  } catch {
    return false;
  }
}

/** The same bytes: an ed25519 wallet signs one message the same way every time. */
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The passkey's user handle: one role byte and 15 random bytes. The role says whether the seed comes
 * from this passkey ("seed") or the passkey only wraps a seed stored on one device ("added"), so a
 * new device never derives a wrong, empty wallet from an added passkey. The random part keeps an
 * added passkey from replacing the first one in the same password manager.
 */
export type PasskeyRole = "seed" | "added";
const ROLE_BYTE: Record<PasskeyRole, number> = { seed: 1, added: 2 };
export function userHandle(role: PasskeyRole, random: Uint8Array = crypto.getRandomValues(new Uint8Array(15))): Uint8Array<ArrayBuffer> {
  if (random.length !== 15) throw new RangeError("15 random bytes");
  return Uint8Array.from([ROLE_BYTE[role], ...random]);
}
export function roleOf(handle: Uint8Array | null | undefined): PasskeyRole | undefined {
  if (!handle || handle.length !== 16) return undefined;
  return handle[0] === 1 ? "seed" : handle[0] === 2 ? "added" : undefined;
}

export interface PassphraseSlot {
  kind: "passphrase";
  salt: string;
  iterations: number;
  iv: string;
  key: string;
}
export interface PasskeySlot {
  kind: "passkey";
  /** Credential id, base64url. */
  id: string;
  role: PasskeyRole;
  addedAt: number;
  iv: string;
  key: string;
}
/** "Use my wallet instead": the data key wrapped under the key from the wallet's signature. */
export interface WalletSlot {
  kind: "wallet";
  /** The Solana address that signed. */
  address: string;
  addedAt: number;
  iv: string;
  key: string;
}
export type Slot = PassphraseSlot | PasskeySlot | WalletSlot;

/** Local storage format v2: the data under a data key, and the slots that wrap it. */
export interface EnvelopeV2 {
  v: 2;
  slots: Slot[];
  iv: string;
  ct: string;
}

/** Binds a wrapped key to its slot, so a slot's ciphertext cannot be moved to another credential. */
const slotAad = (s: { kind: string; id?: string; address?: string }) =>
  enc(s.kind === "passkey" ? `eclyps passkey ${s.id}` : s.kind === "wallet" ? `eclyps wallet ${s.address}` : "eclyps passphrase");

async function aes(key: Uint8Array | CryptoKey): Promise<CryptoKey> {
  return key instanceof Uint8Array ? crypto.subtle.importKey("raw", buf(key), "AES-GCM", false, ["encrypt", "decrypt"]) : key;
}

export async function passphraseKek(passphrase: string, salt: Uint8Array, iterations = PASSPHRASE_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function wrap(kek: Uint8Array | CryptoKey, dek: Uint8Array, aad: Uint8Array, iv: Uint8Array) {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(aad) }, await aes(kek), buf(dek));
  return { iv: b64(iv), key: b64(new Uint8Array(ct)) };
}

/** A passkey slot: the data key wrapped under the passkey's PRF-derived key. */
export async function passkeySlot(
  id: string,
  role: PasskeyRole,
  prf: Uint8Array,
  dek: Uint8Array,
  opts: { iv?: Uint8Array; addedAt?: number } = {},
): Promise<PasskeySlot> {
  const w = await wrap(await kekFromPrf(prf), dek, slotAad({ kind: "passkey", id }), opts.iv ?? crypto.getRandomValues(new Uint8Array(12)));
  return { kind: "passkey", id, role, addedAt: opts.addedAt ?? Date.now(), ...w };
}

/** A wallet slot: the data key wrapped under the key from the wallet's signature, bound to its address. */
export async function walletSlot(address: string, signature: Uint8Array, dek: Uint8Array, opts: { iv?: Uint8Array; addedAt?: number } = {}): Promise<WalletSlot> {
  const w = await wrap(await kekFromSignature(signature), dek, slotAad({ kind: "wallet", address }), opts.iv ?? crypto.getRandomValues(new Uint8Array(12)));
  return { kind: "wallet", address, addedAt: opts.addedAt ?? Date.now(), ...w };
}

/** Opens a wallet slot with that wallet's signature over `walletMessage`. */
export async function openWalletSlot(slot: WalletSlot, signature: Uint8Array): Promise<Uint8Array> {
  return openSlot(slot, await kekFromSignature(signature));
}

/** A passphrase slot, from the passphrase's PBKDF2 key (an older vault's key can be reused as is). */
export async function passphraseSlot(kek: CryptoKey, salt: Uint8Array, dek: Uint8Array, iv = crypto.getRandomValues(new Uint8Array(12))): Promise<PassphraseSlot> {
  const w = await wrap(kek, dek, slotAad({ kind: "passphrase" }), iv);
  return { kind: "passphrase", salt: b64(salt), iterations: PASSPHRASE_ITERATIONS, ...w };
}

/** The data key from a slot; throws if the key is wrong. */
export async function openSlot(slot: Slot, kek: Uint8Array | CryptoKey): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(slot.iv)), additionalData: buf(slotAad(slot)) }, await aes(kek), buf(unb64(slot.key)));
  return new Uint8Array(pt);
}

/** Opens a passkey slot with that passkey's PRF output. */
export async function openPasskeySlot(slot: PasskeySlot, prf: Uint8Array): Promise<Uint8Array> {
  return openSlot(slot, await kekFromPrf(prf));
}

export async function seal(dek: Uint8Array, data: Uint8Array, iv = crypto.getRandomValues(new Uint8Array(12))): Promise<{ iv: string; ct: string }> {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, await aes(dek), buf(data));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function unseal(dek: Uint8Array, box: { iv: string; ct: string }): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(box.iv)) }, await aes(dek), buf(unb64(box.ct))));
}

export const newDataKey = () => crypto.getRandomValues(new Uint8Array(32));
