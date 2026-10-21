# scripts — `@eclyps/scripts`

Spike and end-to-end drivers. Run them from `scripts/` with Node ≥ 24.12 (the Aztec packages need
it), e.g. `pnpm exec tsx testnet/run.ts aztec`. Behind an HTTP proxy, also set `NODE_USE_ENV_PROXY=1`.

| Folder | What | Funds |
| --- | --- | --- |
| [`s1-cctp/`](s1-cctp/README.md) | S1: burn devnet USDC with a batch hook, then relay Circle's attested message to a receiver on Sepolia | devnet USDC and SOL, Sepolia ETH |
| [`s2-aztec/`](s2-aztec/README.md) | S2: L1→L2 message into a claim contract on a local Aztec network, then a private claim | none |
| [`e2e/`](e2e/README.md) | S6: the full path on a local stack (local validator with Circle's CCTP programs, Sepolia fork, local Aztec), plus the UI demo | none |
| [`testnet/`](testnet/README.md) | The Phase 0 gate on public testnets: devnet → Sepolia → Aztec testnet | devnet SOL and USDC, Sepolia ETH |
| `mainnet/` | The mainnet deployment kit (`deploy.ts`, step by step, dry run unless `--send --mainnet` and the owner's confirmation file), its rehearsal on local forks (`rehearse.sh`) and `fee-juice.ts`. Owner's list: [docs/mainnet-checklist.md](../docs/mainnet-checklist.md) | mainnet SOL, ETH, AZTEC, only with the owner |
| `screening/` | ADR 0019: build the deposit denylist from OFAC's SDN list and hand-kept lists (`update.ts`, dry run by default) | rent only, refunded on removal |

Versions (ADR 0001):
- `@aztec-labs/{aztec.js,accounts,wallets,stdlib,foundation,ethereum,noir-contracts.js}` 6.0.0-rc.3
- `@solana/kit` 8.4.0, viem 2.57.4, tsx 4.23.15
- Playwright 1.56.1, which matches the Chromium preinstalled in the dev container

After an Aztec upgrade, delete the local wallet stores once (`scripts/aztec-wallet-data/` and
`finisher/aztec-wallet-data/`); a store from the previous version fails with "Genesis block hash
mismatch".

Keys are read from the environment or from `~/.config/eclyps/`, never from the repo (`.env.example`
lists the variables).
