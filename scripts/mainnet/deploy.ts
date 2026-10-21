/**
 * Mainnet deployment, step by step (docs/mainnet-checklist.md). Mirrors testnet/run.ts, with a gate:
 * every step is a dry run that prints exactly what it would send and what it would cost; it sends
 * only with `--send --mainnet` AND the owner's confirmation file holding the plan digest (lib.ts).
 * `--rehearsal` runs the same code against local stand-ins (mainnet/rehearse.sh) and refuses any
 * non-local endpoint.
 *
 * Run from scripts/ (Node >= 24.12; behind a proxy NODE_USE_ENV_PROXY=1):
 *   pnpm exec tsx mainnet/deploy.ts <step> [--send --mainnet | --rehearsal [--send]] [options]
 *
 *   preflight   read-only: v6 executed (Registry canonical rollup), Inbox/Outbox, VK tree root of the
 *               installed Aztec packages == mainnet's, CCTP V2 contracts/programs and USDC, deployer
 *               balances (SOL, ETH, AZTEC on L1, Fee Juice on Aztec)
 *   gateway     1. solana program deploy (upgrade authority = the admin key, ADR 0010)
 *   portal      2. EclypsPortal on Ethereum; refuses unless the canonical rollup is v6
 *   init        3. gateway initialize ($100 / $1,000, 0.5 % fee split 0.3/0.2, $5,000 cap, guardian,
 *                  treasury) + init_screening. The V2 lanes stay off (init_lanes is never sent)
 *   fee-juice   bridge AZTEC to an Aztec account through the FeeJuicePortal (--to admin|fpc|<addr>
 *               --amount <whole Fee Juice>); the claim secret stays in the private dir
 *   aztec       4. EclypsMinter, Token (AIP-20, minted only through EclypsMinter; ADR 0020), EclypsClaim
 *                  per denomination, the minter's one wiring call, EclypsFPC (ADR 0018), paid with the
 *                  admin's Fee Juice; claims bridged Fee Juice on L2
 *   renounce-minter  the Aztec admin gives up listing new claim contracts: the list is fixed for good
 *                  (owner's choice, ADR 0020)
 *   wire        5. bindClaimContract per denomination (portal deployer); completes deployments/mainnet.json
 *   verify      6. read-only post-deploy checks
 *   pause | unpause      the guardian's deposit pause (7 days at most, ADR 0010)
 *
 * Options:
 *   --solana-keypair <file>   admin = upgrade authority = payer (default <private dir>/solana-admin.json)
 *   --guardian <pubkey>       guardian (default: the admin, with a warning)
 *   --guardian-keypair <file> signs pause/unpause
 *   --treasury-owner <pubkey> owner of the treasury USDC account (default: the admin; no multisig, ADR 0021)
 *   --program-keypair <file>  the gateway's program key (default target/deploy/eclyps_gateway-keypair.json)
 *   Ethereum signer: --ledger [--hd-path m/44'/60'/0'/0/0] | --from <addr> [--signed <file>] | --eth-key <file>
 *   --gwei a,b,c  --max-gwei n  --cu-price µlamports  --eth-usd --sol-usd --fj-usd   (estimates, caps)
 * Private (never committed): ~/.config/eclyps/mainnet/ (keys, Aztec PXE, Fee Juice claim secrets,
 * confirm/). Public: deployments/mainnet.json.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EthAddress, AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { generateClaimSecret } from "@aztec-labs/aztec.js/ethereum";
import { FeeJuicePaymentMethodWithClaim } from "@aztec-labs/aztec.js/fee";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { FeeJuiceContract } from "@aztec-labs/aztec.js/protocol";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { type Address, address, createSolanaRpc, type Instruction } from "@solana/kit";
import { createPublicClient, encodeDeployData, encodeFunctionData, type Hex, http, keccak256, parseAbi, parseEventLogs, zeroAddress } from "viem";
import {
  associatedTokenAddress,
  CCTP,
  configPda,
  createAssociatedTokenIdempotentIx,
  decodeConfig,
  decodeScreening,
  escrowPda,
  exitAuthorityPda,
  exitCustodyPda,
  EXIT_EPOCH_BLOCKS,
  feeVaultPda,
  GATEWAY_PROGRAM_ID,
  initializeIx,
  initScreeningIx,
  lanesPda,
  MIN_EXIT_BATCH,
  programDataPda,
  resolveFees,
  screeningPda,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { EclypsFPCContract } from "../../aztec/artifacts/EclypsFPC.js";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";
import { connectAztec, loadSolanaKeypair, newAztecKeys, solanaClient } from "../../finisher/src/chains.js";
import {
  AwaitSignature, AZTEC_L1_RPC, AZTEC_NODE, b32, cctpBurnAccounts, type Check, computeUnitPriceIx, consumeConfirmation, CU_PRICE,
  ETH_RPC, ethCost, ethSigner, fjCost, forgeArtifact, gate, has, hex, installedVkTreeRoot, LAUNCH, loadPrivate, loadRecord, log,
  MAINNET, opt, PRIVATE_DIR, RECORD_FILE, REHEARSAL, REPO, report, SECRET_HASH_ZERO, SEND, saveRecord, savePrivate, simulateSolana,
  sleep, SOLANA_RPC, SOLANA_TMM, solanaCost, solanaGenesisHash, solanaKeypairPath, solanaPubkey,
} from "./lib.js";

const AZTEC_WAIT = { timeout: 1_800, interval: 5 };
/** Mana (billed L2 gas) of each Aztec transaction of the `aztec` step, measured on the local network
 * (6.0.0-rc.3, 2026-10-19, ADR 0020): EclypsMinter 847,879 (the kit's first transaction also claims the
 * admin's bridged Fee Juice), the AIP-20 Token 1,472,366, EclypsClaim 1,118,126 (publishing its class)
 * and 1,014,326, the minter's wiring 838,767 (two claims), EclypsFPC 1,155,151, a Fee Juice claim
 * 659,123. Rounded up; publishing a class that mainnet does not have yet may cost more. */
const MANA_ESTIMATE = { minter: 1_100_000n, token: 1_500_000n, claim: 1_150_000n, wire: 900_000n, fpc: 1_200_000n, feeJuiceClaim: 700_000n };
/** Gas measured in the rehearsal: portal deploy 2,156,524 and a bind 45,943 (mainnet fork); a Fee Juice
 * deposit 108,886 to 125,949 (the sandbox's L1); an ERC-20 approve about 46k. */
const GAS_ESTIMATE = { portal: 2_160_000n, bind: 46_000n, approve: 50_000n, depositFeeJuice: 130_000n };
/** Mainnet minimum fee per mana when no v6 node answers (v5 mainnet, 2026-10-18; ADR 0018). */
const FALLBACK_FEE_PER_MANA = 1_570_000_872_146n;

const rec = loadRecord();
const rpc = createSolanaRpc(SOLANA_RPC);
const { send: sendSolana, accountData } = solanaClient(SOLANA_RPC, log);
const l1 = createPublicClient({ transport: http(ETH_RPC) });
const usdcMint = MAINNET.solana.usdcMint;
const ethKeyDefault = `${PRIVATE_DIR}/ethereum.key`;
const PORTAL = () => forgeArtifact("EclypsPortal.sol", "EclypsPortal");
const sha256File = (p: string | URL) => createHash("sha256").update(readFileSync(p)).digest("hex");

const REGISTRY_ABI = parseAbi(["function getCanonicalRollup() view returns (address)"]);
const ROLLUP_ABI = parseAbi([
  "function getVersion() view returns (uint256)", "function getInbox() view returns (address)",
  "function getOutbox() view returns (address)", "function getVkTreeRoot() view returns (bytes32)",
]);
const PORTAL_READ_ABI = parseAbi([
  "function inbox() view returns (address)", "function outbox() view returns (address)", "function rollupVersion() view returns (uint256)",
  "function binder() view returns (address)", "function claimContract(uint64) view returns (bytes32)", "function gatewaySender() view returns (bytes32)",
  "function exitCustody() view returns (bytes32)", "function exitAuthority() view returns (bytes32)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)",
]);
const FEE_JUICE_PORTAL_ABI = parseAbi([
  "function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash) returns (bytes32, uint256)",
  "function UNDERLYING() view returns (address)", "function ROLLUP() view returns (address)",
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

// ---------------- shared reads ----------------
async function v6Status() {
  const canonical = (await l1.readContract({ address: MAINNET.aztec.registry, abi: REGISTRY_ABI, functionName: "getCanonicalRollup" })) as Hex;
  const read = (fn: "getVersion" | "getInbox" | "getOutbox" | "getVkTreeRoot") => l1.readContract({ address: canonical, abi: ROLLUP_ABI, functionName: fn });
  const [version, inbox, outbox, vkTreeRoot] = await Promise.all([read("getVersion"), read("getInbox"), read("getOutbox"), read("getVkTreeRoot")]);
  const executed = canonical.toLowerCase() === MAINNET.aztec.rollup.toLowerCase() && version === MAINNET.aztec.rollupVersion;
  return { canonical, version: version as bigint, inbox: inbox as Hex, outbox: outbox as Hex, vkTreeRoot: vkTreeRoot as Hex, executed };
}

/** The gateway's upgrade authority (ProgramData: u32 tag | u64 slot | Option<Pubkey>), or undefined. */
async function upgradeAuthority(): Promise<Address | undefined | null> {
  const d = await accountData(await programDataPda());
  if (!d) return null; // not deployed
  return d[12] === 1 ? (address((await import("@solana/kit")).getAddressDecoder().decode(d.subarray(13, 45))) as Address) : undefined;
}

const admin = async () => loadSolanaKeypair(solanaKeypairPath("admin"));
const adminAddress = async () => (existsSync(solanaKeypairPath("admin")) ? solanaPubkey(solanaKeypairPath("admin")) : undefined);

// ---------------- 0. preflight ----------------
async function preflight() {
  const checks: Check[] = [];
  const c = (name: string, ok: boolean, detail?: string, tolerated = false) => checks.push({ name, ok, detail, tolerated: tolerated && REHEARSAL });

  // Ethereum and Aztec L1
  const chainId = await l1.getChainId();
  c("Ethereum chain id is 1", chainId === MAINNET.ethereum.chainId, String(chainId));
  const v6 = await v6Status();
  c("Registry canonical rollup is v6 (AZUP-3 executed)", v6.executed,
    v6.executed ? v6.canonical : `canonical ${v6.canonical} version ${v6.version}; earliest execution Mon 2026-10-26 08:00 UTC if the vote passes`);
  c("v6 Inbox", v6.inbox.toLowerCase() === MAINNET.aztec.inbox.toLowerCase(), v6.inbox);
  c("v6 Outbox", v6.outbox.toLowerCase() === MAINNET.aztec.outbox.toLowerCase(), v6.outbox);
  c("v6 VK tree root on chain", v6.vkTreeRoot.toLowerCase() === MAINNET.aztec.vkTreeRoot.toLowerCase(), v6.vkTreeRoot);
  const vk = await installedVkTreeRoot();
  c(`installed Aztec packages (${vk.version}) match mainnet's VK tree root`, vk.root.toLowerCase() === MAINNET.aztec.vkTreeRoot.toLowerCase(),
    `${vk.root}; wait for the public v6 release whose getVKTreeRoot() is ${MAINNET.aztec.vkTreeRoot}, then recompile and regenerate`, true);
  const fjp = MAINNET.aztec.feeJuicePortal;
  c("FeeJuicePortal underlying is the AZTEC token", ((await l1.readContract({ address: fjp, abi: FEE_JUICE_PORTAL_ABI, functionName: "UNDERLYING" })) as Hex).toLowerCase() === MAINNET.aztec.feeJuiceToken.toLowerCase());
  c("FeeJuicePortal belongs to the v6 rollup", ((await l1.readContract({ address: fjp, abi: FEE_JUICE_PORTAL_ABI, functionName: "ROLLUP" })) as Hex).toLowerCase() === MAINNET.aztec.rollup.toLowerCase());

  // Circle CCTP V2 on Ethereum
  const e = MAINNET.ethereum;
  for (const [k, a] of Object.entries({ usdc: e.usdc, messageTransmitterV2: e.messageTransmitterV2, tokenMessengerV2: e.tokenMessengerV2, tokenMinterV2: e.tokenMinterV2 })) {
    c(`Ethereum ${k} has code`, ((await l1.getCode({ address: a })) ?? "0x").length > 2, a);
  }
  const call = (address: Hex, sig: string, args: unknown[] = []) => l1.readContract({ address, abi: parseAbi([sig]), functionName: sig.split(" ")[1]!.split("(")[0]!, args } as never) as Promise<unknown>;
  c("MessageTransmitterV2 local domain 0", (await call(e.messageTransmitterV2, "function localDomain() view returns (uint32)")) === 0);
  c("TokenMessengerV2 → MessageTransmitterV2", String(await call(e.tokenMessengerV2, "function localMessageTransmitter() view returns (address)")).toLowerCase() === e.messageTransmitterV2.toLowerCase());
  c("TokenMessengerV2 remote (domain 5) = Solana TokenMessengerMinterV2", String(await call(e.tokenMessengerV2, "function remoteTokenMessengers(uint32) view returns (bytes32)", [5])).toLowerCase() === SOLANA_TMM);
  c("TokenMessengerV2 minter = TokenMinterV2", String(await call(e.tokenMessengerV2, "function localMinter() view returns (address)")).toLowerCase() === e.tokenMinterV2.toLowerCase());
  c("TokenMinterV2 pairs Solana USDC with Ethereum USDC", String(await call(e.tokenMinterV2, "function getLocalToken(uint32,bytes32) view returns (address)", [5, b32(usdcMint)])).toLowerCase() === e.usdc.toLowerCase());
  c("Ethereum USDC has 6 decimals", Number(await l1.readContract({ address: e.usdc, abi: ERC20_ABI, functionName: "decimals" })) === 6);

  // Solana
  const genesis = await solanaGenesisHash();
  c("Solana genesis is mainnet-beta", genesis === MAINNET.solana.genesisHash, genesis, true);
  for (const p of [CCTP.messageTransmitterV2, CCTP.tokenMessengerMinterV2]) {
    const { value } = await rpc.getAccountInfo(p, { encoding: "base64" }).send();
    c(`Solana CCTP V2 program ${p.slice(0, 8)}… executable`, !!value?.executable);
  }
  const accts = await cctpBurnAccounts(usdcMint);
  for (const [k, a] of Object.entries(accts)) {
    const { value } = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
    const owner = k === "messageTransmitter" ? CCTP.messageTransmitterV2 : CCTP.tokenMessengerMinterV2;
    c(`Solana CCTP ${k} exists`, value?.owner === owner, a);
  }
  const mint = await accountData(usdcMint);
  c("Solana USDC mint (6 decimals)", !!mint && mint.length === 82 && mint[44] === 6, usdcMint);

  // The gateway program
  const so = new URL("target/deploy/eclyps_gateway.so", REPO);
  const progKey = opt("--program-keypair") ?? process.env.PROGRAM_KEYPAIR ?? new URL("target/deploy/eclyps_gateway-keypair.json", REPO).pathname;
  const auth = await upgradeAuthority();
  const adm = await adminAddress();
  c("gateway build present", existsSync(so), existsSync(so) ? `${readFileSync(so).length.toLocaleString("en-US")} bytes, sha256 ${sha256File(so).slice(0, 16)}…` : "run anchor build");
  c("program key file matches the gateway id", existsSync(progKey) && (await solanaPubkey(progKey)) === GATEWAY_PROGRAM_ID, GATEWAY_PROGRAM_ID);
  c("admin keypair present", !!adm, adm ?? `no ${solanaKeypairPath("admin")}`);
  if (auth !== null) c("gateway already deployed with the admin as upgrade authority", auth === adm, `authority ${auth ?? "none"}`);
  // Balances against what the steps need
  const size = existsSync(so) ? BigInt(readFileSync(so).length) : 914_000n;
  const programRent = BigInt(await rpc.getMinimumBalanceForRentExemption(size + 45n).send()) + BigInt(await rpc.getMinimumBalanceForRentExemption(36n).send());
  const needSol = programRent + 60_000_000n; // + init accounts and fees (measured ≈ 0.02 SOL) and a margin
  if (adm) {
    const bal = (await rpc.getBalance(adm).send()).value;
    c(`admin SOL ≥ ${(Number(needSol) / 1e9).toFixed(2)} (program rent + init + fees)`, auth !== null || bal >= needSol, `${(Number(bal) / 1e9).toFixed(4)} SOL`);
  }
  const signer = await ethSigner(ETH_RPC, chainId, ethKeyDefault);
  if (signer.address !== zeroAddress) {
    const bal = await l1.getBalance({ address: signer.address });
    const gasPrice = await l1.getGasPrice();
    const need = (GAS_ESTIMATE.portal + 2n * GAS_ESTIMATE.bind + GAS_ESTIMATE.approve + GAS_ESTIMATE.depositFeeJuice) * (gasPrice > 10n ** 9n ? gasPrice : 10n ** 9n) * 2n;
    c(`Ethereum deployer ETH ≥ ${(Number(need) / 1e18).toFixed(4)} (portal, binds, Fee Juice bridge at max(now, 1 gwei) × 2)`, bal >= need, `${signer.address}: ${(Number(bal) / 1e18).toFixed(5)} ETH`);
    const fj = (await l1.readContract({ address: MAINNET.aztec.feeJuiceToken, abi: ERC20_ABI, functionName: "balanceOf", args: [signer.address] })) as bigint;
    c("Ethereum deployer holds AZTEC to bridge as Fee Juice", fj > 0n, `${(Number(fj / 10n ** 15n) / 1e3).toLocaleString("en-US")} AZTEC`, true);
  } else c("Ethereum signer configured", false, "pass --ledger, --from <addr> or --eth-key <file>");

  // Aztec node
  if (!AZTEC_NODE) c("Aztec v6 mainnet node (AZTEC_NODE_URL)", false, "no public v6 mainnet node yet; set AZTEC_NODE_URL once one serves rollup version 2070860440");
  else {
    const node = createAztecNodeClient(AZTEC_NODE, { maxBatchSize: 3 });
    const info = await node.getNodeInfo();
    c("Aztec node is on Ethereum mainnet", info.l1ChainId === 1, `l1 chain ${info.l1ChainId}`, true);
    c("Aztec node serves the v6 rollup", BigInt(info.rollupVersion) === MAINNET.aztec.rollupVersion, `rollup version ${info.rollupVersion}, node ${info.nodeVersion}`, true);
    c("Aztec node uses the mainnet Registry", info.l1ContractAddresses.registryAddress.toString().toLowerCase() === MAINNET.aztec.registry.toLowerCase(), info.l1ContractAddresses.registryAddress.toString(), true);
    const fees = await node.getCurrentMinFees();
    log(`Aztec min fee ${fees.feePerL2Gas} per mana (DA ${fees.feePerDaGas})`);
    if (rec.aztec.admin) {
      const fj = await getFeeJuiceBalance(AztecAddress.fromStringUnsafe(rec.aztec.admin), node);
      c("Aztec admin has Fee Juice (or a pending bridge claim)", fj > 0n || !!loadPrivate().feeJuiceClaims?.some((x) => !x.claimed), `${Number(fj / 10n ** 15n) / 1e3} FJ`);
    }
  }
  if (!report(checks)) process.exitCode = 1;
}

// ---------------- 1. gateway program ----------------
async function stepGateway() {
  const auth = await upgradeAuthority();
  const adm = await adminAddress();
  if (!adm) throw new Error(`no admin keypair at ${solanaKeypairPath("admin")}`);
  if (auth !== null) {
    if (auth !== adm) throw new Error(`gateway already deployed, upgrade authority ${auth} is not the admin ${adm}`);
    return log(`gateway ${GATEWAY_PROGRAM_ID} already deployed (authority ${auth})`);
  }
  const so = new URL("target/deploy/eclyps_gateway.so", REPO).pathname;
  const progKey = opt("--program-keypair") ?? process.env.PROGRAM_KEYPAIR ?? new URL("target/deploy/eclyps_gateway-keypair.json", REPO).pathname;
  if (!existsSync(so)) throw new Error("run anchor build first");
  if (!existsSync(progKey) || (await solanaPubkey(progKey)) !== GATEWAY_PROGRAM_ID) throw new Error(`${progKey} is not the gateway's program key ${GATEWAY_PROGRAM_ID}`);
  const size = readFileSync(so).length;
  const maxLen = Number(opt("--max-len") ?? size);
  const rentProgramData = BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(maxLen + 45)).send());
  const rentProgram = BigInt(await rpc.getMinimumBalanceForRentExemption(36n).send());
  const writes = Math.ceil(size / 1_000);
  const fees = BigInt(writes) * 5_000n + (BigInt(writes) * 2_000n * CU_PRICE) / 1_000_000n;
  const cmd = ["program", "deploy", "target/deploy/eclyps_gateway.so", "--program-id", progKey, "--keypair", solanaKeypairPath("admin"),
    "--upgrade-authority", solanaKeypairPath("admin"), "--max-len", String(maxLen), "--url", SOLANA_RPC, "--use-rpc",
    "--with-compute-unit-price", CU_PRICE.toString(), "--max-sign-attempts", "50", "--output", "json"];
  const plan = {
    action: "solana program deploy", programId: GATEWAY_PROGRAM_ID, soSha256: sha256File(so), size, maxLen,
    payerAndUpgradeAuthority: adm, cluster: REHEARSAL ? "local validator" : "mainnet-beta",
  };
  const ok = gate("gateway", plan, [
    solanaCost(rentProgramData + rentProgram, `program rent (ProgramData ${maxLen + 45} bytes + program account), recoverable only by closing the program`),
    solanaCost(fees, `≈ ${writes} write transactions (5,000 lamports each + priority fee at ${CU_PRICE} µlamports/CU)`),
    `the write buffer temporarily holds the same rent; it moves into the program account at the end`,
  ]);
  if (!ok) return;
  let out: string;
  try {
    out = execFileSync("solana", cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // The CLI prints the write buffer's recovery phrase on failure: keep it out of logs, privately.
    writeFileSync(`${PRIVATE_DIR}/deploy-error.txt`, String((e as { stderr?: string }).stderr ?? e), { mode: 0o600 });
    throw new Error(`solana program deploy failed; buffer recovery details in ${PRIVATE_DIR}/deploy-error.txt (solana program close --buffers recovers its rent)`);
  }
  rec.solana.gateway = GATEWAY_PROGRAM_ID;
  rec.solana.deploySig = JSON.parse(out).signature;
  rec.solana.programDataLen = maxLen + 45;
  saveRecord(rec);
  const at = await rpc.getSlot({ commitment: "confirmed" }).send();
  while ((await rpc.getSlot({ commitment: "confirmed" }).send()) < at + 2n) await sleep(400);
  consumeConfirmation("gateway");
  log(`gateway deployed: ${rec.solana.deploySig}`);
}

// ---------------- 2. portal ----------------
async function portalArgs() {
  return [
    MAINNET.ethereum.messageTransmitterV2, MAINNET.ethereum.usdc, SOLANA_TMM, MAINNET.ethereum.tokenMessengerV2,
    b32(usdcMint), b32(await configPda()), MAINNET.aztec.registry, SECRET_HASH_ZERO,
    b32(await exitAuthorityPda()), b32(await exitCustodyPda()),
  ] as const;
}

async function stepPortal() {
  if (rec.l1.portal) return log(`portal ${rec.l1.portal} (already deployed)`);
  const v6 = await v6Status();
  if (!v6.executed) {
    // The constructor binds the canonical rollup's Inbox/Outbox for good (v6 research §4).
    throw new Error(`the canonical rollup is ${v6.canonical} (version ${v6.version}), not v6 ${MAINNET.aztec.rollup}: deploy the portal only after AZUP-3 executes`);
  }
  if (v6.inbox.toLowerCase() !== MAINNET.aztec.inbox.toLowerCase() || v6.outbox.toLowerCase() !== MAINNET.aztec.outbox.toLowerCase()) throw new Error("v6 Inbox/Outbox differ from the expected addresses");
  const chainId = await l1.getChainId();
  if (chainId !== 1) throw new Error(`chain id ${chainId}`);
  const signer = await ethSigner(ETH_RPC, chainId, ethKeyDefault);
  const art = PORTAL();
  const args = await portalArgs();
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: args as never });
  const gas = await l1.estimateGas({ account: signer.address === zeroAddress ? "0x000000000000000000000000000000000000dEaD" : signer.address, data });
  const plan = {
    action: "create EclypsPortal", chainId, from: signer.address, signer: signer.mode, bytecodeKeccak: keccak256(art.bytecode),
    constructor: {
      messageTransmitterV2: args[0], usdc: args[1], solanaTokenMessengerMinter: args[2], tokenMessengerV2: args[3], solanaUsdcMint: args[4],
      gatewaySenderConfigPda: args[5], aztecRegistry: args[6], registerSecretHash: args[7], exitAuthority: args[8], exitCustody: args[9],
    },
    binds: { inbox: v6.inbox, outbox: v6.outbox, rollupVersion: v6.version },
    note: "the deployer becomes the binder (bindClaimContract, step wire): keep the same signer",
  };
  if (!gate("portal", plan, [ethCost(gas, "portal deploy", await l1.getGasPrice())])) return;
  const receipt = await signer.send({ data }, "portal");
  if (!receipt.contractAddress) throw new Error("no contract address");
  const p = receipt.contractAddress;
  const r = (fn: "inbox" | "outbox" | "rollupVersion" | "binder") => l1.readContract({ address: p, abi: PORTAL_READ_ABI, functionName: fn });
  if (String(await r("inbox")).toLowerCase() !== MAINNET.aztec.inbox.toLowerCase() || (await r("rollupVersion")) !== MAINNET.aztec.rollupVersion) throw new Error("portal bound another rollup");
  Object.assign(rec.l1, { portal: p, deployer: signer.address, deployTx: receipt.transactionHash, deployGas: receipt.gasUsed.toString(), bindTxs: {}, bindGas: {} });
  saveRecord(rec);
  consumeConfirmation("portal");
  log(`EclypsPortal ${p} (gas ${receipt.gasUsed}); binder ${await r("binder")}`);
}

// ---------------- 3. gateway initialize + screening ----------------
async function stepInit() {
  if (!rec.l1.portal) throw new Error("run the portal step first: initialize fixes the portal for good");
  const kp = await admin();
  const auth = await upgradeAuthority();
  if (auth === null) throw new Error("run the gateway step first");
  if (auth !== kp.address) throw new Error(`the upgrade authority ${auth} is not the admin ${kp.address} (initialize requires it, ADR 0010)`);
  const config = await configPda();
  const configured = !!(await accountData(config));
  const screened = !!(await accountData(await screeningPda()));
  if (configured && screened) return log("gateway initialized and screening on (already)");
  const guardian = (opt("--guardian") ? address(opt("--guardian")!) : kp.address);
  const treasuryOwner = (opt("--treasury-owner") ? address(opt("--treasury-owner")!) : kp.address);
  const treasury = await associatedTokenAddress(treasuryOwner, usdcMint);
  const params = { ...LAUNCH.params, depositCap: LAUNCH.depositCap, treasury };
  const initIxs: Instruction[] = [
    computeUnitPriceIx(CU_PRICE),
    await createAssociatedTokenIdempotentIx(kp.address, treasuryOwner, usdcMint),
    await initializeIx({ admin: kp.address, usdcMint, guardian, portal: rec.l1.portal, denominations: LAUNCH.denominations, params, adminLifetimeSecs: LAUNCH.adminLifetimeSecs }),
  ];
  const screenIxs: Instruction[] = [computeUnitPriceIx(CU_PRICE), await initScreeningIx(kp.address)];
  const watch = [config, await escrowPda(), await feeVaultPda(), await exitCustodyPda(), treasury, await screeningPda()];
  const sim = await simulateSolana(configured ? screenIxs : [...initIxs, ...screenIxs.slice(1)], kp.address, watch);
  if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}\n${sim.logs.join("\n")}`);
  const before = await Promise.all(watch.map(async (a) => BigInt((await rpc.getBalance(a).send()).value)));
  const rent = sim.lamports.reduce((s, l, i) => s + l - before[i]!, 0n);
  const plan = {
    action: "initialize + init_screening", programId: GATEWAY_PROGRAM_ID, admin: kp.address, guardian, treasuryOwner, treasury,
    portal: rec.l1.portal, usdcMint, denominations: LAUNCH.denominations, params, adminLifetimeDays: Number(LAUNCH.adminLifetimeSecs / 86_400n),
    v2Lanes: "not initialized (init_lanes is never sent)", skipInitialize: configured,
  };
  if (guardian === kp.address) log("WARN: the guardian is the admin key; pass --guardian <pubkey> for a separate key (docs: keys)");
  const costs = [solanaCost(rent, "rent of config, escrow, fee vault, exit custody, treasury account, screening (simulated)"), solanaCost(2n * 5_000n + (sim.units * CU_PRICE) / 1_000_000n, `fees (${sim.units} CU simulated)`)];
  if (!gate("init", plan, costs)) return;
  if (!configured) {
    rec.solana.initializeSig = await sendSolana(initIxs, [kp.keyPair], kp.address);
    Object.assign(rec.solana, { gateway: GATEWAY_PROGRAM_ID, config, admin: kp.address, guardian, treasury, usdcMint });
    Object.assign(rec.params, { ...LAUNCH.params, epochLenSlots: Number(LAUNCH.params.epochLenSlots), depositCap: LAUNCH.depositCap.toString() });
    saveRecord(rec);
    log(`initialize ${rec.solana.initializeSig}`);
  }
  rec.solana.screeningSig = await sendSolana(screenIxs, [kp.keyPair], kp.address);
  saveRecord(rec);
  consumeConfirmation("init");
  log(`init_screening ${rec.solana.screeningSig}`);
}

// ---------------- Fee Juice bridge (L1 → Aztec) ----------------
async function feeJuiceL1() {
  const pub = createPublicClient({ transport: http(AZTEC_L1_RPC) });
  const chainId = await pub.getChainId();
  if (!REHEARSAL) return { pub, chainId, portal: MAINNET.aztec.feeJuicePortal, token: MAINNET.aztec.feeJuiceToken };
  // Rehearsal: the local Aztec network's own L1 and FeeJuicePortal.
  const info = await createAztecNodeClient(AZTEC_NODE).getNodeInfo();
  return { pub, chainId, portal: info.l1ContractAddresses.feeJuicePortalAddress.toString() as Hex, token: info.l1ContractAddresses.feeJuiceAddress.toString() as Hex };
}

async function stepFeeJuice() {
  const to = opt("--to") ?? "admin";
  const amountFj = BigInt(opt("--amount") ?? "0");
  if (amountFj <= 0n) throw new Error("--amount <whole Fee Juice> is required");
  const recipient = to === "admin" ? rec.aztec.admin : to === "fpc" ? rec.fees.eclypsFpc.address : to;
  if (!recipient) throw new Error(`no Aztec address for ${to} yet (admin: run the aztec step's dry run once; fpc: after the aztec step)`);
  const amount = amountFj * 10n ** 18n;
  const { pub, chainId, portal, token } = await feeJuiceL1();
  const signer = await ethSigner(AZTEC_L1_RPC, chainId, ethKeyDefault);
  const balance = signer.address === zeroAddress ? 0n : ((await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [signer.address] })) as bigint);
  const allowance = signer.address === zeroAddress ? 0n : ((await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [signer.address, portal] })) as bigint);
  const plan = {
    action: "bridge Fee Juice (AZTEC) to Aztec, public", chainId, from: signer.address, signer: signer.mode, token, feeJuicePortal: portal,
    to: recipient, toLabel: to, amount, approve: allowance < amount,
    note: "the claim secret is generated at send time and kept in the private dir; the aztec step claims it on L2",
  };
  const gasPrice = await pub.getGasPrice();
  const ok = gate(`fee-juice-${to}`, plan, [
    `${amountFj.toLocaleString("en-US")} Fee Juice ≈ $${(Number(amountFj) * Number(opt("--fj-usd") ?? 0.0135)).toFixed(2)} (spent: Fee Juice can only pay Aztec fees)`,
    ethCost((allowance < amount ? GAS_ESTIMATE.approve : 0n) + GAS_ESTIMATE.depositFeeJuice, "approve + depositToAztecPublic", gasPrice),
  ]);
  if (!ok) return;
  if (balance < amount) throw new Error(`the signer holds ${balance} AZTEC base units, less than ${amount}`);
  const priv = loadPrivate();
  priv.feeJuiceClaims ??= [];
  let pending = priv.feeJuiceClaims.find((x) => x.to === recipient && x.amount === amount.toString() && !x.l1Tx);
  if (!pending) {
    const [secret, secretHash] = await generateClaimSecret();
    pending = { to: recipient, amount: amount.toString(), secret: secret.toString(), secretHash: secretHash.toString(), leafIndex: "", l1Tx: "" };
    priv.feeJuiceClaims.push(pending);
    savePrivate(priv); // saved before the deposit, so a crash never loses the secret of bridged funds
  }
  if (allowance < amount) await signer.send({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [portal, amount] }) }, `fee-juice-approve-${to}`);
  const receipt = await signer.send({
    to: portal, data: encodeFunctionData({ abi: FEE_JUICE_PORTAL_ABI, functionName: "depositToAztecPublic", args: [recipient as Hex, amount, pending.secretHash as Hex] }),
  }, `fee-juice-deposit-${to}`);
  const ev = parseEventLogs({ abi: FEE_JUICE_PORTAL_ABI, logs: receipt.logs, eventName: "DepositToAztecPublic" })[0];
  if (!ev) throw new Error("no DepositToAztecPublic event");
  Object.assign(pending, { leafIndex: ev.args.index.toString(), l1Tx: receipt.transactionHash, messageHash: ev.args.key });
  savePrivate(priv);
  rec.aztec.feeJuiceBridges ??= [];
  rec.aztec.feeJuiceBridges.push({ to: recipient, amount: amount.toString(), l1Tx: receipt.transactionHash });
  (rec as unknown as { l1: Record<string, unknown> }).l1.feeJuiceDepositGas = receipt.gasUsed.toString();
  saveRecord(rec);
  consumeConfirmation(`fee-juice-${to}`);
  log(`bridged ${amountFj} Fee Juice to ${recipient} (L1 ${receipt.transactionHash}, gas ${receipt.gasUsed}, message leaf ${ev.args.index}); the aztec step claims it`);
}

// ---------------- 4. Aztec contracts ----------------
async function aztecWallet() {
  if (!AZTEC_NODE) throw new Error("AZTEC_NODE_URL is required (a node serving the v6 mainnet rollup)");
  const priv = loadPrivate();
  if (!priv.aztecAdmin) {
    priv.aztecAdmin = newAztecKeys();
    savePrivate(priv);
  }
  const conn = await connectAztec(AZTEC_NODE, `${PRIVATE_DIR}/pxe`, priv.aztecAdmin, "feeJuice");
  if (!rec.aztec.admin) {
    rec.aztec.admin = conn.account.address.toString();
    saveRecord(rec);
  }
  return conn;
}

async function stepAztec() {
  if (!rec.l1.portal) throw new Error("run the portal step first: each claim contract names the portal");
  const { node, info, wallet, account, register } = await aztecWallet();
  const adminAddr = account.address;
  if (!REHEARSAL && BigInt(info.rollupVersion) !== MAINNET.aztec.rollupVersion) throw new Error(`the Aztec node serves rollup ${info.rollupVersion}, not v6`);
  const priv = loadPrivate();
  const unclaimed = (priv.feeJuiceClaims ?? []).filter((x) => x.l1Tx && !x.claimed);
  const balance = await getFeeJuiceBalance(adminAddr, node);
  const fees = await node.getCurrentMinFees().then((f) => f.feePerL2Gas).catch(() => FALLBACK_FEE_PER_MANA);
  const todo = {
    minter: !rec.aztec.minter,
    token: !rec.aztec.token,
    claims: LAUNCH.denominations.filter((d) => !rec.aztec.claims[d.toString()]).map(String),
    wire: !rec.aztec.minterWireTx,
    fpc: !rec.fees.eclypsFpc.address,
  };
  const artifacts = Object.fromEntries(["eclyps_minter_contract-EclypsMinter.json", "token_contract-Token.json", "eclyps_claim_contract-EclypsClaim.json", "eclyps_fpc_contract-EclypsFPC.json"]
    .map((f) => [f, sha256File(new URL(`aztec/artifacts/${f}`, REPO)).slice(0, 16)]));
  const plan = {
    action: "Aztec contracts", node: REHEARSAL ? "local network" : AZTEC_NODE, rollupVersion: info.rollupVersion, admin: adminAddr.toString(), artifacts,
    minter: todo.minter ? { admin: adminAddr.toString(), listingDelay: "7 days" } : rec.aztec.minter,
    token: todo.token ? { standard: "AIP-20", ...LAUNCH.token, minter: "EclypsMinter, fixed for good", admin: "none", transferHook: "none" } : rec.aztec.token,
    claims: todo.claims.map((d) => ({ denomination: d, portal: rec.l1.portal, exitEpochBlocks: EXIT_EPOCH_BLOCKS, minExitBatch: MIN_EXIT_BATCH })),
    minterWiring: todo.wire ? { lists: LAUNCH.denominations.map(String), once: true } : rec.aztec.minterWireTx,
    fpc: todo.fpc ? { slots: LAUNCH.fpcSlots } : rec.fees.eclypsFpc.address,
    feeJuiceClaims: unclaimed.map((x) => ({ to: x.to, amount: x.amount, l1Tx: x.l1Tx })),
    payer: "the admin's own Fee Juice (fees.operator = feeJuice)",
  };
  const m = MANA_ESTIMATE;
  const costs = [
    ...(todo.minter ? [fjCost(m.minter, fees, "EclypsMinter deploy")] : []),
    ...(todo.token ? [fjCost(m.token, fees, "Token deploy")] : []),
    ...todo.claims.map((d) => fjCost(m.claim, fees, `EclypsClaim($${Number(d) / 1e6}) deploy`)),
    ...(todo.wire ? [fjCost(m.wire, fees, "EclypsMinter wiring")] : []),
    ...(todo.fpc ? [fjCost(m.fpc, fees, "EclypsFPC deploy")] : []),
    ...unclaimed.filter((x) => x.to !== adminAddr.toString()).map((x) => fjCost(m.feeJuiceClaim, fees, `claim of the Fee Juice bridged to ${x.to.slice(0, 10)}…`)),
    `admin Fee Juice now: ${Number(balance / 10n ** 15n) / 1e3} (+ ${unclaimed.filter((x) => x.to === adminAddr.toString()).reduce((s, x) => s + BigInt(x.amount), 0n) / 10n ** 18n} bridged, claimed with the first transaction)`,
  ];
  if (!gate("aztec", plan, costs)) return;

  // The admin's own bridged Fee Juice pays its first transaction (FeeJuicePaymentMethodWithClaim).
  const own = unclaimed.find((x) => x.to === adminAddr.toString());
  let first: { paymentMethod?: FeeJuicePaymentMethodWithClaim } = {};
  if (own) {
    const msgHash = (own as { messageHash?: string }).messageHash;
    if (msgHash) await waitForL1ToL2MessageReady(node, Fr.fromString(msgHash), { timeoutSeconds: 1_800 });
    first = { paymentMethod: new FeeJuicePaymentMethodWithClaim(adminAddr, { claimAmount: BigInt(own.amount), claimSecret: Fr.fromString(own.secret), messageLeafIndex: BigInt(own.leafIndex) }) };
    log(`first transaction claims ${BigInt(own.amount) / 10n ** 18n} bridged Fee Juice`);
  } else if (balance === 0n) throw new Error("the admin has no Fee Juice and no bridged claim: run fee-juice --to admin first");
  const fee = () => {
    const f = first;
    first = {};
    if (f.paymentMethod && own) {
      own.claimed = new Date().toISOString();
      savePrivate(priv);
    }
    return f;
  };
  const txFees = ((rec.aztec as Record<string, unknown>).txFees ??= {}) as Record<string, string>;
  /** Records what each transaction paid (Fee Juice base units, from its receipt). */
  const measure = async (label: string, r: { transactionFee?: bigint; txHash: { toString(): string } }) => {
    if (r.transactionFee !== undefined) txFees[label] = r.transactionFee.toString();
    saveRecord(rec);
  };

  // ADR 0020: the minter first, then the token naming it as its only minter, then the claims naming
  // both; one wiring call gives the minter the token and the claims.
  if (todo.minter) {
    log("deploying EclypsMinter");
    const { contract, receipt } = await EclypsMinterContract.deploy(wallet, adminAddr).send({ from: adminAddr, fee: fee(), wait: AZTEC_WAIT });
    rec.aztec.minter = contract.address.toString();
    rec.aztec.minterDeployTx = receipt.txHash.toString();
    await measure("minterDeploy", receipt);
  } else await register(rec.aztec.minter!, EclypsMinterContract.artifact);
  const minter = EclypsMinterContract.at(AztecAddress.fromStringUnsafe(rec.aztec.minter!), wallet);
  if (todo.token) {
    log("deploying Token (eUSDC, AIP-20)");
    const { contract, receipt } = await TokenContract.deployWithOpts(
      { method: "constructor_with_minter", wallet },
      LAUNCH.token.name, LAUNCH.token.symbol, LAUNCH.token.decimals, minter.address, AztecAddress.ZERO,
    ).send({ from: adminAddr, fee: fee(), wait: AZTEC_WAIT });
    rec.aztec.token = contract.address.toString();
    rec.aztec.tokenDeployTx = receipt.txHash.toString();
    await measure("tokenDeploy", receipt);
  } else await register(rec.aztec.token, TokenContract.artifact);
  const token = AztecAddress.fromStringUnsafe(rec.aztec.token);
  rec.aztec.claimDeployTxs ??= {};
  for (const d of LAUNCH.denominations) {
    const k = d.toString();
    if (!rec.aztec.claims[k]) {
      log(`deploying EclypsClaim($${Number(d) / 1e6})`);
      const { contract, receipt } = await EclypsClaimContract.deploy(wallet, token, minter.address, EthAddress.fromString(rec.l1.portal), d, EXIT_EPOCH_BLOCKS, MIN_EXIT_BATCH)
        .send({ from: adminAddr, fee: fee(), wait: AZTEC_WAIT });
      rec.aztec.claims[k] = contract.address.toString();
      rec.aztec.claimDeployTxs[k] = receipt.txHash.toString();
      await measure(`claimDeploy:${k}`, receipt);
    } else await register(rec.aztec.claims[k]!, EclypsClaimContract.artifact);
  }
  if (todo.wire) {
    const claims = LAUNCH.denominations.map((d) => AztecAddress.fromStringUnsafe(rec.aztec.claims[d.toString()]!));
    const denominations = [...LAUNCH.denominations];
    while (claims.length < 4) { claims.push(AztecAddress.ZERO); denominations.push(0n); }
    log("wiring EclypsMinter: the token and the claim contracts (once)");
    const { receipt } = await minter.methods.wire(token, claims, denominations).send({ from: adminAddr, fee: fee(), wait: AZTEC_WAIT });
    rec.aztec.minterWireTx = receipt.txHash.toString();
    await measure("minterWire", receipt);
  }
  if (todo.fpc) {
    const claims = LAUNCH.denominations.map((d) => AztecAddress.fromStringUnsafe(rec.aztec.claims[d.toString()]!));
    const slots = LAUNCH.denominations.map((d) => LAUNCH.fpcSlots[d.toString()]!);
    while (claims.length < 4) { claims.push(AztecAddress.ZERO); slots.push(0); }
    log(`deploying EclypsFPC (slots ${slots.join(", ")})`);
    const { contract, receipt } = await EclypsFPCContract.deploy(wallet, claims, slots).send({ from: adminAddr, fee: fee(), wait: AZTEC_WAIT });
    rec.fees.eclypsFpc.address = contract.address.toString();
    rec.fees.eclypsFpc.slots = LAUNCH.fpcSlots;
    rec.aztec.fpcDeployTx = receipt.txHash.toString();
    await measure("fpcDeploy", receipt);
  }
  // Fee Juice bridged to other accounts (the FPC, the finisher): claimed by the admin on their behalf.
  for (const x of unclaimed.filter((y) => y.to !== adminAddr.toString() && !y.claimed)) {
    const msgHash = (x as { messageHash?: string }).messageHash;
    if (msgHash) await waitForL1ToL2MessageReady(node, Fr.fromString(msgHash), { timeoutSeconds: 1_800 });
    const { receipt } = await FeeJuiceContract.withWallet(wallet).methods.claim(AztecAddress.fromStringUnsafe(x.to), BigInt(x.amount), Fr.fromString(x.secret), new Fr(BigInt(x.leafIndex)))
      .send({ from: adminAddr, fee: fee(), wait: AZTEC_WAIT });
    x.claimed = receipt.txHash.toString();
    savePrivate(priv);
    const b = rec.aztec.feeJuiceBridges?.find((y) => y.l1Tx === x.l1Tx);
    if (b) b.claimTx = receipt.txHash.toString();
    await measure("feeJuiceClaim", receipt);
    log(`claimed ${BigInt(x.amount) / 10n ** 18n} Fee Juice for ${x.to}`);
  }
  Object.assign(rec.aztec, { node: AZTEC_NODE, version: info.nodeVersion, rollupVersion: Number(info.rollupVersion) });
  saveRecord(rec);
  consumeConfirmation("aztec");
  log(`Aztec: token ${rec.aztec.token}, claims ${Object.values(rec.aztec.claims).join(", ")}, FPC ${rec.fees.eclypsFpc.address}`);
}

/** The FPC's Fee Juice claim needs the FPC address first: `fee-juice --to fpc`, then `aztec` again. */

// ---------------- 5. wire ----------------
async function stepWire() {
  if (!rec.l1.portal) throw new Error("no portal");
  const chainId = await l1.getChainId();
  const signer = await ethSigner(ETH_RPC, chainId, ethKeyDefault);
  const portal = rec.l1.portal as Hex;
  const binder = (await l1.readContract({ address: portal, abi: PORTAL_READ_ABI, functionName: "binder" })) as Hex;
  const binds: { denomination: bigint; claim: Hex; data: Hex }[] = [];
  for (const d of LAUNCH.denominations) {
    const claim = rec.aztec.claims[d.toString()];
    if (!claim) throw new Error(`no claim contract for ${d}: run the aztec step first`);
    const bound = (await l1.readContract({ address: portal, abi: PORTAL_READ_ABI, functionName: "claimContract", args: [d] })) as Hex;
    if (BigInt(bound) !== 0n) {
      if (bound.toLowerCase() !== claim.toLowerCase()) throw new Error(`portal already binds ${d} to ${bound}, not ${claim}`);
      continue;
    }
    binds.push({ denomination: d, claim: claim as Hex, data: encodeFunctionData({ abi: PORTAL().abi, functionName: "bindClaimContract", args: [d, claim as Hex] }) });
  }
  const plan = { action: "bindClaimContract", chainId, portal, from: signer.address, signer: signer.mode, binder, binds: binds.map((b) => ({ denomination: b.denomination, claim: b.claim })) };
  if (binds.length && signer.address !== zeroAddress && signer.address.toLowerCase() !== binder.toLowerCase()) throw new Error(`the signer ${signer.address} is not the portal's binder ${binder}`);
  if (binds.length) {
    const gas = await l1.estimateGas({ account: binder, to: portal, data: binds[0]!.data });
    if (!gate("wire", plan, [ethCost(gas * BigInt(binds.length), `${binds.length} × bindClaimContract`, await l1.getGasPrice())])) return;
    for (const b of binds) {
      const receipt = await signer.send({ to: portal, data: b.data }, `bind-${b.denomination}`);
      rec.l1.bindTxs = { ...(rec.l1.bindTxs ?? {}), [b.denomination.toString()]: receipt.transactionHash };
      rec.l1.bindGas = { ...(rec.l1.bindGas ?? {}), [b.denomination.toString()]: receipt.gasUsed.toString() };
      saveRecord(rec);
      log(`bindClaimContract($${Number(b.denomination) / 1e6}) ${receipt.transactionHash} (gas ${receipt.gasUsed})`);
    }
    consumeConfirmation("wire");
  } else log("claims already bound");
  // The deployment the app, finisher and SDK read (resolveFees checks it below in verify).
  Object.assign(rec.fees, { user: "eclypsFpc", operator: "feeJuice" });
  rec.denominations = LAUNCH.denominations.map(String);
  saveRecord(rec);
  log(`wrote ${RECORD_FILE}`);
}

// ---------------- 6. verify ----------------
async function stepVerify() {
  const checks: Check[] = [];
  const c = (name: string, ok: boolean, detail?: string, tolerated = false) => checks.push({ name, ok, detail, tolerated: tolerated && REHEARSAL });
  // Solana
  const cfgRaw = await accountData(await configPda());
  c("gateway config exists", !!cfgRaw);
  if (cfgRaw) {
    const cfg = decodeConfig(cfgRaw);
    c("config.portal == recorded portal", hex(cfg.portal).toLowerCase().endsWith(rec.l1.portal.slice(2).toLowerCase()), hex(cfg.portal));
    c("config.usdcMint is mainnet USDC", cfg.usdcMint === usdcMint, cfg.usdcMint);
    c("denominations $100, $1,000", cfg.denominations.filter((d) => d > 0n).join(",") === LAUNCH.denominations.join(","), cfg.denominations.join(","));
    c("fee 50 bps, finisher 30", cfg.params.feeBps === 50 && cfg.params.finisherBps === 30);
    c(`deposit cap $${Number(LAUNCH.depositCap) / 1e6}`, cfg.params.depositCap === LAUNCH.depositCap, cfg.params.depositCap.toString());
    c("min batch 4, per-epoch cap 4, epoch 2,250 slots", cfg.params.minBatchSize === 4 && cfg.params.perEpochCap === 4 && cfg.params.epochLenSlots === 2_250n);
    c("admin == recorded admin", cfg.admin === rec.solana.admin, cfg.admin);
    c("guardian set", cfg.guardian === rec.solana.guardian, `${cfg.guardian}${cfg.guardian === cfg.admin ? " (same as admin)" : ""}`);
    c("treasury == recorded", cfg.params.treasury === rec.solana.treasury, cfg.params.treasury);
    c("deposits not paused", !cfg.pausedDeposits);
    c("nothing deposited yet (net deposits 0) or matches the escrow", cfg.netDeposits >= 0n, `net ${cfg.netDeposits}`);
    const days = Number(cfg.adminExpiryTs - BigInt(Math.floor(Date.now() / 1000))) / 86_400;
    c("admin sunset about 24 months away", days > 700 && days <= 731, `${days.toFixed(0)} days`);
  }
  const scr = await accountData(await screeningPda());
  c("screening initialized", !!scr, scr ? JSON.stringify(decodeScreening(scr), (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined);
  c("V2 lanes NOT initialized", !(await accountData(await lanesPda())));
  const auth = await upgradeAuthority();
  c("upgrade authority is the admin (renounced once tested, ADR 0021)", auth === rec.solana.admin, String(auth));
  // Ethereum
  const portal = rec.l1.portal as Hex;
  const r = (fn: "inbox" | "outbox" | "rollupVersion" | "gatewaySender" | "exitCustody" | "exitAuthority") => l1.readContract({ address: portal, abi: PORTAL_READ_ABI, functionName: fn });
  c("portal inbox is v6", String(await r("inbox")).toLowerCase() === MAINNET.aztec.inbox.toLowerCase());
  c("portal outbox is v6", String(await r("outbox")).toLowerCase() === MAINNET.aztec.outbox.toLowerCase());
  c("portal rollup version v6", (await r("rollupVersion")) === MAINNET.aztec.rollupVersion);
  c("portal gatewaySender == config PDA", String(await r("gatewaySender")).toLowerCase() === b32(await configPda()).toLowerCase());
  c("portal exit custody == gateway PDA", String(await r("exitCustody")).toLowerCase() === b32(await exitCustodyPda()).toLowerCase());
  for (const d of LAUNCH.denominations) {
    const bound = (await l1.readContract({ address: portal, abi: PORTAL_READ_ABI, functionName: "claimContract", args: [d] })) as Hex;
    c(`portal binds $${Number(d) / 1e6} to its claim contract`, !!rec.aztec.claims[d.toString()] && bound.toLowerCase() === rec.aztec.claims[d.toString()]!.toLowerCase(), bound);
  }
  const usdcHeld = (await l1.readContract({ address: MAINNET.ethereum.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [portal] })) as bigint;
  c("portal holds no USDC between batches", usdcHeld === 0n, usdcHeld.toString(), true);
  // Aztec
  try {
    resolveFees(rec as never);
    c("deployment fees resolve (eclypsFpc users, feeJuice operator)", true);
  } catch (e) {
    c("deployment fees resolve", false, String(e));
  }
  if (AZTEC_NODE && rec.aztec.token) {
    const { node, wallet, account, register } = await aztecWallet();
    await register(rec.aztec.token, TokenContract.artifact);
    const minterAddr = rec.aztec.minter ? AztecAddress.fromStringUnsafe(rec.aztec.minter) : AztecAddress.ZERO;
    // AIP-20 has no getter for its minter: read the slot (PublicImmutable, fixed at creation).
    const tokenMinter = await node.getPublicStorageAt("latest", AztecAddress.fromStringUnsafe(rec.aztec.token), TokenContract.storage.minter.slot);
    c("the token's only minter is EclypsMinter", !!rec.aztec.minter && tokenMinter.equals(minterAddr.toField()), tokenMinter.toString());
    const minter = rec.aztec.minter ? EclypsMinterContract.at(minterAddr, wallet) : undefined;
    if (minter) {
      await register(rec.aztec.minter!, EclypsMinterContract.artifact);
      const { result: wired } = await minter.methods.get_token().simulate({ from: account.address });
      c("EclypsMinter mints the token", wired.toString() === rec.aztec.token, wired.toString());
      const { result: admin } = await minter.methods.get_admin().simulate({ from: account.address });
      c(admin.isZero() ? "EclypsMinter renounced: the claim list is fixed" : "EclypsMinter admin can list new claims (7 days' notice)", true, admin.toString());
    }
    for (const d of LAUNCH.denominations) {
      const claim = rec.aztec.claims[d.toString()];
      if (!claim) continue;
      await register(claim, EclypsClaimContract.artifact);
      const listing = minter ? (await minter.methods.get_listing(AztecAddress.fromStringUnsafe(claim)).simulate({ from: account.address })).result : undefined;
      c(`claim $${Number(d) / 1e6} is listed with the minter for its denomination`, !!listing && BigInt(listing.denomination) === d, String(listing?.denomination));
      const { result: cfg } = await EclypsClaimContract.at(AztecAddress.fromStringUnsafe(claim), wallet).methods.get_config().simulate({ from: account.address });
      c(`claim $${Number(d) / 1e6} names the portal`, JSON.stringify(cfg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase().includes(rec.l1.portal.slice(2).toLowerCase()));
    }
    if (rec.fees.eclypsFpc.address) {
      const fj = await getFeeJuiceBalance(AztecAddress.fromStringUnsafe(rec.fees.eclypsFpc.address), node);
      c("EclypsFPC holds Fee Juice", fj > 0n, `${Number(fj / 10n ** 15n) / 1e3} FJ`);
    }
    const fj = await getFeeJuiceBalance(account.address, node);
    c("admin holds Fee Juice", fj > 0n, `${Number(fj / 10n ** 15n) / 1e3} FJ`);
  }
  rec.checks = Object.fromEntries(checks.map((x) => [x.name, x.ok]));
  saveRecord(rec);
  if (!report(checks)) process.exitCode = 1;
}

// ---------------- renounce the minter's admin (ADR 0020) ----------------
/** The owner's choice: after this, no claim contract can ever be listed (a new denomination then
 * needs a new token). Minting by the listed claim contracts is unchanged. */
async function stepRenounceMinter() {
  if (!rec.aztec.minter) throw new Error("no EclypsMinter: run the aztec step first");
  const { node, wallet, account, register } = await aztecWallet();
  await register(rec.aztec.minter, EclypsMinterContract.artifact);
  const minter = EclypsMinterContract.at(AztecAddress.fromStringUnsafe(rec.aztec.minter), wallet);
  const { result: admin } = await minter.methods.get_admin().simulate({ from: account.address });
  if (admin.isZero()) return log("EclypsMinter: already renounced, the claim list is fixed");
  if (!admin.equals(account.address)) throw new Error(`the minter's admin is ${admin}, not this key`);
  const fees = await node.getCurrentMinFees().then((f) => f.feePerL2Gas).catch(() => FALLBACK_FEE_PER_MANA);
  const plan = { action: "EclypsMinter.renounce", minter: rec.aztec.minter, effect: "no claim contract can ever be listed again; the listed ones keep minting" };
  if (!gate("renounce-minter", plan, [fjCost(MANA_ESTIMATE.wire, fees, "renounce")])) return;
  const { receipt } = await minter.methods.renounce().send({ from: account.address, wait: AZTEC_WAIT });
  rec.aztec.minterRenounceTx = receipt.txHash.toString();
  saveRecord(rec);
  consumeConfirmation("renounce-minter");
  log(`EclypsMinter renounced (tx ${receipt.txHash}): the claim list is fixed`);
}

// ---------------- pause / unpause ----------------
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
async function stepPause(which: "pause_deposits" | "unpause_deposits") {
  const path = solanaKeypairPath("guardian");
  if (!existsSync(path)) throw new Error(`no guardian keypair at ${path} (--guardian-keypair)`);
  const kp = await loadSolanaKeypair(path);
  const ix: Instruction = {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [{ address: kp.address, role: 2 /* READONLY_SIGNER */ }, { address: await configPda(), role: 1 /* WRITABLE */ }],
    data: Uint8Array.from(disc(which)),
  };
  const sim = await simulateSolana([computeUnitPriceIx(CU_PRICE), ix], kp.address, []);
  if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}\n${sim.logs.join("\n")}`);
  if (!gate(which, { action: which, signer: kp.address, programId: GATEWAY_PROGRAM_ID }, [solanaCost(5_000n, "fee")])) return;
  log(`${which} ${await sendSolana([computeUnitPriceIx(CU_PRICE), ix], [kp.keyPair], kp.address)}`);
  consumeConfirmation(which);
}

// ---------------- main ----------------
const steps: Record<string, () => Promise<unknown>> = {
  preflight, gateway: stepGateway, portal: stepPortal, init: stepInit, "fee-juice": stepFeeJuice, aztec: stepAztec, wire: stepWire, verify: stepVerify,
  "renounce-minter": stepRenounceMinter,
  pause: () => stepPause("pause_deposits"), unpause: () => stepPause("unpause_deposits"),
  // The gate alone, with no network and nothing to send: shows what --send needs on this machine.
  "gate-selftest": async () => {
    if (gate("gate-selftest", { action: "nothing (gate self-test)" }, [])) consumeConfirmation("gate-selftest");
  },
};
const which = process.argv[2] ?? "";
try {
  if (!steps[which]) throw new Error(`usage: deploy.ts <${Object.keys(steps).join("|")}> [--send --mainnet | --rehearsal [--send]]`);
  if (SEND && has("--dry-run")) throw new Error("--send and --dry-run");
  await steps[which]!();
  process.exit(process.exitCode ?? 0);
} catch (e) {
  if (e instanceof AwaitSignature) {
    console.log(e.message);
    process.exit(0);
  }
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
