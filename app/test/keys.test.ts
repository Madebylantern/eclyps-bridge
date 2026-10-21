/**
 * Keys without a phrase (ADR 0016): the seed and the vault key from a passkey's PRF output, and the
 * slots that wrap the data key. Fixed vectors, so a change to the derivation (which would give every
 * passkey user a different, empty wallet) fails here. The same for "Use my wallet instead" (the
 * seed from a wallet's ed25519 signature over a fixed message, ADR 0016 amended 2026-10-19). Run
 * with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { createPrivateKey, hkdfSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  b64url,
  hex,
  kekFromPrf,
  kekFromSignature,
  openPasskeySlot,
  openSlot,
  openWalletSlot,
  PRF_INPUT,
  prfInput,
  passkeySlot,
  passphraseKek,
  passphraseSlot,
  roleOf,
  sameBytes,
  seal,
  seedFromPrf,
  seedFromSignature,
  unb64url,
  unseal,
  userHandle,
  verifyWalletSignature,
  WALLET_MESSAGE,
  walletMessage,
  walletSlot,
} from "../src/lib/keys.ts";

const prf = Uint8Array.from({ length: 32 }, (_, i) => i);
const dek = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
const iv = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
const SEED = "04e4b699ecf3714977ac043c635627ea71d90dfe980b409dcd6863f0734d6690";
const KEK = "3f3986b029be7a00109f06c6bdb6999abb873ef3d795097062890ddcac440717";

describe("seed and vault key from the PRF output", () => {
  it("uses the ADR's fixed PRF input", () => {
    assert.equal(PRF_INPUT, "eclyps-seed-v1");
    assert.deepEqual(prfInput(), new TextEncoder().encode("eclyps-seed-v1"));
  });

  it("derives fixed vectors", async () => {
    assert.equal(hex(await seedFromPrf(prf)), SEED);
    assert.equal(hex(await kekFromPrf(prf)), KEK);
  });

  it("matches an independent HKDF-SHA256 (empty salt, labelled info)", async () => {
    const ref = (info: string) => Buffer.from(hkdfSync("sha256", prf, new Uint8Array(0), info, 32)).toString("hex");
    assert.equal(ref("eclyps seed"), SEED);
    assert.equal(ref("eclyps vault key"), KEK);
  });

  it("keeps the seed and the vault key apart, and the same passkey gives the same seed", async () => {
    assert.notEqual(hex(await seedFromPrf(prf)), hex(await kekFromPrf(prf)));
    assert.equal(hex(await seedFromPrf(Uint8Array.from(prf))), SEED);
    const other = Uint8Array.from(prf, (b) => b ^ 1);
    assert.notEqual(hex(await seedFromPrf(other)), SEED);
  });

  it("refuses a PRF output that is not 32 bytes", async () => {
    await assert.rejects(seedFromPrf(new Uint8Array(16)), RangeError);
  });
});

describe("passkey slots", () => {
  it("wraps the data key to a fixed vector and opens it again", async () => {
    const slot = await passkeySlot("Y3JlZC0x", "seed", prf, dek, { iv, addedAt: 0 });
    assert.deepEqual(slot, {
      kind: "passkey",
      id: "Y3JlZC0x",
      role: "seed",
      addedAt: 0,
      iv: "AQIDBAUGBwgJCgsM",
      key: "O+1eKQ48aBisko0mWgEZFCJku4aErem3+/fxV/jsdtrID+8B01MWdDEJMrVA2G8V",
    });
    assert.deepEqual(await openPasskeySlot(slot, prf), dek);
  });

  it("does not open with another passkey's output, or moved to another credential", async () => {
    const slot = await passkeySlot("Y3JlZC0x", "added", prf, dek);
    await assert.rejects(openPasskeySlot(slot, Uint8Array.from(prf, (b) => b ^ 0xff)));
    await assert.rejects(openPasskeySlot({ ...slot, id: "b3RoZXI" }, prf));
  });

  it("lets a second passkey open the same data key (Add a passkey)", async () => {
    const second = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const a = await passkeySlot("first", "seed", prf, dek);
    const b = await passkeySlot("second", "added", second, dek);
    assert.deepEqual(await openPasskeySlot(a, prf), await openPasskeySlot(b, second));
  });
});

describe("passphrase slot (a v1 vault moving to v2)", () => {
  it("wraps the data key under the old PBKDF2 key and opens it from the passphrase", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    const oldKey = await passphraseKek("correct horse battery staple", salt, 1000);
    const slot = await passphraseSlot(oldKey, salt, dek);
    assert.deepEqual(await openSlot(slot, await passphraseKek("correct horse battery staple", salt, 1000)), dek);
    await assert.rejects(openSlot(slot, await passphraseKek("wrong horse battery staple", salt, 1000)));
  });
});

describe("vault data under the data key", () => {
  it("seals to a fixed vector and round-trips", async () => {
    const pt = new TextEncoder().encode('{"seedHex":"00"}');
    const box = await seal(dek, pt, iv);
    assert.deepEqual(box, { iv: "AQIDBAUGBwgJCgsM", ct: "43E0G107zY444GwVtBOH65uztF04Hq1SQHJH72sttXk=" });
    assert.deepEqual(await unseal(dek, box), pt);
    await assert.rejects(unseal(Uint8Array.from(dek, (b) => b ^ 1), box));
  });
});

describe("user handle", () => {
  it("carries the role in its first byte", () => {
    const h = userHandle("added", new Uint8Array(15).fill(7));
    assert.equal(hex(h), "02070707070707070707070707070707");
    assert.equal(roleOf(h), "added");
    assert.equal(roleOf(userHandle("seed")), "seed");
    assert.equal(roleOf(new Uint8Array([1, 2])), undefined);
    assert.equal(roleOf(null), undefined);
  });

  it("encodes credential ids as base64url both ways", () => {
    const id = Uint8Array.from({ length: 40 }, (_, i) => (i * 37) & 0xff);
    assert.deepEqual(unb64url(b64url(id)), id);
    assert.ok(!/[+/=]/.test(b64url(id)));
  });
});

describe("seed from a wallet signature (Use my wallet instead)", () => {
  // A fixed ed25519 key (seed bytes 0..31), as a wallet would hold it.
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(prf)]), format: "der", type: "pkcs8" });
  const PUB = Uint8Array.from(Buffer.from("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8", "hex"));
  const signed = (m: string) => new Uint8Array(sign(null, new TextEncoder().encode(m), key));
  const SIG = "38e75d6da2e065cc38091086ccdc68b1ecb9637e6fcd5df3fe1aaf184fabc35d4e603d1d3f283bb5754b5f28409cc3325d3832d6a5d3d82363ffe44e61f57a0c";
  const WALLET_SEED = "96cfa0a4d51cedbf4b73974e48acb6938fa3896bca611e63b9e443ae986221e5";
  const WALLET_KEK = "065a1754d0bbd201566b9b0a4441b7fa7015e27f9946656cccecb7044ca064a8";
  const TESTNET_SEED = "8f868b3a4c311b73c9b9e4d9e2a991ee4484e406c72c87983b7731fe6d6a2369";

  it("signs the ADR's fixed, domain-bound message; off mainnet the network is in it", () => {
    assert.equal(WALLET_MESSAGE, "Eclyps keys v1 · eclyps.xyz — sign only on eclyps.xyz");
    assert.equal(walletMessage("mainnet"), WALLET_MESSAGE);
    assert.equal(walletMessage("testnet"), "Eclyps testnet keys v1 · eclyps.xyz — sign only on eclyps.xyz");
    assert.equal(walletMessage("local"), "Eclyps local keys v1 · eclyps.xyz — sign only on eclyps.xyz");
  });

  it("an ed25519 signature is deterministic: the same wallet signs the message the same way", () => {
    const a = signed(WALLET_MESSAGE);
    assert.equal(hex(a), SIG);
    assert.ok(sameBytes(a, signed(WALLET_MESSAGE)));
    assert.ok(!sameBytes(a, signed(walletMessage("testnet"))));
    assert.ok(!sameBytes(a, a.subarray(0, 63)));
  });

  it("derives fixed vectors, matching an independent HKDF-SHA256", async () => {
    const sig = signed(WALLET_MESSAGE);
    assert.equal(hex(await seedFromSignature(sig)), WALLET_SEED);
    assert.equal(hex(await kekFromSignature(sig)), WALLET_KEK);
    const ref = (info: string) => Buffer.from(hkdfSync("sha256", sig, new Uint8Array(0), info, 32)).toString("hex");
    assert.equal(ref("eclyps wallet seed"), WALLET_SEED);
    assert.equal(ref("eclyps wallet vault key"), WALLET_KEK);
    assert.equal(hex(await seedFromSignature(signed(walletMessage("testnet")))), TESTNET_SEED);
  });

  it("keeps the wallet seed apart from a passkey's, and from its own vault key", async () => {
    const sig = signed(WALLET_MESSAGE);
    assert.notEqual(hex(await seedFromSignature(sig)), hex(await kekFromSignature(sig)));
    // The same 32 bytes as PRF output and as the first half of a signature never give the same seed.
    assert.notEqual(hex(await seedFromSignature(sig)), hex(await seedFromPrf(sig.subarray(0, 32))));
  });

  it("refuses anything but a 64-byte signature", async () => {
    await assert.rejects(seedFromSignature(new Uint8Array(32)), RangeError);
    await assert.rejects(kekFromSignature(new Uint8Array(65)), RangeError);
  });

  it("accepts only the wallet's own signature over exactly this message", async () => {
    const msg = new TextEncoder().encode(WALLET_MESSAGE);
    const sig = signed(WALLET_MESSAGE);
    assert.equal(await verifyWalletSignature(PUB, sig, msg), true);
    assert.equal(await verifyWalletSignature(PUB, sig, new TextEncoder().encode(walletMessage("testnet"))), false);
    assert.equal(await verifyWalletSignature(PUB, Uint8Array.from(sig, (b, i) => (i === 0 ? b ^ 1 : b)), msg), false);
    assert.equal(await verifyWalletSignature(Uint8Array.from(PUB, (b) => b ^ 1), sig, msg), false);
    assert.equal(await verifyWalletSignature(PUB, sig.subarray(0, 32), msg), false);
  });

  it("wraps the data key in a wallet slot bound to the address, to a fixed vector", async () => {
    const sig = signed(WALLET_MESSAGE);
    const address = "Eclyps1111111111111111111111111111111111111";
    const slot = await walletSlot(address, sig, dek, { iv, addedAt: 0 });
    assert.deepEqual(slot, { kind: "wallet", address, addedAt: 0, iv: "AQIDBAUGBwgJCgsM", key: "ALKnUaDi0pDsEi+Hyr9EWyboTyVlnG/PEn4plAS5UuWomJQxBGQU4GPt2Vxgqs1d" });
    assert.deepEqual(await openWalletSlot(slot, sig), dek);
    await assert.rejects(openWalletSlot(slot, signed(walletMessage("testnet"))));
    await assert.rejects(openWalletSlot({ ...slot, address: "Other111111111111111111111111111111111111111" }, sig));
  });
});
