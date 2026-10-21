import { buildPoseidon } from "circomlibjs";
import { AccountRole, address, type Address, getAddressEncoder, type Instruction } from "@solana/kit";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CCTP,
  decodeExitHook,
  decodeExitMessage,
  decodeTokenMessengerFeeRecipient,
  encodeExitHook,
  encodeExitMessage,
  evmAddressToBytes32,
  EXIT_MESSAGE_LENGTH,
  SEPOLIA,
} from "../src/cctp.js";
import {
  deriveEthereumExit,
  deriveEthereumExitSecret,
  deriveExit,
  deriveExitSecret,
  destinationFields,
  ETHEREUM_EXIT_TAG,
  ethereumExitCommitment,
  ethereumExitContent,
  exitBatchContent,
  exitClaimInputs,
  exitCommitment,
} from "../src/exit.js";
import {
  claimExitIx,
  decodeExitBatch,
  exitAuthorityPda,
  exitBatchPda,
  exitBatchPdaOfMessage,
  exitClaimed,
  exitCustodyPda,
  GATEWAY_PROGRAM_ID,
  receiveExitIx,
  receiveExitLookupTableAddresses,
} from "../src/gateway.js";
import { BN254_R, path, root, rootFromPath } from "../src/merkle.js";
import { deriveNote, seedFromHex } from "../src/notes.js";

const seed = seedFromHex("11".repeat(32));
const A = address("4AcCC5T8tycuA31o8Ysr9Wu6joQsBLaeQwqzGKRmVLpY");
const B = address("4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf");

describe("exit commitments (ADR 0009)", () => {
  it("splits a destination into two 128-bit halves that recompose it", () => {
    const [hi, lo] = destinationFields(A);
    expect(hi < 1n << 128n && lo < 1n << 128n).toBe(true);
    const bytes = (hi << 128n) | lo;
    expect(bytes.toString(16).length).toBeLessThanOrEqual(64);
  });

  it("derives seed-bound, index-separated secrets, distinct from note secrets", async () => {
    const s0 = await deriveExitSecret(seed, 0);
    expect(await deriveExitSecret(seed, 0)).toBe(s0);
    expect(await deriveExitSecret(seed, 1)).not.toBe(s0);
    const note = await deriveNote(seed, 0);
    expect([note.secret, note.nullifierKey]).not.toContain(s0);
    expect(s0 < BN254_R).toBe(true);
  });

  it("binds the destination", async () => {
    const a = await deriveExit(seed, 0, A);
    const b = await deriveExit(seed, 0, B);
    expect(a.secret).toBe(b.secret);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.commitment).toBe(exitCommitment(A, a.secret));
  });

  it("matches an independent Poseidon (circomlibjs)", async () => {
    const poseidon = await buildPoseidon();
    const e = await deriveExit(seed, 3, A);
    const [hi, lo] = destinationFields(A);
    expect(poseidon.F.toObject(poseidon([hi, lo, e.secret])) as bigint).toBe(e.commitment);
  });

  it("matches the program's 3-input Poseidon vector (circuits/merkle-rs)", () => {
    // Destination whose halves are 1 and 2, secret 3: circomlib poseidon([1, 2, 3]).
    const bytes = new Uint8Array(32);
    bytes[15] = 1;
    bytes[31] = 2;
    const dest = decodeAddress(bytes);
    expect(destinationFields(dest)).toEqual([1n, 2n]);
    expect(exitCommitment(dest, 3n)).toBe(0x0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732n);
  });
});

// A received and partly claimed exit batch written by the gateway's LiteSVM tests
// (programs/gateway/tests/exit.rs exit_fixture_for_the_sdk): the instructions below succeeded on
// chain, so the SDK's leaf, path, builders and decoder must reproduce them exactly.
const fx = JSON.parse(readFileSync(new URL("./fixtures/exit-claim.json", import.meta.url), "utf8"));
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
type FxAccount = { address: string; writable: boolean; signer: boolean };
const role = (a: FxAccount) =>
  a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
const shape = (ix: Instruction) => ({
  program: ix.programAddress,
  accounts: ix.accounts!.map((a) => ({ address: a.address, role: a.role })),
  data: Buffer.from(ix.data!).toString("base64"),
});
const expected = (x: { accounts: FxAccount[]; data: string }) => ({
  program: GATEWAY_PROGRAM_ID,
  accounts: x.accounts.map((a) => ({ address: a.address, role: role(a) })),
  data: x.data,
});

function decodeAddress(b: Uint8Array): Address {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return address(s);
}

describe("exit claims against the program (ADR 0009)", () => {
  const leaves: bigint[] = fx.exits.map((e: { leaf: string }) => BigInt(e.leaf));

  it("computes the program's leaves, root and path", () => {
    for (const e of fx.exits) expect(exitCommitment(address(e.destination), BigInt(e.secret))).toBe(BigInt(e.leaf));
    expect(root(leaves)).toBe(BigInt(fx.root));
    const i = fx.claim.leafIndex as number;
    expect(path(leaves, i).map((x) => BigInt(x))).toEqual(fx.claim.path.map((x: string) => BigInt(x)));
    const ex = fx.exits[i];
    const inputs = exitClaimInputs(leaves, address(ex.destination), BigInt(ex.secret));
    expect(inputs).toEqual({ leafIndex: i, leaf: BigInt(ex.leaf), path: fx.claim.path.map((x: string) => BigInt(x)), root: BigInt(fx.root) });
    expect(rootFromPath(inputs.leaf, i, inputs.path)).toBe(BigInt(fx.root));
    expect(() => exitClaimInputs(leaves, address(ex.destination), BigInt(fx.exits[0].secret))).toThrow("not in the batch");
  });

  it("builds the claim_exit that paid on chain", async () => {
    const i = fx.claim.leafIndex as number;
    const ex = fx.exits[i];
    const { path: p } = exitClaimInputs(leaves, address(ex.destination), BigInt(ex.secret));
    const ix = await claimExitIx({
      payer: address(fx.payer),
      usdcMint: address(fx.usdcMint),
      denominationIndex: fx.denominationIndex,
      exitEpochId: BigInt(fx.exitEpochId),
      leafIndex: i,
      path: p,
      destination: address(ex.destination),
      secret: BigInt(ex.secret),
    });
    expect(shape(ix)).toEqual(expected(fx.claim));
  });

  it("builds the receive_exit that landed on chain, and its lookup table", async () => {
    const message = hexBytes(fx.receive.message);
    expect(message.length).toBe(EXIT_MESSAGE_LENGTH);
    const denominations = fx.denominations.map((d: string) => BigInt(d));
    const ix = await receiveExitIx({
      payer: address(fx.payer),
      usdcMint: address(fx.usdcMint),
      message,
      attestation: hexBytes(fx.receive.attestation),
      denominations,
      cctpFeeRecipient: address(fx.cctpFeeRecipient),
    });
    expect(shape(ix)).toEqual(expected(fx.receive));
    // Everything but the payer, the ExitBatch and CCTP's used nonce goes in the lookup table.
    const table = await receiveExitLookupTableAddresses({
      usdcMint: address(fx.usdcMint),
      burnToken: message.slice(152, 184),
      cctpFeeRecipient: address(fx.cctpFeeRecipient),
    });
    const perMessage = [fx.payer, fx.exitBatch.address, ix.accounts![6]!.address];
    expect(table).toHaveLength(18);
    expect(new Set(table)).toEqual(new Set(fx.receive.accounts.map((a: FxAccount) => a.address).filter((a: string) => !perMessage.includes(a))));
    expect(await exitBatchPdaOfMessage(message, denominations)).toBe(fx.exitBatch.address);
    expect(await exitAuthorityPda()).toBe(fx.exitAuthority);
    expect(await exitCustodyPda()).toBe(fx.exitCustody);
  });

  it("reads the exit message and the ExitBatch the program wrote", async () => {
    const m = decodeExitMessage(hexBytes(fx.receive.message));
    expect(m).toMatchObject({ sourceDomain: 0, destinationDomain: 5, finalityExecuted: 2000, feeExecuted: 0n, amount: 3n * 1_000_000_000n });
    expect(m.hook).toEqual({ denomination: 1_000_000_000n, exitEpochId: BigInt(fx.exitEpochId), count: 3, root: BigInt(fx.root) });
    expect(Buffer.from(m.messageSender).toString("hex")).toBe("00".repeat(29) + "0ec175");
    // Only the gateway's exit authority can receive it, and it pays exit custody.
    expect(m.destinationCaller).toEqual(new Uint8Array(getAddressEncoder().encode(address(fx.exitAuthority))));
    expect(m.mintRecipient).toEqual(new Uint8Array(getAddressEncoder().encode(address(fx.exitCustody))));
    expect(m.recipient).toEqual(new Uint8Array(getAddressEncoder().encode(address("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"))));
    const b = decodeExitBatch(b64(fx.exitBatch.data));
    expect(b).toMatchObject({
      denominationIndex: fx.denominationIndex,
      denomination: 1_000_000_000n,
      exitEpochId: BigInt(fx.exitEpochId),
      root: BigInt(fx.root),
      count: 3,
      claimedCount: fx.exitBatch.claimedCount,
      receivedSlot: BigInt(fx.exitBatch.receivedSlot),
    });
    expect(Buffer.from(b.cctpNonce).toString("hex")).toBe(fx.exitBatch.cctpNonce.replace(/^0x/, ""));
    expect([0, 1, 2].map((i) => exitClaimed(b, i))).toEqual([false, true, false]);
    expect(await exitBatchPda(fx.denominationIndex, BigInt(fx.exitEpochId))).toBe(fx.exitBatch.address);
  });

  it("encodes the exit hook the program and the portal use", () => {
    const h = { denomination: 100_000_000n, exitEpochId: 0x1112131415161718n, count: 0x00f1, root: 0xabn };
    const b = encodeExitHook(h);
    expect(b.length).toBe(51);
    expect(b[0]).toBe(2);
    expect(Buffer.from(b.slice(1, 9)).toString("hex")).toBe("0000000005f5e100");
    expect(Buffer.from(b.slice(9, 19)).toString("hex")).toBe("111213141516171800f1");
    expect(b[50]).toBe(0xab);
    expect(decodeExitHook(b)).toEqual(h);
    expect(() => decodeExitHook(Uint8Array.of(1, ...b.slice(1)))).toThrow("bad exit hook");
    expect(() => encodeExitHook({ ...h, count: 257 })).toThrow(RangeError);
    expect(() => encodeExitHook({ ...h, root: BN254_R })).toThrow(RangeError);
  });

  it("reads CCTP's fee recipient from the TokenMessenger state", () => {
    // tests/fixtures/cctp-devnet/AawthJCG…json (devnet TokenMessenger).
    const fixture = JSON.parse(
      readFileSync(new URL("../../programs/gateway/tests/fixtures/cctp-devnet/AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W.json", import.meta.url), "utf8"),
    );
    expect(decodeTokenMessengerFeeRecipient(b64(fixture.account.data[0]))).toBe(fx.cctpFeeRecipient);
  });
});

// The Ethereum leg (contracts/portal): shared exit vectors, and the message Circle's real
// TokenMessengerV2 emitted for EclypsPortal.exitBatch on a Sepolia fork (ExitBatchFork.t.sol).
const vectors = JSON.parse(readFileSync(new URL("../../circuits/vectors/exit.json", import.meta.url), "utf8"));
const burn = JSON.parse(
  readFileSync(new URL("../../contracts/portal/test/fixtures/exit-burn-sepolia-fork.json", import.meta.url), "utf8"),
);

describe("the portal's exit burn (ADR 0009)", () => {
  it("encodes the shared exit vectors, hook and L2->L1 content", async () => {
    expect(vectors.vectors).toHaveLength(4);
    for (const v of vectors.vectors) {
      const h = { denomination: BigInt(v.denomination), exitEpochId: BigInt(v.exitEpochId), count: v.count, root: BigInt(v.root) };
      expect(Buffer.from(encodeExitHook(h)).toString("hex")).toBe(v.hook.replace(/^0x/, ""));
      expect(decodeExitHook(hexBytes(v.hook))).toEqual(h);
      // sha256ToField(abi.encode(root, count, exitEpochId, denomination)), as the Aztec claim
      // contract must send it and EclypsPortal.exitContent rebuilds it.
      const word = (x: bigint) => x.toString(16).padStart(64, "0");
      const words = Buffer.from(word(h.root) + word(BigInt(h.count)) + word(h.exitEpochId) + word(h.denomination), "hex");
      const content = "00" + createHash("sha256").update(words).digest("hex").slice(0, 62);
      expect(content).toBe(v.content.replace(/^0x/, ""));
      expect(await exitBatchContent(h.root, h.count, h.exitEpochId, h.denomination)).toBe(BigInt(v.content));
    }
  });

  it("reads the message the portal burned on a Sepolia fork, and Iris's copy is what Solana received", async () => {
    const raw = hexBytes(burn.message);
    expect(raw.length).toBe(EXIT_MESSAGE_LENGTH);
    const m = decodeExitMessage(raw);
    expect(m).toMatchObject({ sourceDomain: 0, destinationDomain: 5, finalityExecuted: 0, feeExecuted: 0n, amount: 3_000_000_000n });
    expect(m.nonce).toEqual(new Uint8Array(32));
    expect(m.sender).toEqual(evmAddressToBytes32(SEPOLIA.tokenMessengerV2));
    expect(m.recipient).toEqual(new Uint8Array(getAddressEncoder().encode(CCTP.tokenMessengerMinterV2)));
    expect(m.burnToken).toEqual(evmAddressToBytes32(SEPOLIA.usdc));
    expect(m.messageSender).toEqual(evmAddressToBytes32(burn.portal));
    // The portal's constructor arguments: this program's exit PDAs as bytes32.
    expect(m.destinationCaller).toEqual(new Uint8Array(getAddressEncoder().encode(await exitAuthorityPda())));
    expect(m.mintRecipient).toEqual(new Uint8Array(getAddressEncoder().encode(await exitCustodyPda())));
    expect(encodeExitHook(m.hook)).toEqual(raw.slice(376));
    expect(m.hook).toEqual({ denomination: 1_000_000_000n, exitEpochId: 7n, count: 3, root: BigInt(burn.root) });
    // Iris fills the nonce and the executed finality; the rest is byte-identical.
    const filled = raw.slice();
    filled.set(hexBytes(fx.receive.message).slice(12, 44), 12);
    new DataView(filled.buffer).setUint32(144, 2000);
    expect(Buffer.from(filled).toString("hex")).toBe(fx.receive.message);
  });

  it("builds the message Circle's TokenMessengerV2 emitted, field by field (the local stack's Iris)", () => {
    const raw = hexBytes(burn.message);
    const m = decodeExitMessage(raw);
    const burnArgs = {
      tokenMessenger: SEPOLIA.tokenMessengerV2, burnToken: SEPOLIA.usdc, destinationCaller: m.destinationCaller,
      mintRecipient: m.mintRecipient, amount: m.amount, messageSender: burn.portal, minFinality: 2000, maxFee: 0n,
      hook: raw.slice(376),
    };
    expect(encodeExitMessage(burnArgs)).toEqual(raw);
    const nonce = hexBytes(fx.receive.message).slice(12, 44);
    expect(Buffer.from(encodeExitMessage({ ...burnArgs, nonce, finalityExecuted: 2000 })).toString("hex")).toBe(fx.receive.message);
    expect(() => encodeExitMessage({ ...burnArgs, hook: raw.slice(377) })).toThrow();
  });
});

// Leave to Ethereum: circuits/vectors/exit-ethereum.json (Python), also checked by the portal
// (ClaimToEthereum.t.sol) and the claim contract (TXE).
const ethVectors = JSON.parse(readFileSync(new URL("../../circuits/vectors/exit-ethereum.json", import.meta.url), "utf8"));
const ALICE = "0x00000000000000000000000000000000000a11ce";

describe("exits to Ethereum (ADR 0014 §4)", () => {
  it("matches the shared vectors: tag, commitment, content", async () => {
    expect(ETHEREUM_EXIT_TAG).toBe(BigInt(ethVectors.tag));
    expect(Buffer.from(ETHEREUM_EXIT_TAG.toString(16), "hex").toString()).toBe("eclyps:exit-to-ethereum");
    expect(ethVectors.vectors).toHaveLength(4);
    for (const v of ethVectors.vectors) {
      const c = await ethereumExitCommitment(v.recipient, BigInt(v.exitSecret));
      expect(c).toBe(BigInt(v.commitment));
      expect(await ethereumExitContent(c, BigInt(v.denomination))).toBe(BigInt(v.content));
    }
  });

  it("derives secrets in their own index space (domain 4), apart from Solana exits and notes", async () => {
    const s0 = await deriveEthereumExitSecret(seed, 0);
    expect(await deriveEthereumExitSecret(seed, 0)).toBe(s0);
    expect(await deriveEthereumExitSecret(seed, 1)).not.toBe(s0);
    expect(s0).not.toBe(await deriveExitSecret(seed, 0));
    const note = await deriveNote(seed, 0);
    expect([note.secret, note.nullifierKey]).not.toContain(s0);
    expect(s0 < BN254_R).toBe(true);
    // Poseidon(s0, 4, i) with an independent Poseidon.
    const poseidon = await buildPoseidon();
    const { seedField } = await import("../src/notes.js");
    expect(poseidon.F.toObject(poseidon([await seedField(seed), 4n, 0n])) as bigint).toBe(s0);
  });

  it("binds the recipient, and refuses a malformed or zero address", async () => {
    const a = await deriveEthereumExit(seed, 0, ALICE);
    const b = await deriveEthereumExit(seed, 0, "0x00000000000000000000000000000000000000b0");
    expect(a.secret).toBe(b.secret);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.commitment).toBe(await ethereumExitCommitment(ALICE, a.secret));
    expect(a.commitment < 1n << 248n).toBe(true);
    await expect(ethereumExitCommitment("0x1234", a.secret)).rejects.toThrow();
    await expect(ethereumExitCommitment(`0x${"0".repeat(40)}`, a.secret)).rejects.toThrow();
  });

  it("never gives an exit batch's content (the tag word, and 96 bytes against 128)", async () => {
    const c = await ethereumExitCommitment(ALICE, 7n);
    expect(await ethereumExitContent(c, 100_000_000n)).not.toBe(await exitBatchContent(c, 1, 0n, 100_000_000n));
  });
});
