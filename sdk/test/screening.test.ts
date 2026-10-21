import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AccountRole, address, getAddressEncoder, type Instruction } from "@solana/kit";
import {
  BLOCKED_ADDRESS_LEN,
  blockAddressIx,
  blockedPda,
  cancelUnblockIx,
  decodeBlockedAddress,
  decodeScreening,
  depositExpressIx,
  depositIx,
  initScreeningIx,
  isBlockedRecord,
  LIST,
  proposeUnblockIx,
  screeningPda,
  unblockIx,
} from "../src/gateway.js";

const idl = JSON.parse(readFileSync(new URL("../../programs/gateway/idl/eclyps_gateway.json", import.meta.url), "utf8"));
const spec = (name: string) => idl.instructions.find((i: { name: string }) => i.name === name);
const enc = getAddressEncoder();

const guardian = address("Guard1an11111111111111111111111111111111111");
const user = address("Us3r111111111111111111111111111111111111111");
const target = address("Target1111111111111111111111111111111111111");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const rolesOf = (name: string) =>
  (spec(name).accounts as { signer?: boolean; writable?: boolean }[]).map((a) =>
    a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY);

describe("screening (ADR 0019)", () => {
  it("builders match the IDL: discriminators, account order and roles", async () => {
    const built: [string, Instruction][] = [
      ["init_screening", await initScreeningIx(guardian)],
      ["block_address", await blockAddressIx({ signer: guardian, address: target, list: LIST.sanctions, reference: new Uint8Array(32).fill(7) })],
      ["propose_unblock", await proposeUnblockIx(guardian, target)],
      ["cancel_unblock", await cancelUnblockIx(guardian, target)],
      ["unblock", await unblockIx(target, guardian)],
    ];
    for (const [name, ix] of built) {
      expect([...ix.data!.slice(0, 8)]).toEqual(spec(name).discriminator);
      expect({ name, roles: ix.accounts!.map((a) => a.role) }).toEqual({ name, roles: rolesOf(name) });
    }
    const block = built[1]![1];
    expect(block.accounts![2]!.address).toBe(await screeningPda());
    expect(block.accounts![3]!.address).toBe(await blockedPda(target));
    // address | list u8 | reference [32]
    expect([...block.data!.slice(8)]).toEqual([...enc.encode(target), 0, ...new Array(32).fill(7)]);
    expect(built[4]![1].accounts![2]!.address).toBe(guardian);
  });

  it("deposits name the depositor's record last", async () => {
    const dep = await depositIx({ payer: user, authority: user, source: target, usdcMint: mint, denominationIndex: 0, currentEpochId: 0n, commitment: new Uint8Array(32) });
    const names = spec("deposit").accounts.map((a: { name: string }) => a.name);
    expect(names.at(-1)).toBe("blocked");
    expect(dep.accounts!.length).toBe(names.length);
    expect(dep.accounts!.at(-1)).toEqual({ address: await blockedPda(user), role: AccountRole.READONLY });
    const x = await depositExpressIx({ payer: user, authority: user, source: target, usdcMint: mint, denominationIndex: 0, expressId: 1n << 63n, commitment: new Uint8Array(32), maxExpressFee: 0n });
    expect(spec("deposit_express").accounts.at(-1).name).toBe("blocked");
    expect(x.accounts!.at(-1)!.address).toBe(await blockedPda(user));
  });

  it("decodes the accounts", () => {
    const disc = (n: string) => idl.accounts.find((a: { name: string }) => a.name === n).discriminator as number[];
    // Screening: disc | version u8 | bump u8 | blocked u32 | added u64 | removed u64 | reserved [64]
    const s = new Uint8Array(8 + 1 + 1 + 4 + 8 + 8 + 64);
    s.set(disc("Screening"));
    const sv = new DataView(s.buffer);
    s[8] = 1;
    sv.setUint32(10, 3, true);
    sv.setBigUint64(14, 5n, true);
    sv.setBigUint64(22, 2n, true);
    expect(decodeScreening(s)).toEqual({ version: 1, blocked: 3, added: 5n, removed: 2n });
    // BlockedAddress: disc | version | bump | address | list | reference | added_at i64 | added_by |
    // rent_payer | unblock_eta i64 | reserved [32]
    const b = new Uint8Array(8 + 2 + 32 + 1 + 32 + 8 + 32 + 32 + 8 + 32);
    expect(b.length).toBe(BLOCKED_ADDRESS_LEN);
    b.set(disc("BlockedAddress"));
    const bv = new DataView(b.buffer);
    b.set(enc.encode(target), 10);
    b[42] = LIST.stolenFunds;
    b.set(new Uint8Array(32).fill(9), 43);
    bv.setBigInt64(75, 1_700_000_000n, true);
    b.set(enc.encode(guardian), 83);
    b.set(enc.encode(guardian), 115);
    bv.setBigInt64(147, 1_700_172_800n, true);
    expect(decodeBlockedAddress(b)).toEqual({
      address: target, list: 1, reference: new Uint8Array(32).fill(9), addedAt: 1_700_000_000n, addedBy: guardian, rentPayer: guardian, unblockEta: 1_700_172_800n,
    });
    expect(isBlockedRecord(b)).toBe(true);
    expect(isBlockedRecord(undefined)).toBe(false);
    expect(isBlockedRecord(s)).toBe(false);
  });
});
