# Run the finisher on Railway

Testnet first (sections 1 to 5). Mainnet uses the same image with other variables (section 6).

An always-on worker: Solana devnet to Sepolia to Aztec testnet, exits on (`features.exit` in
`deployments/testnet.json`). It holds test money only, on its own fresh keys. Nothing is public: no
port, no site.

## 1. Make the keys (on your computer)

```
pnpm --filter @eclyps/finisher new-keys
```

Writes `~/.config/eclyps/finisher-railway/railway.env` (private, never committed) and prints two
public addresses: Solana devnet and Sepolia. It refuses to overwrite an existing file.

## 2. Fund them (test money)

| Address | Faucet | Start with | Then, per day of work |
| --- | --- | --- | --- |
| Solana devnet | faucet.solana.com | 0.2 SOL | about 0.005 SOL per batch sent, about 0.003 SOL per exit batch |
| Sepolia | any Sepolia faucet | 0.02 ETH | gas of each relay and exitBatch (watch the first day, then adjust) |

Aztec fees are paid by the testnet's SponsoredFPC. The finisher earns test USDC from each batch it
sends. It warns in the log under 0.05 SOL or 0.005 ETH.

## 3. Railway (click-steps)

1. New Project, Deploy from GitHub repo, `Madebylantern/eclyps-bridge`, branch `main`.
2. Service Settings: Root Directory empty (repo root). The root `Dockerfile` and `railway.json`
   are picked up. No public domain, no healthcheck.
3. Variables, Raw Editor: paste the 5 lines of `railway.env`, then add `ECLYPS_DATA_DIR=/data`.
   Names only here:
   - `FINISHER_SOLANA_KEY`
   - `FINISHER_SEPOLIA_PRIVATE_KEY`
   - `FINISHER_AZTEC_SECRET`
   - `FINISHER_AZTEC_SALT`
   - `FINISHER_AZTEC_SIGNING_KEY`
   - `ECLYPS_DATA_DIR` (value `/data`)
   - optional: `SOLANA_RPC_URL`, `ETHEREUM_RPC_URL` (or `SEPOLIA_RPC_URL`), `AZTEC_NODE_URL` (a
     paid or private RPC if the public ones rate-limit), `FINISHER_INTERVAL` (seconds, 60),
     `FINISHER_MAX_GWEI` (no cap on testnet unless set), `DEPLOYMENT` (default
     `deployments/testnet.json`)
4. Volume: add one, mount path `/data`. It keeps the state (`finisher-state.json`) and the Aztec
   wallet database (`finisher-pxe/`), so a restart resumes where it was. Without it every restart
   re-syncs the wallet from scratch (slow) and loses its record (the chains are still checked, so
   nothing is sent twice).
5. Resources: give it at least 4 GB of memory. Aztec proofs (bb.js) are the heavy part; this
   figure is a safe guess, not a measurement, so check the Metrics tab on the first batch.
6. Deploy. Restarts are automatic on failure (`ON_FAILURE`, up to 10).

Node 24 is in the image. No extra proxy variables are needed on Railway.

## 4. What the log shows

First: the addresses, SOL / ETH / USDC balances, what it has earned. Then one line per action:
`close_epoch`, `send_batch`, `iris`, `relay`, `register_batch`, `carried across`, and for exits
`close_exit_epoch`, `exitBatch`, `receive_exit`. Errors are one line and retried. Add `DEBUG=1` for
stack traces. The first start also logs `created this finisher's Aztec account keys` only if you did
not set the three `FINISHER_AZTEC_*` variables.

## 5. Stop it

Service, Settings, Remove (or the three dots on the deployment, Remove). Stopping is safe at any
time: progress is saved after each step and checked on chain before each action. To stop it
spending: remove the service; the keys hold only test money.

Keep `railway.env` safe and out of the repo; losing it only costs the test funds on those keys.

## 6. Mainnet

Only after the owner approves it: this service spends real SOL, ETH and Fee Juice. Make it a
**separate Railway service with its own volume**; never point the testnet service at mainnet.

The finisher refuses to start on mainnet unless all three hold: `NETWORK=mainnet`, `DEPLOYMENT`
names a deployment whose `network` is `mainnet` (not the template), and `ECLYPS_MAINNET_OK=1`.
A mainnet deployment without the other two is refused too.

1. Keys: `pnpm --filter @eclyps/finisher new-keys -- --mainnet` writes
   `~/.config/eclyps/finisher-mainnet/railway.env` and prints the Solana and Ethereum addresses.
   Fresh keys only; never reuse the testnet ones.
2. Fund them (owner's call, small floats): SOL for `send_batch` and `receive_exit`, ETH for each
   relay and `exitBatch` (about 650k to 750k gas per relay), and Fee Juice bridged to the Aztec
   address the log prints (ADR 0018; `scripts/mainnet/fee-juice.ts`). The finisher never bridges.
3. Variables (names only here):
   - `NETWORK` = `mainnet`
   - `ECLYPS_MAINNET_OK` = `1`
   - `DEPLOYMENT` = `../deployments/mainnet.json` (the image runs in `/app/finisher`)
   - `ECLYPS_DATA_DIR` = `/data`
   - `FINISHER_SOLANA_KEY`, `FINISHER_ETHEREUM_PRIVATE_KEY` (the Sepolia name is refused on
     mainnet), `FINISHER_AZTEC_SECRET`, `FINISHER_AZTEC_SALT`, `FINISHER_AZTEC_SIGNING_KEY`
   - `AZTEC_NODE_URL` if `aztec.node` is empty in the deployment
   - recommended: `SOLANA_RPC_URL`, `ETHEREUM_RPC_URL` (paid RPCs; the defaults are public ones)
   - optional: `FINISHER_MAX_GWEI` (default 20; relays and `exitBatch` wait while gas is above it,
     then go on a later pass; `off` removes the cap), `FINISHER_FEE_JUICE_CHECK` (minutes between
     Fee Juice checks, 30), `FINISHER_INTERVAL`, `IRIS_URL` (default from the deployment's
     `cctp.iris`, `https://iris-api.circle.com`; the sandbox is refused on mainnet)
4. Volume at `/data`, 4 GB of memory, as for testnet.

From the deployment: the Ethereum chain (`l1.chainId` 1), Circle's Iris and CCTP domains (`cctp`),
and the Aztec fee mode (`fees.operator` = `feeJuice`).

The log starts with `MAINNET: real money`, then the Iris URL, the CCTP domains and the gas cap.
Every 30 minutes it logs the finisher's Fee Juice; under `fees.operatorFeeJuice.low` it adds
`LOW: bridge N to <address>`. Under 0.05 SOL or 0.005 ETH it warns at start.

To stop spending: remove the service, or unset `ECLYPS_MAINNET_OK` (the next start refuses).
