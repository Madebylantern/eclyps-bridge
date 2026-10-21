# app — Eclyps web app (ADR 0007)

A shielded portfolio, not a wizard. Notes are deposited, batched, sent and claimed asynchronously,
so the app is something you can leave and come back to. It is a static Next.js export that runs
entirely in the browser; there is no Eclyps server and no analytics.

Two routes, each with its own root layout so their styles never mix:
- **`/`: the landing page** (`src/app/(landing)/`). Black and white: the eclipse with the name
  inside it (WebGL point sprites, motion computed in the vertex shader), the tagline, the crossing
  (one screen that plays by itself on arrival: the route as three quiet words, Solana · Bridge ·
  Aztec, the notes travelling at one slow even pace into the dark of the bridge and out onto Aztec,
  each word lighting with one short line as they reach it, and "How it works" to `/docs/#how`, where
  who holds the money and how to verify each stage now live), the crowd (one screen too: its dots
  gather by themselves, then its two lines emerge one after the other), and one closing line. The
  page moves like pages: CSS scroll snap rests it on one full screen at a time, never between two.
  `scene.ts` runs everything that moves and follows `prefers-reduced-motion` (the two stories then
  show their last frame); there is no Tailwind on this page. Inter and IBM Plex Mono are
  self-hosted. The splash is a cover: the page does not scroll until "Enter the darkness" is
  pressed (or a tap, or a key that would scroll); the press wakes the eclipse in time with the
  horn's first call (it swells, then settles to a stronger breathing), and once it has swelled
  "Scroll" appears and the page lets go (at once with reduced motion). A link to a section opens
  past the cover. A few lines emerge from the dark as they arrive (`emerge.ts`: word by word, blur
  to focus; a whole-line fade with reduced motion). Once the tagline's "Open the app" reaches the
  top it stays docked there. Sound (`sound.ts`, `sound-gate.ts`): procedural Web Audio, started by
  that press or any first click, tap or key, never by scrolling (turned off, in the app or here,
  it stays off for those, but pressing "Enter the darkness" itself always starts it); a horn call
  comes every 20-35 s, and the crossing, as it plays, brings the answer;
  `M` or the footer word turns it off. `node app/scripts/sound-preview.mjs <dir>` renders the same
  graph offline (WAV, MP3, spectrogram, loudness, call times; `--tune` tries knobs).

  **Typeface preview (owner only, `face.ts`).** Inter is the landing's face. To preview face II
  (Marcellus SC, inscription capitals) on the display lines, open `/?face=2`; it is remembered in
  this browser until `/?face=1`. After either, `T` toggles it on the landing (not for other visitors). Nothing on the page shows the
  switch, and the font downloads only when it is on.
- **`/app/`: the app** (`src/app/(app)/`), described below. The export uses trailing slashes, so
  the app is `out/app/index.html`.

**Understood at a glance.** Every screen reads at first sight: at most two short lines of plain
English per item, and a picture rather than a sentence wherever one can carry the state (the route
with notes as points of light, crowd disks, the eclipse). Explanations, risks, what is public and
private, limits and fees live on the Docs page (`/docs/`, anchors `#what`, `#how`, `#crowd`,
`#totality`, `#public`, `#limits`, `#keys`, `#fees`, `#status`, `#verify`); the app links there
with a quiet word ("Why", "How it works", "Docs") instead of explaining in place. A risk that
matters for a decision stays visible as one line with "Why". "Docs" is also a header word, and the
footer is one line: "Testnet · Unaudited · No Eclyps server · Docs". Each step's line has a quiet
**"?"** (`HelpMark` in `src/components/ui.tsx`, keyboard reachable): it shows one or two short plain
sentences beneath, written for someone crossing for the first time (Connect wallet, the amount as
fixed notes, Start, the choice, the batch, the crossing, Claim, Move out), with "More in Docs" where
it helps; a second press or Escape hides it.

**Wallet first (ADR 0016, amended 2026-10-19).** The app opens on the bridge with no vault: the
first action is **Connect wallet**, then the amount (the wallet's USDC under it). The vault is
created or unlocked only when an action needs it (`ensureVault`, `src/lib/app.tsx`): Send, a plan,
a claim, Move out, Keys, the Aztec wallet, and Balance or Privacy once a vault exists. It comes as
one centred step over the bridge (`src/components/vault-sheet.tsx`); closing it cancels that action.

Sections (header words; the test ids keep the earlier tab names `tab-shield` (Bridge), `tab-portfolio`,
`tab-exit`, `tab-privacy`, `tab-vault`):

| Section | What |
| --- | --- |
| **Balance** | The private balance in large thin figures (hidden until Show), and "Crossing" / "Planned" only when there is something. **Next**: the one thing to do now, in one short sentence (take back a stuck deposit → deposit a due note → claim → "Nothing to do until 14:20. Then your $100 deposit is due."); when nothing is urgent, the eclipse beside it. The claim shows "Now · 1 in 4" against "After the next batch · 1 in 8 or more", each crowd as points, and at most one risk line. Then each **transfer**: "Moving in $1,310", one status line, the **route figure**, the notes ("Wallet · 14:20", "Escrow · 2 of 4 in batch", "Ready to claim") and **Where it is**: a one-line headline and each stage with a one-line where and the reference to copy. Ids and the hold override sit under Technical details |
| **Bridge** | The front door, where the app opens: **the Tunnel journey** (`src/components/tunnel.tsx`, picture in `src/lib/tunnel-scene.ts`, stages in `src/lib/tunnel.ts`). **Connect wallet** comes first (the amount waits for it); then the wallet's USDC shows under the disk, the amount is typed inside it and its notes appear as points of light around it ("1 × $100 · fee $0.50"; what does not fit stays in the wallet), **To** (your private balance; "an Ethereum address" with `deployment.features.exitEthereum`), **Send** (the vault step comes here when no vault is open). Then, before anything is signed, the choice: **Wait for the eclipse** (the Totality plan, "· 2d 04h") or **Cross with the next batch** (Fast: deposits now; **Cross now** once `features.crossNow`, ADR 0015, exists), under the real crowd ("You're the only one crossing right now."). The same screen then follows the crossing from real states: the batch filling (others' notes fly in as leaves appear), the flight into the disk when it closes or is sent, the diamond ring and the arrival when Aztec registers it ("Arrived · Claim"), the balance in the far ring, and **Move out**, the way back, with honest waits. Reopening resumes at the real stage. **More options** opens the plans in a sheet: **Fast**, **Balanced** (6 h), **Private** (72 h) and **Totality**, the timeline (bigger notes, bigger points), three facts, the crowds as small disks and the advice; a plan made there goes to Balance |
| **Move out** | The notes, **To** (a fresh Solana address, or "An Ethereum address" with `deployment.features.exitEthereum`; an address chosen on the bridge comes back prefilled), what Aztec sees and one-line exit advice, then **Move out**: each note is burned on Aztec by the account itself (`exit` / `exit_to_ethereum` under an authwit, the SponsoredFPC paying) and saved in the vault before it is sent. Below, each exit with the journey view: Burned → In an exit batch ("Waiting for 2 more exits to fill the batch.") → Through Ethereum → On Solana → Paid, or Burned → Proven → Paid; a paid exit shrinks to one line. The user's one step is **Claim**: `claim_exit` from the connected Solana wallet (one line warns when it is a deposit wallet), or `claimToEthereum` from the browser's Ethereum wallet (without one: one line and Docs). Without `deployment.features.exit`, one gate line ("Not open yet. You can prepare one. Nothing is sent.") |
| **Privacy** | **Now**: the eclipse, large, and each batch forming as points ("Next $100 batch ●●○○ 2 of 4 deposits"). **Crowds**: a disk per size with a crowd or a forming batch (one point per note that crossed, hollow points for deposits waiting, a faint ring for 256), one big count and one short line ("crossed · small crowd"); quiet sizes share one line. "How privacy works" links to Docs. **Your own notes**: one line, or one line per link found |
| **Keys** | The 24-word recovery phrase (veiled; shown behind the passphrase, or a passkey tap for a passkey vault, where it is the optional **Back up**; the old 64-hex form under Advanced), a 3-word check, then rows of one short line each: backup, **passkeys** (count, **Add a passkey**), encryption and lock, start the Aztec wallet on unlock, notifications, a chain scan, the vault file and a view-only export |

Keys and recovery:
- **Passkey first (ADR 0016).** Where the browser has a passkey authenticator with PRF
  (`src/lib/passkey.ts`), the vault step is one action: the face-scan line icon over **Start** (no
  arrow) and one line, "Keeps your private receipts on this device.", with its "?"; everything else
  under a quiet **Other options**; unlock is **Unlock** ("Opens your private receipts on this device."). The seed is HKDF of
  the passkey's PRF output (`src/lib/keys.ts`, input `eclyps-seed-v1`), so the same synced passkey
  gives the same notes on any device (**I already have a passkey** then scans the chain). The vault data
  sits under a random data key that each passkey wraps (storage v2); **Add a passkey** adds a
  wrap. No phrase step: the phrase is an optional backup under Keys, with one quiet reminder once
  notes exist ("Eclyps can't recover your passkey", with a Docs link). Without PRF (headless Chromium, IP-address origins such as `127.0.0.1`, an
  authenticator that lacks it) the step is the passphrase vault below (storage v1): the same line,
  "Choose a passphrase" and **Start**, restore and import under Other options, and
  its phrase step can be left for later. An older passphrase vault that adds a passkey keeps its
  passphrase as a slot.
- **Use my wallet instead** (under Other options; ADR 0016 amended). The connected Solana wallet
  signs one fixed, domain-bound message (`walletMessage` in `src/lib/keys.ts`; off mainnet it names
  the network); the seed and the vault key are HKDF-SHA256 of the 64-byte ed25519 signature
  (`eclyps wallet seed`, `eclyps wallet vault key`). The signature must verify against the
  wallet's address, and at creation the wallet signs twice and must give the same bytes. A `wallet`
  slot (storage v2) unlocks with the same wallet; the same wallet makes the same keys on any device
  (the chain scan runs before the first deposit). One white line says the risk: "Only sign this on
  eclyps.xyz." (a copy of the site could ask for the same signature; passkeys are bound to the
  site). Vectors in `test/keys.test.ts`.
- **Recovery phrase.** The 32-byte seed is the BIP-39 entropy (SDK `mnemonic.ts`), so 24 words and
  older 64-hex backups restore the same notes. Creating a vault shows the words (blurred until
  Reveal), then asks for 3 random words; "Check later" keeps a reminder visible until checked.
- **Restore rescans the chain.** After a restore the app reads every epoch, finds the seed's
  commitments (`recoverNotes`), rebuilds the note book under "Recovered notes" and continues the
  note index after them. Deposits stay off until that scan has run.
- **No index is deposited twice.** Before every deposit, `findCommitment` checks the note against
  all known epochs; a commitment already on chain is recorded as recovered and the planned note
  moves to the next unused index.
- The vault (v3) is encrypted with PBKDF2-SHA256 (600k) + AES-GCM in localStorage. Older vaults
  migrate: notes without a transfer show under "Earlier notes".

Totality (the cold start):
- **A weekly crossing window when people move in together**, so batches fill sooner and a deposit's
  timing says less about who made it. Default: Sundays 20:00–21:00 UTC; Totality #1 is
  2026-10-18. It is configuration plus client logic, with no server: `deployment.totality`
  (`{ "weekday": 0, "hourUtc": 20, "minutes": 60, "first": "2026-10-18T20:00:00Z" }`), validated
  by `parseTotality`. Absent or invalid, every Totality feature is hidden.
- **The Totality plan** schedules the notes inside the window that is on (while at least 10 minutes
  remain) or the next one, spread like Balanced (`planSchedule` with `withinWindow`). A window too
  short for one note per epoch keeps the notes inside it, closer together, and the advisor says so.
  What it does not do (it helps timing at deposit; claims should still wait for later batches) is
  on Docs.
- **The eclipse** (`src/components/eclipse.tsx`) is how the app shows it: a white disk that a black
  disk slides over, from full at the end of one window (a week before Totality #1) to total when the
  next one starts, linear in time (`eclipseAt`; `eclipseOffset` places the dark disk so that the
  covered area is exactly that share). During a window it is total, with a thin stippled corona.
  Under it: "Next eclipse in 4d 06h 12m" (seconds in the last ten minutes) or "Eclipse now · until
  21:00 UTC", local time on hover, "Add to calendar" (a weekly .ics, "Eclyps: Totality", no
  amounts) and "Why". Large on Privacy and beside the next step on Balance; on the bridge, the time to the next window is on "Wait for the eclipse". Canvas at up to 2× pixel ratio, redrawn about once a minute; with reduced motion nothing glides.
- **An option, never a gate.** Moving in works at any time and every plan stays available.
- Nothing is rewarded or promised for taking part. Window maths is UTC (a week is exactly 7 × 24 h),
  so there is no daylight-saving arithmetic; `src/lib/totality.ts` holds it as pure functions,
  tested by `pnpm --filter @eclyps/app test` (`node --test test/`).

Deposits, refunds, claims:
- **Portal check.** The app reads the gateway config and compares its portal with
  `deployment.l1.portal` (`portalMatches`). A mismatch blocks deposits; an empty portal means the
  gateway is not fully deployed, and deposits stay off.
- **Fee and cap (ADR 0012).** Each note costs its denomination plus the gateway's fee (0.5 % by
  default), read from the config and the open epoch's snapshot. The bridge shows it under the amount
  ("fee $6.55") and, under More options, as one fact ("0.5% · $6.55 · ≈ 0.0022 SOL"), checks the USDC with fees, and Pay with SOL buys both. When the
  deposit cap leaves no room, one line says so and deposits stop.
- **Holds.** A scheduled note waits while another of yours of the same denomination is in the open
  epoch, and says why. The override lives in that note's Technical details, behind an in-page
  confirmation that names the risk.
- **Take back.** A deposit whose open epoch could not cross within about 24 h and rolled over
  (`refundStatus`) can be returned to the wallet that made it (`refundDepositIx`, to its USDC
  account), with the fee it paid ("Take back $100.50"). Only that wallet can sign; the app says which one is needed. Refunded notes leave the
  balances.
- **Aztec wallet warm-up.** After unlock the embedded PXE opens in the background (a setting turns
  this off). The header shows warming up / ready / failed (click to retry). Claims show Preparing →
  Proving → Sending → Waiting for inclusion with an elapsed timer.
- **Reminders without a server.** A scheduled deposit happens only while the page is open and you
  sign. The app offers an .ics file made in the browser ("Eclyps: deposit due", no amounts; the
  calendar provider sees the times), opt-in browser notifications while a tab is open, and a
  "(1)" prefix in the tab title.

Pay with SOL (ADR 0011):
- **Any coin in, one crowd inside.** With `deployment.swap` set and `solana.cluster` "mainnet", the
  bridge offers "Pay with USDC · SOL". With SOL, one line under From ("≈ 12.13 SOL · swapped to
  USDC first") and one swap transaction for exactly the plan's USDC (Jupiter's keyless API,
  ExactOut), signed like a deposit and final before the plan goes on. Local and devnet never show it.
- `src/lib/swap.ts` holds the config check, the quote and transaction checks and the amounts,
  tested on recorded fixtures (`test/fixtures/jupiter-*.json`). Jupiter sees the wallet, amount
  and IP; Docs say so under `#limits` and `#fees`.

Wallets:
- **Solana:** Wallet Standard (Phantom, Solflare, Backpack, …). On test networks a pasted throwaway
  dev keypair can sign instead.
- **Aztec:** the embedded PXE (WASM in this page; the recipient derives from the phrase), or an
  extension wallet found through the Aztec Wallet SDK and connected over an ECDH channel verified
  by emojis. On testnet the recipient sends its own claim and the network's SponsoredFPC pays.
- **Merkle paths** are computed in the browser from public epoch accounts.

The app's look and feel: black and white only, the same language as the landing. Tokens live once in
`src/app/globals.css` (Tailwind 4 `@theme`, default palette switched off): `black`, `white`, `text`,
`grey`, `dim` and `hair`. No boxes, pills, badges or coloured states: hierarchy comes from size,
weight and light. Actions are words that brighten and glow on hover and keyboard focus; lists use a
1px hairline between rows; statuses are words, sometimes with a still dot; advice shows its severity
by typography ("Risk" in white, "Caution" in grey), one line per item, the detail on Docs. Progress is words and an elapsed timer,
never a spinner. Wallet sheets are full-screen black. Fonts are self-hosted at build time with
`next/font`: Inter (200–500) for display and body, IBM Plex Mono for data. Motion is fades and
positions only and follows `prefers-reduced-motion`.

## Deploying (Vercel)

- Project settings: **Root Directory** `app`; leave Install and Build to `app/vercel.json`
  (`pnpm install --frozen-lockfile`, `pnpm run build`, which runs `next build --webpack`: Next 16's
  default Turbopack build does not support this app's config). Node 22 or newer.
- The Aztec bindings the app imports are committed in `aztec/artifacts/` (generated by
  `pnpm --filter @eclyps/aztec-contracts codegen`, with the debug source map stripped), so the
  build needs no Aztec toolchain. CI fails if they drift from a fresh compile.
- `deployment.json`: a hosted build has no `public/deployment.json`, so `scripts/ensure-deployment.mjs`
  ships `deployments/$ECLYPS_DEPLOYMENT.json` (default `testnet`). A local one is never overwritten.
- `vercel.json` sets the COOP/COEP headers the in-browser prover needs.

Code map: `src/lib/` holds state and chain logic (`app.tsx` context, `portfolio.ts` stages,
`transfers.ts` grouping and the next action, `journey.ts` where the money is at each stage, `tunnel.ts` the bridge's journey stages and words,
`tunnel-scene.ts` its picture, `sound.ts` its two calls, `totality.ts` the
crossing windows, `swap.ts` paying with SOL, `recovery.ts`, `reminders.ts`, `vault.ts`,
`solana.ts`, `aztec.ts`, `exits.ts` reading where each exit is and the claims, `exit-status.ts` its words and steps); `src/components/` holds the views. The advisor (`splitAmount`,
`planSchedule`, `adviseShield`, `adviseClaim`, `adviseExit`, `auditNotes`) lives in the SDK and is
unit-tested.

The Tunnel: WebGL points (about 90k on a phone, up to about 140k on a large screen) with a 2D
fallback, paused in a hidden tab or under a sheet, slower while holding; with reduced motion the
stages change without the flight. Flights play only when a real state moves forward while the page
is open. Sound on the bridge is two calls of the landing's engine (`src/lib/sound.ts`): a horn as
the light goes into the disk and a distant answer at the arrival, on the landing's switch
(`eclyps.sound`), `M` and the header word "Sound off / Sound on"; nothing plays while it is off.
Test ids: the bridge keeps `bridge`, `shield-amount`, `shield-split`, `shield-submit`,
`shield-connect`, `bridge-to-aztec`, `bridge-to-ethereum`, `bridge-eth-address`, `bridge-more` and,
in the sheet, `shield-plan-*`, `shield-advice`, `shield-submit`; the journey adds `data-stage` on
`bridge` and `tunnel-*` words (`tunnel-cross-batch`, `tunnel-wait-eclipse`, `tunnel-claim`,
`tunnel-move-out`, `tunnel-exit-destination`, `tunnel-exit-submit`, `tunnel-exit-claim`,
`tunnel-new`, …) and `sound-toggle` in the header. Wallet first adds `bridge-usdc`, `bridge-unlock`
(a locked vault), `help-toggle` / `help-text` (a step's "?"), and the vault step's `vault-sheet`,
`vault-close`, `gate-line`, `gate-wallet`, `wallet-gate`, `wallet-sign`, `wallet-connect` and
`wallet-warning`; the gate keeps its earlier ids (`passkey-create`, `passphrase`, `create-vault`,
`unlock`, `seed-*`, `restore-*`, `gate-*`).

Tools: Next.js 16.4 (webpack mode: `next build --webpack`), React 19.3, Tailwind 4.3, motion 14,
lucide-react, `@aztec-labs/{aztec.js,wallets,wallet-sdk,noir-contracts.js}` 6.0.0-rc.3. The in-browser
prover needs COOP/COEP headers: `next dev` and `serve.mjs` send them, and `vercel.json` sets them
in production. In `next dev`, open `http://localhost:3000` (the landing) or
`http://localhost:3000/app/` (Next blocks dev resources for other origins such as 127.0.0.1). The
UI demos open `/app/` under `APP_URL` (default `http://127.0.0.1:3000`).

```
# local stack + deployment: scripts/e2e/start-local-stack.sh && (cd scripts && pnpm exec tsx e2e/deploy-local.ts)
pnpm --filter @eclyps/app build && cp app/public/deployment.json app/out/ && node app/serve.mjs   # :3000 (app at /app/)
# disk: the local Solana ledger grows ~100 MB/min (~3 GB a demo); rm -rf app/.next after the build saves 2.5 GB
cd scripts && pnpm exec tsx e2e/ui-demo.ts          # full local path in headless Chromium (in, claim, move out to Solana and to Ethereum, then a whole crossing in the tunnel), writes docs/demo/
# testnet: cp deployments/testnet.json app/out/deployment.json, then
cd scripts && pnpm exec tsx testnet/ui-demo.ts check # in-browser PXE on Aztec testnet
# passkeys (no chain needed): Chromium's virtual authenticator with PRF, on localhost (not 127.0.0.1)
PORT=3017 node app/serve.mjs & (cd scripts && APP=http://localhost:3017/app/ pnpm exec tsx e2e/passkey-check.ts)
```
