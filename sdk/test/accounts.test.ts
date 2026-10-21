import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { configPortalAddress, decodeConfig, decodeEpoch, epochNoteFee } from "../src/gateway.js";

// Real account bytes written by the gateway's LiteSVM tests (programs/gateway/tests/instructions.rs
// account_fixtures_for_the_sdk): the hand-written decoders must read what the program writes.
const fx = JSON.parse(readFileSync(new URL("./fixtures/gateway-accounts.json", import.meta.url), "utf8"));
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

describe("decoders against program-written accounts", () => {
  it("decodes Config", () => {
    const c = decodeConfig(bytes(fx.config.data));
    expect(c.admin).toBe(fx.config.admin);
    expect(c.guardian).toBe(fx.config.guardian);
    expect(c.pendingAdmin).toBe(fx.config.pendingAdmin);
    expect(c.denominations).toEqual([100_000_000n, 1_000_000_000n, 0n, 0n]);
    expect(c.currentEpoch).toEqual([0n, 0n, 0n, 0n]);
    expect(c.params).toEqual({
      epochLenSlots: 9_000n, minBatchSize: 8, perEpochCap: 32, feeBps: 50, finisherBps: 30,
      depositCap: BigInt(fx.config.depositCap), treasury: fx.config.treasury,
    });
    expect(c.escrow).toBe(fx.config.escrow);
    expect(c.feeVault).toBe(fx.config.feeVault);
    expect(c.exitCustody).toBe(fx.config.exitCustody);
    expect(c.netDeposits).toBe(BigInt(fx.config.netDeposits));
    expect(c.netDeposits).toBe(200_000_000n); // two $100 notes
    // The fixture has a pending change: a higher per-epoch cap, same fee.
    expect(c.pending?.params).toEqual({ ...c.params, perEpochCap: 64 });
    expect(c.pending!.eta).toBeGreaterThan(0n);
    expect(c.pausedDeposits).toBe(true);
    expect(c.pauseCooldownUntil - c.pauseExpiry).toBe(7n * 86_400n);
    expect(c.adminExpiryTs).toBeGreaterThan(c.pauseExpiry);
    expect(configPortalAddress(c)).toBe("0x" + "00".repeat(17) + "0ec175");
  });

  it("decodes Epoch with its depositors", () => {
    const e = decodeEpoch(bytes(fx.epoch.data));
    expect(e).toMatchObject({ denominationIndex: 0, denomination: 100_000_000n, epochId: 0n, status: "Open", rollovers: 0 });
    expect(e.leaves).toEqual(fx.epoch.leaves.map((h: string) => BigInt("0x" + h)));
    expect(e.depositors).toEqual(fx.epoch.depositors);
    expect(e.endSlot - e.openedSlot).toBe(9_000n);
    expect({ feeBps: e.feeBps, finisherBps: e.finisherBps }).toEqual({ feeBps: fx.epoch.feeBps, finisherBps: fx.epoch.finisherBps });
    expect(epochNoteFee(e)).toBe(500_000n);
  });
});
