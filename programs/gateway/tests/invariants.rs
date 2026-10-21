//! Property tests for the SPEC §5.3 invariants (S4). Random operation sequences run against the
//! real SBF program in LiteSVM, checked after every step against a small reference model:
//!
//! I1 escrow balance >= sum over unsent leaves x denomination (equality: send_batch burns exactly
//!    the batch through CCTP, refund_deposit pays exactly one denomination)
//! I2 every leaf is in exactly one epoch/batch, and a repeated commitment is never accepted into
//!    the same epoch
//! I3 only send_batch (by exactly leaf_count x denomination) and refund_deposit (by exactly one
//!    denomination, to the leaf's depositor) move escrow out; exits never touch escrow (E3)
//! I4 the deposit pause never changes the outcome of close_epoch / send_batch / refund_deposit
//! I5 fee_bps <= FEE_CAP_BPS, finisher_bps <= fee_bps, and params always satisfy their hard bounds
//! plus: every closed batch's on-chain root equals the shared Merkle root of its leaves; every
//! leaf's recorded depositor is the wallet that deposited it; the guardian cannot pause during
//! the cooldown (ADR 0010).
//!
//! Fees and the deposit cap (ADR 0012):
//! F1 the fee vault holds exactly the fees of deposited-but-unsent leaves, each at its epoch's
//!    snapshot (equality, like I1)
//! F2 only send_batch (the batch's fees: the finisher's share to the finisher, the rest to the
//!    treasury, or all to the finisher when the treasury cannot receive) and refund_deposit (one
//!    note's fee, to the depositor) move the fee vault
//! F3 an epoch's fee snapshot is the fee in force when it opened and never changes; a deposit
//!    costs exactly denomination + that fee
//! F4 net_deposits = principal deposited - principal refunded, and never exceeds deposit_cap
//! plus: every wallet the test controls (depositors, the finisher, the treasuries) holds exactly
//! what the model says.
//!
//! Exit (ADR 0009), with exit batches received through the real CCTP programs and claimed:
//! E1 exit custody >= unclaimed exits x denomination (equality here: nobody donates to it), and
//!    every ExitBatch's claimed bitmap and count match the model
//! E2 each exit leaf is paid at most once, to its own destination: a second claim, a wrong secret
//!    or another destination fails, and every destination holds exactly what it was paid
//! E3 only claim_exit moves exit custody out (by exactly one denomination); only receive_exit
//!    moves it in (by exactly count x denomination); a replayed message or exit epoch moves nothing
//! E4 the deposit pause never changes the outcome of receive_exit or claim_exit
//! and the deposit-side invariants above, and the fee and cap (F1-F4), are unchanged by exits.

mod common;
use common::*;
use eclyps_gateway::{
    EpochStatus, Params, FEE_CAP_BPS, PAUSE_COOLDOWN_SECS, PAUSE_DURATION_SECS, REFUND_DELAY_SLOTS,
};
use proptest::prelude::*;
use solana_signer::Signer;
use spl_token_interface::state::AccountState;
use std::collections::HashMap;

/// Each depositor starts with this much USDC.
const START: u64 = 1_000 * THOUSAND;

#[derive(Debug, Clone)]
enum Op {
    Deposit {
        user: usize,
        idx: u8,
    },
    /// Re-deposit a commitment already in the current epoch.
    DepositDuplicate {
        user: usize,
        idx: u8,
        pick: usize,
    },
    Refund {
        user: usize,
        idx: u8,
        pick: usize,
    },
    Close {
        idx: u8,
    },
    Send {
        idx: u8,
        pick: usize,
    },
    WarpSlots(u64),
    WarpSecs(i64),
    Pause,
    Unpause,
    Propose {
        cap_up: u16,
        fee: u16,
        finisher: u16,
        len: u64,
        min: u16,
        /// Deposit cap change in $1,000 steps; negative proposals must be refused.
        deposit_cap: i64,
        /// Index into the run's treasuries; the last one is frozen (cannot receive).
        treasury: usize,
    },
    Apply,
    /// Receive a new exit batch of `n` exits for denomination `idx` (its next exit epoch).
    Exit {
        idx: u8,
        n: u16,
    },
    /// Claim an exit (pays if it was not paid yet, else must fail).
    Claim {
        pick: usize,
    },
    /// Claim an exit with another exit's secret, or to another destination: must fail.
    BadClaim {
        pick: usize,
        redirect: bool,
    },
    /// Resend a received message, or send a new one for a received exit epoch: must fail.
    ReplayExit {
        pick: usize,
        new_nonce: bool,
    },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => (0usize..3, 0u8..2).prop_map(|(user, idx)| Op::Deposit { user, idx }),
        1 => (0usize..3, 0u8..2, 0usize..8)
            .prop_map(|(user, idx, pick)| Op::DepositDuplicate { user, idx, pick }),
        2 => (0usize..3, 0u8..2, 0usize..8).prop_map(|(user, idx, pick)| Op::Refund { user, idx, pick }),
        3 => (0u8..2).prop_map(|idx| Op::Close { idx }),
        2 => (0u8..2, 0usize..4).prop_map(|(idx, pick)| Op::Send { idx, pick }),
        3 => (0u64..12_000).prop_map(Op::WarpSlots),
        1 => (0i64..(16 * 86_400)).prop_map(Op::WarpSecs),
        1 => Just(Op::Pause),
        1 => Just(Op::Unpause),
        1 => (0u16..8, 0u16..60, 0u16..60, 2_000u64..12_000, 3u16..10, -2i64..6, 0usize..3)
            .prop_map(|(cap_up, fee, finisher, len, min, deposit_cap, treasury)| Op::Propose {
                cap_up, fee, finisher, len, min, deposit_cap, treasury,
            }),
        1 => Just(Op::Apply),
        2 => (0u8..2, 1u16..7).prop_map(|(idx, n)| Op::Exit { idx, n }),
        3 => (0usize..64).prop_map(|pick| Op::Claim { pick }),
        1 => (0usize..64, any::<bool>()).prop_map(|(pick, redirect)| Op::BadClaim { pick, redirect }),
        1 => (0usize..8, any::<bool>()).prop_map(|(pick, new_nonce)| Op::ReplayExit { pick, new_nonce }),
    ]
}

/// A received exit batch, as the model sees it.
struct ExitRecord {
    idx: u8,
    exit_epoch_id: u64,
    tree: ExitTree,
    message: Vec<u8>,
    claimed: Vec<bool>,
}

#[derive(Default)]
struct Model {
    /// Every leaf still held -> (denomination index, epoch id, depositor).
    leaves: HashMap<[u8; 32], (u8, u64, Pubkey)>,
    deposited: u64,
    sent: u64,
    refunded: u64,
    next_leaf: u64,
    /// Fees paid in at deposit, and out at send (finisher, treasury) and refund.
    fees_in: u64,
    fees_to_finisher: u64,
    fees_to_treasury: u64,
    fees_refunded: u64,
    /// (denomination index, epoch id) -> (fee_bps, finisher_bps) in force when it opened.
    snapshots: HashMap<(u8, u64), (u16, u16)>,
    /// USDC every account the test controls must hold.
    balances: HashMap<Pubkey, u64>,
    /// Exit batches received, in order.
    exits: Vec<ExitRecord>,
    next_exit_epoch: [u64; 2],
    /// USDC paid into exit custody by receive_exit, and out of it by claim_exit.
    exits_in: u64,
    exits_out: u64,
    /// USDC each exit destination (owner of the paid associated account) received.
    exit_paid: HashMap<Pubkey, u64>,
}

fn denom(idx: u8) -> u64 {
    [HUNDRED, THOUSAND][idx as usize]
}

/// Expected outcome of close_epoch, from on-chain state *ignoring* the pause (I4).
fn expect_close(env: &Env, idx: u8) -> Option<bool> {
    let c = env.config();
    let e = env.epoch(idx, c.current_epoch[idx as usize])?;
    let full = e.leaves.len() >= c.params.per_epoch_cap as usize;
    if e.status != EpochStatus::Open || !(env.clock().slot >= e.end_slot || full) {
        return None;
    }
    Some(e.leaves.len() >= c.params.min_batch_size as usize) // true = closes, false = rolls over
}

/// Expected outcome of refund_deposit for `leaf` by `user`, *ignoring* the pause (I4).
fn expect_refund(env: &Env, idx: u8, leaf: &[u8; 32], user: &Pubkey) -> bool {
    let c = env.config();
    let Some(e) = env.epoch(idx, c.current_epoch[idx as usize]) else {
        return false;
    };
    e.status == EpochStatus::Open
        && e.rollovers >= 1
        && env.clock().slot >= e.opened_slot + REFUND_DELAY_SLOTS
        && e.leaves
            .iter()
            .zip(&e.depositors)
            .any(|(l, d)| l == leaf && d == user)
}

struct Moved {
    escrow_before: u64,
    escrow_out: u64,
    fees_before: u64,
    fees_out: u64,
    /// Exit custody before the op, and what receive_exit put in / claim_exit took out.
    exit_before: u64,
    exit_in: u64,
    exit_out: u64,
}

fn check_invariants(env: &Env, m: &Model, mv: &Moved) {
    let c = env.config();
    // I5
    assert!(c.params.fee_bps <= FEE_CAP_BPS);
    assert!(c.params.finisher_bps <= c.params.fee_bps);
    c.params.validate(None).expect("params within hard bounds");
    // F4
    assert_eq!(c.net_deposits, m.deposited - m.refunded, "net_deposits");
    assert!(
        c.net_deposits <= c.params.deposit_cap,
        "past the deposit cap"
    );

    // Scan every epoch account.
    let mut seen: HashMap<[u8; 32], u32> = HashMap::new();
    let mut unsent_value = 0u64;
    let mut unsent_fees = 0u64;
    let mut all_value = 0u64;
    for idx in 0..2u8 {
        for id in 0..=c.current_epoch[idx as usize] {
            let Some(e) = env.epoch(idx, id) else {
                continue;
            };
            assert_eq!(e.denomination, denom(idx));
            // F3
            assert_eq!(
                m.snapshots.get(&(idx, id)),
                Some(&(e.fee_bps, e.finisher_bps)),
                "epoch fee snapshot"
            );
            let value = e.leaves.len() as u64 * e.denomination;
            all_value += value;
            if e.status != EpochStatus::Sent {
                unsent_value += value;
                unsent_fees += e.leaves.len() as u64 * fee_of(e.denomination, e.fee_bps);
            }
            if e.status != EpochStatus::Open {
                let r = eclyps_merkle::root(&e.leaves, eclyps_merkle::BATCH_TREE_DEPTH).unwrap();
                assert_eq!(e.root, r, "closed batch root mismatch");
                assert!(
                    id < c.current_epoch[idx as usize],
                    "closed epoch is not current"
                );
            }
            assert_eq!(e.depositors.len(), e.leaves.len(), "one depositor per leaf");
            for (l, d) in e.leaves.iter().zip(&e.depositors) {
                *seen.entry(*l).or_default() += 1;
                assert_eq!(
                    m.leaves.get(l),
                    Some(&(idx, id, *d)),
                    "leaf in unexpected epoch or with the wrong depositor"
                );
            }
        }
    }
    // I2
    assert_eq!(seen.len(), m.leaves.len(), "a deposited leaf is missing");
    assert!(
        seen.values().all(|&n| n == 1),
        "a leaf appears in more than one epoch"
    );
    // I1 / I3
    let escrow = env.escrow_balance();
    assert_eq!(all_value, m.deposited - m.refunded);
    assert_eq!(escrow, m.deposited - m.sent - m.refunded);
    assert!(escrow >= unsent_value);
    assert_eq!(escrow, unsent_value);
    // I3: escrow only goes down through send_batch / refund_deposit, by exactly what they move.
    assert!(
        escrow + mv.escrow_out >= mv.escrow_before,
        "escrow decreased outside send_batch and refund_deposit"
    );
    // F1 / F2
    let fees = env.fee_vault_balance();
    assert_eq!(fees, unsent_fees, "fee vault != fees of unsent leaves");
    assert_eq!(
        fees,
        m.fees_in - m.fees_to_finisher - m.fees_to_treasury - m.fees_refunded
    );
    assert!(
        fees + mv.fees_out >= mv.fees_before,
        "fee vault decreased outside send_batch and refund_deposit"
    );
    for (account, want) in &m.balances {
        assert_eq!(env.token_balance(account), *want, "USDC of {account}");
    }

    // E1: exit custody holds exactly the unclaimed exits; every batch's bitmap is the model's.
    let mut unclaimed_value = 0u64;
    for r in &m.exits {
        let b = env
            .exit_batch(r.idx, r.exit_epoch_id)
            .expect("received exit batch");
        assert_eq!(
            (b.denomination, b.count, b.root),
            (denom(r.idx), r.tree.count(), r.tree.root)
        );
        let paid = r.claimed.iter().filter(|c| **c).count();
        assert_eq!(b.claimed_count as usize, paid, "claimed count");
        for (i, c) in r.claimed.iter().enumerate() {
            assert_eq!(b.is_claimed(i as u16), *c, "claimed bit {i}");
        }
        unclaimed_value += (r.tree.count() as u64 - paid as u64) * b.denomination;
    }
    let custody = env.exit_custody_balance();
    assert!(custody >= unclaimed_value, "exit custody < unclaimed exits");
    assert_eq!(custody, unclaimed_value);
    assert_eq!(custody, m.exits_in - m.exits_out);
    // E3: exit custody moves only by what receive_exit and claim_exit moved in this op.
    assert_eq!(
        custody + mv.exit_out,
        mv.exit_before + mv.exit_in,
        "exit custody moved outside receive_exit and claim_exit"
    );
    // E2: every destination holds what its claims paid, once each.
    for (d, want) in &m.exit_paid {
        assert_eq!(env.usdc_of(d), *want, "USDC of exit destination {d}");
    }
}

/// The exit `pick` points at: (batch index, leaf index), if any batch was received.
fn pick_exit(m: &Model, pick: usize) -> Option<(usize, usize)> {
    if m.exits.is_empty() {
        return None;
    }
    let b = pick % m.exits.len();
    Some((b, (pick / m.exits.len()) % m.exits[b].claimed.len()))
}

fn run(ops: Vec<Op>) {
    let p = Params {
        epoch_len_slots: 9_000,
        min_batch_size: 4,
        per_epoch_cap: 8,
        fee_bps: FEE_BPS,
        finisher_bps: FINISHER_BPS,
        // Low enough that random sequences reach it.
        deposit_cap: 8 * THOUSAND,
        treasury: TREASURY,
    };
    let mut env = Env::new(p);
    let users: Vec<_> = (0..3).map(|_| env.user(START)).collect();
    let (finisher, finisher_usdc) = env.finisher();
    // Treasuries a proposal can name; the last one is frozen, so its share goes to the finisher.
    let (_, t2) = env.user(0);
    let frozen = Pubkey::new_unique();
    env.set_usdc_account(frozen, &TREASURY_OWNER, 0, AccountState::Frozen);
    let treasuries = [TREASURY, t2, frozen];
    let admin = env.admin.insecure_clone();
    let guardian = env.guardian.insecure_clone();
    let mut m = Model::default();
    for (_, ta) in &users {
        m.balances.insert(*ta, START);
    }
    for a in [finisher_usdc, TREASURY, t2, frozen] {
        m.balances.insert(a, 0);
    }

    let mut exit_seed = 0u64;
    for op in ops {
        let mut mv = Moved {
            escrow_before: env.escrow_balance(),
            escrow_out: 0,
            fees_before: env.fee_vault_balance(),
            fees_out: 0,
            exit_before: env.exit_custody_balance(),
            exit_in: 0,
            exit_out: 0,
        };
        match op {
            Op::Exit { idx, n } => {
                // E4: received whatever the pause state.
                exit_seed += 1;
                let tree = ExitTree::new(n as usize, exit_seed);
                let exit_epoch_id = m.next_exit_epoch[idx as usize];
                let message = env.exit_msg(idx, exit_epoch_id, &tree).bytes();
                env.receive_exit(&message).unwrap();
                m.next_exit_epoch[idx as usize] += 1;
                mv.exit_in = n as u64 * denom(idx);
                m.exits_in += mv.exit_in;
                m.exits.push(ExitRecord {
                    idx,
                    exit_epoch_id,
                    claimed: vec![false; n as usize],
                    tree,
                    message,
                });
            }
            Op::Claim { pick } => {
                let Some((b, i)) = pick_exit(&m, pick) else {
                    continue;
                };
                let r = &m.exits[b];
                let (idx, id, tree) = (r.idx, r.exit_epoch_id, r.tree.clone());
                let res = env.claim_exit(idx, id, &tree, i);
                if m.exits[b].claimed[i] {
                    assert_err(res, "ExitAlreadyClaimed");
                } else {
                    // E4: paid whatever the pause state.
                    res.unwrap();
                    m.exits[b].claimed[i] = true;
                    mv.exit_out = denom(idx);
                    m.exits_out += mv.exit_out;
                    *m.exit_paid.entry(tree.destinations[i]).or_default() += mv.exit_out;
                }
            }
            Op::BadClaim { pick, redirect } => {
                let Some((b, i)) = pick_exit(&m, pick) else {
                    continue;
                };
                let r = &m.exits[b];
                let (destination, secret) = if redirect {
                    (Pubkey::new_unique(), r.tree.secrets[i])
                } else {
                    // A secret no exit uses (exit secrets come from seeds below 10^9).
                    (
                        r.tree.destinations[i],
                        exit_secret(1_000_000_000 + pick as u64),
                    )
                };
                let payer = env.stranger();
                let ix = env.ix_claim_exit(
                    &payer.pubkey(),
                    r.idx,
                    r.exit_epoch_id,
                    i as u16,
                    r.tree.path(i),
                    destination,
                    secret,
                );
                assert_err(env.send(&[ix], &payer, &[]), "InvalidExitProof");
            }
            Op::ReplayExit { pick, new_nonce } => {
                if m.exits.is_empty() {
                    continue;
                }
                let r = &m.exits[pick % m.exits.len()];
                let message = if new_nonce {
                    let (idx, id, tree) = (r.idx, r.exit_epoch_id, r.tree.clone());
                    env.exit_msg(idx, id, &tree).bytes()
                } else {
                    r.message.clone()
                };
                assert_err(env.receive_exit(&message), "already in use");
            }
            Op::Deposit { user, idx } => {
                let c = env.config();
                let now = env.clock().unix_timestamp;
                let id = c.current_epoch[idx as usize];
                let current = env.epoch(idx, id);
                let count = current.as_ref().map_or(0, |e| e.leaves.len());
                let expect_ok = !c.deposits_paused(now)
                    && count < c.params.per_epoch_cap as usize
                    && c.net_deposits + denom(idx) <= c.params.deposit_cap;
                // The fee in force now, unless the epoch is already open with its own snapshot.
                let snapshot = current
                    .as_ref()
                    .map_or((c.params.fee_bps, c.params.finisher_bps), |e| {
                        (e.fee_bps, e.finisher_bps)
                    });
                let l = leaf(1_000_000 + m.next_leaf);
                m.next_leaf += 1;
                let (kp, ta) = &users[user];
                let r = env.deposit(kp, ta, idx, l);
                assert_eq!(r.is_ok(), expect_ok, "deposit outcome {r:?}");
                if r.is_ok() {
                    m.leaves.insert(l, (idx, id, kp.pubkey()));
                    m.snapshots.entry((idx, id)).or_insert(snapshot);
                    let fee = fee_of(denom(idx), snapshot.0);
                    m.deposited += denom(idx);
                    m.fees_in += fee;
                    *m.balances.get_mut(ta).unwrap() -= denom(idx) + fee;
                }
            }
            Op::DepositDuplicate { user, idx, pick } => {
                let c = env.config();
                let Some(e) = env.epoch(idx, c.current_epoch[idx as usize]) else {
                    continue;
                };
                if e.leaves.is_empty() {
                    continue;
                }
                let l = e.leaves[pick % e.leaves.len()];
                let (kp, ta) = &users[user];
                assert!(env.deposit(kp, ta, idx, l).is_err(), "duplicate accepted");
            }
            Op::Refund { user, idx, pick } => {
                let (kp, ta) = &users[user];
                let c = env.config();
                let Some(e) = env.epoch(idx, c.current_epoch[idx as usize]) else {
                    continue;
                };
                // Mostly the user's own leaves, sometimes someone else's (must fail).
                let candidates: Vec<[u8; 32]> = if pick % 4 == 0 {
                    e.leaves.clone()
                } else {
                    e.leaves
                        .iter()
                        .zip(&e.depositors)
                        .filter(|(_, d)| **d == kp.pubkey())
                        .map(|(l, _)| *l)
                        .collect()
                };
                let Some(&l) = candidates.get(pick % candidates.len().max(1)) else {
                    continue;
                };
                let expect = expect_refund(&env, idx, &l, &kp.pubkey());
                let before = env.token_balance(ta);
                let r = env.refund(kp, ta, idx, l);
                assert_eq!(r.is_ok(), expect, "refund outcome {r:?}");
                if r.is_ok() {
                    // The note and exactly the fee it paid.
                    mv.escrow_out = denom(idx);
                    mv.fees_out = fee_of(denom(idx), e.fee_bps);
                    m.refunded += mv.escrow_out;
                    m.fees_refunded += mv.fees_out;
                    m.leaves.remove(&l);
                    *m.balances.get_mut(ta).unwrap() += mv.escrow_out + mv.fees_out;
                    assert_eq!(env.token_balance(ta), before + mv.escrow_out + mv.fees_out);
                    assert_eq!(env.escrow_balance(), mv.escrow_before - mv.escrow_out);
                    assert_eq!(env.fee_vault_balance(), mv.fees_before - mv.fees_out);
                }
            }
            Op::Close { idx } => {
                let before = env.config().current_epoch[idx as usize];
                let expect = expect_close(&env, idx);
                let r = env.close_epoch(idx);
                // I4: same outcome whether or not deposits are paused.
                assert_eq!(r.is_ok(), expect.is_some(), "close outcome {r:?}");
                let after = env.config().current_epoch[idx as usize];
                match expect {
                    Some(true) => {
                        assert_eq!(after, before + 1);
                        assert_eq!(env.epoch(idx, before).unwrap().status, EpochStatus::Closed);
                    }
                    Some(false) => {
                        assert_eq!(after, before);
                        assert_eq!(env.epoch(idx, before).unwrap().status, EpochStatus::Open);
                    }
                    None => assert_eq!(after, before),
                }
            }
            Op::Send { idx, pick } => {
                let current = env.config().current_epoch[idx as usize];
                let closed: Vec<u64> = (0..current)
                    .filter(|id| {
                        env.epoch(idx, *id)
                            .is_some_and(|e| e.status == EpochStatus::Closed)
                    })
                    .collect();
                if let Some(&id) = closed.get(pick % closed.len().max(1)) {
                    // I4: must succeed whatever the pause state.
                    let treasury = env.config().params.treasury;
                    env.send_batch_by(&finisher, &finisher_usdc, idx, id, TMM)
                        .0
                        .unwrap();
                    let e = env.epoch(idx, id).unwrap();
                    assert_eq!(e.status, EpochStatus::Sent);
                    let n = e.leaves.len() as u64;
                    mv.escrow_out = n * e.denomination;
                    m.sent += mv.escrow_out;
                    assert_eq!(env.escrow_balance(), mv.escrow_before - mv.escrow_out);
                    // F2: the batch's fees at its snapshot, split between finisher and treasury.
                    mv.fees_out = n * fee_of(e.denomination, e.fee_bps);
                    let mut to_finisher = n * fee_of(e.denomination, e.finisher_bps);
                    if treasury == frozen {
                        to_finisher = mv.fees_out;
                    }
                    m.fees_to_finisher += to_finisher;
                    m.fees_to_treasury += mv.fees_out - to_finisher;
                    *m.balances.get_mut(&finisher_usdc).unwrap() += to_finisher;
                    *m.balances.get_mut(&treasury).unwrap() += mv.fees_out - to_finisher;
                    assert_eq!(env.fee_vault_balance(), mv.fees_before - mv.fees_out);
                    assert!(env.send_batch(idx, id).is_err());
                }
            }
            Op::WarpSlots(n) => env.warp_slots(n),
            Op::WarpSecs(s) => env.warp_secs(s),
            Op::Pause => {
                let c = env.config();
                let now = env.clock().unix_timestamp;
                let expect_ok = c.admin_active(now) && now >= c.pause_cooldown_until;
                assert_eq!(env.pause(&guardian, true).is_ok(), expect_ok);
                if expect_ok {
                    let c = env.config();
                    assert_eq!(c.pause_expiry, now + PAUSE_DURATION_SECS);
                    assert_eq!(
                        c.pause_cooldown_until,
                        now + PAUSE_DURATION_SECS + PAUSE_COOLDOWN_SECS
                    );
                }
            }
            Op::Unpause => {
                env.pause(&guardian, false).unwrap();
            }
            Op::Propose {
                cap_up,
                fee,
                finisher,
                len,
                min,
                deposit_cap,
                treasury,
            } => {
                let cur = env.config().params;
                let new = Params {
                    epoch_len_slots: len,
                    min_batch_size: min,
                    per_epoch_cap: (cur.per_epoch_cap + cap_up).min(64),
                    fee_bps: fee,
                    finisher_bps: finisher,
                    deposit_cap: (cur.deposit_cap as i64 + deposit_cap * THOUSAND as i64).max(1)
                        as u64,
                    treasury: treasuries[treasury],
                };
                let now = env.clock().unix_timestamp;
                let expect_ok = env.config().admin_active(now) && new.validate(Some(&cur)).is_ok();
                assert_eq!(env.propose(&admin, new).is_ok(), expect_ok);
            }
            Op::Apply => {
                let c = env.config();
                let now = env.clock().unix_timestamp;
                let expect_ok = c.admin_active(now)
                    && c.pending.is_some_and(|p| {
                        now >= p.eta && p.params.validate(Some(&c.params)).is_ok()
                    });
                assert_eq!(env.apply().is_ok(), expect_ok);
            }
        }
        check_invariants(&env, &m, &mv);
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(48),
        ..ProptestConfig::default()
    })]

    #[test]
    fn invariants_hold_for_random_operation_sequences(ops in prop::collection::vec(op(), 1..60)) {
        run(ops);
    }
}

/// Proposes `fee` / `finisher` / `treasury` and a deposit cap change, keeping the rest.
fn propose(fee: u16, finisher: u16, deposit_cap: i64, treasury: usize) -> Op {
    Op::Propose {
        cap_up: 0,
        fee,
        finisher,
        len: 9_000,
        min: 4,
        deposit_cap,
        treasury,
    }
}

/// A deterministic long run that is guaranteed to exercise close, rollover, send and pause, a fee
/// change while an epoch is open (its deposits and payout keep the snapshot), a treasury that
/// cannot receive, and the deposit cap.
#[test]
fn invariants_hold_on_scripted_sequence() {
    // Room for the whole script: $8,000 + $10,000, a 7-day change (no fee field moves).
    let mut ops = vec![
        propose(FEE_BPS, FINISHER_BPS, 10, 0),
        Op::WarpSecs(7 * 86_400),
        Op::Apply,
    ];
    for round in 0..6 {
        for u in 0..3 {
            ops.push(Op::Deposit {
                user: u,
                idx: (round % 2) as u8,
            });
        }
        if round == 2 {
            ops.push(Op::Pause);
        }
        ops.push(Op::WarpSlots(9_001));
        ops.push(Op::Close { idx: 0 });
        ops.push(Op::Close { idx: 1 });
        ops.push(Op::Send { idx: 0, pick: 0 });
        ops.push(Op::Send { idx: 1, pick: 0 });
        if round == 3 {
            ops.push(Op::WarpSecs(PAUSE_DURATION_SECS));
        }
    }
    // The open $100 epoch takes deposits before and after a fee change (0.5 % -> 0.2 %, another
    // treasury, 14 days); it closes and pays out at its snapshot; the next epoch opens at 0.2 %.
    ops.push(Op::Deposit { user: 0, idx: 0 });
    ops.push(Op::Deposit { user: 1, idx: 0 });
    ops.push(propose(20, 10, 0, 1));
    ops.push(Op::WarpSecs(7 * 86_400));
    ops.push(Op::Apply); // too early: refused
    ops.push(Op::WarpSecs(7 * 86_400));
    ops.push(Op::Apply);
    ops.push(Op::Deposit { user: 2, idx: 0 });
    ops.push(Op::Deposit { user: 0, idx: 0 });
    ops.push(Op::Close { idx: 0 });
    ops.push(Op::Deposit { user: 1, idx: 0 });
    ops.push(Op::Send { idx: 0, pick: 0 });
    // A frozen treasury: the $1,000 batch still sends, its whole fee to the finisher.
    ops.push(propose(20, 10, 0, 2));
    ops.push(Op::WarpSecs(15 * 86_400));
    ops.push(Op::Apply);
    for u in [0, 1, 2, 0] {
        ops.push(Op::Deposit { user: u, idx: 1 });
    }
    ops.push(Op::WarpSlots(9_001));
    ops.push(Op::Close { idx: 1 });
    ops.push(Op::Send { idx: 1, pick: 0 });
    // A thin epoch that rolls over, waits a day, and is refunded; then a duplicate is refused.
    ops.push(Op::Deposit { user: 0, idx: 0 });
    ops.push(Op::DepositDuplicate {
        user: 1,
        idx: 0,
        pick: 0,
    });
    ops.push(Op::WarpSlots(9_001));
    ops.push(Op::Close { idx: 0 });
    ops.push(Op::Refund {
        user: 0,
        idx: 0,
        pick: 1,
    });
    ops.push(Op::WarpSecs(86_400 + 3_600));
    ops.push(Op::Refund {
        user: 1,
        idx: 0,
        pick: 4,
    });
    ops.push(Op::Refund {
        user: 0,
        idx: 0,
        pick: 1,
    });
    // $1,000 notes until the deposit cap refuses one.
    for u in [0, 1, 2, 0] {
        ops.push(Op::Deposit { user: u, idx: 1 });
    }
    ops.push(Op::Pause);
    ops.push(Op::Pause);
    // Exits while deposits are paused: batches of both denominations arrive, are claimed, some
    // twice; bad claims and replays fail; and the deposit side above stays exactly as it was.
    ops.push(Op::Exit { idx: 0, n: 3 });
    ops.push(Op::Exit { idx: 1, n: 5 });
    ops.push(Op::Exit { idx: 0, n: 1 });
    for pick in [0, 1, 4, 3, 0, 7, 1, 12, 13] {
        ops.push(Op::Claim { pick });
    }
    ops.push(Op::BadClaim {
        pick: 2,
        redirect: true,
    });
    ops.push(Op::BadClaim {
        pick: 5,
        redirect: false,
    });
    ops.push(Op::ReplayExit {
        pick: 1,
        new_nonce: false,
    });
    ops.push(Op::ReplayExit {
        pick: 2,
        new_nonce: true,
    });
    ops.push(Op::WarpSecs(PAUSE_DURATION_SECS));
    ops.push(Op::Deposit { user: 1, idx: 0 });
    ops.push(Op::Exit { idx: 1, n: 2 });
    for pick in 0..24 {
        ops.push(Op::Claim { pick });
    }
    run(ops);
}
