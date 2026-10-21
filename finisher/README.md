# finisher — permissionless batch finisher (SPEC §5.2)

A finisher holds no user data and only decides *when* to act. Anyone can run one; several can run
at once (each step is checked on chain first). Per pass it:
1. **Solana:**
   - calls `close_epoch` on epochs that have ended or are full. On testnet, an ended epoch below the
     batch minimum (but not empty) is rolled over once per end, so its deposits become refundable;
   - calls `send_batch` on closed epochs (a CCTP V2 burn carrying the batch hook). It pays this
     finisher its share of the batch's fees (0.3 % by default, ADR 0012) into its own USDC
     account, which it creates if missing.
   - once the gateway has its V2 lanes (ADR 0015), calls `send_express_batch` on every express
     epoch (a Cross now note, closed when made); it pays this finisher its share of the note's fee
     plus the express fee. From there an express batch is relayed and registered like any batch
     (its epoch id carries the top bit; the logs name it `$100 express #0`).
2. **Ethereum:** gets Circle's attested message (Iris) and calls `EclypsPortal.relay`. On the local
   stack, Iris is substituted.
3. **Aztec:** calls `EclypsClaim.register_batch` once the L1→L2 message can be consumed.
4. **Exits** (ADR 0009, `src/exits.ts`), when the deployment has `features.exit`:
   - `close_exit_epoch` on Aztec for an exit epoch with at least the minimum of exits (4) that has
     ended or is full. On testnet the close is timed with the Aztec clock read from the rollup
     (ADR 0017 item 1): sent at once while at least two Aztec slots are left in the Aztec epoch;
     otherwise held, and sent in the last slots before the margin of the next Aztec epoch, so the
     exits and the close are proven together (never a close just after a boundary);
   - `EclypsPortal.exitBatch` once the Aztec epoch holding the close is proven (the Outbox witness
     from the Aztec node), skipped when the portal says `exited`;
   - Circle's attestation of that transaction (Iris; substituted on the local stack by
     `src/local-iris.ts`), then `receive_exit` on Solana as a v0 transaction with the address
     lookup table (`solana.exitLookupTable`, or one the finisher creates once, about 0.0053 SOL).
     The finisher pays about 0.003 SOL of rent per exit batch; exits pay no fee.

   Each user then claims their own exit from the app.

The deployment's `network` picks the mode: `src/local.ts` (local stack) or `src/testnet.ts`
(testnet and mainnet; `src/network.ts` resolves the chain, Iris, CCTP domains, endpoints, fee mode
and gas cap from the deployment and the environment).

```
# local stack: scripts/e2e/start-local-stack.sh && (cd scripts && pnpm exec tsx e2e/deploy-local.ts)
DEPLOYMENT=../scripts/e2e/.local/deployment.json pnpm exec tsx src/main.ts   # Node >= 24.12; --once for one round
```

`pnpm --filter @eclyps/finisher test` runs the unit tests of the scheduling rules (`src/plan.ts`,
batches and exits) and of the local Iris.

## Run a finisher on testnet

Solana devnet → Sepolia → Aztec testnet, on your own computer. Leave it running, for example around
the weekly Totality window: it carries every closed batch across, and earns the finisher share (test
USDC) of each batch it sends.

**You need**
- Node ≥ 24.12 and pnpm 10, a clone of this repo, and `pnpm install` at its root. The Aztec contract
  bindings are committed (`aztec/artifacts`), so no Aztec, Solana or Foundry toolchain is needed.
- Two key files, outside the repo:
  - `~/.config/eclyps/devnet.json`: a Solana keypair (`solana-keygen new -o …`, or any 64-byte JSON key);
  - `~/.config/eclyps/sepolia.key`: one 0x-prefixed Ethereum private key.
- A little test money on those keys: about 0.1 devnet SOL (faucet.solana.com) and 0.01 Sepolia ETH.
  Each batch sent costs about 0.005 SOL; each relay costs Sepolia gas. Aztec fees are paid by the
  testnet's SponsoredFPC.

**Run**

```
pnpm --filter @eclyps/finisher testnet
```

It prints its addresses, its SOL, ETH and USDC balances (with a warning under 0.05 SOL or
0.005 ETH) and what it has earned so far. Then one line per action: `close_epoch`, `send_batch`
(with the amount earned), `iris`, `relay`, `register_batch`, `carried across`. Errors are one line
and retried later; `DEBUG=1` prints stack traces.

**Stop and resume.** Ctrl-C stops after the current step. Run the same command to resume. Progress
is saved after every step in `~/.config/eclyps/testnet/finisher-state.json`, and the chains are
checked before each action, so nothing is sent, relayed or registered twice. Next to that file:
the finisher's Aztec account keys (`finisher-aztec.json`, private, made at the first start) and its
wallet database (`finisher-pxe/`).

Options: `--once` (one pass), `FINISHER_INTERVAL` (seconds between passes, default 60),
`FINISHER_SOLANA_KEYPAIR`, `FINISHER_SEPOLIA_KEY`, `FINISHER_STATE`, `DEPLOYMENT` (default
`deployments/testnet.json`), and `SOLANA_RPC_URL`, `SEPOLIA_RPC_URL`, `AZTEC_NODE_URL`, `IRIS_URL`
for other endpoints. Behind an HTTP proxy, also set `NODE_USE_ENV_PROXY=1`.

To try it without funds: `scripts/testnet/rehearse.sh finisher` (see `scripts/testnet/README.md`).

## Mainnet

The same code. It refuses to start unless it is asked for mainnet (`pnpm --filter @eclyps/finisher
mainnet`, or `NETWORK=mainnet`), `DEPLOYMENT` points at a mainnet deployment (not the template),
and `ECLYPS_MAINNET_OK=1` is set. Ask the owner first: it spends real funds.

```
ECLYPS_MAINNET_OK=1 DEPLOYMENT=../deployments/mainnet.json pnpm --filter @eclyps/finisher mainnet
```

- Ethereum chain from `l1.chainId`; Iris and CCTP domains from the deployment's `cctp` (default
  `https://iris-api.circle.com`, Ethereum 0, Solana 5; the sandbox is refused).
- Aztec fees from `fees.operator` (`feeJuice`): its Fee Juice is logged every
  `FINISHER_FEE_JUICE_CHECK` minutes (30), with the refill to bridge when it is low (ADR 0018).
- Gas guard: relays and `exitBatch` wait while L1 gas is above `FINISHER_MAX_GWEI` (20 on mainnet).
- Its own files: `~/.config/eclyps/mainnet/` (`solana.json`, `ethereum.key`,
  `finisher-state.json`), or `FINISHER_SOLANA_KEY`, `FINISHER_ETHEREUM_PRIVATE_KEY`,
  `ECLYPS_DATA_DIR`. Endpoints: `SOLANA_RPC_URL`, `ETHEREUM_RPC_URL`, `AZTEC_NODE_URL`.

Hosted: [RAILWAY.md](RAILWAY.md), section 6.

## Reference keeper: fast exits from the liquidity pool (ADR 0017)

`src/keeper.ts` fronts exits to Solana from the gateway's liquidity pool, on testnet only. It must
run with the pool's keeper key (`lanes.params.keeper`, set at `init_lanes` or through the 7-day
timelock); any other key is refused by the gateway.

```
pnpm --filter @eclyps/finisher keeper      # http://127.0.0.1:8787: GET /quote, POST /front
```

- `POST /front` with `{ denomination, exitEpochId, leafIndex, destination, secret, aztecTx }`
  (the app sends it after the burn when the user picks Fast). The keeper checks on Aztec that the
  exit transaction succeeded in a block already checkpointed on L1 and that the exit leaf at that
  index is `exitCommitment(destination, secret)`; on Solana, that the exit batch has not arrived,
  the leaf is not fronted and the pool covers the note. Then `front_exit_from_pool`: the destination
  gets the note minus the pool's fee at once. Answers `fronted`, `wait` (ask again) or `refused`.
- Each pass (`KEEPER_INTERVAL`, 60 s) it sends `claim_exit` for the exits it fronted whose batch
  has arrived, which repays the pool the whole note.
- Files: `~/.config/eclyps/keeper.json` (Solana key, `KEEPER_SOLANA_KEYPAIR`), the record
  `~/.config/eclyps/testnet/keeper-state.json` (private: it holds exit secrets until they are
  claimed), and its Aztec simulation keys and wallet database next to it. No request logs.
- The app finds it at the deployment's `keeper.url`. It learns destinations early: serve it over a
  channel you trust (ADR 0017).

The rules are pure functions in `src/keeper-plan.ts`, tested in `test/keeper.test.ts`.

## Hosted (Railway)

Always-on in the cloud: see [RAILWAY.md](RAILWAY.md). Keys and state can come from the environment
(`FINISHER_SOLANA_KEY`, `FINISHER_SEPOLIA_PRIVATE_KEY`, `FINISHER_AZTEC_SECRET` / `_SALT` /
`_SIGNING_KEY`, `ECLYPS_DATA_DIR`); the key files remain the default. `pnpm --filter @eclyps/finisher
new-keys` makes a fresh set.
