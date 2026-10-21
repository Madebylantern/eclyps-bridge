/**
 * Drives the real UI against the public testnets in headless Chromium: the hosted app
 * (APP_URL=https://eclyps-six.vercel.app) or a local static export (app/out, served by
 * app/serve.mjs with app/out/deployment.json = deployments/testnet.json).
 *
 *   check  the in-browser Aztec PXE on Aztec testnet (real proofs, SponsoredFPC), which the app
 *          starts in the background at unlock; no funds
 *   demo   the round trip through the Tunnel (the bridge screen):
 *          $1, Send, "Cross with the next batch" (one browser deposit, signed by the pasted devnet
 *          key) → other depositors fill the batch (run.ts deposit 3) → a finisher carries it
 *          (run.ts finish) → Arrived · Claim (a real proof in the browser) → Move out to a fresh
 *          Sepolia address (exit_to_ethereum proven in the browser) → once Aztec's epoch is proven
 *          on Sepolia, Claim (claimToEthereum, sent through the page's Ethereum wallet).
 *          The page's Ethereum wallet is an injected EIP-1193 provider whose signing stays in this
 *          Node process (the Sepolia key in ~/.config/eclyps/sepolia.key; it never enters the page).
 *          Records screenshots, the video and testnet-marks.json (stage times, for cutting the
 *          waits) in DEMO_OUT (default docs/demo/, not committed), and a `ui` entry on the run
 *          that run.ts recorded in deployments/testnet.json.
 *   solana the round trip back to Solana: as `demo` up to the private claim, then Move out to a fresh
 *          Solana address (exit proven in the browser) → 3 more exits fill the exit epoch
 *          (exits.ts fill 3; an epoch needs min_exit_batch = 4) → the testnet finisher (started
 *          here, unless FINISHER=0) closes it, waits for Aztec's epoch proof, exitBatch, Iris,
 *          receive_exit → Claim on Solana (claim_exit, paid by the connected devnet wallet: the
 *          page shows its linking line) → the fresh address holds exactly $1, a replay is refused.
 *          Then exits.ts fill-carry and fill-solana record and pay the fill's exits.
 *   solana-resume  after a solana run that stopped once the exit was burned (the browser profile
 *          in DEMO_OUT/profile/ keeps the vault): unlock it, then from the arrival on Solana as
 *          `solana`, recorded on the same run's `ui` entry. The finisher must be running.
 *
 *   pnpm exec tsx testnet/ui-demo.ts <check|demo|solana|solana-resume>     (from scripts/; behind a proxy NODE_USE_ENV_PROXY=1)
 *   env: APP_URL, DEMO_OUT, CHROMIUM (executable), ECLYPS_KEYS, SOLANA_KEYPAIR, SEPOLIA_PRIVATE_KEY
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { associatedTokenAddress } from "@eclyps/sdk";
import { AccountRole, address, generateKeyPairSigner, getBase58Encoder, type Instruction, type Signature } from "@solana/kit";
import { chromium, type Page } from "playwright";
import { createPublicClient, createWalletClient, type Hex, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadSolanaKeypair, solanaClient } from "../../finisher/src/chains.js";

const mode = process.argv[2] ?? "check";
const repo = new URL("../../", import.meta.url);
const outDir = process.env.DEMO_OUT ? `${process.env.DEMO_OUT.replace(/\/$/, "")}/` : new URL("docs/demo/", repo).pathname;
mkdirSync(outDir, { recursive: true });
// APP_URL is the site; `/` is the landing page and the app itself is served at /app/.
const APP = new URL("/app/", process.env.APP_URL ?? "http://127.0.0.1:3000").href;
const KEYS = process.env.ECLYPS_KEYS ?? `${homedir()}/.config/eclyps`;
const PUBLIC_FILE = new URL("deployments/testnet.json", repo);
const dep = JSON.parse(readFileSync(PUBLIC_FILE, "utf8"));
const t0 = Date.now();
const marks: { t: number; at: number; label: string }[] = [];
let videoStart = t0;
const say = (s: string) => {
  marks.push({ t: (Date.now() - videoStart) / 1000, at: Date.now(), label: s });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${s}`);
};
const runTs = (args: string[], script = "testnet/run.ts") =>
  execFileSync("pnpm", ["-s", "exec", "tsx", script, ...args], { cwd: new URL("scripts/", repo), stdio: "inherit" });
const resume = mode === "solana-resume";
const crossing = mode === "demo" || mode === "solana" || resume;

/**
 * solana: the testnet finisher, as anyone would run it (pnpm --filter @eclyps/finisher testnet), in
 * its own process group so that stopping it stops its children; its output goes to finisher.log.
 */
let finisher: ChildProcess | undefined;
const startFinisher = () => {
  if (process.env.FINISHER === "0" || finisher) return;
  const out = openSync(`${outDir}finisher.log`, "a");
  finisher = spawn("pnpm", ["-s", "--filter", "@eclyps/finisher", "testnet"], { cwd: repo, stdio: ["ignore", out, out], detached: true });
  console.log(`  finisher started (pid ${finisher.pid}), log ${outDir}finisher.log`);
};
const stopFinisher = () => {
  if (!finisher?.pid) return;
  try { process.kill(-finisher.pid, "SIGTERM"); } catch { /* already gone */ }
  finisher = undefined;
};
process.on("exit", stopFinisher);

/**
 * The instructions of a confirmed Solana transaction, rebuilt to be sent again by the devnet key
 * (the payer the page used): a replay of the page's claim_exit.
 */
async function instructionsOf(sol: ReturnType<typeof solanaClient>, sig: string, payer: string): Promise<Instruction[]> {
  // The JSON encoding of getTransaction, read loosely.
  const tx: any = await sol.rpc.getTransaction(sig as Signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
  const m = tx?.transaction?.message;
  if (!m) throw new Error(`transaction ${sig} not found`);
  if (tx.meta?.loadedAddresses?.writable?.length || tx.meta?.loadedAddresses?.readonly?.length) throw new Error("a lookup-table transaction: not rebuilt here");
  const keys: string[] = m.accountKeys;
  if (keys[0] !== payer) throw new Error(`the page's claim was paid by ${keys[0]}, not the devnet key`);
  const h = m.header as { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  const role = (i: number) => {
    const signer = i < h.numRequiredSignatures;
    const writable = signer ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < keys.length - h.numReadonlyUnsignedAccounts;
    return signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;
  };
  return (m.instructions as { programIdIndex: number; accounts: number[]; data: string }[]).map((ix) => ({
    programAddress: address(keys[ix.programIdIndex]!),
    accounts: ix.accounts.map((i) => ({ address: address(keys[i]!), role: role(i) })),
    data: new Uint8Array(getBase58Encoder().encode(ix.data)),
  }));
}
/** Sends the page's claim_exit again from the devnet key: resolves if it went through. */
async function replaySolana(sol: ReturnType<typeof solanaClient>, sig: string) {
  const me = await loadSolanaKeypair(process.env.SOLANA_KEYPAIR ?? `${KEYS}/devnet.json`);
  const ixs = await instructionsOf(sol, sig, me.address); // a failure here fails the run, not the check
  return { send: () => sol.send(ixs, [me.keyPair], me.address) };
}

/**
 * The demo's `ui` entry goes on the run run.ts recorded for this batch (re-read: run.ts wrote the
 * file meanwhile), once, on success or when a later step fails (with its error).
 */
let pendingUi: (Record<string, unknown> & { timings: Record<string, number> }) | undefined;
/** solana-resume: the run whose `ui` entry this run completes. */
let resumeIndex: number | undefined;
const recordUi = () => {
  const ui = pendingUi;
  pendingUi = undefined;
  if (!ui) return -1;
  const rec = JSON.parse(readFileSync(PUBLIC_FILE, "utf8"));
  const runIndex = resumeIndex ?? rec.runs.findLastIndex((r: { kind?: string; timings?: { start?: number } }) => r.kind !== "exit" && (r.timings?.start ?? 0) >= ui.timings.start!);
  if (runIndex < 0) return -1;
  rec.runs[runIndex].ui = ui;
  writeFileSync(PUBLIC_FILE, `${JSON.stringify(rec, null, 2)}\n`);
  return runIndex;
};
process.on("uncaughtExceptionMonitor", (e) => { if (pendingUi) pendingUi.error = String(e?.message ?? e).split("\n")[0]!.slice(0, 300); });
process.on("exit", () => {
  recordUi();
  writeFileSync(`${outDir}testnet-marks.json`, `${JSON.stringify(marks, null, 2)}\n`);
});

// Behind an HTTPS proxy, send only remote hosts through it; a local app is served on loopback
// (Playwright proxies loopback too unless told not to).
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
// A profile on disk, so the vault (IndexedDB) outlives a crashed page: the run opens the app again
// and unlocks. Removed at the end; it holds the run's vault.
const profileDir = `${outDir}profile/`;
if (!resume) rmSync(profileDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profileDir, {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
  proxy,
  viewport: { width: 1280, height: 860 },
  // A long run (solana: about 90 min) records a lot: smaller frames keep the file small.
  ...(crossing ? { recordVideo: { dir: outDir, size: mode === "solana" ? { width: 800, height: 538 } : { width: 960, height: 645 } } } : {}),
});

// The page's Ethereum wallet (demo): EIP-1193 in the page, the key and the signing here.
const l1 = createPublicClient({ chain: sepolia, transport: http(dep.l1.rpc) });
const ethTxs: string[] = [];
if (mode === "demo") {
  const account = privateKeyToAccount((process.env.SEPOLIA_PRIVATE_KEY ?? readFileSync(`${KEYS}/sepolia.key`, "utf8").trim()) as Hex);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(dep.l1.rpc) });
  await context.exposeFunction("__eclypsEth", async (method: string, params: unknown[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return `0x${sepolia.id.toString(16)}`;
      case "wallet_switchEthereumChain":
        if (Number((params[0] as { chainId: string }).chainId) !== sepolia.id) throw new Error("this demo wallet is on Sepolia only");
        return null;
      case "eth_sendTransaction": {
        const tx = params[0] as { to: Hex; data?: Hex; value?: Hex; gas?: Hex };
        const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
        ethTxs.push(hash);
        return hash;
      }
      default:
        return l1.request({ method, params } as never);
    }
  });
  // A string, not a function: tsx (esbuild keepNames) would add `__name(...)` calls that do not
  // exist in the page, and the provider would silently never appear.
  await context.addInitScript(`window.ethereum = {
    request: ({ method, params }) => window.__eclypsEth(method, params || []),
    on() {}, removeListener() {},
  };`);
}

// Solana signatures the page sends (the browser deposit), read from the RPC's answers.
const solanaSigs: string[] = [];
const pages: Page[] = [];
const wire = (p: Page) => {
  pages.push(p);
  p.on("console", (m) => { if (m.type() === "error") console.log(`  [browser] ${m.text().slice(0, 200)}`); });
  p.on("response", async (r) => {
    try {
      if (r.request().method() !== "POST" || !r.request().postData()?.includes("sendTransaction")) return;
      const body = await r.json();
      if (typeof body?.result === "string") solanaSigs.push(body.result);
    } catch { /* not JSON-RPC */ }
  });
  return p;
};
let page = wire(context.pages()[0] ?? (await context.newPage()));
videoStart = Date.now();
const shot = async (name: string, mask: string[] = []) =>
  page.screenshot({ path: `${outDir}testnet-${name}.png`, mask: mask.map((s) => page.locator(s)), maskColor: "#111111" });

say(`open ${APP}`);
await page.goto(APP);
// Wallet first (ADR 0016, amended): the app opens on the bridge; the vault step comes only when an action needs it.
await page.getByTestId("bridge").waitFor();
/** The Menu holds the wallets and Keys; Move out opens from Balance. */
const menu = async (open: boolean) => {
  if ((await page.getByTestId("menu").count() > 0) !== open) await page.getByTestId(open ? "menu-open" : "menu-close").click();
};
await menu(true);
await page.getByTestId("network").filter({ hasText: "testnet" }).waitFor();
await menu(false);
if (mode === "demo" && (await page.evaluate("window.ethereum.request({ method: 'eth_chainId' })")) !== `0x${sepolia.id.toString(16)}`) {
  throw new Error("the page's Ethereum wallet is not there");
}
/** The vault step (headless has no passkey): a passphrase, then the recovery phrase and its 3-word check. */
const createVault = async () => {
  await page.getByTestId("passphrase").fill("correct horse battery staple");
  await page.getByTestId("create-vault").click();
  // Recovery phrase: reveal, then answer the 3-word check from what is on screen.
  await page.getByTestId("seed-reveal").click();
  const words: string[] = [];
  for (let i = 1; i <= 24; i++) words.push((await page.getByTestId(`seed-word-${i}`).textContent())!.trim());
  await page.getByTestId("seed-saved").click();
  const challenge = page.locator('[data-testid^="backup-word-"]');
  for (let k = 0; k < (await challenge.count()); k++) {
    const pos = Number(await challenge.nth(k).getAttribute("data-position"));
    await challenge.nth(k).fill(words[pos - 1]!);
  }
  await page.getByTestId("backup-check-submit").click();
  await page.getByTestId("vault-sheet").waitFor({ state: "detached" });
};
if (mode === "check") {
  // Keys needs the vault: the vault step comes now, and the Aztec wallet starts once it is open.
  await menu(true);
  await page.getByTestId("tab-vault").click();
  await createVault();
}

/** The app opens the embedded PXE in the background after unlock; wait for it (or start it, or retry it once). */
const openAztec = async () => {
  await menu(true);
  const chip = page.getByTestId("chip-aztec");
  const ready = page.locator('[data-testid="chip-aztec"][data-state="ready"]');
  const failed = page.locator('[data-testid="chip-aztec"][data-state="failed"]');
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await chip.getAttribute("data-state");
    if (state === "ready") return menu(false);
    if (state === "idle" || state === "failed") {
      await chip.click(); // a failed wallet retries on click
      if (state === "idle") await page.getByTestId("open-aztec").click();
      await page.keyboard.press("Escape");
    }
    await Promise.race([ready.waitFor({ timeout: 900_000 }), failed.waitFor({ timeout: 900_000 })]);
    if (await ready.count()) return menu(false);
    console.log(`  Aztec wallet failed: ${await chip.getAttribute("title")}`);
  }
  throw new Error(await chip.getAttribute("title") ?? "Aztec wallet failed");
};

/** The devnet test wallet: the pasted keypair (test networks only). The page does not keep it. */
const connectSolana = async () => {
  await menu(true);
  if (await page.getByTestId("chip-solana").filter({ hasText: "$" }).waitFor({ timeout: 8_000 }).then(() => true, () => false)) return menu(false);
  await page.getByTestId("chip-solana").click();
  await page.getByTestId("dev-key").fill(readFileSync(process.env.SOLANA_KEYPAIR ?? `${KEYS}/devnet.json`, "utf8").trim());
  await page.getByTestId("use-dev-key").click();
  await page.getByTestId("chip-solana").filter({ hasText: "$" }).waitFor({ timeout: 60_000 });
  await menu(false);
};
/** Unlock the vault kept in this browser, then the Aztec wallet and (if it was) the Solana wallet. */
let solanaConnected = false;
const unlock = async () => {
  // The app opens on the bridge with the vault locked; its quiet "Unlock" opens the vault step.
  await page.getByTestId("bridge-unlock").click({ timeout: 120_000 });
  await page.getByTestId("passphrase").fill("correct horse battery staple");
  await page.getByTestId("unlock").click();
  await page.getByTestId("vault-sheet").waitFor({ state: "detached", timeout: 120_000 });
  say("unlocked");
  if (solanaConnected) await connectSolana();
  await openAztec();
};
const isCrash = (e: unknown) => /Target crashed|Page crashed|Target page, context or browser has been closed/i.test(String((e as Error)?.message ?? e));
/** A crashed page (the renderer died): a new page on the same profile, unlocked. */
const reopen = async () => {
  say("the page crashed: open the app again and unlock (the vault stays in this browser profile)");
  await page.close().catch(() => {});
  page = wire(await context.newPage());
  await page.goto(APP);
  await unlock();
};

if (mode === "check") {
  say("open the in-browser Aztec PXE against Aztec testnet");
  await openAztec();
  await page.getByTestId("tab-portfolio").click();
  await page.getByTestId("balance-toggle").click(); // hidden by default
  await page.getByTestId("private-balance").filter({ hasText: /\$\s*\d/ }).waitFor({ timeout: 300_000 }); // a number, not the loading "$…"
  say(`PXE ready: private balance ${(await page.getByTestId("private-balance").textContent())?.trim()}`);
  await shot("aztec-pxe-ready");
} else {
  const mask = ['[data-testid="chip-solana"]'];
  const bridge = (stage: string) => page.locator(`[data-testid="bridge"][data-stage="${stage}"]`);
  const stageNow = () => page.getByTestId("bridge").getAttribute("data-stage");
  /** Waits for one of the bridge's stages; a `tunnel-error` line fails the run. A crashed page is opened again. */
  const until = async (stages: string[], timeout: number) => {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        const s = await stageNow();
        if (s && stages.includes(s)) return s;
        const err = page.getByTestId("tunnel-error");
        if (await err.count()) throw new Error(`tunnel error at ${s}: ${await err.textContent()} ${(await err.getAttribute("title")) ?? ""}`.trim());
        if (Date.now() > end) throw new Error(`still at ${s} after ${timeout / 1000} s (waiting for ${stages.join("|")})`);
        await page.waitForTimeout(2_000);
      } catch (e) {
        if (!isCrash(e)) throw e;
        await reopen();
      }
    }
  };
  /** Reload and unlock (the vault stays in this browser), then the Aztec wallet again. */
  const recover = async () => {
    await page.reload();
    await unlock();
  };
  /** A step the in-browser wallet may fail (public testnet nodes, PXE): up to 3 tries, reloading between them. */
  const failures: string[] = [];
  const attempt = async (what: string, step: (n: number) => Promise<boolean>) => {
    for (let n = 1; n <= 3; n++) {
      try {
        if (await step(n)) return;
      } catch (e) {
        if (!isCrash(e)) throw e;
        failures.push(`${what} #${n}: the page crashed`);
        await reopen();
        continue;
      }
      const err = (await page.getByTestId("tunnel-error").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("title")].filter(Boolean).join(" ")))).join(" ");
      await page.getByTestId("tab-portfolio").click();
      await page.waitForTimeout(1_500);
      const lines = (await page.locator("main").innerText()).split("\n").filter((l) => /error|invalid|not found|failed|reverted/i.test(l));
      failures.push(`${what} #${n}: ${err || lines.join(" | ") || "no message"}`);
      say(`${what} failed (try ${n}): ${failures.at(-1)}`);
      await shot(`${what.replace(/\s+/g, "-")}-failed-${n}`, mask);
      await page.getByTestId("tab-shield").click();
      if (n < 3) await recover();
    }
    throw new Error(`${what} failed 3 times`);
  };
  /**
   * The 32-byte references on the Move out tab's exit rows (full values sit in the titles). Waits for
   * a row and for the section's fade-in: read at once, the tab was still empty.
   */
  const exitRefs = async () => {
    await menu(false);
    await page.getByTestId("tab-portfolio").click();
    await page.getByTestId("tab-exit").click();
    await page.locator('[data-testid^="exit-row-"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
    return page.locator('[data-testid^="exit-row-"]').evaluateAll((els) =>
      [...new Set(els.flatMap((e) => [e.textContent ?? "", ...[...e.querySelectorAll("[title]")].map((t) => t.getAttribute("title") ?? "")]).join(" ").match(/0x[0-9a-f]{64}/gi) ?? [])]);
  };
  type Ui = Record<string, unknown> & { timings: Record<string, number>; checks: Record<string, boolean> };
  let ui: Ui = { app: APP, timings: { start: Date.now() }, checks: {} };
  if (resume) {
    const rec = JSON.parse(readFileSync(PUBLIC_FILE, "utf8"));
    resumeIndex = rec.runs.findLastIndex((r: { ui?: { exitToSolana?: { claimSig?: string } } }) => r.ui?.exitToSolana && !r.ui.exitToSolana.claimSig);
    if (resumeIndex! < 0) throw new Error("no solana run to resume");
    ui = rec.runs[resumeIndex!].ui;
    ui.resumed = { after: ui.error, at: Date.now() };
    delete ui.error;
    pendingUi = Object.assign(ui, { failures: (ui.failures as string[] | undefined) ?? [] });
    failures.push(...(ui.failures as string[]));
    ui.failures = failures;
    say(`resume runs[${resumeIndex}]: unlock the vault kept in this browser profile`);
    solanaConnected = true;
    await unlock();
  }

  if (!resume) {
    say("connect the devnet test wallet (pasted keypair; test networks only)");
    await connectSolana();
    solanaConnected = true;
    // Balance shows when Solana was last read.
    await page.getByTestId("tab-portfolio").click();
    await page.getByTestId("chain-updated").filter({ hasText: "slot" }).waitFor({ timeout: 120_000 });
    if (await page.getByTestId("gateway-not-deployed").count()) throw new Error("This deployment names no Ethereum portal: the app keeps deposits off.");
    if (await page.getByTestId("portal-mismatch").count()) throw new Error("The gateway's portal does not match the deployment: the app blocks deposits.");

    say("the Tunnel: $1 to your private balance, Send");
    await page.getByTestId("tab-shield").click();
    if ((await stageNow()) !== "amount") await page.getByTestId("tunnel-new").click();
    await bridge("amount").waitFor();
    await page.getByTestId("shield-amount").fill("1");
    await page.getByTestId("shield-split").filter({ hasText: "1 × $1" }).waitFor();
    await page.getByTestId("bridge-to-aztec").waitFor();
    await shot("1-tunnel-amount", mask);
    await page.getByTestId("shield-submit").click();
    // Send asks for the vault first (wallet first, ADR 0016 amended).
    await createVault();
    // Before anything is signed: wait for the eclipse, or cross with the next batch.
    await bridge("decide").waitFor();
    await page.getByTestId("tunnel-wait-eclipse").waitFor();
    await page.waitForTimeout(1_500);
    await shot("2-tunnel-decide", mask);
    say("Cross with the next batch: the browser signs one $1 deposit");
    await page.getByTestId("tunnel-cross-batch").click();
    await until(["wait"], 180_000);
    await page.getByTestId("tunnel-line").filter({ hasText: /of 4 deposits/ }).waitFor({ timeout: 60_000 });
    ui.timings.deposited = Date.now();
    say(`in the batch: ${await page.getByTestId("tunnel-line").textContent()}`);
    await page.waitForTimeout(1_500);
    await shot("3-tunnel-wait", mask);

    say("other depositors fill the batch (run.ts deposit 3)");
    runTs(["deposit", "3"]);
    pendingUi = Object.assign(ui, { failures }); // from here on the run is recorded, even if a later step fails
    ui.timings.filled = Date.now();
    await page.getByTestId("tunnel-line").filter({ hasText: /4 of 4|Crossing/ }).waitFor({ timeout: 120_000 }).catch(() => {});
    await shot("4-tunnel-full", mask);
    say("a finisher closes the batch, burns through CCTP, relays on Sepolia, registers on Aztec (run.ts finish)");
    runTs(["finish"]);
    if (mode === "solana") startFinisher(); // the forward batch is carried; from here it carries the exits
    ui.timings.registered = Date.now();
    // The page follows: transit, then Arrived once the Aztec wallet reads the registered batch.
    await openAztec();
    await until(["arrived"], 900_000);
    await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
    ui.timings.arrivedInPage = Date.now();
    say("Arrived");
    await shot("5-tunnel-arrived", mask);

    say("Claim: a real proof in the browser, sent privately");
    await attempt("claim", async (n) => {
      await until(["arrived"], 900_000);
      await page.getByTestId("tunnel-claim").click();
      await until(["claim", "claimed", "arrived"], 120_000);
      if (n === 1) await shot("6-tunnel-claiming", mask);
      return (await until(["claimed", "arrived"], 2_400_000).catch(() => "failed")) === "claimed";
    });
    await page.getByTestId("tunnel-balance").filter({ hasText: "$1" }).waitFor({ timeout: 120_000 });
    await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
    ui.timings.claimed = Date.now();
    say("claimed: $1 in the private balance");
    await shot("7-tunnel-claimed", mask);
  }

  if (mode === "solana" || resume) {
    // A brand-new address: its key is not kept, it only receives.
    const exit = (ui.exitToSolana ?? { destination: (await generateKeyPairSigner()).address }) as Record<string, unknown> & { destination: string };
    const destination = address(exit.destination);
    ui.exitToSolana = exit;
    if (!resume) {
      say("Move out to a fresh Solana address");
      await attempt("move out", async (n) => {
        // After a crash mid-burn, the reopened page may already follow the exit.
        if (["burning", "leaving", "exit-claim"].includes((await stageNow()) ?? "")) return (await until(["leaving", "exit-claim"], 2_400_000)) !== undefined;
        await until(["claimed"], 900_000);
        await page.getByTestId("tunnel-move-out").click();
        if (await page.getByTestId("tunnel-exit-to-solana").count()) await page.getByTestId("tunnel-exit-to-solana").click();
        await page.getByTestId("tunnel-exit-destination").fill(destination);
        await page.getByTestId("tunnel-exit-submit").waitFor();
        if (n === 1) await shot("8-tunnel-move-out", mask);
        await page.getByTestId("tunnel-exit-submit").click();
        await page.waitForTimeout(3_000);
        if (n === 1) await shot("9-tunnel-burning", mask);
        for (const end = Date.now() + 2_400_000; Date.now() < end; await page.waitForTimeout(2_000)) {
          const st = await stageNow();
          if (st === "leaving" || st === "exit-claim") return true;
          if (await page.getByTestId("tunnel-error").count()) return false;
        }
        throw new Error("the burn did not finish in 40 min");
      });
      ui.timings.burned = Date.now();
      say("burned on Aztec: the exit waits in the open exit epoch for 3 more");
      await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
      await shot("10-tunnel-leaving", mask);
      exit.burnRefs = await exitRefs();
      await page.getByTestId("tab-shield").click();
      await page.getByTestId("bridge").waitFor();

      say("3 more exits fill the exit epoch (exits.ts fill 3)");
      runTs(["fill", "3"], "testnet/exits.ts");
      ui.timings.epochFilled = Date.now();
      const fillIndex = JSON.parse(readFileSync(PUBLIC_FILE, "utf8")).runs.findLastIndex((r: { purpose?: string }) => r.purpose === "fill");
      exit.fillRun = fillIndex;
      say(`the testnet finisher closes the epoch, then exitBatch, Iris, receive_exit (runs[${fillIndex}] fills it)`);
      await shot("11-tunnel-epoch-full", mask);
    }
    await until(["exit-claim"], 7_200_000);
    ui.timings.arrivedOnSolanaInPage = Date.now();
    await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
    say("arrived on Solana: Claim, paid by the connected devnet wallet");
    exit.linkedLineShown = (await page.getByTestId("tunnel-exit-linked").count()) > 0;
    await shot("12-tunnel-exit-claim", mask);
    await attempt("solana claim", async () => {
      if ((await stageNow()) === "out") return true;
      await until(["exit-claim"], 900_000);
      await page.getByTestId("tunnel-exit-claim").click();
      return (await until(["out"], 600_000).catch(() => "failed")) === "out";
    });
    await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
    ui.timings.claimedOnSolana = Date.now();
    await shot("13-tunnel-out", mask);

    // On Solana: the fresh address's USDC account, its claim_exit, and a replay of that claim.
    const sol = solanaClient(dep.solana.rpc);
    const ata = await associatedTokenAddress(destination, address(dep.solana.usdcMint));
    const paid = BigInt((await sol.rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send()).value.amount);
    const [claimSig] = (await sol.rpc.getSignaturesForAddress(ata, { commitment: "confirmed" }).send()).map((x) => x.signature).reverse();
    exit.claimSig = claimSig;
    ui.checks["the fresh Solana address holds exactly $1 of devnet USDC"] = paid === 1_000_000n;
    say(`out: ${destination} holds ${Number(paid) / 1e6} USDC on Solana (claim_exit ${claimSig})`);
    const again = await replaySolana(sol, claimSig!);
    const replay = await again.send().then(() => true, (e) => (say(`replay refused: ${String(e?.message ?? e).split("\n")[0]!.slice(0, 160)}`), false));
    ui.checks["a second claim_exit of the same exit is refused"] = !replay;
    if (paid !== 1_000_000n) throw new Error(`the Solana address holds ${paid}, not $1`);
    if (replay) throw new Error("a replay of claim_exit went through");

    await menu(true);
    await page.getByTestId("tab-vault").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-viewing-key").click()]);
    const view = JSON.parse(readFileSync((await download.path())!, "utf8")) as { notes: { depositSig: string | null; claimTx: string | null }[] };
    await download.delete();
    Object.assign(ui, { depositSig: view.notes[0]?.depositSig ?? solanaSigs[0], claimTx: view.notes[0]?.claimTx ?? undefined });
    exit.refs = await exitRefs();
    await shot("14-move-out-paid", mask);
    say(`done: recorded as runs[${recordUi()}].ui`);
    stopFinisher();

    say("the fill's own exits: record the carry, claim_exit to its addresses (exits.ts fill-carry, fill-solana)");
    runTs(["fill-carry"], "testnet/exits.ts");
    runTs(["fill-solana"], "testnet/exits.ts");
  } else {
    say("Move out to a fresh Ethereum address");
    // A brand-new address: its key is not kept, it only receives.
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    ui.exitToEthereum = { recipient };
    await attempt("move out", async (n) => {
      await until(["claimed"], 900_000);
      await page.getByTestId("tunnel-move-out").click();
      await page.getByTestId("tunnel-exit-to-ethereum").click();
      await page.getByTestId("tunnel-exit-destination").fill(recipient);
      await page.getByTestId("tunnel-exit-submit").waitFor();
      if (n === 1) await shot("8-tunnel-move-out", mask);
      await page.getByTestId("tunnel-exit-submit").click();
      await page.waitForTimeout(3_000);
      if (n === 1) await shot("9-tunnel-burning", mask);
      // Back on "claimed" (with a tunnel-error line) means the burn failed; nothing left Aztec.
      for (const end = Date.now() + 2_400_000; Date.now() < end; await page.waitForTimeout(2_000)) {
        const st = await stageNow();
        if (st === "leaving" || st === "exit-claim") return true;
        if (await page.getByTestId("tunnel-error").count()) return false;
      }
      throw new Error("the burn did not finish in 40 min");
    });
    ui.timings.burned = Date.now();
    say("burned on Aztec; waiting for Aztec's epoch proof on Sepolia");
    await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
    await shot("10-tunnel-leaving", mask);
    // The burn's Aztec transaction shows on the exit's journey (Move out) only until it is paid.
    ui.exitToEthereum = { ...(ui.exitToEthereum as object), burnRefs: await exitRefs() };
    await page.getByTestId("tab-shield").click();
    await page.getByTestId("bridge").waitFor();
    await until(["exit-claim"], 5_400_000);
    ui.timings.provenInPage = Date.now();
    say("proven: Claim on Ethereum through the page's wallet");
    await attempt("ethereum claim", async (n) => {
      await until(["exit-claim"], 900_000);
      await page.getByTestId("tunnel-exit-claim").waitFor();
      if (n === 1) await shot("11-tunnel-exit-claim", mask);
      await page.getByTestId("tunnel-exit-claim").click();
      return (await until(["out"], 600_000).catch(() => "failed")) === "out";
    });
    await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 60_000 });
    ui.timings.claimedOnEthereum = Date.now();
    const usdc = await l1.readContract({ address: dep.l1.portal, abi: parseAbi(["function usdc() view returns (address)"]), functionName: "usdc" });
    const paid = await l1.readContract({ address: usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [recipient] });
    Object.assign(ui.exitToEthereum as object, { claimTx: ethTxs.at(-1) });
    ui.checks["the fresh Ethereum address holds exactly $1 of Sepolia USDC"] = paid === 1_000_000n;
    say(`out: ${recipient} holds ${Number(paid) / 1e6} USDC on Sepolia`);
    await shot("12-tunnel-out", mask);
    if (paid !== 1_000_000n) throw new Error(`the Ethereum address holds ${paid}, not $1`);

    // References from the page: the deposit and the claim (view-only export, kept in memory only),
    // the exit's references from its journey on Move out.
    await menu(true);
    await page.getByTestId("tab-vault").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-viewing-key").click()]);
    const view = JSON.parse(readFileSync((await download.path())!, "utf8")) as { notes: { depositSig: string | null; claimTx: string | null }[] };
    await download.delete();
    Object.assign(ui, { depositSig: view.notes[0]?.depositSig ?? solanaSigs[0], claimTx: view.notes[0]?.claimTx ?? undefined });
    Object.assign(ui.exitToEthereum as object, { refs: await exitRefs() });
    await shot("13-move-out-paid", mask);

    say(`done: recorded as runs[${recordUi()}].ui`);
  }
}

const videos = await Promise.all(pages.map((p) => p.video()?.path()));
await context.close();
rmSync(profileDir, { recursive: true, force: true });
videos.forEach((v, i) => v && renameSync(v, `${outDir}eclyps-testnet-demo${i ? `-${i + 1}` : ""}.webm`));
say(`UI ${mode} OK`);
