# Public testnet run

Solana devnet → Sepolia → Aztec testnet (6.0.0-rc.3), using real third-party contracts on every leg:
Circle CCTP V2 (devnet programs, Iris sandbox attestation, Sepolia contracts) and the Aztec testnet
(Inbox, real proofs, fees paid by the testnet's SponsoredFPC).

`run.ts` is resumable. Each phase records its results and is skipped once it has run.

**Rehearsal (no funds, nothing public):** `scripts/testnet/rehearse.sh` runs the same `run.ts`
phases (portal, program, deposit, burn, relay) against stand-ins:
- a local validator with Circle's CCTP V2 programs and state, where our program is deployed with the
  real `solana program deploy`;
- an anvil fork of Sepolia, with Circle's real CCTP V2 contracts and the real Aztec testnet Inbox,
  plus a test attester;
- an Iris stand-in that signs with that test attester.

It passes end to end up to the L1→L2 message, so the funded run only adds real Iris and the Aztec
testnet steps. Without the gateway's program key (`target/deploy/eclyps_gateway-keypair.json`), the
gateway is preloaded instead of deployed.

`rehearse.sh finisher` runs the testnet finisher (`finisher/src/testnet.ts`) instead of `burn` and
`relay`, with its own throwaway keys: close, send, Iris, relay, then it waits for Aztec. It is
stopped, restarted and its record deleted; it never repeats a step. Then a lone deposit: its epoch
is rolled over once per end (this mode runs faster slots, so an epoch ends in about 4 minutes).

| Where | What |
| --- | --- |
| `~/.config/eclyps/devnet.json` | Solana devnet key: deploys and upgrades the gateway, is the admin, deposits notes |
| `~/.config/eclyps/gateway-program.json` | The gateway's program key (`4GG6NHxU…B1jf`). `run.ts program` deploys from `target/deploy/eclyps_gateway-keypair.json`, so copy it there. **Private, never commit** |
| `~/.config/eclyps/sepolia.key` | Sepolia key: deploys and binds the portal, relays the batch |
| `~/.config/eclyps/testnet/` | Aztec admin keys, note seeds, PXE database; the finisher's state, Aztec keys and wallet (`finisher-*`). **Private, never commit** |
| [`deployments/testnet.json`](../../deployments/testnet.json) | Public addresses, transaction hashes, timings and checks. Committed |

Testnet notes are **$1 / $10**: Circle's faucet gives 20 devnet USDC per request. The batch is 4 notes,
min batch 4, epoch 2,250 slots, and the admin expires after 30 days.

## Funding

| Network | Amount | Faucet |
| --- | --- | --- |
| Solana devnet | about 3 SOL (the program account takes about 2.1 SOL of rent) | faucet.solana.com |
| Solana devnet | 4 USDC per run | faucet.circle.com, "Solana Devnet" |
| Sepolia | about 0.02 ETH | any Sepolia faucet |

## Run

From `scripts/`, with Node ≥ 24.12, after `anchor build`, `forge build` (in `contracts/portal`) and
the Aztec codegen. Behind a proxy, also set `NODE_USE_ENV_PROXY=1`.

```
pnpm exec tsx testnet/aztec-info.ts      # node version, Inbox, SponsoredFPC balance
pnpm exec tsx testnet/run.ts aztec       # Aztec admin account + EclypsMinter + Token (AIP-20, ADR 0020)
pnpm exec tsx testnet/run.ts portal      # EclypsPortal on Sepolia (exit accounts from the gateway program id)
pnpm exec tsx testnet/run.ts claims      # EclypsClaim($1, $10) + the minter's wiring + bindClaimContract
pnpm exec tsx testnet/run.ts program     # solana program deploy + initialize
pnpm exec tsx testnet/run.ts deposit [n] # n × $1 seed-derived notes (default 4: a full batch)
pnpm exec tsx testnet/run.ts finish      # close, CCTP burn, Iris, relay, register_batch
pnpm exec tsx testnet/run.ts claim       # private claim to a fresh account + checks
```

UI on testnet: against the hosted app (`APP_URL=https://eclyps-six.vercel.app`), or run `next build` in
`app/`, copy `deployments/testnet.json` to `app/out/deployment.json` and start `node app/serve.mjs`. Then:

```
pnpm exec tsx testnet/ui-demo.ts check   # in-browser PXE on Aztec testnet (no funds): ready in about 1 min
pnpm exec tsx testnet/ui-demo.ts demo    # the Tunnel: $1, Cross with the next batch, 3 other depositors, finisher,
                                         # private claim, Move out to a fresh Sepolia address, Claim on Ethereum
pnpm exec tsx testnet/ui-demo.ts solana  # the same to the private claim, then Move out to a fresh Solana address,
                                         # exits.ts fill 3 (an exit epoch needs 4 exits), the testnet finisher
                                         # (started here; FINISHER=0 to run your own), Claim on Solana
pnpm exec tsx testnet/ui-demo.ts solana-resume  # after a solana run stopped once the exit was burned:
                                         # unlocks the vault kept in DEMO_OUT/profile/ and goes on from there
```

`demo` needs 4.02 devnet USDC up front (4 notes with fees; the fees come back, as treasury and
finisher are the test key) and a little Sepolia ETH. The page's Ethereum wallet is an injected
EIP-1193 provider that signs in the Node process with the Sepolia key. The vault lives only in that
headless browser: if the run dies after the deposit, its note (or exit) cannot be claimed any more.
`DEMO_OUT` sets where screenshots, the video and `testnet-marks.json` go (default `docs/demo/`).

`finish` carries one batch: what the permissionless finisher does, using a funded key. Any key works;
the gateway does not check who calls. To carry every batch, unattended (for example around the
Totality window), run the finisher itself:

```
pnpm --filter @eclyps/finisher testnet   # same keys by default; see finisher/README.md
```

Exits (ADR 0009, ADR 0014 §4), once two $1 batches have crossed (`deposit`, `finish` twice), with
the testnet finisher running with `features.exit` on (a copy of the deployment with the flag set,
via `DEPLOYMENT`, until the flags are on in `deployments/testnet.json`):

```
pnpm exec tsx testnet/exits.ts table     # the receive_exit lookup table, once (solana.exitLookupTable)
pnpm exec tsx testnet/exits.ts claim     # the runs' unclaimed $1 notes to a fresh Aztec account
pnpm exec tsx testnet/exits.ts exit      # 4 × exit to fresh Solana addresses, 1 × exit_to_ethereum
pnpm exec tsx testnet/exits.ts carry     # follows the finisher: close, Aztec proof, exitBatch, Iris, receive_exit
pnpm exec tsx testnet/exits.ts solana    # claim_exit to each address; a replay is refused
pnpm exec tsx testnet/exits.ts ethereum  # claimToEthereum to the fresh address; a replay is refused
```

Re-runnable, to fill an exit epoch shared with other exits (the app's Move out): `exits.ts fill [n]`
claims n unclaimed $1 notes of the runs to a fresh Aztec account and exits each to a fresh Solana
address (a new `runs` entry, `purpose: "fill"`); `fill-carry` and `fill-solana` then record the carry
and pay its addresses.

`exits.ts` records a `runs` entry with `kind: "exit"`; the account that exits and the exit secrets
stay in `~/.config/eclyps/testnet/` (`state.json`, `exit-pxe/`).

Public endpoints: `aztec-testnet.drpc.org` (free tier) refuses JSON-RPC batches of more than 3
requests, so every Aztec node client here sets `maxBatchSize: 3`. Devnet's public RPC answers 429
under load; a send keeps polling until its blockhash expires, so a rerun never repeats a deposit.

The checks the `claim` phase records:

- the recipient's private balance equals one note, and its public balance is 0;
- the recipient appears neither in the Sepolia relay calldata nor in the claim's public effects;
- a second claim of the same note is refused.

## V2 lanes: Cross now, fast exits, the liquidity pool (ADR 0015, 0017)

After the gateway upgrade that adds them (nothing changes until the admin turns them on):

```
pnpm exec tsx testnet/lanes.ts status
pnpm exec tsx testnet/lanes.ts init            # dry run: prints the parameters and accounts
pnpm exec tsx testnet/lanes.ts init --send     # init_lanes, signed by the admin key
```

Defaults for testnet's $1 / $10 notes: express fee $0.10, front fee cap 30 bps, pool fee 10 bps,
pool outstanding bound $100, keeper = the admin key (`--keeper` for another). Then: top up the
crossing pool with a USDC transfer to the address `status` prints, add liquidity (`lp_deposit`,
SDK `lpDepositIx`), run the keeper (`pnpm --filter @eclyps/finisher keeper`), and set
`features.crossNow`, `features.fastExit` and `keeper.url` in the deployment the app serves.
