/**
 * Headless check of the passkey vault (ADR 0016) with Chromium's virtual authenticator (CDP
 * WebAuthn, `hasPrf`). Needs only the built app, no chain:
 *
 *   pnpm --filter @eclyps/app build && PORT=3017 node app/serve.mjs &
 *   APP=http://localhost:3017/app/ pnpm --filter @eclyps/scripts exec tsx e2e/passkey-check.ts
 *
 * It checks, in order:
 *   1. no authenticator (headless default): the passphrase vault, as before (the demos' path);
 *   2. create with a passkey, lock, unlock with one tap, reveal the optional phrase with the passkey;
 *   3. an empty browser holding the same synced passkey: Other options, "I already have a passkey"
 *      gives the same phrase;
 *   4. Add a passkey (a second authenticator): it unlocks the vault and keeps the same phrase, and on
 *      a device without the vault it is refused instead of deriving a wrong, empty wallet;
 *   5. an authenticator without PRF: one line, then the passphrase vault;
 *   6. an older passphrase vault adds a passkey and opens with either;
 *   7. "Use my wallet instead" (a dev keypair signs like a wallet): the keys, unlock with the same
 *      wallet, and the same keys again where the vault was forgotten.
 * Wallet first (ADR 0016, amended): the app opens on the bridge, so each check asks for the vault
 * through Keys, an action that needs it.
 * Screenshots (1440×900 and 390×844) go to SHOTS (default /tmp/eclyps-passkeys/).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type BrowserContext, type CDPSession, chromium, type Page } from "playwright";

const APP = process.env.APP ?? "http://localhost:3017/app/";
const SHOTS = (process.env.SHOTS ?? "/tmp/eclyps-passkeys").replace(/\/$/, "");
mkdirSync(SHOTS, { recursive: true });
const PASS = "correct horse battery staple";

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const say = (s: string) => console.log(`· ${s}`);
const fail = (s: string): never => {
  throw new Error(s);
};

interface Device {
  ctx: BrowserContext;
  page: Page;
  cdp: CDPSession;
}

async function device(): Promise<Device> {
  // The app blocks the network only by failing to reach it; no chain is needed for these screens.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  return { ctx, page, cdp };
}

async function authenticator(d: Device, opts: { prf: boolean; transport?: string }): Promise<string> {
  const { authenticatorId } = await d.cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: opts.transport ?? "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: opts.prf,
      automaticPresenceSimulation: true,
    },
  } as never);
  return authenticatorId;
}

/** Both viewports, the phrase masked. */
async function shot(d: Device, name: string) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await d.page.setViewportSize({ width: w, height: h });
    await d.page.waitForTimeout(600);
    await d.page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: true, mask: [d.page.locator('[data-testid="phrase-revealed"], [data-testid="seed-backup"][data-revealed="true"]')], maskColor: "#111111" });
  }
  await d.page.setViewportSize({ width: 1440, height: 900 });
}

/** Keys is in the Menu. */
const keys = async (d: Device) => {
  await d.page.getByTestId("menu-open").click();
  await d.page.getByTestId("tab-vault").click();
};
/**
 * Wallet first (ADR 0016, amended): the app opens on the bridge, and the vault step comes when an
 * action needs it. Keys is one, and needs no chain.
 */
const gate = async (d: Device) => {
  await keys(d);
  await d.page.locator('[data-testid="passkey-gate"], [data-testid="passphrase"], [data-testid="wallet-gate"]').first().waitFor({ timeout: 60_000 });
};
const open = async (d: Device) => {
  await d.page.goto(APP);
  await d.page.getByTestId("bridge").waitFor({ timeout: 60_000 });
  await gate(d);
};
/** The vault step closed on an open vault. */
const inApp = async (d: Device) => {
  await d.page.getByTestId("vault-sheet").waitFor({ state: "detached", timeout: 60_000 });
  await d.page.getByTestId("menu-open").waitFor({ timeout: 60_000 });
};
async function phrase(d: Device): Promise<string> {
  await keys(d);
  await d.page.getByTestId("reveal-phrase").click();
  const grid = d.page.getByTestId("phrase-revealed");
  await grid.waitFor();
  return (await grid.locator('[data-testid^="seed-word-"]').allTextContents()).map((w) => w.trim()).join(" ");
}
/** Lock from Keys (the app goes back to the bridge), then ask for the vault again: the unlock step. */
const lock = async (d: Device) => {
  await keys(d);
  await d.page.getByTestId("vault-lock").click();
  await d.page.getByTestId("bridge").waitFor();
  await gate(d);
};
const visible = (d: Device, id: string) => d.page.getByTestId(id).isVisible();

// 1. No authenticator: the passphrase vault, exactly the demos' path.
{
  say("no authenticator: the passphrase vault, as before");
  const d = await device();
  await open(d);
  if (await visible(d, "passkey-create")) fail("a passkey was offered with no authenticator");
  await shot(d, "00-passphrase-start");
  await d.page.getByTestId("passphrase").fill(PASS);
  await d.page.getByTestId("create-vault").click();
  await d.page.getByTestId("seed-reveal").click();
  const words: string[] = [];
  for (let i = 1; i <= 24; i++) words.push((await d.page.getByTestId(`seed-word-${i}`).textContent())!.trim());
  await shot(d, "06-fallback-phrase");
  await d.page.getByTestId("seed-saved").click();
  const challenge = d.page.locator('[data-testid^="backup-word-"]');
  for (let k = 0; k < (await challenge.count()); k++) {
    const pos = Number(await challenge.nth(k).getAttribute("data-position"));
    await challenge.nth(k).fill(words[pos - 1]!);
  }
  await d.page.getByTestId("backup-check-submit").click();
  await inApp(d);
  await d.ctx.close();
}

// 2. Create with a passkey, lock, unlock, reveal the phrase.
say("passkey: create, lock, unlock, reveal the optional phrase");
const a = await device();
const authA = await authenticator(a, { prf: true });
await open(a);
await a.page.getByTestId("passkey-create").waitFor();
await shot(a, "01-create");
await a.page.getByTestId("gate-other").click();
await a.page.getByTestId("passkey-signin").waitFor();
await shot(a, "01b-other-options");
await a.page.getByTestId("gate-other").click();
await a.page.getByTestId("passkey-create").click();
await inApp(a);
const phraseA = await phrase(a);
if (phraseA.split(" ").length !== 24) fail(`expected 24 words, got "${phraseA}"`);
await a.page.getByTestId("phrase-revealed").waitFor();
await shot(a, "03-keys-backup-revealed");
await a.page.getByText("Hide").click();
await shot(a, "02-keys");
await lock(a);
await a.page.getByTestId("passkey-unlock").waitFor();
await shot(a, "04-unlock");
await a.page.getByTestId("passkey-unlock").click();
await inApp(a);
if ((await phrase(a)) !== phraseA) fail("the phrase changed after unlocking");
/** "Other options", then "I already have a passkey". */
const signIn = async (d: Device) => {
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("passkey-signin").click();
};
/** An empty browser holding the same synced passkey: the vault here is forgotten, the passkey kept. */
const forgetHere = async (d: Device) => {
  await lock(d);
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("gate-forget").click();
  await d.page.getByTestId("forget-vault-confirm").click();
};

// 3. A new device with the same synced passkey. (Chromium cannot export a virtual credential's PRF
// secret, so the "new device" is this browser with its vault forgotten and the passkey kept.)
say("new device, same synced passkey: the same seed");
await forgetHere(a);
await signIn(a);
await a.page.getByTestId("restore-scan").waitFor();
await a.page.waitForFunction(() => !(document.querySelector('[data-testid="restore-continue"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 120_000 });
await shot(a, "05-new-device-scan");
await a.page.getByTestId("restore-continue").click();
await inApp(a);
if ((await phrase(a)) !== phraseA) fail("the synced passkey gave a different seed on the new device");

// 4. Add a passkey from a second authenticator (a security key or another device's own passkey).
say("Add a passkey: a second authenticator opens the same vault");
await a.page.getByText("Hide").click();
await a.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authA });
await authenticator(a, { prf: true, transport: "usb" });
await a.page.getByTestId("passkey-add").click();
await a.page.locator('[data-testid="passkey-count"]', { hasText: "2 passkeys" }).waitFor();
await shot(a, "07-keys-two-passkeys");
await lock(a);
await a.page.getByTestId("passkey-unlock").click();
await inApp(a);
if ((await phrase(a)) !== phraseA) fail("the added passkey opened a different seed");
// Where the vault is not stored, the added passkey is refused instead of making a wrong, empty wallet.
await forgetHere(a);
await signIn(a);
await a.page.getByTestId("gate-error").filter({ hasText: "only where it was added" }).waitFor();
await a.ctx.close();

// 5. An authenticator without PRF: one line, then the passphrase vault.
{
  say("authenticator without PRF: the passphrase vault");
  const d = await device();
  await authenticator(d, { prf: false });
  await open(d);
  await d.page.getByTestId("passkey-create").click();
  await d.page.getByTestId("gate-error").filter({ hasText: "can't hold keys" }).waitFor();
  await d.page.getByTestId("passphrase").waitFor();
  await shot(d, "08-no-prf-fallback");
  await d.page.getByTestId("passphrase").fill(PASS);
  await d.page.getByTestId("create-vault").click();
  await d.page.getByTestId("seed-reveal").waitFor();
  await d.page.getByTestId("seed-later").click();
  await inApp(d);
  await d.ctx.close();
}

// 6. An older passphrase vault adds a passkey, then opens with either.
{
  say("passphrase vault: add a passkey, open with either");
  const d = await device();
  await authenticator(d, { prf: true });
  await open(d);
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("gate-passphrase").click();
  await d.page.getByTestId("passphrase").fill(PASS);
  await d.page.getByTestId("create-vault").click();
  await d.page.getByTestId("seed-reveal").click();
  const before = (await d.page.getByTestId("seed-backup").locator('[data-testid^="seed-word-"]').allTextContents()).join(" ");
  await d.page.getByTestId("seed-later").click();
  await inApp(d);
  await keys(d);
  await d.page.getByTestId("passkey-add").click();
  await d.page.locator('[data-testid="passkey-count"]', { hasText: "1 passkey" }).waitFor();
  await lock(d);
  await d.page.getByTestId("passkey-unlock").click();
  await inApp(d);
  if ((await phrase(d)) !== before) fail("adding a passkey changed the seed");
  await lock(d);
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("gate-passphrase").click();
  await d.page.getByTestId("passphrase").fill(PASS);
  await d.page.getByTestId("unlock").click();
  await inApp(d);
  await d.ctx.close();
}

// 7. "Use my wallet instead": the wallet's signature makes the keys, and the same wallet brings them
// back where the vault is forgotten. A throwaway dev keypair signs like a wallet (no chain needed:
// if the RPC is out of reach the wallet sheet shows that, but the wallet is connected).
{
  say("Use my wallet instead: the same wallet gives the same seed");
  const d = await device();
  const pair = generateKeyPairSync("ed25519");
  const secret = [...pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), ...pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32)];
  await d.page.goto(APP);
  await d.page.getByTestId("bridge").waitFor({ timeout: 60_000 });
  await d.page.getByTestId("menu-open").click();
  await d.page.getByTestId("chip-solana").click();
  await d.page.getByTestId("dev-key").fill(JSON.stringify(secret));
  await d.page.getByTestId("use-dev-key").click();
  await d.page.locator('[data-testid="chip-solana"][data-lit="true"]').waitFor({ timeout: 60_000 });
  if (await d.page.getByTestId("solana-modal").count()) await d.page.keyboard.press("Escape");
  await d.page.getByTestId("solana-modal").waitFor({ state: "detached" });
  await d.page.getByTestId("menu-close").click();
  await gate(d);
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("gate-wallet").click();
  await d.page.getByTestId("wallet-warning").filter({ hasText: "Only sign this on eclyps.xyz." }).waitFor();
  await shot(d, "09-wallet-instead");
  await d.page.getByTestId("wallet-sign").click();
  await inApp(d);
  const words = await phrase(d);
  if (words.split(" ").length !== 24) fail(`expected 24 words, got "${words}"`);
  await d.page.getByText("Hide").click();
  // Unlock with the same wallet.
  await lock(d);
  await d.page.getByTestId("wallet-sign").click();
  await inApp(d);
  if ((await phrase(d)) !== words) fail("the wallet unlocked a different seed");
  await d.page.getByText("Hide").click();
  // Forgotten here: the same wallet makes the same keys again.
  await lock(d);
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("gate-forget").click();
  await d.page.getByTestId("forget-vault-confirm").click();
  await d.page.getByTestId("gate-other").click();
  await d.page.getByTestId("gate-wallet").click();
  await d.page.getByTestId("wallet-sign").click();
  await inApp(d);
  if ((await phrase(d)) !== words) fail("the same wallet gave a different seed after the vault was forgotten");
  await d.ctx.close();
}

await browser.close();
console.log(`passkey check OK; screenshots in ${SHOTS}/`);
