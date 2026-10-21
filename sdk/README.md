# sdk — `@eclyps/sdk`

TypeScript client shared by the scripts, the finisher and the app. It has no network or server
dependency of its own; callers bring the RPC.

| Module | What |
| --- | --- |
| `merkle.ts` | Poseidon BN254 (circom parameters) `hashPair`, `commitment`, `root`, `path`, `rootFromPath`; depth 8, empty leaf 0 (ADR 0004) |
| `notes.ts` | Seed-derived notes: `deriveNote(seed, i)` gives `nullifierKey`, `secret` and `commitment`. No keys come from a wallet signature (SPEC §1.2) |
| `cctp.ts` | CCTP V2 constants (devnet, Sepolia, domains), the 51-byte batch and exit hooks, `deposit_for_burn_with_hook` builder, `MessageSent` account parser, exit message decoder and `receive_message` accounts (ADR 0002, 0009) |
| `advisor.ts` | Privacy advisor, pure and tested: `splitAmount`, `planSchedule` (notes spread across epochs, SPEC §5.6), `anonymityLevel`, `adviseShield`, `adviseClaim`, `adviseExit`, `auditNotes` (ADR 0007) |
| `exit.ts` | To Solana: `exitSecret = Poseidon(s0, 3, i)`, `leaf = Poseidon(dest_hi, dest_lo, exitSecret)`, `exitClaimInputs`, `exitBatchContent` (ADR 0009). To Ethereum: `exitSecret = Poseidon(s0, 4, i)` (own index space), `ethereumExitCommitment = sha256ToField(recipient, exitSecret)`, `ethereumExitContent` with its tag (ADR 0014 §4). The claim contracts' exit epoch parameters (`EXIT_EPOCH_BLOCKS`, `MIN_EXIT_BATCH`) |
| `gateway.ts` | PDAs, instruction builders (`initialize`, `open_epoch`, `deposit`, `close_epoch`, `send_batch`, `refund_deposit`, `propose_params`, `apply_params`, `cancel_params`, `set_guardian`, `propose_admin`, `accept_admin`), `Config`/`Epoch` decoders, `refundStatus`, `portalMatches`, exits (`receiveExitIx` with its lookup table addresses, `claimExitIx`, `decodeExitBatch`, `exitClaimed`), fee and cap helpers (`bpsOf`, `depositCost`, `depositFeeBps`, `depositRoom`), associated token accounts (ADR 0005, 0009, 0010, 0012). Discriminators and every builder's accounts are checked against the committed IDL, and the decoders against program-written account bytes (`test/fixtures`) |
| `mnemonic.ts` | The seed as a 24-word BIP-39 phrase (the seed is the entropy, so hex backups restore the same notes), `parseSeedInput`, backup word check (ADR 0010) |
| `recovery.ts` | `recoverNotes`: after a restore, find the seed's notes in public epoch leaves; `findCommitment`: refuse to deposit a commitment that is already on-chain (ADR 0010) |

Versions (ADR 0001): `@solana/kit` 8.4.0, `poseidon-lite` 0.3.0, `@scure/bip39` 2.4.0, TypeScript 6.0.3, vitest 5.0.3,
and `circomlibjs` 0.1.7 (tests only, as an independent Poseidon reference). Node ≥ 22.12.

```
pnpm --filter @eclyps/sdk test        # vectors (circuits/vectors), notes, gateway client vs IDL
pnpm --filter @eclyps/sdk typecheck
```

The same roots are produced in Rust (host and the Solana syscall) and in Noir, from
`circuits/vectors/merkle.json`.
