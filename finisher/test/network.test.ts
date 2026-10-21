/**
 * The public finisher's configuration (src/network.ts): chain, Iris, CCTP domains, endpoints, keys,
 * fee mode, gas cap, and the mainnet gate. Pure: no network, no files.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ConfigError,
  type Deployment,
  deploymentPath,
  type Env,
  feeJuiceCheckDue,
  gasCheck,
  IRIS,
  maxGwei,
  requestedNetwork,
  resolveConfig,
} from "../src/network.js";

const testnet: Deployment = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8"));
const template = JSON.parse(readFileSync(new URL("../../deployments/mainnet.template.json", import.meta.url), "utf8"));

/** A filled-in mainnet deployment, as scripts/mainnet would write it (made-up addresses). */
function mainnetDep(over: Partial<Deployment> = {}): Deployment {
  const d = structuredClone(template);
  delete d._template;
  d.l1.portal = "0x00000000000000000000000000000000000000aa";
  d.aztec.node = "https://aztec-mainnet.example";
  d.fees.eclypsFpc.address = "0x0000000000000000000000000000000000000000000000000000000000000bbb";
  return { ...d, ...over };
}

const MAIN_OK: Env = { ECLYPS_MAINNET_OK: "1", DEPLOYMENT: "/x/mainnet.json" };
const resolveTestnet = (env: Env = {}, argv: string[] = [], dep: Deployment = testnet) =>
  resolveConfig({ argv, env, dep, deploymentPath: "/x/testnet.json", home: "/home/f" });
const resolveMainnet = (env: Env = MAIN_OK, argv: string[] = ["--mainnet"], dep: Deployment = mainnetDep()) =>
  resolveConfig({ argv, env, dep, deploymentPath: "/x/mainnet.json", home: "/home/f" });
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ConfigError && re.test(e.message));

describe("network asked for", () => {
  it("defaults to testnet; --mainnet or NETWORK=mainnet asks for mainnet", () => {
    assert.equal(requestedNetwork([], {}), "testnet");
    assert.equal(requestedNetwork(["--mainnet"], {}), "mainnet");
    assert.equal(requestedNetwork([], { NETWORK: "mainnet" }), "mainnet");
    assert.equal(requestedNetwork(["--testnet"], { NETWORK: "testnet" }), "testnet");
  });
  it("refuses a conflict or an unknown NETWORK", () => {
    refused(() => requestedNetwork(["--testnet"], { NETWORK: "mainnet" }), /NETWORK=mainnet/);
    refused(() => requestedNetwork(["--mainnet", "--testnet"], {}), /both/);
    refused(() => requestedNetwork([], { NETWORK: "devnet" }), /NETWORK must be/);
  });
  it("mainnet needs DEPLOYMENT set; testnet defaults to deployments/testnet.json", () => {
    refused(() => deploymentPath("mainnet", {}, "/repo/deployments/testnet.json"), /set DEPLOYMENT/);
    assert.equal(deploymentPath("testnet", {}, "/repo/deployments/testnet.json"), "/repo/deployments/testnet.json");
    assert.equal(deploymentPath("mainnet", { DEPLOYMENT: "/d/mainnet.json" }, "/t"), "/d/mainnet.json");
  });
});

describe("the mainnet gate", () => {
  it("runs on mainnet with all three: --mainnet, a mainnet deployment, ECLYPS_MAINNET_OK=1", () => {
    assert.equal(resolveMainnet().network, "mainnet");
    assert.equal(resolveMainnet({ ...MAIN_OK, NETWORK: "mainnet" }, [], mainnetDep()).network, "mainnet", "or NETWORK=mainnet");
  });
  it("refuses without ECLYPS_MAINNET_OK=1", () => {
    refused(() => resolveMainnet({ DEPLOYMENT: "/x" }), /ECLYPS_MAINNET_OK=1/);
    refused(() => resolveMainnet({ DEPLOYMENT: "/x", ECLYPS_MAINNET_OK: "true" }), /ECLYPS_MAINNET_OK=1/);
  });
  it("refuses mainnet on a testnet deployment, and a mainnet deployment without --mainnet", () => {
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], testnet), /"testnet" deployment/);
    refused(() => resolveTestnet({ ECLYPS_MAINNET_OK: "1" }, [], mainnetDep()), /mainnet deployment; run the mainnet finisher/);
    refused(() => resolveTestnet({}, ["--testnet"], mainnetDep()), /mainnet deployment/);
  });
  it("refuses the template, a deployment without a portal, and a mainnet deployment off chain 1", () => {
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], template), /template/);
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ l1: { chainId: 1, portal: "" } })), /no portal/);
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ l1: { chainId: 11155111, portal: "0x01" } })), /chain 1, not 11155111/);
    refused(() => resolveTestnet({}, [], { ...testnet, l1: { ...testnet.l1, chainId: 1 } }), /testnet deployment on Ethereum mainnet/);
    refused(() => resolveTestnet({}, [], { ...testnet, l1: { ...testnet.l1, chainId: 5 } }), /unknown l1.chainId 5/);
  });
  it("refuses a mainnet deployment without SponsoredFPC-free fees (ADR 0018)", () => {
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ fees: undefined })), /no SponsoredFPC/);
  });
});

describe("testnet (unchanged behaviour)", () => {
  const c = resolveTestnet();
  it("Sepolia, the Iris sandbox, domains 0 and 5, the SponsoredFPC, no gas cap", () => {
    assert.equal(c.chain.id, 11155111);
    assert.equal(c.l1Name, "Sepolia");
    assert.equal(c.iris, IRIS.testnet);
    assert.deepEqual(c.domains, { ethereum: 0, solana: 5 });
    assert.equal(c.fees.operator, "sponsoredFpc");
    assert.equal(c.maxGwei, undefined);
  });
  it("endpoints from the deployment, overridden by env (SEPOLIA_RPC_URL still read)", () => {
    assert.equal(c.rpc.solana, testnet.solana.rpc);
    assert.equal(c.rpc.ethereum, testnet.l1.rpc);
    assert.equal(c.rpc.aztec, testnet.aztec.node);
    const o = resolveTestnet({ SOLANA_RPC_URL: "https://s.example", SEPOLIA_RPC_URL: "https://e.example/", AZTEC_NODE_URL: "https://a.example" });
    assert.deepEqual(o.rpc, { solana: "https://s.example", ethereum: "https://e.example", aztec: "https://a.example" });
    assert.equal(resolveTestnet({ ETHEREUM_RPC_URL: "https://n.example", SEPOLIA_RPC_URL: "https://o.example" }).rpc.ethereum, "https://n.example");
  });
  it("keeps the testnet key and state paths and env names", () => {
    assert.equal(c.keys.solanaFile, "/home/f/.config/eclyps/devnet.json");
    assert.equal(c.keys.ethereumFile, "/home/f/.config/eclyps/sepolia.key");
    assert.equal(c.statePath, "/home/f/.config/eclyps/testnet/finisher-state.json");
    const e = resolveTestnet({ FINISHER_SEPOLIA_KEY: "/k/s.key", FINISHER_SEPOLIA_PRIVATE_KEY: "0xabc", ECLYPS_DATA_DIR: "/data" });
    assert.equal(e.keys.ethereumFile, "/k/s.key");
    assert.equal(e.keys.ethereumInline, "0xabc");
    assert.equal(e.statePath, "/data/finisher-state.json");
  });
  it("refuses the mainnet Iris on testnet", () => {
    refused(() => resolveTestnet({ IRIS_URL: IRIS.mainnet }), /mainnet Iris/);
  });
});

describe("mainnet", () => {
  const c = resolveMainnet();
  it("Ethereum, Circle's production Iris, domains from the deployment, Fee Juice, a 20 gwei cap", () => {
    assert.equal(c.chain.id, 1);
    assert.equal(c.l1Name, "Ethereum");
    assert.equal(c.iris, "https://iris-api.circle.com");
    assert.deepEqual(c.domains, { ethereum: 0, solana: 5 });
    assert.equal(c.fees.operator, "feeJuice");
    assert.equal(c.maxGwei, 20);
  });
  it("reads Iris and the domains from the deployment's cctp block", () => {
    const d = resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ cctp: { iris: "https://iris-api.circle.com/", domains: { ethereum: 0, solana: 7 } } }));
    assert.equal(d.iris, "https://iris-api.circle.com");
    assert.deepEqual(d.domains, { ethereum: 0, solana: 7 });
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ cctp: { domains: { solana: -1 } } })), /uint32/);
    assert.equal(resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ cctp: undefined })).iris, IRIS.mainnet, "default without the block");
  });
  it("refuses the Iris sandbox on mainnet", () => {
    refused(() => resolveMainnet({ ...MAIN_OK, IRIS_URL: IRIS.testnet }), /sandbox/);
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], mainnetDep({ cctp: { iris: IRIS.testnet } })), /sandbox/);
  });
  it("endpoints: env, else the deployment, else mainnet defaults; SEPOLIA_RPC_URL is ignored", () => {
    assert.equal(c.rpc.ethereum, template.l1.rpc);
    assert.equal(c.rpc.aztec, "https://aztec-mainnet.example");
    const bare = mainnetDep();
    bare.solana = { ...bare.solana, rpc: undefined };
    bare.l1 = { ...bare.l1, rpc: undefined };
    const d = resolveMainnet({ ...MAIN_OK, SEPOLIA_RPC_URL: "https://sepolia.example" }, ["--mainnet"], bare);
    assert.equal(d.rpc.solana, "https://api.mainnet-beta.solana.com");
    assert.equal(d.rpc.ethereum, "https://ethereum-rpc.publicnode.com");
    assert.equal(resolveMainnet({ ...MAIN_OK, ETHEREUM_RPC_URL: "https://eth.example" }).rpc.ethereum, "https://eth.example");
    refused(() => resolveMainnet({ ...MAIN_OK, SOLANA_RPC_URL: "not a url" }), /not an http/);
  });
  it("needs an Aztec node (the template has none)", () => {
    const d = mainnetDep();
    d.aztec = { ...d.aztec, node: "" };
    refused(() => resolveMainnet(MAIN_OK, ["--mainnet"], d), /AZTEC_NODE_URL/);
    assert.equal(resolveMainnet({ ...MAIN_OK, AZTEC_NODE_URL: "https://n.example" }, ["--mainnet"], d).rpc.aztec, "https://n.example");
  });
  it("uses its own key and state paths, and never the Sepolia key variables", () => {
    assert.equal(c.keys.solanaFile, "/home/f/.config/eclyps/mainnet/solana.json");
    assert.equal(c.keys.ethereumFile, "/home/f/.config/eclyps/mainnet/ethereum.key");
    assert.equal(c.keys.ethereumFileEnv, "FINISHER_ETHEREUM_KEY");
    assert.equal(c.statePath, "/home/f/.config/eclyps/mainnet/finisher-state.json");
    assert.equal(resolveMainnet({ ...MAIN_OK, FINISHER_SEPOLIA_KEY: "/k/s.key" }).keys.ethereumFile, "/home/f/.config/eclyps/mainnet/ethereum.key");
    refused(() => resolveMainnet({ ...MAIN_OK, FINISHER_SEPOLIA_PRIVATE_KEY: "0xabc" }), /FINISHER_ETHEREUM_PRIVATE_KEY/);
    assert.equal(resolveMainnet({ ...MAIN_OK, FINISHER_ETHEREUM_PRIVATE_KEY: "0xdef" }).keys.ethereumInline, "0xdef");
  });
});

describe("gas guard and Fee Juice loop", () => {
  it("FINISHER_MAX_GWEI: the network's default, a number, or off", () => {
    assert.equal(maxGwei("mainnet", {}), 20);
    assert.equal(maxGwei("testnet", {}), undefined);
    assert.equal(maxGwei("mainnet", { FINISHER_MAX_GWEI: "5.5" }), 5.5);
    assert.equal(maxGwei("mainnet", { FINISHER_MAX_GWEI: "off" }), undefined);
    assert.equal(maxGwei("testnet", { FINISHER_MAX_GWEI: "3" }), 3);
    refused(() => maxGwei("mainnet", { FINISHER_MAX_GWEI: "0" }), /positive/);
    refused(() => maxGwei("mainnet", { FINISHER_MAX_GWEI: "lots" }), /positive/);
  });
  it("sends at or under the cap, waits above it", () => {
    assert.deepEqual(gasCheck(20_000_000_000n, 20), { ok: true, gwei: 20 });
    assert.equal(gasCheck(20_000_000_001n, 20).ok, false);
    assert.equal(gasCheck(40_000_000n, 20).ok, true);
    assert.equal(gasCheck(10n ** 15n, undefined).ok, true, "no cap");
  });
  it("checks Fee Juice at once, then every period", () => {
    assert.equal(feeJuiceCheckDue(undefined, 0, 1_800_000), true);
    assert.equal(feeJuiceCheckDue(1_000, 1_000 + 1_799_999, 1_800_000), false);
    assert.equal(feeJuiceCheckDue(1_000, 1_000 + 1_800_000, 1_800_000), true);
  });
});
