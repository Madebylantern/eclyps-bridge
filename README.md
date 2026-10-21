# Eclyps

The private bridge between Solana and Ethereum, through Aztec.

USDC deposited on Solana becomes fixed-size notes. Notes cross together in batches through
Circle's CCTP to Ethereum and land on Aztec, where each one is claimed privately. A claim proves
it is one of the batch's notes, never which one. Notes can move out again to Solana or Ethereum.

**Beta.** It works end to end. Start with small notes while it is tested.

## Layout

```
programs/gateway/   Solana program (Anchor): deposits, epochs, batches, exits
contracts/portal/   Ethereum portal (Foundry): relays batches to Aztec, pays exits
aztec/              Aztec contracts (Aztec.nr): claims, minter, fee payer
circuits/           shared Poseidon Merkle tree and test vectors (Rust, Noir)
sdk/                TypeScript SDK used by the app and the finisher
finisher/           permissionless batch finisher
app/                web app (static Next.js): landing at /, the bridge at /app/, how it works at /docs/
scripts/            local end-to-end runs, testnet and mainnet deployment kits
deployments/        public addresses and transaction hashes
```

## Build and test

```
pnpm install
cargo test -p eclyps-gateway          # after anchor build
(cd contracts/portal && forge test)
(cd aztec && aztec test)
pnpm --filter @eclyps/sdk test
pnpm --filter @eclyps/app test
```

Toolchain versions are pinned in `rust-toolchain.toml`, `Anchor.toml`, `package.json` and the CI
workflow (`.github/workflows/ci.yml`).

## Check it

Every deployed address is in `deployments/`. The Solana program, the Ethereum portal and the Aztec
contracts can be read on their chains' explorers and compared with this code.
