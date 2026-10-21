# programs/gateway — Solana gateway (Anchor 1.2.1)

Forward path (S4, ADR 0005, 0010, 0012): `initialize`, `open_epoch`, `deposit`, `close_epoch`
(rollover + Poseidon-syscall root), `send_batch` (CCTP V2 burn with the batch hook, fee payout),
`refund_deposit`, `pause_deposits`/`unpause_deposits`, `propose_params`/`apply_params`/`cancel_params`,
`set_guardian`, `propose_admin`/`accept_admin`.

Exit (ADR 0009): `receive_exit` (CCTP V2 `receive_message` CPI as the exit authority; stores the
`ExitBatch`) and `claim_exit` (Merkle proof of `Poseidon(dest_hi, dest_lo, secret)`, pays one
denomination to the destination's USDC account). `receive_exit` goes in a v0 transaction with an
address lookup table.

V2 lanes (off until the admin runs `init_lanes`; new accounts only, the V1 accounts keep their
layout, so the upgrade needs no migration):
- Cross now (ADR 0015): `deposit_express` (one note in its own express epoch, id with the top bit
  set, closed at once; the express fee from the crossing pool while it holds one, else from the
  user up to `max_express_fee`) and `send_express_batch` (the CCTP burn; the finisher gets the
  express fee). The crossing pool is a USDC account at `["crossing_pool"]`: top it up with a plain
  token transfer.
- Fronted exits (ADR 0017): `front_exit` (a solver pays the destination now and becomes the payee
  of that leaf, record `["front", leaf]`), `front_exit_from_pool` (the same from the liquidity
  pool, signed by the keeper), `write_off_front`; `claim_exit` pays the fronter when a record exists.
- Liquidity pool (ADR 0017, amended): `lp_deposit`, `lp_withdraw` (idle funds only).
- Parameters: `init_lanes`, `propose_lane_params` / `apply_lane_params` / `cancel_lane_params`
  (7 days, 14 for a fee rate), `disable_pool_fronts` (admin or guardian, at once).

Screening deposits (ADR 0019; off until the admin runs `init_screening`; new accounts only):
`block_address` (guardian or admin, at once: PDA `["blocked", address]`), `propose_unblock` /
`cancel_unblock` / `unblock` (a removal is announced, then anyone carries it out 2 days later).
`deposit` and `deposit_express` take the authority's record as their last account and refuse a
listed depositor; nothing else reads it. Lists: `scripts/screening/update.ts`.

```
cargo test -p eclyps-gateway --test lanes   # V2: express, fronts, pool; property test
cargo test -p eclyps-gateway --test screening   # ADR 0019 denylist
```

Tools (ADR 0001): Agave CLI 4.3.0 (platform-tools v1.57, SBPF v3), Anchor CLI 1.2.1, Rust 1.97.1.

```
anchor build                               # target/deploy/eclyps_gateway.so (+ IDL)
cargo test -p eclyps-gateway               # LiteSVM: unit tests + invariant property tests
cargo test -p eclyps-gateway --test exit   # receive_exit / claim_exit against Circle's CCTP V2
PROPTEST_CASES=512 cargo test -p eclyps-gateway --test invariants   # longer fuzzing
```

The program keypair (`target/deploy/eclyps_gateway-keypair.json`) is git-ignored. Nothing is deployed.
