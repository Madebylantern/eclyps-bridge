/**
 * Aztec side of the app, behind one interface for two kinds of wallet:
 *
 * - **Embedded PXE** (default): the private execution environment runs in this page as WASM via
 *   the official EmbeddedWallet, so claims never touch a team server (SPEC §4.3). The recipient is
 *   a fresh Schnorr account derived from the vault seed; it never appears on Solana or Ethereum.
 * - **Extension wallet** (Aztec Wallet SDK): discovered over the extension channel, connected with
 *   an ECDH secure channel the user verifies by comparing emojis. The PXE and keys stay in the
 *   wallet; the recipient is the wallet's account.
 *
 * Fees (ADR 0018, the deployment's `fees`): on the local stack Aztec's prefunded test account 0
 * sends the claim (public). Elsewhere the recipient sends its own claims and exits, so no other
 * account is linked to it, and the fee is paid by:
 * - `sponsoredFpc` (testnet, the default): the network's SponsoredFPC;
 * - `eclypsFpc` (mainnet): the Eclyps FPC, from a sponsor slot of one of the user's deposited notes
 *   (the note being claimed, or the note being moved out), with capped gas;
 * - `feeJuice`: the account itself, from its own Fee Juice.
 */
import { isSpentSlotError, resolveFees, slotsToTry, SPONSORED_GAS, type UserFeeMode } from "@eclyps/sdk";
import type { Deployment } from "./deployment";
import { isBrokenStoreError, withRetry } from "./retry";

const enc = new TextEncoder();

async function seedScalar(seed: Uint8Array, label: string): Promise<Buffer> {
  const { Buffer } = await import("buffer");
  const material = new Uint8Array([...seed, ...enc.encode(`eclyps/aztec/${label}`)]);
  return Buffer.from(new Uint8Array(await crypto.subtle.digest("SHA-256", material)));
}

export interface ClaimArgs {
  denomination: string;
  root: bigint;
  nullifierKey: bigint;
  secret: bigint;
  leafIndex: number;
  path: bigint[];
}

/** Claim progress as the user sees it. "preparing" is the app's own work before the wallet starts. */
export type ClaimStage = "preparing" | "proving" | "sending" | "waiting";

/** A deposited note that pays the Aztec fee of a transaction through the Eclyps FPC (ADR 0018). */
export interface SponsorNote {
  denomination: string;
  root: bigint;
  nullifierKey: bigint;
  secret: bigint;
  leafIndex: number;
  path: bigint[];
}

/** One exit: burn one `denomination` note from the private balance, committed to a destination. */
export interface ExitArgs {
  to: "solana" | "ethereum";
  denomination: string;
  commitment: bigint;
  /** The note that pays the fee when the Eclyps FPC pays (mainnet); unused otherwise. */
  sponsor?: SponsorNote;
}

/** A claim contract's exit epochs (ADR 0009), read through the wallet. */
export interface ExitReads {
  /** The open exit epoch: its id and how many exits it holds. */
  openExitEpoch(denomination: string): Promise<{ id: bigint; count: number }>;
  /** The commitments of an exit epoch, in order (public). */
  exitLeaves(denomination: string, id: bigint): Promise<bigint[]>;
}

export interface AztecSession {
  kind: "embedded" | "extension";
  label: string;
  recipient: string;
  feePayer: string;
  /** Proves and sends the claim, reporting each stage; resolves with the transaction hash once included. */
  claim(args: ClaimArgs, onStage?: (s: ClaimStage) => void): Promise<string>;
  isRegistered(denomination: string, root: bigint): Promise<boolean>;
  privateBalance(): Promise<bigint>;
  /**
   * Burns one note through the claim contract (`exit` or `exit_to_ethereum`) under an authwit for
   * `Token.burn_private`, sent by the account itself; resolves with the transaction hash once mined.
   */
  exit(args: ExitArgs, onStage?: (s: ClaimStage) => void): Promise<string>;
  reads: ExitReads;
  /** Master incoming viewing secret key of the recipient (embedded only): sees notes, cannot spend. */
  incomingViewingKey?: string;
  disconnect?(): Promise<void>;
}

async function contracts() {
  const [{ AztecAddress }, { Fr }, { NO_WAIT }, { waitForTx }, claim, minter, token] = await Promise.all([
    import("@aztec-labs/aztec.js/addresses"),
    import("@aztec-labs/aztec.js/fields"),
    import("@aztec-labs/aztec.js/contracts"),
    import("@aztec-labs/aztec.js/node"),
    import("@eclyps/aztec-contracts/artifacts/EclypsClaim"),
    import("@eclyps/aztec-contracts/artifacts/EclypsMinter"),
    import("@eclyps/aztec-contracts/artifacts/Token"),
  ]);
  return { AztecAddress, Fr, NO_WAIT, waitForTx, ...claim, ...minter, ...token };
}

/** Claims can wait up to 30 min for inclusion on testnet. */
const CLAIM_WAIT = { timeout: 1_800, interval: 3 };

async function sponsoredFee(register: Register) {
  const [{ SponsoredFeePaymentMethod }, { SponsoredFPCContract }, { getContractInstanceFromInstantiationParams }, { Fr }] = await Promise.all([
    import("@aztec-labs/aztec.js/fee"),
    import("@aztec-labs/noir-contracts.js/SponsoredFPC"),
    import("@aztec-labs/aztec.js/contracts"),
    import("@aztec-labs/aztec.js/fields"),
  ]);
  const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await register(fpc as never, SponsoredFPCContract.artifact as never);
  return { fee: { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) }, address: fpc.address.toString() };
}

/** Fee options for one `send`; undefined lets the sending account pay from its own Fee Juice. */
type Fee = { paymentMethod: unknown; gasSettings?: unknown } | undefined;

/** How this session's claims and exits pay (ADR 0018). */
interface UserFees {
  mode: UserFeeMode;
  /** Who the user is told pays. */
  label: string;
  /** The fee of a transaction paid with sponsor slot `slot` of `note` (eclypsFpc), or the plain fee. */
  feeFor(note: SponsorNote | undefined, slot: number): Promise<Fee>;
  /** Slots a note of this denomination has (eclypsFpc). */
  allowance(denomination: string): number;
}

type Register = (instance: never, artifact: never) => Promise<unknown>;

async function userFees(dep: Deployment, wallet: unknown, register: Register, getContract: (addr: string) => Promise<unknown>): Promise<UserFees> {
  const fees = resolveFees(dep);
  if (fees.user === "feeJuice") return { mode: "feeJuice", label: "your account (Fee Juice)", feeFor: async () => undefined, allowance: () => 0 };
  if (fees.user === "sponsoredFpc") {
    const s = await sponsoredFee(register);
    return { mode: "sponsoredFpc", label: `SponsoredFPC ${s.address.slice(0, 10)}…`, feeFor: async () => s.fee, allowance: () => 0 };
  }
  const x = fees.eclypsFpc!;
  const [{ EclypsFPCContract, EclypsFPCContractArtifact }, { AztecAddress }, { Fr }, { ExecutionPayload }, { Gas, GasFees }] = await Promise.all([
    import("@eclyps/aztec-contracts/artifacts/EclypsFPC"),
    import("@aztec-labs/aztec.js/addresses"),
    import("@aztec-labs/aztec.js/fields"),
    import("@aztec-labs/aztec.js/tx"),
    import("@aztec-labs/stdlib/gas"),
  ]);
  const fpc = AztecAddress.fromStringUnsafe(x.address);
  const instance = await getContract(x.address);
  if (!instance) throw new Error(`Eclyps FPC ${x.address} not found on the Aztec node`);
  await register(instance as never, EclypsFPCContractArtifact as never);
  // Within the FPC's caps: no teardown, no priority fee. The wallet sets the max fee per gas.
  const gasSettings = { gasLimits: new Gas(SPONSORED_GAS.daGas, SPONSORED_GAS.l2Gas), teardownGasLimits: Gas.empty(), maxPriorityFeesPerGas: GasFees.empty() };
  return {
    mode: "eclypsFpc",
    label: "Eclyps",
    allowance: (d) => x.slots[d] ?? 0,
    async feeFor(note, slot) {
      if (!note) throw new Error("No deposited note to pay this transaction's Aztec fee.");
      const claim = dep.aztec.claims[note.denomination];
      if (!claim) throw new Error(`No claim contract for ${note.denomination}`);
      // Only `getFunctionCall` is used: the FPC's call goes first in the transaction, as its payment.
      const call = await EclypsFPCContract.at(fpc, wallet as never)
        .methods.sponsor(AztecAddress.fromStringUnsafe(claim), new Fr(note.root), new Fr(note.nullifierKey), new Fr(note.secret), new Fr(note.leafIndex), note.path.map((p) => new Fr(p)), slot)
        .getFunctionCall();
      const paymentMethod = {
        getAsset: async () => fpc,
        getFeePayer: async () => fpc,
        getGasSettings: () => undefined,
        getExecutionPayload: async () => new ExecutionPayload([call], [], [], [], fpc),
      };
      return { paymentMethod, gasSettings };
    },
  };
}

/**
 * Sends with this session's fee. Through the Eclyps FPC, tries the note's sponsor slots from
 * `first` (a claim starts at 0, an exit at 1) while the network says a slot is spent.
 */
async function withFee<T>(fees: UserFees, first: number, note: SponsorNote | undefined, send: (fee: Fee) => Promise<T>): Promise<T> {
  if (fees.mode !== "eclypsFpc") return send(await fees.feeFor(undefined, 0));
  if (!note) throw new Error("No deposited note to pay this transaction's Aztec fee.");
  let last: unknown;
  for (const slot of slotsToTry(first, fees.allowance(note.denomination))) {
    try {
      return await send(await fees.feeFor(note, slot));
    } catch (e) {
      if (!isSpentSlotError(e)) throw e;
      last = e;
    }
  }
  throw new Error("This note has paid for all the Aztec fees it can.", { cause: last });
}

type Contracts = Awaited<ReturnType<typeof contracts>>;

/**
 * The exit call and the exit reads for any wallet: the authwit lets the claim contract burn one
 * note of `from`'s, and the account sends the transaction itself (its fee paid as `fees` says; the
 * Eclyps FPC takes it from a sponsor slot of `sponsor`, the note being moved out).
 * `sendExit` ends once the node holds the transaction; the caller waits for it to be mined.
 */
function exitOps(c: Contracts, wallet: Parameters<Contracts["TokenContract"]["at"]>[1], from: InstanceType<Contracts["AztecAddress"]>, claimFor: (d: string) => ReturnType<Contracts["EclypsClaimContract"]["at"]>, token: ReturnType<Contracts["TokenContract"]["at"]>, fees: () => Promise<UserFees>) {
  const { Fr, NO_WAIT } = c;
  return {
    async sendExit({ to, denomination, commitment, sponsor }: ExitArgs) {
      const claim = claimFor(denomination);
      return withFee(await fees(), 1, sponsor, async (fee) => {
        const nonce = Fr.random();
        const call = await token.methods.burn_private(from, BigInt(denomination), nonce).getFunctionCall();
        const witness = await (wallet as unknown as { createAuthWit(from: unknown, intent: unknown): Promise<never> }).createAuthWit(from, { caller: claim.address, call });
        const method = to === "solana" ? claim.methods.exit : claim.methods.exit_to_ethereum;
        const { txHash } = await method(new Fr(commitment), nonce)
          .with({ authWitnesses: [witness] })
          .send({ from, fee: fee as never, wait: NO_WAIT });
        return txHash;
      });
    },
    reads: {
      async openExitEpoch(denomination: string) {
        const { result } = await claimFor(denomination).methods.get_exit_epoch().simulate({ from });
        return { id: BigInt(result.id), count: Number(result.count) };
      },
      async exitLeaves(denomination: string, id: bigint) {
        const { result } = await claimFor(denomination).methods.get_exit_leaves(id).simulate({ from });
        return (result.storage as bigint[]).slice(0, Number(result.len)).map(BigInt);
      },
    } satisfies ExitReads,
  };
}

/** A wallet this page closed: the next one waits for it to let go of its store (at most 5 s). */
let stopping: Promise<unknown> = Promise.resolve();
const stopWallet = (w: { stop(): Promise<void> }) =>
  (stopping = Promise.race([w.stop().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]));

/** Embedded PXE in this page. */
export async function openEmbedded(dep: Deployment, seed: Uint8Array, onStatus: (s: string) => void): Promise<AztecSession> {
  onStatus("Loading Aztec libraries…");
  const [{ createAztecNodeClient }, { EmbeddedWallet }, { GrumpkinScalar }, { deriveKeys }, c] = await Promise.all([
    import("@aztec-labs/aztec.js/node"),
    import("@aztec-labs/wallets/embedded"),
    import("@aztec-labs/aztec.js/fields"),
    import("@aztec-labs/aztec.js/keys"),
    contracts(),
  ]);
  const { AztecAddress, Fr, NO_WAIT, waitForTx, EclypsClaimContract, EclypsClaimContractArtifact, EclypsMinterContractArtifact, TokenContract, TokenContractArtifact } = c;
  await stopping;

  // Public testnet nodes (drpc's free tier) refuse JSON-RPC batches of more than 3 requests.
  const node = createAztecNodeClient(dep.aztec.node, { maxBatchSize: 3 });
  // The wallet proves, then hands the proven transaction to the node: wrapping sendTx shows the
  // user when proving is over. The client is a plain object of closures, so this is safe.
  let onSending: (() => void) | undefined;
  const nodeSendTx = node.sendTx;
  node.sendTx = (...args) => {
    onSending?.();
    return nodeSendTx(...args);
  };
  const secret = Fr.fromBufferReduce(await seedScalar(seed, "secret"));
  const keys = await deriveKeys(secret);

  /** The wallet and everything bound to it; made again if its store breaks. */
  const build = async (status: (s: string) => void) => {
    status("Starting the in-browser PXE…");
    const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: dep.network !== "local" } });
    try {
      status("Registering contracts…");
      const register = async (addr: string, artifact: Parameters<typeof wallet.registerContract>[1]) => {
        const instance = await node.getContract(AztecAddress.fromStringUnsafe(addr));
        if (!instance) throw new Error(`contract ${addr} not found on the Aztec node`);
        await wallet.registerContract(instance, artifact);
      };
      await register(dep.aztec.token, TokenContractArtifact);
      // A claim mints through the minter (ADR 0020), so the wallet runs its private function too.
      if (dep.aztec.minter) await register(dep.aztec.minter, EclypsMinterContractArtifact);
      for (const a of Object.values(dep.aztec.claims)) await register(a, EclypsClaimContractArtifact);

      status("Deriving your recipient account…");
      const recipient = await wallet.createSchnorrInitializerlessAccount(
        secret,
        Fr.fromBufferReduce(await seedScalar(seed, "salt")),
        GrumpkinScalar.fromBufferReduce(await seedScalar(seed, "signing")),
      );

      let sender = recipient.address;
      let feePayer: string;
      // Fees as the deployment says (ADR 0018); built once, when first needed.
      let feesOnce: Promise<UserFees> | undefined;
      const fees = () => (feesOnce ??= userFees(dep, wallet, (i, a) => wallet.registerContract(i, a), (a) => node.getContract(AztecAddress.fromStringUnsafe(a))));
      // Claims: undefined while the local test account sends them (it pays from its Fee Juice).
      let claimFees: UserFees | undefined;
      if (dep.network === "local") {
        const { getInitialTestAccountsData } = await import("@aztec-labs/accounts/testing");
        const [acc0] = await getInitialTestAccountsData();
        sender = (await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey)).address;
        feePayer = `test account ${sender.toString().slice(0, 10)}…`;
      } else {
        claimFees = await fees();
        feePayer = claimFees.label;
      }
      const token = TokenContract.at(AztecAddress.fromStringUnsafe(dep.aztec.token), wallet);
      const claimFor = (d: string) => EclypsClaimContract.at(AztecAddress.fromStringUnsafe(dep.aztec.claims[d]!), wallet);
      // Exits are sent by the account itself (the burn is its own), paid as the deployment says:
      // the network's SponsoredFPC by default, on the local network too (it is prefunded there).
      const ops = exitOps(c, wallet as never, recipient.address, claimFor, token, fees);
      // After a reorg or behind a lagging node, a sync moves the PXE's anchor to a block the node has.
      const resync = async () => {
        await (wallet as unknown as { pxe?: { sync?(): Promise<void> } }).pxe?.sync?.().catch(() => undefined);
      };
      return { wallet, recipient: recipient.address, sender, claimFees, feePayer, token, claimFor, ops, resync };
    } catch (e) {
      await stopWallet(wallet);
      throw e;
    }
  };
  type Core = Awaited<ReturnType<typeof build>>;

  let core: Core = await build(onStatus);
  let closed = false;
  let reopening: Promise<Core> | undefined;
  // The store under the in-page PXE can break (seen on testnet after a failed claim: "SQLITE_ERROR:
  // no such table: data"). The wallet is then closed and made again, without a reload: the
  // recipient comes from the seed, and the PXE syncs its notes from the chain.
  const reopen = (bad: Core) =>
    (reopening ??= (async () => {
      await stopWallet(bad.wallet);
      return withRetry(() => build(() => undefined), { attempts: 3, baseMs: 1_000, retryable: () => !closed });
    })()
      .then((k) => {
        core = k;
        return k;
      })
      .finally(() => {
        reopening = undefined;
      }));
  /** Runs `op` on the live wallet; if its store broke, reopens the wallet and runs `op` once more. */
  const use = async <T,>(op: (k: Core) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("The Aztec wallet is closed.");
    const k = reopening ? await reopening : core;
    try {
      return await op(k);
    } catch (e) {
      if (closed || !isBrokenStoreError(e)) throw e;
      return op(core === k ? await reopen(k) : core);
    }
  };
  /**
   * Simulates, proves and sends; while the node no longer has the block the transaction was made
   * against (a reorg, a lagging node), resyncs and makes it again. Resolves once the node has it.
   */
  const sendSafely = <T,>(send: (k: Core) => Promise<T>, again?: () => void) =>
    use((k) =>
      withRetry(() => send(k), {
        onRetry: async () => {
          again?.();
          await k.resync();
        },
      }),
    );
  onStatus("Ready");

  return {
    kind: "embedded",
    label: "Embedded PXE (this page)",
    recipient: core.recipient.toString(),
    feePayer: core.feePayer,
    incomingViewingKey: keys.masterIncomingViewingSecretKey.toString(),
    async claim({ denomination, root, nullifierKey, secret: s, leafIndex, path }, onStage) {
      onStage?.("proving");
      onSending = () => onStage?.("sending");
      try {
        const note: SponsorNote = { denomination, root, nullifierKey, secret: s, leafIndex, path };
        const txHash = await sendSafely(async (k) => {
          const send = async (fee: Fee) =>
            (
              await k
                .claimFor(denomination)
                .methods.claim(new Fr(root), new Fr(nullifierKey), new Fr(s), new Fr(leafIndex), path.map((x) => new Fr(x)), k.recipient)
                .send({ from: k.sender, fee: fee as never, wait: NO_WAIT })
            ).txHash;
          // The note being claimed pays its own claim through the Eclyps FPC (slot 0 first).
          return k.claimFees ? withFee(k.claimFees, 0, note, send) : send(undefined);
        }, () => onStage?.("proving"));
        onStage?.("waiting");
        await waitForTx(node, txHash, CLAIM_WAIT);
        return txHash.toString();
      } finally {
        onSending = undefined;
      }
    },
    isRegistered: (denomination, root) =>
      use(async (k) => Boolean((await k.claimFor(denomination).methods.is_registered(new Fr(root)).simulate({ from: k.sender })).result)),
    privateBalance: () => use(async (k) => BigInt((await k.token.methods.balance_of_private(k.recipient).simulate({ from: k.recipient })).result)),
    async exit(args, onStage) {
      onStage?.("proving");
      onSending = () => onStage?.("sending");
      try {
        const txHash = await sendSafely((k) => k.ops.sendExit(args), () => onStage?.("proving"));
        onStage?.("waiting");
        await waitForTx(node, txHash, CLAIM_WAIT);
        return txHash.toString();
      } finally {
        onSending = undefined;
      }
    },
    reads: {
      openExitEpoch: (d) => use((k) => withRetry(() => k.ops.reads.openExitEpoch(d), { attempts: 2, onRetry: k.resync })),
      exitLeaves: (d, id) => use((k) => withRetry(() => k.ops.reads.exitLeaves(d, id), { attempts: 2, onRetry: k.resync })),
    },
    // Stops the in-page PXE, which holds the recipient's keys (on lock or disconnect).
    async disconnect() {
      closed = true;
      await reopening?.catch(() => undefined);
      await stopWallet(core.wallet);
    },
  };
}

export interface ExtensionCandidate {
  id: string;
  name: string;
  icon?: string;
  /** Opens the secure channel; the user must compare `emojis` with the wallet before `confirm`. */
  connect(): Promise<{ emojis: string; confirm(): Promise<AztecSession>; cancel(): void }>;
}

/** Discovers Aztec wallet extensions (Aztec Wallet SDK) for this network. */
export async function discoverExtensions(dep: Deployment, onFound: (c: ExtensionCandidate) => void, timeoutMs = 6_000): Promise<void> {
  const [{ WalletManager }, { hashToEmoji }, { createAztecNodeClient }, c] = await Promise.all([
    import("@aztec-labs/wallet-sdk/manager"),
    import("@aztec-labs/wallet-sdk/crypto"),
    import("@aztec-labs/aztec.js/node"),
    contracts(),
  ]);
  const { AztecAddress, Fr, NO_WAIT, waitForTx, EclypsClaimContract, EclypsClaimContractArtifact, EclypsMinterContractArtifact, TokenContract, TokenContractArtifact } = c;
  const node = createAztecNodeClient(dep.aztec.node, { maxBatchSize: 3 });
  const info = await node.getNodeInfo();
  const chainInfo = { chainId: new Fr(BigInt(info.l1ChainId)), version: new Fr(BigInt(info.rollupVersion)) };
  const session = WalletManager.configure({ extensions: { enabled: true } }).getAvailableWallets({
    chainInfo,
    appId: "eclyps",
    timeout: timeoutMs,
    onWalletDiscovered: (provider) =>
      onFound({
        id: provider.id,
        name: provider.name,
        icon: provider.icon,
        async connect() {
          const pending = await provider.establishSecureChannel("eclyps");
          return {
            emojis: hashToEmoji(pending.verificationHash),
            cancel: () => pending.cancel(),
            async confirm() {
              const wallet = await pending.confirm();
              const [account] = await wallet.getAccounts();
              if (!account) throw new Error(`${provider.name}: no account`);
              const me = account.item;
              const register = async (addr: string, artifact: Parameters<typeof wallet.registerContract>[1]) => {
                const instance = await node.getContract(AztecAddress.fromStringUnsafe(addr));
                if (instance) await wallet.registerContract(instance, artifact);
              };
              await register(dep.aztec.token, TokenContractArtifact);
              if (dep.aztec.minter) await register(dep.aztec.minter, EclypsMinterContractArtifact);
              for (const a of Object.values(dep.aztec.claims)) await register(a, EclypsClaimContractArtifact);
              // ADR 0018. On the local network the extension's account pays its claims itself.
              const fees = await userFees(dep, wallet, (i, a) => wallet.registerContract(i, a), (a) => node.getContract(AztecAddress.fromStringUnsafe(a)));
              const claimFees = dep.network === "local" ? undefined : fees;
              const token = TokenContract.at(AztecAddress.fromStringUnsafe(dep.aztec.token), wallet);
              const claimFor = (d: string) => EclypsClaimContract.at(AztecAddress.fromStringUnsafe(dep.aztec.claims[d]!), wallet);
              const ops = exitOps(c, wallet as never, me, claimFor, token, async () => fees);
              return {
                kind: "extension" as const,
                label: provider.name,
                recipient: me.toString(),
                feePayer: !claimFees ? provider.name : claimFees.mode === "sponsoredFpc" ? "SponsoredFPC" : claimFees.label,
                // The extension proves and sends in one step; the app sees "proving" until it returns.
                async claim({ denomination, root, nullifierKey, secret, leafIndex, path }: ClaimArgs, onStage?: (s: ClaimStage) => void) {
                  onStage?.("proving");
                  const send = (fee: Fee) =>
                    claimFor(denomination)
                      .methods.claim(new Fr(root), new Fr(nullifierKey), new Fr(secret), new Fr(leafIndex), path.map((x) => new Fr(x)), me)
                      .send({ from: me, fee: fee as never, wait: NO_WAIT });
                  const note: SponsorNote = { denomination, root, nullifierKey, secret, leafIndex, path };
                  // The extension syncs its own PXE on each send: after a reorg, another try is enough.
                  const { txHash } = await withRetry(() => (claimFees ? withFee(claimFees, 0, note, send) : send(undefined)));
                  onStage?.("waiting");
                  await waitForTx(node, txHash, CLAIM_WAIT);
                  return txHash.toString();
                },
                async isRegistered(denomination: string, root: bigint) {
                  const { result } = await claimFor(denomination).methods.is_registered(new Fr(root)).simulate({ from: me });
                  return Boolean(result);
                },
                async privateBalance() {
                  const { result } = await token.methods.balance_of_private(me).simulate({ from: me });
                  return BigInt(result);
                },
                async exit(args: ExitArgs, onStage?: (s: ClaimStage) => void) {
                  onStage?.("proving");
                  const txHash = await withRetry(() => ops.sendExit(args));
                  onStage?.("waiting");
                  await waitForTx(node, txHash, CLAIM_WAIT);
                  return txHash.toString();
                },
                reads: ops.reads,
                disconnect: () => provider.disconnect(),
              };
            },
          };
        },
      }),
  });
  await session.done;
}
