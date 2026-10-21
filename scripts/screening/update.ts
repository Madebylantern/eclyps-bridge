/**
 * Screening deposits (ADR 0019): builds the gateway's denylist from local JSON lists and brings the
 * on-chain records in line with it. Nothing is sent without `--send`; nothing is sent on mainnet
 * without `--mainnet` too (the owner approves every mainnet transaction and its rent first).
 *
 *   pnpm exec tsx screening/update.ts fetch-ofac [--xml <SDN_ADVANCED.XML>] [--out screening/lists/ofac-sdn.json]
 *   pnpm exec tsx screening/update.ts plan [--list <file.json> ...] [--offline] [--send]
 *   pnpm exec tsx screening/update.ts status
 *   pnpm exec tsx screening/update.ts init [--send]
 *
 * fetch-ofac  Reads OFAC's SDN list (Advanced XML; free, public domain, updated whenever OFAC acts)
 *             and writes every "Digital Currency Address" that is a Solana address (base58, 32 bytes)
 *             or an Ethereum address (0x + 40 hex) to a list file, with the OFAC record it came from.
 *             Without --xml it downloads the file (about 130 MB) from OFAC's Sanctions List Service
 *             (behind a proxy set NODE_USE_ENV_PROXY=1, or download it with curl -L and pass --xml).
 * plan        Unions the lists (default: every *.json in screening/lists/) and compares their Solana
 *             entries with the records on chain: adds what is missing (block_address, at once),
 *             announces the removal of records no list names any more (propose_unblock, 2 days), and
 *             carries out removals that are due (unblock). Ethereum entries are counted, not sent:
 *             the gateway is on Solana (ADR 0019, follow-ups). --offline skips the chain reads.
 * status      The Screening counters and every record on chain.
 * init        The admin's init_screening (once).
 *
 * List file: { "source": "...", "entries": [{ "chain": "solana" | "ethereum", "address": "...",
 *   "list": "sanctions" | "stolenFunds" | "other", "ref": "public pointer to the source record" }] }.
 * On chain, an entry stores its list and sha256(ref), so anyone can match a record to its source.
 *
 * Keys: SOLANA_KEYPAIR (default ~/.config/eclyps/devnet.json; the guardian or the admin, who pays
 * about 0.0022 SOL of rent per record, refunded on removal). DEPLOYMENT (default
 * deployments/testnet.json).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, address, type Base58EncodedBytes, getBase58Decoder, getBase58Encoder, type Instruction, isAddress } from "@solana/kit";
import {
  BLOCKED_ADDRESS_DISCRIMINATOR,
  BLOCKED_ADDRESS_LEN,
  blockAddressIx,
  decodeBlockedAddress,
  decodeConfig,
  decodeScreening,
  GATEWAY_PROGRAM_ID,
  initScreeningIx,
  isBlockedRecord,
  LIST,
  type ListKind,
  proposeUnblockIx,
  screeningPda,
  UNBLOCK_DELAY_SECS,
  unblockIx,
} from "@eclyps/sdk";

const OFAC_SDN_ADVANCED = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";
const here = dirname(fileURLToPath(import.meta.url));
const LISTS_DIR = resolve(here, "lists");
const repo = new URL("../../", import.meta.url);
const args = process.argv.slice(2);
const log = (s: string) => console.log(s);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

export interface Entry {
  chain: "solana" | "ethereum";
  address: string;
  list: ListKind;
  ref: string;
}
interface ListFile {
  source: string;
  issued?: string;
  fetchedAt?: string;
  entries: Entry[];
}

// ---------- OFAC SDN (Advanced XML) ----------

const isSolana = (a: string) => isAddress(a) && getBase58Encoder().encode(a).length === 32;
const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * The digital currency addresses of an SDN_ADVANCED.XML text that are Solana or Ethereum addresses.
 * OFAC tags each with an asset ("Digital Currency Address - SOL", "- ETH", "- USDC", "- USDT", ...);
 * a USDC or USDT address can be on either chain, so the address format decides, not the tag.
 */
export function parseSdnAdvanced(xml: string): { issued?: string; entries: Entry[]; skipped: number } {
  const assets = new Map<string, string>();
  for (const m of xml.matchAll(/<FeatureType ID="(\d+)"[^>]*>Digital Currency Address - ([^<]+)<\/FeatureType>/g)) assets.set(m[1]!, m[2]!.trim());
  const d = /<DateOfIssue[^>]*>\s*<Year>(\d+)<\/Year>\s*<Month>(\d+)<\/Month>\s*<Day>(\d+)<\/Day>/.exec(xml);
  const issued = d ? `${d[1]}-${d[2]!.padStart(2, "0")}-${d[3]!.padStart(2, "0")}` : undefined;
  const seen = new Set<string>();
  const entries: Entry[] = [];
  let skipped = 0;
  const feature = /<Feature ID="(\d+)" FeatureTypeID="(\d+)">([\s\S]*?)<\/Feature>/g;
  for (const m of xml.matchAll(feature)) {
    const asset = assets.get(m[2]!);
    if (!asset) continue;
    const value = /<VersionDetail[^>]*>([^<]+)<\/VersionDetail>/.exec(m[3]!)?.[1]?.trim();
    if (!value) continue;
    const chain = isSolana(value) ? "solana" : isEvm(value) ? "ethereum" : undefined;
    if (!chain) {
      skipped++;
      continue;
    }
    const addr = chain === "ethereum" ? value.toLowerCase() : value;
    if (seen.has(`${chain}:${addr}`)) continue;
    seen.add(`${chain}:${addr}`);
    entries.push({ chain, address: addr, list: "sanctions", ref: `ofac-sdn:feature:${m[1]}:${asset}` });
  }
  return { issued, entries, skipped };
}

async function fetchOfac() {
  const path = flag("--xml");
  let xml: string;
  if (path) xml = readFileSync(resolve(path), "utf8");
  else {
    log(`downloading ${OFAC_SDN_ADVANCED} (about 130 MB)…`);
    const r = await fetch(OFAC_SDN_ADVANCED);
    if (!r.ok) throw new Error(`OFAC answered ${r.status}; download it with curl -L and pass --xml`);
    xml = await r.text();
  }
  const { issued, entries, skipped } = parseSdnAdvanced(xml);
  const out = resolve(flag("--out") ?? resolve(LISTS_DIR, "ofac-sdn.json"));
  const file: ListFile = { source: OFAC_SDN_ADVANCED, issued, fetchedAt: new Date().toISOString(), entries };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
  const n = (c: Entry["chain"]) => entries.filter((e) => e.chain === c).length;
  log(`OFAC SDN issued ${issued ?? "?"}: ${n("solana")} Solana and ${n("ethereum")} Ethereum addresses (${skipped} other-chain addresses skipped) -> ${out}`);
}

// ---------- lists ----------

const listKinds = Object.keys(LIST) as ListKind[];

function readLists(paths: string[]): Entry[] {
  const files = paths.length > 0 ? paths.map((p) => resolve(p)) : existsSync(LISTS_DIR) ? readdirSync(LISTS_DIR).filter((f) => f.endsWith(".json")).map((f) => resolve(LISTS_DIR, f)) : [];
  const byKey = new Map<string, Entry>();
  for (const f of files) {
    const file = JSON.parse(readFileSync(f, "utf8")) as ListFile;
    for (const e of file.entries) {
      if (!listKinds.includes(e.list)) throw new Error(`${f}: unknown list "${e.list}" for ${e.address}`);
      if (e.chain === "solana" ? !isSolana(e.address) : !isEvm(e.address)) throw new Error(`${f}: not a ${e.chain} address: ${e.address}`);
      if (!e.ref) throw new Error(`${f}: ${e.address} has no ref (a public pointer to why it is listed)`);
      const key = `${e.chain}:${e.chain === "ethereum" ? e.address.toLowerCase() : e.address}`;
      if (!byKey.has(key)) byKey.set(key, e); // the first file that names an address wins
    }
    log(`read ${file.entries.length} entries from ${f}`);
  }
  return [...byKey.values()];
}

export const refHash = (ref: string) => new Uint8Array(createHash("sha256").update(ref).digest());

// ---------- chain ----------

interface Deployment {
  network: string;
  solana: { rpc: string; config: string };
}
const DEPLOYMENT = process.env.DEPLOYMENT ? resolve(process.env.DEPLOYMENT) : fileURLToPath(new URL("deployments/testnet.json", repo));

async function chain() {
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as Deployment;
  // Loaded only when the chain is used, so fetch-ofac and --offline need no RPC.
  const { solanaClient, loadSolanaKeypair } = await import("../../finisher/src/chains.js");
  const client = solanaClient(process.env.SOLANA_RPC_URL ?? dep.solana.rpc, log);
  /** Every screening record on chain (getProgramAccounts on the record's discriminator and size). */
  const records = async () => {
    const out = new Map<Address, ReturnType<typeof decodeBlockedAddress>>();
    const value = await client.rpc
      .getProgramAccounts(GATEWAY_PROGRAM_ID, {
        encoding: "base64",
        filters: [
          { dataSize: BigInt(BLOCKED_ADDRESS_LEN) },
          { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(BLOCKED_ADDRESS_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } },
        ],
      })
      .send();
    for (const { account } of value) {
      const data = new Uint8Array(Buffer.from(account.data[0], "base64"));
      if (isBlockedRecord(data)) {
        const r = decodeBlockedAddress(data);
        out.set(r.address, r);
      }
    }
    return out;
  };
  const signer = async () => {
    const kp = await loadSolanaKeypair(process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/eclyps/devnet.json`);
    const raw = await client.accountData(address(dep.solana.config));
    if (!raw) throw new Error(`no gateway config at ${dep.solana.config}`);
    const cfg = decodeConfig(raw);
    if (kp.address !== cfg.guardian && kp.address !== cfg.admin) throw new Error(`${kp.address} is neither the guardian (${cfg.guardian}) nor the admin (${cfg.admin})`);
    return { kp, cfg };
  };
  const mayWrite = () => {
    if (!args.includes("--send")) return false;
    if (/mainnet/i.test(dep.network) && !args.includes("--mainnet")) throw new Error("mainnet: the owner approves every mainnet transaction and its rent first; then add --mainnet");
    return true;
  };
  return { dep, client, records, signer, mayWrite };
}

async function plan() {
  const entries = readLists(flags("--list"));
  const sol = entries.filter((e) => e.chain === "solana");
  log(`${sol.length} Solana and ${entries.length - sol.length} Ethereum entries in the lists (Ethereum entries are not sent: ADR 0019)`);
  if (args.includes("--offline")) {
    for (const e of sol) log(`  would add ${e.address} (${e.list}, ${e.ref})`);
    return log(`offline: ${sol.length} additions if nothing is on chain yet; removals need the chain`);
  }
  const c = await chain();
  if (!(await c.client.accountData(await screeningPda()))) return log("no Screening account on this gateway yet (run: init)");
  const onChain = await c.records();
  const listed = new Set(sol.map((e) => e.address));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const adds = sol.filter((e) => !onChain.has(address(e.address)));
  // Records no list names any more: announce their removal, then carry it out once due.
  const stale = [...onChain].filter(([a]) => !listed.has(a));
  const announce = stale.filter(([, r]) => r.unblockEta === 0n);
  const due = stale.filter(([, r]) => r.unblockEta !== 0n && r.unblockEta <= now);
  const waiting = stale.filter(([, r]) => r.unblockEta > now);
  // A record whose removal was announced but which a list names again: keep it (cancel_unblock).
  const relisted = sol.filter((e) => (onChain.get(address(e.address))?.unblockEta ?? 0n) !== 0n);
  log(`plan: add ${adds.length} · announce removal of ${announce.length} (${UNBLOCK_DELAY_SECS / 86_400} days) · remove ${due.length} now · ${waiting.length} removals waiting · ${relisted.length} announced but listed again (cancel by hand)`);
  for (const e of adds) log(`  add ${e.address} (${e.list}, ${e.ref})`);
  for (const [a] of announce) log(`  announce removal of ${a}`);
  for (const [a] of due) log(`  remove ${a}`);
  for (const e of relisted) log(`  listed again while its removal is announced: ${e.address}`);
  if (adds.length > 0) log(`rent: about ${(adds.length * 0.0022).toFixed(4)} SOL, refunded when the records are removed`);
  if (!c.mayWrite()) return log("dry run: add --send to send it");
  const { kp } = await c.signer();
  const ixs: Instruction[] = [];
  for (const e of adds) ixs.push(await blockAddressIx({ signer: kp.address, address: address(e.address), list: LIST[e.list], reference: refHash(e.ref) }));
  for (const [a] of announce) ixs.push(await proposeUnblockIx(kp.address, a));
  for (const [a, r] of due) ixs.push(await unblockIx(a, r.rentPayer));
  // Eight per transaction keeps each well under the size and compute limits.
  for (let i = 0; i < ixs.length; i += 8) log(`sent ${await c.client.send(ixs.slice(i, i + 8), [kp.keyPair], kp.address)}`);
}

async function status() {
  const c = await chain();
  const raw = await c.client.accountData(await screeningPda());
  if (!raw) return log("no Screening account on this gateway yet (run: init)");
  const s = decodeScreening(raw);
  log(`screening: ${s.blocked} addresses blocked now · ${s.added} added · ${s.removed} removed`);
  for (const [a, r] of await c.records()) log(`  ${a} · ${listKinds[r.list] ?? r.list} · since ${new Date(Number(r.addedAt) * 1000).toISOString()}${r.unblockEta ? ` · removal from ${new Date(Number(r.unblockEta) * 1000).toISOString()}` : ""}`);
}

async function init() {
  const c = await chain();
  if (await c.client.accountData(await screeningPda())) return log("Screening already exists");
  const { kp, cfg } = await c.signer();
  if (kp.address !== cfg.admin) throw new Error(`init_screening is the admin's (${cfg.admin})`);
  log(`init_screening creates ${await screeningPda()} (rent about 0.0015 SOL)`);
  if (!c.mayWrite()) return log("dry run: add --send to send it");
  log(`init_screening: ${await c.client.send([await initScreeningIx(kp.address)], [kp.keyPair], kp.address)}`);
}

const cmd = args[0];
if (cmd === "fetch-ofac") await fetchOfac();
else if (cmd === "plan") await plan();
else if (cmd === "status") await status();
else if (cmd === "init") await init();
else log("usage: update.ts fetch-ofac [--xml f] [--out f] | plan [--list f ...] [--offline] [--send] [--mainnet] | status | init [--send]");
