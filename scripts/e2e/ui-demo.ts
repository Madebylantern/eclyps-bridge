/**
 * Drives the real UI (app/, static export served by app/serve.mjs) against the local stack in
 * headless Chromium, recording a video and screenshots into docs/demo/. Other depositors (crowd)
 * and a finisher run in the background, as independent parties would.
 *
 * What it shows (ADR 0007; wallet first, ADR 0016 amended):
 *   the bridge, no vault yet → Balance (empty) → connect Solana → the bridge: $1,310, then More
 *   options and the Balanced plan (5 scheduled notes in one transfer, advisor; Fast, the bridge's
 *   default, shows its risks) → Plan: the vault step comes now (headless has no passkey: the
 *   passphrase, the 24-word phrase, the 3-word check) and the plan is saved → deposit one $100 note early
 *   → crowd fills its epoch → finisher sends + relays → the Aztec wallet (started in the
 *   background at unlock) is ready → finisher registers → claim with the claim advisor → show the
 *   private balance: $100 → Privacy (crowds, exposure) → Move out to a fresh Solana address
 *   (ADR 0009): the burn, three strangers move out too (crowd-exit.ts), the finisher closes the exit
 *   epoch, burns it through Ethereum and receives it on Solana, then the claim pays $100 → a $10
 *   note crosses the same way and moves out to an Ethereum address (ADR 0014 §4), claimed with the
 *   page's Ethereum wallet (an EIP-1193 provider backed by the local L1) → the bridge as a journey
 *   (the tunnel): New crossing, $100, Send, the choice (Wait for the eclipse · Cross with the next
 *   batch), the batch filling, the crossing, Arrived · Claim, the balance in the far ring, then Move
 *   out from the tunnel to a fresh Solana address, paid → Vault & keys.
 *
 * Prereqs: stack up, deploy-local.ts run, `next build` done, app/out/deployment.json copied from
 * app/public/, and `node app/serve.mjs` serving :3000.
 *   pnpm exec tsx e2e/ui-demo.ts        (from scripts/, Node >= 24.12)
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, renameSync, statfsSync } from "node:fs";
import { createSolanaRpc, generateKeyPairSigner } from "@solana/kit";
import { associatedTokenAddress } from "@eclyps/sdk";
import { createPublicClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { chromium } from "playwright";

const repo = new URL("../../", import.meta.url);
const out = new URL("docs/demo/", repo);
mkdirSync(out, { recursive: true });
// APP_URL is the site; `/` is the landing page and the app itself is served at /app/.
const APP = new URL("/app/", process.env.APP_URL ?? "http://127.0.0.1:3000").href;
const devKey = readFileSync(new URL("scripts/e2e/.local/user.json", repo), "utf8");
const t0 = Date.now();
// The local Solana ledger grows ~100 MB a minute (start-local-stack.sh). A full disk kills the
// validator and every later Solana step stalls on refused connections: fail fast and say why.
const freeMb = () => {
  const f = statfsSync(repo);
  return Number((BigInt(f.bavail) * BigInt(f.bsize)) >> 20n);
};
const MIN_FREE_MB = Number(process.env.ECLYPS_MIN_FREE_MB ?? 2_500);
if (freeMb() < MIN_FREE_MB) {
  console.error(`only ${freeMb()} MB free; the UI demo needs ${MIN_FREE_MB} MB (the Solana ledger and the video grow during the run). rm -rf app/.next once the app is built (serve.mjs serves app/out).`);
  process.exit(1);
}
const diskWatch = setInterval(() => {
  if (freeMb() >= 200) return;
  console.error(`the disk is full (${freeMb()} MB free): the local validator cannot write its ledger. Stopping.`);
  process.exit(1);
}, 15_000);
diskWatch.unref();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);
const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("pnpm", ["-s", "exec", "tsx", ...args], { cwd: new URL(cwd, repo), env: { ...process.env, ...env }, encoding: "utf8" });
const finisher = () => run("finisher/", ["src/main.ts", "--once"], { DEPLOYMENT: "../scripts/e2e/.local/deployment.json" });
/** A finisher left running (exits wait on Aztec's proofs, which take a few passes); FINISHER_LOG=<file> keeps its output. */
let looping: ChildProcess | undefined;
const startFinisherLoop = () => {
  looping = spawn("pnpm", ["-s", "exec", "tsx", "src/main.ts"], {
    cwd: new URL("finisher/", repo), env: { ...process.env, DEPLOYMENT: "../scripts/e2e/.local/deployment.json" }, stdio: process.env.FINISHER_LOG ? ["ignore", openSync(process.env.FINISHER_LOG, "a"), openSync(process.env.FINISHER_LOG, "a")] : "ignore", detached: true,
  });
};
const stopFinisherLoop = () => {
  if (!looping?.pid) return;
  try {
    process.kill(-looping.pid, "SIGTERM");
  } catch {
    looping.kill("SIGTERM");
  }
  looping = undefined;
};
process.on("exit", stopFinisherLoop);
const dep = JSON.parse(readFileSync(new URL("scripts/e2e/.local/deployment.json", repo), "utf8"));
// The page's Ethereum wallet: an EIP-1193 provider that forwards to the local L1, where anvil's
// default accounts are unlocked (it signs eth_sendTransaction itself). Account #4 sends the claim.
const ethWallet = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 4 }).address;

process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, recordVideo: { dir: out.pathname, size: { width: 1360, height: 900 } } });
await context.addInitScript(({ rpc, account }) => {
  let id = 0;
  (window as unknown as { ethereum: unknown }).ethereum = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
    on() {},
    removeListener() {},
  };
}, { rpc: dep.l1.rpc as string, account: ethWallet });
const page = await context.newPage();
page.on("requestfailed", (r) => console.log(`  [failed] ${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`));
page.on("console", (m) => { if (m.type() === "error") console.log(`  [browser] ${m.text().slice(0, 200)}`); });
const shot = async (name: string, mask: string[] = []) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out.pathname}${name}.png`, fullPage: true, mask: mask.map((s) => page.locator(s)), maskColor: "#111111" });
};
/** The Menu holds the wallets, Privacy and Keys; Move out opens from Balance. */
const menu = async (open: boolean) => {
  if ((await page.getByTestId("menu").count() > 0) !== open) await page.getByTestId(open ? "menu-open" : "menu-close").click();
};
const tab = async (t: string) => {
  await menu(t === "privacy" || t === "vault");
  if (t === "exit") await page.getByTestId("tab-portfolio").click();
  await page.getByTestId(`tab-${t}`).click();
};
/** Notes live inside transfer cards, folded into one line on Balance: open them all. */
const expandTransfers = async () => {
  await page.locator('[data-testid="notes-toggle"]').waitFor();
  if ((await page.getByTestId("notes-toggle").getAttribute("aria-expanded")) === "false") await page.getByTestId("notes-toggle").click();
  await page.locator('[data-testid^="transfer-toggle-"]').first().waitFor();
  const collapsed = page.locator('[data-testid^="transfer-toggle-"][aria-expanded="false"]');
  while (await collapsed.count()) await collapsed.first().click();
};
/** The app opens the Aztec wallet in the background after unlock; open or retry it if needed. */
const aztecReady = async (timeout: number) => {
  await menu(true);
  const chip = page.getByTestId("chip-aztec");
  const state = await chip.getAttribute("data-state");
  if (state === "idle" || state === "failed") {
    await chip.click(); // a failed wallet retries on click
    if (state === "idle") await page.getByTestId("open-aztec").click();
    await page.keyboard.press("Escape");
  }
  await page.locator('[data-testid="chip-aztec"][data-state="ready"]').waitFor({ timeout });
  await menu(false);
};

/** The vault step, when an action first needs it: headless has no passkey, so the passphrase, then the phrase and its check. */
const createVault = async () => {
  await page.getByTestId("passphrase").fill("correct horse battery staple");
  await page.getByTestId("create-vault").click();
  await page.getByTestId("seed-reveal").click();
  await page.getByTestId("seed-word-24").waitFor();
  await shot("01-vault-recovery-phrase", ['[data-testid="seed-backup"]']);
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

say("open app: the bridge, no vault yet");
await page.goto(APP);
// The app opens on the bridge; Balance shows the empty state.
await page.getByTestId("bridge").waitFor();
await tab("portfolio");
await page.getByTestId("empty-shield").waitFor();
await shot("02-portfolio-empty");

say("connect the local dev wallet");
await menu(true);
await page.getByTestId("chip-solana").click();
await page.getByTestId("dev-key").fill(devKey.trim());
await page.getByTestId("use-dev-key").click();
await page.getByTestId("chip-solana").filter({ hasText: "$" }).waitFor({ timeout: 30_000 });
await menu(false);

say("the bridge: $1,310, then More options and the Balanced plan (spread across epochs)");
await tab("shield");
await page.getByTestId("shield-amount").fill("1310");
await page.getByTestId("shield-split").filter({ hasText: "1 × $1,000" }).waitFor();
await page.getByTestId("bridge-to-aztec").waitFor();
await page.getByTestId("bridge-more").click();
await page.getByTestId("shield-plan-balanced").click();
await page.getByTestId("shield-advice").waitFor();
await shot("03-shield-balanced-plan");
await page.getByTestId("shield-plan-fast").click();
await page.locator('[data-testid="shield-advice"] [data-severity="risk"]').first().waitFor();
await shot("04-shield-fast-warnings");
await page.getByTestId("shield-plan-balanced").click();
await page.getByTestId("shield-submit").click();
say("the vault step comes with the first plan: create the vault, write down and check the recovery phrase");
await createVault();
await expandTransfers();
await page.locator('[data-stage="scheduled"]').first().waitFor();
await shot("05-portfolio-scheduled");

say("deposit one scheduled $100 note early");
const row = page.locator('[data-stage="scheduled"]').filter({ hasText: "$100" }).first();
const id = (await row.getAttribute("data-testid"))!.replace("note-", "");
await page.getByTestId(`deposit-${id}`).click();
await page.locator(`[data-testid="note-${id}"][data-stage="queued"]`).waitFor({ timeout: 60_000 });
// The other scheduled $100 notes are now held until a new $100 epoch opens (rollover guard).
await page.locator('[data-stage="scheduled"][data-held="true"]').filter({ hasText: "$100" }).first().waitFor({ timeout: 30_000 });
await shot("06-portfolio-queued");

say("other depositors fill the $100 epoch; a finisher closes, sends and relays");
run("scripts/", ["e2e/crowd.ts", "1", "3"]);
finisher();
await page.locator(`[data-testid="note-${id}"][data-stage="sent"]`).waitFor({ timeout: 60_000 });

say("the embedded Aztec wallet (started at unlock) is ready");
await aztecReady(600_000);
say("finisher registers the root on Aztec");
// A finisher runs in a loop; on a fresh local network the L1->L2 message may need another round
// (the finisher nudges a block when it is not consumable yet).
const stateFile = new URL("scripts/e2e/.local/finisher-state.json", repo);
const unregistered = () =>
  Object.values(JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, { l1Tx?: string; registered?: boolean }>)
    .some((b) => b.l1Tx && !b.registered);
for (let round = 0; round < 10 && unregistered(); round++) {
  await new Promise((r) => setTimeout(r, round === 0 ? 14_000 : 5_000));
  finisher();
}
await page.locator(`[data-testid="note-${id}"][data-stage="claimable"]`).waitFor({ timeout: 300_000 });
await shot("07-portfolio-claimable");

say("claim, with the claim advisor");
await page.getByTestId(`claim-${id}`).click();
await page.getByTestId(`claim-advice-${id}`).waitFor();
await shot("08-claim-advisor");
await page.getByTestId(`claim-confirm-${id}`).click();
await page.locator(`[data-testid="note-${id}"][data-stage="claimed"]`).waitFor({ timeout: 600_000 });
await page.getByTestId("balance-toggle").click(); // hidden by default
await page.getByTestId("private-balance").filter({ hasText: "$100" }).waitFor({ timeout: 60_000 });
await shot("09-portfolio-claimed");

say("privacy");
await tab("privacy");
await page.getByTestId("pool-1").waitFor();
await shot("10-privacy");

say("move out $100 to a fresh Solana address");
await tab("exit");
await page.getByTestId(`exit-note-${id}`).click();
const user = JSON.parse(readFileSync(new URL("scripts/e2e/.local/accounts.json", repo), "utf8")).user as string;
await page.getByTestId("exit-destination").fill(user);
await page.locator('[data-testid="exit-advice"] [data-severity="risk"]').waitFor();
await shot("11-exit-same-wallet-warning");
const fresh = (await generateKeyPairSigner()).address;
await page.getByTestId("exit-destination").fill(fresh);
await page.getByTestId("exit-commitments").waitFor();
await shot("12-exit-prepared");
await page.getByTestId("exit-submit").click();
const solRow = page.locator('[data-testid^="exit-row-solana:"]').first();
await page.locator('[data-testid^="exit-row-solana:"][data-stage="burned"]').waitFor({ timeout: 300_000 });
await shot("13-exit-burned");
say("three strangers move out too; a finisher closes the exit batch, burns it through Ethereum, receives it on Solana");
run("scripts/", ["e2e/crowd-exit.ts", "1", "3"]);
startFinisherLoop();
await page.locator('[data-testid^="exit-row-solana:"][data-stage="arrived"]').waitFor({ timeout: 900_000 });
await shot("14-exit-arrived");
say("claim it to the fresh address (the dev wallet sends the claim)");
const solId = (await solRow.getAttribute("data-testid"))!.replace("exit-row-", "");
await page.getByTestId(`exit-claim-${solId}`).click();
await page.locator(`[data-testid="exit-row-${solId}"][data-stage="paid"]`).waitFor({ timeout: 120_000 });
const rpc = createSolanaRpc(dep.solana.rpc as string);
const got = (await rpc.getTokenAccountBalance(await associatedTokenAddress(fresh, dep.solana.usdcMint)).send()).value.amount;
if (got !== "100000000") throw new Error(`the fresh Solana address holds ${got}, not $100`);
await shot("15-exit-paid");

say("a $10 note crosses, then moves out to an Ethereum address");
await tab("portfolio");
await expandTransfers();
const row10 = page.locator('[data-stage="scheduled"]').filter({ hasText: "$10" }).filter({ hasNotText: "$100" }).first();
const id10 = (await row10.getAttribute("data-testid"))!.replace("note-", "");
await page.getByTestId(`deposit-${id10}`).click();
await page.locator(`[data-testid="note-${id10}"][data-stage="queued"]`).waitFor({ timeout: 60_000 });
run("scripts/", ["e2e/crowd.ts", "0", "3"]);
await page.locator(`[data-testid="note-${id10}"][data-stage="claimable"]`).waitFor({ timeout: 600_000 });
await page.getByTestId(`claim-${id10}`).click();
await page.getByTestId(`claim-confirm-${id10}`).click();
await page.locator(`[data-testid="note-${id10}"][data-stage="claimed"]`).waitFor({ timeout: 600_000 });
await tab("exit");
await page.getByTestId(`exit-note-${id10}`).click();
await page.getByTestId("exit-to-ethereum").click();
const recipient = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`;
await page.getByTestId("exit-destination").fill(recipient);
await page.getByTestId("exit-commitments").waitFor();
await page.getByTestId("exit-submit").click();
const ethRow = page.locator('[data-testid^="exit-row-ethereum:"]').first();
// Burned, or already proven when the Aztec epoch was proven before the page looked.
await page.locator('[data-testid^="exit-row-ethereum:"]:is([data-stage="burned"], [data-stage="proven"])').waitFor({ timeout: 300_000 });
// The local network builds blocks only on demand: keep it moving until the burn's epoch is proven.
for (let i = 0; i < 40 && (await ethRow.getAttribute("data-stage")) !== "proven"; i++) run("scripts/", ["e2e/aztec-blocks.ts", "2"]);
await page.locator('[data-testid^="exit-row-ethereum:"][data-stage="proven"]').waitFor({ timeout: 120_000 });
await shot("16-exit-ethereum-ready");
const ethId = (await ethRow.getAttribute("data-testid"))!.replace("exit-row-", "");
await page.getByTestId(`exit-claim-${ethId}`).click();
await page.locator(`[data-testid="exit-row-${ethId}"][data-stage="paid"]`).waitFor({ timeout: 120_000 });
const l1 = createPublicClient({ transport: http(dep.l1.rpc) });
const paid = await l1.readContract({ address: dep.l1.usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [recipient as `0x${string}`] });
if (paid !== 10_000_000n) throw new Error(`the Ethereum address holds ${paid}, not $10`);
await shot("17-exit-ethereum-paid");

say("the bridge as a journey: a new $100 crossing in the tunnel, from Send to Move out");
await tab("shield");
const bridge = (stage: string) => page.locator(`[data-testid="bridge"][data-stage="${stage}"]`);
// The tunnel follows the newest crossing (the Balanced plan, still in flight): start a new one.
await page.getByTestId("tunnel-new").click();
await bridge("amount").waitFor();
await page.getByTestId("shield-amount").fill("100");
await page.getByTestId("shield-split").filter({ hasText: "1 × $100" }).waitFor();
await page.getByTestId("shield-submit").click();
// Before anything is signed: wait for the eclipse, or cross with the next batch.
await bridge("decide").waitFor();
await page.getByTestId("tunnel-wait-eclipse").waitFor();
await page.getByTestId("tunnel-line").filter({ hasText: "crossing right now" }).waitFor();
await shot("19-tunnel-decide");
await page.getByTestId("tunnel-cross-batch").click();
await bridge("wait").waitFor({ timeout: 60_000 });
await page.getByTestId("tunnel-line").filter({ hasText: "1 of 4 deposits" }).waitFor({ timeout: 30_000 });
await shot("20-tunnel-wait");
say("three others join the batch; the finisher (still running) closes, sends, relays and registers it");
run("scripts/", ["e2e/crowd.ts", "1", "3"]);
await bridge("arrived").waitFor({ timeout: 600_000 });
await page.locator('[data-testid="bridge"][data-settled="true"]').waitFor({ timeout: 30_000 });
await shot("21-tunnel-arrived");
await page.getByTestId("tunnel-claim").click();
await bridge("claimed").waitFor({ timeout: 600_000 });
await page.getByTestId("tunnel-balance").filter({ hasText: "$100" }).waitFor();
await shot("22-tunnel-claimed");
say("move out from the tunnel, to a fresh Solana address");
await page.getByTestId("tunnel-move-out").click();
const fresh2 = (await generateKeyPairSigner()).address;
await page.getByTestId("tunnel-exit-destination").fill(fresh2);
await page.getByTestId("tunnel-exit-submit").click();
await bridge("leaving").waitFor({ timeout: 300_000 });
run("scripts/", ["e2e/crowd-exit.ts", "1", "3"]);
await bridge("exit-claim").waitFor({ timeout: 900_000 });
await page.getByTestId("tunnel-exit-claim").click();
await bridge("out").waitFor({ timeout: 120_000 });
const got2 = (await rpc.getTokenAccountBalance(await associatedTokenAddress(fresh2, dep.solana.usdcMint)).send()).value.amount;
if (got2 !== "100000000") throw new Error(`the tunnel's fresh Solana address holds ${got2}, not $100`);
await shot("23-tunnel-out");
stopFinisherLoop();

await tab("vault");
await page.getByTestId("backup-status").waitFor();
await shot("18-vault-keys");
say("done: $100 claimed privately and moved out to Solana; $10 moved out to Ethereum; $100 crossed and moved out from the tunnel");

const video = await page.video()?.path();
await context.close();
await browser.close();
if (video) renameSync(video, `${out.pathname}eclyps-local-demo.webm`);
console.log(`UI demo OK in ${((Date.now() - t0) / 1000).toFixed(0)} s; artifacts in docs/demo/`);
