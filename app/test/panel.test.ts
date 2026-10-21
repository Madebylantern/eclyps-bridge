/**
 * The control panel (src/lib/panel.ts): which wallets it lists, when one needs topping up, and
 * how amounts read. Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { amount, explorerOf, l1Usdc, level, type PanelDeployment, walletsOf } from "../src/lib/panel.ts";

const testnet: PanelDeployment = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8"));
const mainnet = (): PanelDeployment => ({
  ...testnet,
  network: "mainnet",
  solana: { ...testnet.solana, cluster: "mainnet", admin: "Admin1111111111111111111111111111111111111" },
  l1: { ...testnet.l1, chainId: 1, deployer: "0x00000000000000000000000000000000000000d1" },
  aztec: { ...testnet.aztec, admin: "0xa1" },
  finisher: { solana: "Fin11111111111111111111111111111111111111111", ethereum: "0x00000000000000000000000000000000000000f1", aztec: "0xf1" },
  fees: {
    user: "eclypsFpc", operator: "feeJuice", eclypsFpc: { address: "0xfc", slots: { "100000000": 3 } },
    operatorFeeJuice: { low: 500, target: 2000 }, fpcFeeJuice: { low: 1000, target: 5000 },
  } as PanelDeployment["fees"],
  fpcTest: undefined,
});
const FJ = 10n ** 18n;

describe("walletsOf", () => {
  it("lists the testnet wallets, without the finisher's Aztec account (the SponsoredFPC pays there)", () => {
    const keys = walletsOf(testnet).map((w) => w.key);
    assert.deepEqual(keys, ["sol-admin", "sol-finisher", "eth-deployer", "eth-finisher", "az-admin", "az-fpc"]);
    assert.equal(walletsOf(testnet).find((w) => w.key === "az-fpc")!.address, testnet.fpcTest!.fpc);
  });
  it("on mainnet adds the finisher's Fee Juice and takes the levels from the deployment", () => {
    const w = walletsOf(mainnet(), { admin: "Admin1111111111111111111111111111111111111", guardian: "Guard11111111111111111111111111111111111111" });
    assert.deepEqual(w.map((x) => x.key), ["sol-admin", "sol-guardian", "sol-finisher", "eth-deployer", "eth-finisher", "az-admin", "az-finisher", "az-fpc"]);
    const fpc = w.find((x) => x.key === "az-fpc")!;
    assert.equal(fpc.low, 1_000n * FJ);
    assert.equal(fpc.target, 5_000n * FJ);
    assert.equal(w.find((x) => x.key === "eth-finisher")!.low, 2n * 10n ** 16n);
  });
  it("prefers the admin the gateway config names, and hides a guardian that is the admin", () => {
    const w = walletsOf(testnet, { admin: "OnChainAdmin111111111111111111111111111111", guardian: "OnChainAdmin111111111111111111111111111111" });
    assert.equal(w.find((x) => x.key === "sol-admin")!.address, "OnChainAdmin111111111111111111111111111111");
    assert.equal(w.find((x) => x.key === "sol-guardian"), undefined);
  });
});

describe("level", () => {
  const w = { low: 1_000n, target: 4_000n };
  it("asks for a top-up under the low mark only", () => {
    assert.deepEqual(level(999n, w), { fill: 0.249, low: true });
    assert.deepEqual(level(1_000n, w), { fill: 0.25, low: false });
  });
  it("fills to the target and no further", () => {
    assert.equal(level(9_000n, w).fill, 1);
    assert.equal(level(0n, w).fill, 0);
  });
  it("has no gauge for a key without a level", () => {
    assert.deepEqual(level(5n, {}), { low: false });
  });
});

describe("amount", () => {
  it("reads each unit plainly", () => {
    assert.equal(amount(214_400_000n, "SOL"), "0.214 SOL");
    assert.equal(amount(12_345_678_900_000_000n, "ETH"), "0.0123 ETH");
    assert.equal(amount(1_994n * FJ + FJ / 3n, "FJ"), "1,994 FJ");
    assert.equal(amount(8_020_000n, "USDC"), "$8.02");
    assert.equal(amount(0n, "SOL"), "0.000 SOL");
  });
});

describe("links", () => {
  it("points each chain at its explorer for the network", () => {
    assert.equal(explorerOf(testnet, "solana", "abc"), "https://explorer.solana.com/address/abc?cluster=devnet");
    assert.equal(explorerOf(mainnet(), "solana", "abc"), "https://explorer.solana.com/address/abc");
    assert.equal(explorerOf(testnet, "ethereum", "0x1"), "https://sepolia.etherscan.io/address/0x1");
    assert.equal(explorerOf(testnet, "aztec", "0x1"), undefined);
    assert.equal(l1Usdc(1), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  });
});
