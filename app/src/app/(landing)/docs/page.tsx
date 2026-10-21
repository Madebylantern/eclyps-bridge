import type { Metadata } from "next";
import "./docs.css";
import { Corona, Crossing, type CrossingStage } from "./drawings";
import { CrowdFigure, PhraseSlots, SizesPair, WaitPair } from "./figures";
import { Addresses, EclipseSchedule, NoteSizes, TopBar } from "./live";

// Docs (/docs/): what Eclyps is and how it works, drawings first, in plain English. It shares the
// landing's root layout (fonts, black page). Every fact here comes from the repository: the app's
// journey and privacy copy (src/lib/journey.ts, src/components), ADR 0005, 0007, 0009, 0010, 0011 and 0012, and
// SPEC §1.2, §5.8 and §5.9. The section ids are linked from the app; keep them.

export const metadata: Metadata = {
  title: "Eclyps · Docs",
  description: "How the private bridge between Solana and Ethereum works, in plain English: USDC from Solana to a private balance on Aztec, Ethereum's private layer, verifiable at every step.",
};

const STAGES: CrossingStage[] = [
  {
    n: "01",
    title: "Your wallet",
    chain: "Solana",
    line: "Your USDC is split into notes of fixed sizes. You sign each deposit.",
    held: "You",
    check: "That your wallet deposited, and when",
  },
  {
    n: "02",
    title: "Gateway escrow",
    chain: "Solana",
    line: "The Eclyps program holds your note in the open batch.",
    held: "Eclyps gateway escrow",
    check: "Every note in the open batch",
  },
  {
    n: "03",
    title: "The batch closes",
    chain: "Solana",
    line: "Once {min} deposits of one size have arrived, anyone can close it and send it.",
    held: "Gateway escrow",
    check: "The batch: its size, total and fingerprint",
  },
  {
    n: "04",
    title: "Circle CCTP",
    chain: "Solana to Ethereum",
    line: "Circle burns the batch on Solana and mints it on Ethereum.",
    held: "Nobody: burned, then minted to the portal",
    check: "Circle’s message, carrying the fingerprint",
  },
  {
    n: "05",
    title: "Eclyps portal",
    chain: "Ethereum",
    line: "The portal holds the USDC and tells Aztec about the batch.",
    held: "Eclyps portal",
    check: "The portal’s USDC, and the batch registered on Aztec",
  },
  {
    n: "06",
    title: "Your private note",
    chain: "Aztec",
    line: "You claim one note into your private balance, when you choose.",
    held: "You, privately, backed by USDC in the portal",
    check: "That a claim happened. Never which note",
  },
];

function Head({ label, title, id }: { label: string; title: string; id: string }) {
  return (
    <div className="d-head">
      <span className="label">{label}</span>
      <h2 id={`${id}-title`}>{title}</h2>
    </div>
  );
}

/** The public copy of the code (scripts/publish/export.sh); bounty reports go to its Security tab. */
const CODE = "github.com/Madebylantern/eclyps-bridge";

export default function Docs() {
  return (
    <div className="docs">
      <TopBar />

      <main>
        <section className="d-hero" id="what" aria-labelledby="what-title">
          <div className="w d-hero-in">
            <Corona className="d-corona" />
            <div className="d-hero-text">
              <span className="label">What Eclyps is</span>
              <h1 id="what-title">A private bridge between Solana and Ethereum.</h1>
              <p>Your USDC lands in a private balance on Aztec, Ethereum&rsquo;s private layer. Every step is on a public chain, so anyone can check it. What stays private is which deposit became which balance.</p>
              <span className="d-route">Solana · Circle CCTP · Ethereum · Aztec</span>
            </div>
          </div>
        </section>

        <section className="d-sec" id="how" aria-labelledby="how-title">
          <div className="w">
            <Head id="how" label="How money crosses" title="Where your money is, at every step." />
            <Crossing stages={STAGES} />
            <ul className="d-notes">
              <li>Move in at any time. Your note waits in the escrow until its batch fills.</li>
              <li>Anyone can close a batch and carry it across. Eclyps runs no server in the path.</li>
              <li>If a batch can’t fill within about a day, you can take your note back to the wallet that deposited it.</li>
              <li>Moving out burns a note on Aztec. To Solana, exits cross in batches of at least four; you claim yours to a fresh address when it lands.</li>
              <li>To Ethereum, each exit is its own message. Once Aztec proves it, you claim it to the address you chose, from any Ethereum wallet.</li>
              <li>How long: a batch lands on Aztec a minute or two after it crosses, and the claim takes a couple more. Leaving Aztec waits for its proof, which comes about 3 to 5 minutes after the end of each 38-minute epoch; to Solana, Circle then needs about 15 minutes more. The app shows an estimate at each step, from these measured times.</li>
            </ul>
          </div>
        </section>

        <section className="d-sec" id="crowd" aria-labelledby="crowd-title">
          <div className="w">
            <Head id="crowd" label="The crowd" title="Your claim hides in a crowd of identical notes." />
            <div className="c-main">
              <CrowdFigure />
              <div className="c-say">
                <p className="c-big">A claim proves it is one of them.</p>
                <p className="c-big dim">Never which one.</p>
                <p>A claim doesn’t reveal its batch either, so the crowd is every note of that size that has crossed.</p>
              </div>
            </div>
            <div className="c-pairs">
              <div className="c-idea">
                <h3>Why fixed sizes</h3>
                <SizesPair />
                <p>Each size has its own crowd. Whatever doesn’t fit a size stays in your wallet.</p>
                <NoteSizes />
              </div>
              <div className="c-idea">
                <h3>Why waiting helps</h3>
                <WaitPair />
                <p>Wait for later batches of the same size, then claim at a time of your own.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="d-sec" id="totality" aria-labelledby="totality-title">
          <div className="w">
            <Head id="totality" label="The eclipse" title="Once a week, people move in together." />
            <EclipseSchedule />
            <p className="e-any">
              You can move in at any time. The eclipse is optional: crossing outside it works the same, with fewer people, so it is less private.
            </p>
            <div className="d-cols">
              <div>
                <span className="label">What it does</span>
                <ul>
                  <li>Deposits arrive together, so batches fill sooner.</li>
                  <li>A deposit’s timing says less about who made it.</li>
                  <li>In the app, after Send, Wait for the eclipse puts your deposits in that hour.</li>
                </ul>
              </div>
              <div>
                <span className="label">What it doesn’t</span>
                <ul>
                  <li>No reward, and no promise of how many will come.</li>
                  <li>It doesn’t grow the crowd you claim from. Claim later, at a time of your own.</li>
                  <li>You still sign each deposit yourself, with the app open.</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="d-sec" id="public" aria-labelledby="public-title">
          <div className="w">
            <Head id="public" label="Public and private" title="What anyone can see, and what only you can." />
            <div className="d-cols">
              <div>
                <span className="label">Anyone can see</span>
                <ul className="soft">
                  <li>Your Solana wallet deposited notes of a fixed size, and when</li>
                  <li>Each batch: its size, its total and its fingerprint</li>
                  <li>That a claim of one size happened on Aztec, and when</li>
                  <li>The USDC held by the Eclyps portal on Ethereum</li>
                  <li>Where a note moved out to, and when: never which note or account it came from</li>
                </ul>
              </div>
              <div>
                <span className="label">Only you can see</span>
                <ul className="bright">
                  <li>Which deposit a claim came from</li>
                  <li>Your Aztec account and its balance</li>
                  <li>Your recovery phrase and your notes’ secrets</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="d-sec" id="limits" aria-labelledby="limits-title">
          <div className="w">
            <Head id="limits" label="Limits" title="What Eclyps cannot hide, and what helps." />
            <div className="d-cols">
              <div>
                <span className="label">Cannot hide</span>
                <dl className="d-terms">
                  <div>
                    <dt>Low traffic</dt>
                    <dd>Few notes make a small crowd. Early on, it is small.</dd>
                  </div>
                  <div>
                    <dt>Amount and timing</dt>
                    <dd>Deposits made together, unusual mixes of sizes and quick claims can be matched up.</dd>
                  </div>
                  <div>
                    <dt>Network metadata</dt>
                    <dd>The RPC providers you connect to see your IP address.</dd>
                  </div>
                  <div>
                    <dt>Your own wallets</dt>
                    <dd>Moving out to a wallet that deposited, or claiming an exit with it, links the two.</dd>
                  </div>
                  <div>
                    <dt>Paying with SOL</dt>
                    <dd>Jupiter sees the swap: your wallet, the amount and your IP address.</dd>
                  </div>
                </dl>
              </div>
              <div>
                <span className="label">What helps</span>
                <dl className="d-terms">
                  <div>
                    <dt>Spread deposits</dt>
                    <dd>One note per epoch, over hours or days.</dd>
                  </div>
                  <div>
                    <dt>Claim later</dt>
                    <dd>After later batches of the same size have landed.</dd>
                  </div>
                  <div>
                    <dt>Hide your IP</dt>
                    <dd>Use Tor or a private relay where you can.</dd>
                  </div>
                  <div>
                    <dt>Move out fresh</dt>
                    <dd>To a new address, hours or days after claiming, one note at a time.</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        <section className="d-sec" id="screening" aria-labelledby="screening-title">
          <div className="w">
            <Head id="screening" label="Screening" title="Sanctioned and stolen funds can't enter." />
            <dl className="d-terms">
              <div>
                <dt>What is checked</dt>
                <dd>The depositing wallet, against a public list on the gateway: OFAC sanctions and known hacks.</dd>
              </div>
              <div>
                <dt>What it reveals</dt>
                <dd>Nothing new. The depositing wallet is public anyway; no outside service is asked.</dd>
              </div>
              <div>
                <dt>What it cannot do</dt>
                <dd>Stop a fresh wallet. It stops the known cases, not every case.</dd>
              </div>
              <div>
                <dt>Never blocked</dt>
                <dd>Refunds, claims and exits. Money already in always gets out.</dd>
              </div>
              <div>
                <dt>Listed by mistake</dt>
                <dd>A removal is announced on chain and takes effect two days later.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="d-sec" id="keys" aria-labelledby="keys-title">
          <div className="w">
            <Head id="keys" label="Your keys" title="Your keys stay with you, not with Eclyps." />
            <div className="k-main">
              <PhraseSlots />
              <dl className="d-terms">
                <div>
                  <dt>Passkey</dt>
                  <dd>
                    Face ID, Touch ID, Windows Hello or a phone. Your keys come from it, so the same synced passkey opens your notes on a new device. Phishing sites can&apos;t use it: it works only on Eclyps. The app asks for it only when an action needs it, like your first Send.
                    <span className="mono d-spec">WebAuthn PRF · HKDF-SHA256</span>
                  </dd>
                </div>
                <div>
                  <dt>Your wallet instead</dt>
                  <dd>
                    An option: your Solana wallet signs one fixed message, and your keys come from that signature, so the same wallet brings your notes back anywhere. Unlike a passkey, the signature is not tied to Eclyps: a site copying Eclyps could ask for the same one and take every note made from that wallet. Sign it only on eclyps.xyz.
                    <span className="mono d-spec">ed25519 signature · HKDF-SHA256</span>
                  </dd>
                </div>
                <div>
                  <dt>24 words</dt>
                  <dd>The same keys as a recovery phrase. Optional with a passkey, under Keys; needed if you lose every device and the account that syncs it.</dd>
                </div>
                <div>
                  <dt>This browser</dt>
                  <dd>
                    Holds an encrypted vault, opened by your passkey (or your wallet, if you chose it), or by a passphrase where passkeys can&apos;t hold keys.
                    <span className="mono d-spec">AES-GCM-256 · PBKDF2-SHA256 600,000×</span>
                  </dd>
                </div>
                <div>
                  <dt>No Eclyps server</dt>
                  <dd>Nobody else keeps a copy, and Eclyps can&apos;t recover anything. Whoever controls your passkey or your words (or the wallet, if you chose it) controls your notes.</dd>
                </div>
                <div>
                  <dt>View-only key</dt>
                  <dd>Lets someone, like an accountant, see your notes. It cannot spend.</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="d-sec" id="fees" aria-labelledby="fees-title">
          <div className="w">
            <Head id="fees" label="Fees" title="What a crossing costs." />
            <div className="f-main">
              <p className="f-big">
                <span>0.5%</span>
                <span className="label">on top of each note</span>
              </p>
              <dl className="d-terms">
                <div>
                  <dt>Eclyps fee</dt>
                  <dd>0.3% to whoever carries the batch, 0.2% to the treasury. Nothing is charged if the batch never crosses.</dd>
                </div>
                <div>
                  <dt>Deposit cap</dt>
                  <dd>A cap limits the total that can enter while the code is young.</dd>
                </div>
                <div>
                  <dt>Per note</dt>
                  <dd>≈ 0.00045 SOL: the Solana fee, plus rent for the 64 bytes each deposit adds.</dd>
                </div>
                <div>
                  <dt>Circle CCTP</dt>
                  <dd>None. Batches use the standard transfer.</dd>
                </div>
                <div>
                  <dt>Paying with SOL</dt>
                  <dd>Swapped to USDC through Jupiter first, at Jupiter’s price, pool fees included.</dd>
                </div>
                <div>
                  <dt>Claim on Aztec</dt>
                  <dd>Paid by Eclyps, from the entry fee. You need no Aztec tokens.</dd>
                </div>
                <div>
                  <dt>Moving out</dt>
                  <dd>No Eclyps fee. The claim pays its chain’s fee; on Solana ≈ 0.002 SOL more if the address has no USDC account yet.</dd>
                </div>
                <div>
                  <dt>Carrying batches</dt>
                  <dd>Paid by whoever closes, sends and registers them, from their 0.3%.</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="d-sec" id="status" aria-labelledby="status-title">
          <div className="w">
            <Head id="status" label="Status" title="Early days, with a cap." />
            <ul className="s-big">
              <li>
                Capped. <span>$5,000 can enter in total for now. Raising it takes 7 days’ public notice.</span>
              </li>
              <li>
                Unaudited. <span>The code has not been audited. A </span><a href="#bounty">bounty</a><span> pays for flaws found.</span>
              </li>
              <li>
                Moving out takes time. <span>It waits for an Aztec proof; to Solana, also for four exits to share a batch. An hour or more.</span>
              </li>
              <li>
                Small crowds. <span>Anonymity is weak while few people use it.</span>
              </li>
            </ul>
            <div className="s-trust">
              <span className="label">Who can move the money</span>
              <dl className="d-terms">
                <div>
                  <dt>In the escrow</dt>
                  <dd>
                    Held by the program until its batch sends, its fee beside it. No one, the team included, has an instruction to withdraw either. A
                    stuck deposit can only go back, with its fee, to the wallet that made it, after about a day.
                  </dd>
                </div>
                <div>
                  <dt>In the portal</dt>
                  <dd>The portal contract can’t be upgraded. Its USDC moves only for an exit Aztec has proven: a batch burned to Solana, or one note paid to its Ethereum address.</dd>
                </div>
                <div>
                  <dt>Upgrades</dt>
                  <dd>
                    One offline key, not a multisig, can still upgrade the Solana program, until that power is renounced.
                    Parameter changes wait behind a timelock. Admin roles expire within two years.
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="d-sec" id="bounty" aria-labelledby="bounty-title">
          <div className="w">
            <Head id="bounty" label="Bounty" title="Up to $5,000 for a flaw." />
            <ul className="s-big">
              <li>
                What counts. <span>A way to take or lock deposits, to mint eUSDC without a deposit, or to tell which deposit became which balance.</span>
              </li>
              <li>
                What it pays. <span>Up to $5,000 in USDC for those; less for smaller bugs.</span>
              </li>
              <li>
                How to report. <span>Privately, on the code’s GitHub page: </span>
                <a href={`https://${CODE}/security/advisories/new`}>Report a vulnerability</a><span>. Nothing public until it is fixed.</span>
              </li>
              <li>
                The rules. <span>Show it on a test network or with your own money. Never touch other people’s funds.</span>
              </li>
            </ul>
          </div>
        </section>

        <section className="d-sec" id="verify" aria-labelledby="verify-title">
          <div className="w">
            <Head id="verify" label="Verify it yourself" title="Addresses anyone can inspect." />
            <Addresses />
            <div className="v-source">
              <span className="label">Source code</span>
              <p><a href={`https://${CODE}`}>{CODE}</a></p>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span className="mark">ECLYPS</span>
        <p>Beta · Nothing here is financial or legal advice</p>
      </footer>
    </div>
  );
}
