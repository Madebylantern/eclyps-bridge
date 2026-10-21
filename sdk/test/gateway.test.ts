import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AccountRole, address, getAddressDecoder, getAddressEncoder, type Instruction } from "@solana/kit";
import { encodeExitHook } from "../src/cctp.js";
import {
  applyParamsIx,
  associatedTokenAddress,
  bpsOf,
  claimExitIx,
  createLookupTableIx,
  decodeLookupTable,
  extendLookupTableIx,
  configPda,
  configPortalAddress,
  decodeEpoch,
  depositCost,
  depositFeeBps,
  depositIx,
  depositRoom,
  encodeParams,
  epochPda,
  FEE_CAP_BPS,
  GATEWAY_PROGRAM_ID,
  initializeIx,
  type Params,
  PARAMS_LEN,
  portalMatches,
  proposeParamsIx,
  receiveExitIx,
  REFUND_DELAY_SLOTS,
  refundDepositIx,
  refundStatus,
  sendBatchIx,
} from "../src/gateway.js";

const idl = JSON.parse(
  readFileSync(new URL("../../programs/gateway/idl/eclyps_gateway.json", import.meta.url), "utf8"),
);

describe("gateway client", () => {
  it("program id matches the IDL", () => {
    expect(idl.address).toBe(GATEWAY_PROGRAM_ID);
  });

  it("instruction discriminators match the IDL", async () => {
    const src = readFileSync(new URL("../src/gateway.ts", import.meta.url), "utf8");
    for (const [name, key] of [
      ["initialize", "initialize"],
      ["open_epoch", "openEpoch"],
      ["deposit", "deposit"],
      ["close_epoch", "closeEpoch"],
      ["send_batch", "sendBatch"],
      ["refund_deposit", "refundDeposit"],
      ["propose_params", "proposeParams"],
      ["apply_params", "applyParams"],
      ["cancel_params", "cancelParams"],
      ["set_guardian", "setGuardian"],
      ["propose_admin", "proposeAdmin"],
      ["accept_admin", "acceptAdmin"],
      ["receive_exit", "receiveExit"],
      ["claim_exit", "claimExit"],
    ]) {
      const ix = idl.instructions.find((i: { name: string }) => i.name === name);
      expect(src).toContain(`${key}: [${ix.discriminator.join(", ")}]`);
    }
    for (const [name, key] of [
      ["Config", "configAccount"],
      ["Epoch", "epochAccount"],
      ["ExitBatch", "exitBatchAccount"],
    ]) {
      const account = idl.accounts.find((a: { name: string }) => a.name === name);
      expect(src).toContain(`${key}: [${account.discriminator.join(", ")}]`);
    }
  });

  it("decodes an epoch account", async () => {
    const disc = idl.accounts.find((a: { name: string }) => a.name === "Epoch").discriminator;
    // disc | idx u8 | denomination, epoch_id, opened_slot, end_slot u64 | rollovers u32 |
    // status u8 | root [32] | bump u8 | fee_bps, finisher_bps u16 | leaves vec (u32 len + 32 each) |
    // depositors vec (u32 len + 32 each)
    const b = new Uint8Array(8 + 1 + 8 * 4 + 4 + 1 + 32 + 1 + 4 + 4 + 32 + 4 + 32);
    b.set(disc, 0);
    const dv = new DataView(b.buffer);
    b[8] = 1;
    dv.setBigUint64(9, 1_000_000_000n, true);
    dv.setBigUint64(17, 3n, true);
    b[45] = 1; // Closed
    b[46 + 31] = 7; // root = 7
    dv.setUint16(79, 50, true);
    dv.setUint16(81, 30, true);
    dv.setUint32(83, 1, true);
    b[87 + 31] = 9; // leaf = 9
    dv.setUint32(119, 1, true);
    b.set(getAddressEncoder().encode(GATEWAY_PROGRAM_ID), 123);
    const e = decodeEpoch(b);
    expect(e).toMatchObject({ denominationIndex: 1, denomination: 1_000_000_000n, epochId: 3n, status: "Closed", root: 7n, leaves: [9n], feeBps: 50, finisherBps: 30 });
    expect(e.depositors).toEqual([GATEWAY_PROGRAM_ID]);
    expect(await epochPda(1, 3n)).not.toBe(await configPda());
  });

  it("refunds only deposits that could not cross", () => {
    const open = { status: "Open" as const, openedSlot: 1_000n, rollovers: 1 };
    const due = 1_000n + REFUND_DELAY_SLOTS;
    expect(refundStatus(open, due - 1n)).toMatchObject({ refundable: false, reason: "too-early", fromSlot: due });
    expect(refundStatus(open, due)).toMatchObject({ refundable: true });
    expect(refundStatus({ ...open, rollovers: 0 }, due)).toMatchObject({ refundable: false, reason: "no-rollover" });
    expect(refundStatus({ ...open, status: "Closed" }, due)).toMatchObject({ refundable: false, reason: "crossing" });
  });

  it("charges fees the way the program does", () => {
    expect(FEE_CAP_BPS).toBe(50);
    // $100 at 0.5 %: $0.50 on top; the finisher's 0.3 % is $0.30, the treasury's rest $0.20.
    expect(bpsOf(100_000_000n, 50)).toBe(500_000n);
    expect(depositCost(100_000_000n, 50)).toBe(100_500_000n);
    expect(bpsOf(100_000_000n, 30)).toBe(300_000n);
    // Rounded down, as on chain (programs/gateway/tests: 1_234_567 -> 6_172 and 3_703).
    expect(bpsOf(1_234_567n, 50)).toBe(6_172n);
    expect(bpsOf(1_234_567n, 30)).toBe(3_703n);
    expect(depositCost(100_000_000n, 0)).toBe(100_000_000n);
    // The open epoch's snapshot wins over the config; a new epoch takes the config's fee.
    const cfg = { params: { feeBps: 20 } as Params };
    expect(depositFeeBps(cfg, { status: "Open", feeBps: 50 })).toBe(50);
    expect(depositFeeBps(cfg, undefined)).toBe(20);
    expect(depositRoom({ netDeposits: 30n, params: { depositCap: 100n } as Params })).toBe(70n);
    expect(depositRoom({ netDeposits: 100n, params: { depositCap: 100n } as Params })).toBe(0n);
  });

  it("encodes params as the program's Borsh layout", () => {
    const treasury = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const b = encodeParams({ epochLenSlots: 9_000n, minBatchSize: 8, perEpochCap: 32, feeBps: 50, finisherBps: 30, depositCap: 50_000_000_000n, treasury });
    expect(b.length).toBe(PARAMS_LEN);
    const dv = new DataView(b.buffer);
    expect([dv.getBigUint64(0, true), dv.getUint16(8, true), dv.getUint16(10, true), dv.getUint16(12, true), dv.getUint16(14, true), dv.getBigUint64(16, true)])
      .toEqual([9_000n, 8, 32, 50, 30, 50_000_000_000n]);
    expect(b.slice(24)).toEqual(new Uint8Array(getAddressEncoder().encode(treasury)));
    const fields = idl.types.find((t: { name: string }) => t.name === "Params").type.fields.map((f: { name: string }) => f.name);
    expect(fields).toEqual(["epoch_len_slots", "min_batch_size", "per_epoch_cap", "fee_bps", "finisher_bps", "deposit_cap", "treasury"]);
  });

  it("builds instructions with the IDL's accounts, in order, with its roles", async () => {
    // Distinct placeholder addresses, so no two accounts collapse into one.
    const key = (n: number) => getAddressDecoder().decode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 1)));
    const payer = key(1), authority = key(2), source = key(3), mint = key(4);
    const event = key(5), finisherUsdc = key(6), treasury = key(7), destination = key(8);
    const params: Params = { epochLenSlots: 2_250n, minBatchSize: 4, perEpochCap: 4, feeBps: 50, finisherBps: 30, depositCap: 1n, treasury };
    // A 427-byte exit message: header and burn body zero except the nonce, then the version-2 hook.
    const exitMessage = new Uint8Array(427);
    exitMessage.fill(9, 12, 44);
    exitMessage.set(encodeExitHook({ denomination: 1n, exitEpochId: 3n, count: 1, root: 7n }), 376);
    const built: [string, Instruction][] = [
      ["initialize", await initializeIx({ admin: payer, usdcMint: mint, guardian: payer, portal: "0x" + "11".repeat(20), denominations: [1n], params, adminLifetimeSecs: 1n })],
      ["deposit", await depositIx({ payer, authority, source, usdcMint: mint, denominationIndex: 0, currentEpochId: 0n, commitment: new Uint8Array(32) })],
      ["send_batch", await sendBatchIx({ payer, usdcMint: mint, messageSentEventData: event, denominationIndex: 0, epochId: 0n, finisherUsdc, treasury })],
      ["refund_deposit", await refundDepositIx({ authority, destination, usdcMint: mint, denominationIndex: 0, currentEpochId: 0n, commitment: new Uint8Array(32) })],
      ["propose_params", await proposeParamsIx(payer, params)],
      ["apply_params", await applyParamsIx()],
      ["receive_exit", await receiveExitIx({ payer, usdcMint: mint, message: exitMessage, attestation: new Uint8Array(130), denominations: [1n], cctpFeeRecipient: treasury })],
      ["claim_exit", await claimExitIx({ payer, usdcMint: mint, denominationIndex: 0, exitEpochId: 3n, leafIndex: 5, path: Array(8).fill(1n), destination, secret: 2n })],
    ];
    for (const [name, ix] of built) {
      const spec = idl.instructions.find((i: { name: string }) => i.name === name).accounts as { name: string; writable?: boolean; signer?: boolean }[];
      const roles = ix.accounts!.map((a) => a.role);
      const want = spec.map((a) =>
        a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY);
      expect({ name, roles }).toEqual({ name, roles: want });
    }
    const named = (name: string, ix: Instruction, account: string) =>
      ix.accounts![idl.instructions.find((i: { name: string }) => i.name === name).accounts.findIndex((a: { name: string }) => a.name === account)]!.address;
    const send = built.find(([n]) => n === "send_batch")![1];
    expect(named("send_batch", send, "finisher_usdc")).toBe(finisherUsdc);
    expect(named("send_batch", send, "treasury")).toBe(treasury);
    expect(named("initialize", built[0]![1], "treasury")).toBe(treasury);
    const claim = built.find(([n]) => n === "claim_exit")![1];
    expect(named("claim_exit", claim, "destination_wallet")).toBe(destination);
    expect(named("claim_exit", claim, "destination_usdc")).toBe(await associatedTokenAddress(destination, mint));
    // The IDL's fixed addresses (programs and pinned CCTP accounts) are the builders'.
    for (const [name, ix] of built) {
      const spec = idl.instructions.find((i: { name: string }) => i.name === name).accounts as { name: string; address?: string }[];
      spec.forEach((a, i) => {
        if (a.address) expect({ name, account: a.name, address: ix.accounts![i]!.address }).toEqual({ name, account: a.name, address: a.address });
      });
    }
  });

  it("derives associated token accounts", async () => {
    // Vector from `spl-token address --owner <gateway id> --token <devnet USDC>` (Agave 4.3.0).
    const owner = address("4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf");
    const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(await associatedTokenAddress(owner, mint)).toBe("6mgTbkziKW9z4z9SrVd4hsVsYdFkSchGgH49mcrMWsS2");
  });

  it("checks the configured portal", () => {
    const portal = new Uint8Array(32);
    portal.set([0xab, 0xcd], 30);
    expect(configPortalAddress({ portal })).toBe("0x" + "00".repeat(18) + "abcd");
    expect(portalMatches({ portal }, "0x" + "00".repeat(18) + "ABCD")).toBe(true);
    expect(portalMatches({ portal }, "0x" + "00".repeat(18) + "abce")).toBe(false);
    expect(portalMatches({ portal }, "")).toBe(false);
  });
});


describe("address lookup tables (receive_exit)", () => {
  it("creates the table at the (authority, slot) PDA and extends it with 32-byte addresses", async () => {
    const authority = address("3F5qRPtKg8GhGNnbd3qCj6nVJxWsGxq7pvH84okYLAqf");
    const { ix, table } = await createLookupTableIx({ authority, payer: authority, recentSlot: 513n });
    const data = ix.data!;
    expect(Array.from(data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(4, true)).toBe(513n);
    expect(data.length).toBe(13);
    expect(ix.accounts![0]).toEqual({ address: table, role: AccountRole.WRITABLE });
    const ext = extendLookupTableIx({ table, authority, payer: authority, addresses: [authority, GATEWAY_PROGRAM_ID] });
    expect(ext.data!.length).toBe(4 + 8 + 64);
    expect(ext.data![0]).toBe(2);
    const raw = new Uint8Array(56 + 64);
    raw.set(ext.data!.slice(12), 56);
    expect(decodeLookupTable(raw)).toEqual([authority, GATEWAY_PROGRAM_ID]);
  });
});
