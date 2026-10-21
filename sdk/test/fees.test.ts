import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSpentSlotError, MAX_SPONSOR_SLOTS, refillAmount, resolveFees, slotsToTry, SPONSORED_GAS } from "../src/fees.js";

const repo = new URL("../../", import.meta.url).pathname;
const json = (p: string) => JSON.parse(readFileSync(repo + p, "utf8"));

describe("fees (ADR 0018)", () => {
  it("testnet keeps the SponsoredFPC for everyone (no fees field)", () => {
    const dep = json("deployments/testnet.json");
    expect(dep.fees).toBeUndefined();
    expect(resolveFees(dep)).toEqual({ user: "sponsoredFpc", operator: "sponsoredFpc" });
  });

  it("the mainnet template: users through the Eclyps FPC, the operator with its own Fee Juice", () => {
    const dep = json("deployments/mainnet.template.json");
    expect(dep.network).toBe("mainnet");
    expect(dep.denominations).toEqual(["100000000", "1000000000"]);
    // The FPC is not deployed yet: the template refuses to resolve until its address is filled in.
    expect(() => resolveFees(dep)).toThrow(/address is empty/);
    const filled = { ...dep, fees: { ...dep.fees, eclypsFpc: { ...dep.fees.eclypsFpc, address: "0x01" } } };
    const r = resolveFees(filled);
    expect(r.user).toBe("eclypsFpc");
    expect(r.operator).toBe("feeJuice");
    expect(Object.keys(r.eclypsFpc!.slots).sort()).toEqual([...dep.denominations].sort());
  });

  it("mainnet refuses the SponsoredFPC", () => {
    expect(() => resolveFees({ network: "mainnet" })).toThrow(/no SponsoredFPC/);
    expect(() => resolveFees({ network: "mainnet", fees: { user: "feeJuice" } })).toThrow(/no SponsoredFPC/);
    expect(resolveFees({ network: "mainnet", fees: { user: "feeJuice", operator: "feeJuice" } })).toEqual({ user: "feeJuice", operator: "feeJuice" });
  });

  it("rejects unknown modes and bad slot tables", () => {
    expect(() => resolveFees({ network: "testnet", fees: { user: "free" as never } })).toThrow(/unknown mode/);
    expect(() => resolveFees({ network: "testnet", fees: { operator: "eclypsFpc" as never } })).toThrow(/unknown mode/);
    const fpc = (slots: Record<string, number>) => ({ network: "testnet", fees: { user: "eclypsFpc" as const, eclypsFpc: { address: "0x01", slots } } });
    expect(() => resolveFees(fpc({}))).toThrow(/slots is empty/);
    expect(() => resolveFees(fpc({ "100000000": 0 }))).toThrow(/bad entry/);
    expect(() => resolveFees(fpc({ "100000000": MAX_SPONSOR_SLOTS + 1 }))).toThrow(/bad entry/);
    expect(() => resolveFees(fpc({ "1e8": 4 }))).toThrow(/bad entry/);
    expect(resolveFees(fpc({ "100000000": 4 })).eclypsFpc!.slots).toEqual({ "100000000": 4 });
  });

  it("matches the FPC contract's caps", () => {
    const src = readFileSync(repo + "aztec/fpc/src/main.nr", "utf8");
    const num = (name: string) => Number(src.match(new RegExp(`pub global ${name}: u32 = ([\\d_]+);`))![1]!.replaceAll("_", ""));
    expect(SPONSORED_GAS.l2Gas).toBe(num("SPONSOR_MAX_L2_GAS"));
    expect(SPONSORED_GAS.daGas).toBe(num("SPONSOR_MAX_DA_GAS"));
    expect(MAX_SPONSOR_SLOTS).toBe(num("MAX_SLOTS"));
  });

  it("tries each slot once, starting where the transaction kind starts", () => {
    expect(slotsToTry(0, 4)).toEqual([0, 1, 2, 3]);
    expect(slotsToTry(1, 4)).toEqual([1, 2, 3, 0]);
    expect(slotsToTry(5, 4)).toEqual([0, 1, 2, 3]);
    expect(slotsToTry(1, 1)).toEqual([0]);
  });

  it("recognises a spent slot", () => {
    expect(isSpentSlotError(new Error("Nullifier collision"))).toBe(true);
    expect(isSpentSlotError(new Error("Existing nullifier"))).toBe(true);
    expect(isSpentSlotError(new Error("tx failed", { cause: "duplicate nullifier in tx" }))).toBe(true);
    expect(isSpentSlotError(new Error("not a member of root"))).toBe(false);
  });

  it("refills only below the low mark, back to the target", () => {
    const fj = (n: number) => BigInt(n) * 10n ** 18n;
    const policy = { low: 500, target: 2_000 };
    expect(refillAmount(fj(600), policy)).toBe(0n);
    expect(refillAmount(fj(500), policy)).toBe(0n);
    expect(refillAmount(fj(120), policy)).toBe(fj(1_880));
    expect(() => refillAmount(0n, { low: 10, target: 5 })).toThrow(/below the low mark/);
  });
});
