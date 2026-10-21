//! Unit tests per instruction (S4). Run `anchor build` first, then `cargo test -p eclyps-gateway`.

mod common;
use common::*;
use eclyps_gateway::{
    EpochStatus, Params, FEE_CAP_BPS, FEE_DELAY_SECS, MAX_BATCH_LEAVES, PARAM_DELAY_SECS,
    PAUSE_COOLDOWN_SECS, PAUSE_DURATION_SECS, REFUND_DELAY_SLOTS,
};
use solana_program_pack::Pack;
use solana_signer::Signer;
use spl_token_interface::state::AccountState;

/// What one $100 note costs the depositor at the default fee: $100.50.
const HUNDRED_PAID: u64 = HUNDRED + HUNDRED * FEE_BPS as u64 / 10_000;

// ---------- initialize ----------

#[test]
fn initialize_sets_config_and_escrow() {
    let env = Env::new(default_params());
    let c = env.config();
    assert_eq!(c.denominations, [HUNDRED, THOUSAND, 0, 0]);
    assert_eq!(c.current_epoch, [0; 4]);
    assert_eq!(c.params, default_params());
    assert_eq!((c.params.fee_bps, c.params.finisher_bps), (50, 30));
    assert_eq!(c.escrow, env.escrow);
    assert_eq!(c.fee_vault, env.fee_vault);
    // Exit custody (ADR 0009): a USDC account owned by the exit authority PDA, empty.
    assert_eq!(c.exit_custody, env.exit_custody);
    assert_eq!(env.exit_custody_balance(), 0);
    let custody = spl_token_interface::state::Account::unpack_from_slice(
        &env.svm.get_account(&env.exit_custody).unwrap().data,
    )
    .unwrap();
    assert_eq!(
        (custody.owner, custody.mint),
        (env.exit_authority, env.mint)
    );
    assert_eq!(c.net_deposits, 0);
    assert!(!c.paused_deposits);
    assert_eq!(env.escrow_balance(), 0);
    assert_eq!(env.fee_vault_balance(), 0);
}

#[test]
fn initialize_rejects_out_of_bound_params() {
    let p = default_params();
    assert_eq!(FEE_CAP_BPS, 50);
    let bad = [
        Params {
            fee_bps: FEE_CAP_BPS + 1,
            ..p
        },
        Params {
            fee_bps: 20,
            finisher_bps: 21,
            ..p
        },
        Params {
            deposit_cap: 0,
            ..p
        },
        Params {
            treasury: Pubkey::default(),
            ..p
        },
        Params {
            epoch_len_slots: 2_249,
            ..p
        },
        Params {
            epoch_len_slots: 216_001,
            ..p
        },
        Params {
            min_batch_size: 3,
            ..p
        },
        Params {
            min_batch_size: 65,
            per_epoch_cap: 65,
            ..p
        },
        Params {
            per_epoch_cap: 7,
            ..p
        },
        Params {
            per_epoch_cap: MAX_BATCH_LEAVES + 1,
            ..p
        },
    ];
    for b in bad {
        assert!(
            Env::try_new(vec![HUNDRED], b, 86_400).is_err(),
            "{b:?} accepted"
        );
    }
    for d in [
        vec![],
        vec![0],
        vec![THOUSAND, HUNDRED],
        vec![HUNDRED, HUNDRED],
        vec![1, 2, 3, 4, 5],
    ] {
        assert!(
            Env::try_new(d.clone(), p, 86_400).is_err(),
            "{d:?} accepted"
        );
    }
    assert!(Env::try_new(vec![HUNDRED], p, 0).is_err());
    assert!(Env::try_new(vec![HUNDRED], p, 731 * 86_400).is_err());
    // At the cap, and with the whole fee to the finisher, is fine.
    Env::try_new(
        vec![HUNDRED],
        Params {
            fee_bps: FEE_CAP_BPS,
            finisher_bps: FEE_CAP_BPS,
            ..p
        },
        86_400,
    )
    .unwrap();
}

#[test]
fn initialize_requires_a_usdc_treasury_outside_the_vaults() {
    let p = default_params();
    // Not a token account at all.
    let mut env = Env::deployed();
    let admin = env.admin.insecure_clone();
    let nowhere = Pubkey::new_unique();
    assert!(env
        .initialize(
            &admin,
            vec![HUNDRED],
            Params {
                treasury: nowhere,
                ..p
            },
            86_400
        )
        .is_err());
    // One of the gateway's own vaults, exit custody included (ADR 0009).
    for vault in [env.escrow, env.fee_vault, env.exit_custody] {
        assert!(env
            .initialize(
                &admin,
                vec![HUNDRED],
                Params {
                    treasury: vault,
                    ..p
                },
                86_400
            )
            .is_err());
    }
    // A USDC account anyone owns is fine.
    let (_, other) = env.user(0);
    env.initialize(
        &admin,
        vec![HUNDRED],
        Params {
            treasury: other,
            ..p
        },
        86_400,
    )
    .unwrap();
    assert_eq!(env.config().params.treasury, other);
}

#[test]
fn initialize_requires_the_upgrade_authority() {
    // Nobody can front-run initialization and point every batch at their own portal.
    let mut env = Env::deployed();
    let p = default_params();
    let front_runner = env.stranger();
    assert_err(
        env.initialize(&front_runner, vec![HUNDRED], p, 86_400),
        "NotUpgradeAuthority",
    );
    assert!(env
        .svm
        .get_account(&env.config)
        .is_none_or(|a| a.data.is_empty()));
    // A deployment with no upgrade authority (immutable before init) cannot be initialized either.
    let mut frozen = Env::deployed();
    let key = program_data_pda();
    let mut acc = frozen.svm.get_account(&key).unwrap();
    acc.data[12] = 0;
    frozen.svm.set_account(key, acc).unwrap();
    let admin = frozen.admin.insecure_clone();
    assert_err(
        frozen.initialize(&admin, vec![HUNDRED], p, 86_400),
        "NotUpgradeAuthority",
    );
    let admin = env.admin.insecure_clone();
    env.initialize(&admin, vec![HUNDRED], p, 86_400).unwrap();
    assert_eq!(env.config().admin, admin.pubkey());
}

// ---------- deposit ----------

#[test]
fn deposit_moves_exactly_one_denomination_and_appends_leaf() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED);
    let (v, tb) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    // The deposit alone, once the epoch is open.
    let ix = env.ix_deposit(&v.pubkey(), &tb, 0, leaf(2));
    let meta = env.send(&[ix], &v, &[]).unwrap();
    println!("deposit: {} CU", meta.compute_units_consumed);
    // The note stays exact in the escrow; the fee (0.5 %: $0.50 on $100) waits in the fee vault.
    assert_eq!(env.escrow_balance(), 2 * HUNDRED);
    assert_eq!(env.fee_vault_balance(), 2 * 500_000);
    assert_eq!(env.token_balance(&ta), 10 * HUNDRED - HUNDRED_PAID);
    assert_eq!(env.config().net_deposits, 2 * HUNDRED);
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.leaves, vec![leaf(1), leaf(2)]);
    assert_eq!(e.depositors, vec![u.pubkey(), v.pubkey()]);
    assert_eq!(e.status, EpochStatus::Open);
    assert_eq!(e.denomination, HUNDRED);
    assert_eq!((e.fee_bps, e.finisher_bps), (FEE_BPS, FINISHER_BPS));
    assert_eq!(e.fee_per_note(), 500_000);
}

#[test]
fn deposit_rejects_bad_leaves_and_denominations() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * THOUSAND);
    assert_err(
        env.deposit(&u, &ta, 0, eclyps_merkle::BN254_MODULUS_BE),
        "InvalidLeaf",
    );
    assert_err(env.deposit(&u, &ta, 0, [0xff; 32]), "InvalidLeaf");
    assert_err(env.deposit(&u, &ta, 0, [0; 32]), "InvalidLeaf");
    assert_err(env.deposit(&u, &ta, 2, leaf(1)), "UnknownDenomination");
    assert_err(env.deposit(&u, &ta, 9, leaf(1)), "UnknownDenomination");
    assert_eq!(env.escrow_balance(), 0);
    assert_eq!(env.fee_vault_balance(), 0);
    assert_eq!(env.config().net_deposits, 0);
}

#[test]
fn deposit_rejects_a_commitment_already_in_the_epoch() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * THOUSAND);
    let (v, tb) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    // Whoever repeats it, the second copy could never be claimed and would link the deposits.
    assert_err(env.deposit(&u, &ta, 0, leaf(1)), "DuplicateLeaf");
    assert_err(env.deposit(&v, &tb, 0, leaf(1)), "DuplicateLeaf");
    assert_eq!(env.escrow_balance(), HUNDRED);
    // The program only sees one epoch per deposit, so another epoch accepts the same commitment;
    // clients check every epoch before depositing (sdk/src/recovery.ts findCommitment).
    env.deposit(&u, &ta, 1, leaf(1)).unwrap();
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.leaves, vec![leaf(1)]);
    assert_eq!(e.depositors, vec![u.pubkey()]);
}

#[test]
fn deposit_rejects_insufficient_funds() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(HUNDRED - 1);
    assert!(env.deposit(&u, &ta, 0, leaf(1)).is_err());
    // The note alone is not enough: the fee comes on top.
    let (v, tb) = env.user(HUNDRED_PAID - 1);
    assert!(env.deposit(&v, &tb, 0, leaf(1)).is_err());
    assert_eq!(env.escrow_balance(), 0);
    assert_eq!(env.fee_vault_balance(), 0);
    let (w, tc) = env.user(HUNDRED_PAID);
    env.deposit(&w, &tc, 0, leaf(1)).unwrap();
    assert_eq!(env.token_balance(&tc), 0);
}

#[test]
fn deposit_respects_per_epoch_cap() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * HUNDRED);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    assert_err(env.deposit(&u, &ta, 0, leaf(9)), "EpochFull");
    // A full epoch can be closed before its end slot; deposits go to the next epoch.
    env.close_epoch(0).unwrap();
    env.deposit(&u, &ta, 0, leaf(9)).unwrap();
    assert_eq!(env.epoch(0, 1).unwrap().leaves, vec![leaf(9)]);
}

// ---------- close_epoch ----------

#[test]
fn close_before_end_fails() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    assert_err(env.close_epoch(0), "EpochNotEnded");
}

#[test]
fn close_with_too_few_leaves_rolls_over() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(20 * HUNDRED);
    for i in 0..5 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    let end = env.epoch(0, 0).unwrap().end_slot;
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.status, EpochStatus::Open, "rolled over, not closed");
    assert_eq!(e.rollovers, 1);
    assert!(e.end_slot > end);
    assert_eq!(env.config().current_epoch[0], 0);
    // Leaves stay and new deposits join them.
    for i in 5..8 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.status, EpochStatus::Closed);
    assert_eq!(e.leaves.len(), 8);
}

#[test]
fn close_computes_shared_root_on_chain() {
    let mut env = Env::new(default_params());
    // The 16 note commitments of circuits/vectors/merkle.json.
    let v: serde_json_lite::Value = serde_json_lite::load();
    let (u, ta) = env.user(16 * HUNDRED_PAID);
    let p = Params {
        per_epoch_cap: 16,
        ..default_params()
    };
    let _ = p;
    for l in &v.leaves {
        env.deposit(&u, &ta, 0, *l).unwrap();
    }
    env.warp_slots(9_000);
    let meta = env.close_epoch(0).unwrap();
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(
        e.root, v.root_batch_16,
        "on-chain (syscall) root equals the shared vector"
    );
    assert_eq!(
        e.root,
        eclyps_merkle::root(&e.leaves, eclyps_merkle::BATCH_TREE_DEPTH).unwrap()
    );
    assert_eq!(env.config().current_epoch[0], 1);
    println!(
        "close_epoch with 16 leaves: {} CU",
        meta.compute_units_consumed
    );
    assert_err(env.close_epoch(0), "AccountNotInitialized"); // epoch 1 not opened yet
}

#[test]
fn close_full_256_leaf_batch_fits_compute_budget() {
    let p = Params {
        per_epoch_cap: 256,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(256 * HUNDRED_PAID);
    for i in 0..256 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    // A full batch also carries 256 depositors: it must still fit the 32 KiB heap, in
    // close_epoch and in send_batch.
    let meta = env.close_epoch(0).unwrap();
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.leaves.len(), 256);
    assert_eq!(e.depositors.len(), 256);
    assert_eq!(e.root, eclyps_merkle::root(&e.leaves, 8).unwrap());
    println!(
        "close_epoch with 256 leaves: {} CU",
        meta.compute_units_consumed
    );
    assert!(meta.compute_units_consumed < 1_400_000);
    let (f, fu) = env.finisher();
    let (r, _) = env.send_batch_by(&f, &fu, 0, 0, TMM);
    let meta = r.unwrap();
    println!(
        "send_batch with 256 leaves: {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(env.escrow_balance(), 0);
    assert_eq!(env.fee_vault_balance(), 0);
    assert_eq!(env.token_balance(&fu), 256 * 300_000);
    assert_eq!(env.treasury_balance(), 256 * 200_000);
}

// ---------- send_batch ----------

#[test]
fn send_batch_only_once_and_only_when_closed() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * HUNDRED);
    for i in 0..3 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    assert_err(env.send_batch(0, 0), "EpochNotClosed");
    env.deposit(&u, &ta, 0, leaf(3)).unwrap();
    env.close_epoch(0).unwrap();
    env.send_batch(0, 0).unwrap();
    assert_eq!(env.epoch(0, 0).unwrap().status, EpochStatus::Sent);
    assert_eq!(env.escrow_balance(), 0, "the whole batch was burned");
    assert_err(env.send_batch(0, 0), "EpochNotClosed");
}

/// The gateway PDA burns through Circle's *real* CCTP V2 programs (devnet binaries and state)
/// and the resulting message is exactly what the Ethereum portal expects (ADR 0002).
#[test]
fn send_batch_burns_through_real_cctp_with_bound_hook() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * THOUSAND);
    for i in 0..5 {
        env.deposit(&u, &ta, 1, leaf(i)).unwrap();
    }
    env.warp_slots(9_000);
    env.close_epoch(1).unwrap();
    let root = env.epoch(1, 0).unwrap().root;
    let (r, message_sent) = env.send_batch_with(1, 0, TMM);
    let meta = r.unwrap();
    println!("send_batch (CCTP CPI): {} CU", meta.compute_units_consumed);
    assert_eq!(env.escrow_balance(), 0);

    let m = env.cctp_message(&message_sent);
    let u32_at = |o: usize| u32::from_be_bytes(m[o..o + 4].try_into().unwrap());
    let b32 = |o: usize| <[u8; 32]>::try_from(&m[o..o + 32]).unwrap();
    assert_eq!(u32_at(4), 5, "source domain Solana");
    assert_eq!(u32_at(8), 0, "destination domain Ethereum");
    assert_eq!(b32(44), TMM.to_bytes(), "sender = TokenMessengerMinterV2");
    assert_eq!(b32(108), PORTAL, "destination caller = portal");
    assert_eq!(u32_at(140), 2000, "standard finality");
    assert_eq!(b32(152), DEVNET_USDC.to_bytes(), "burn token");
    assert_eq!(b32(184), PORTAL, "mint recipient = portal");
    let mut amount = [0u8; 32];
    amount[24..].copy_from_slice(&(5 * THOUSAND).to_be_bytes());
    assert_eq!(b32(216), amount);
    assert_eq!(
        b32(248),
        env.config.to_bytes(),
        "messageSender = gateway config PDA"
    );
    assert_eq!(b32(280), [0u8; 32], "max fee 0");
    let hook = eclyps_gateway::batch_hook(THOUSAND, 0, 5, &root);
    assert_eq!(
        &m[376..],
        &hook[..],
        "batch hook bound into the burn message"
    );
}

#[test]
fn send_batch_rejects_fake_cctp_program() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * HUNDRED);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    env.close_epoch(0).unwrap();
    // A malicious finisher substitutes its own "TokenMessenger" to receive the PDA signature.
    let (r, _) = env.send_batch_with(0, 0, Pubkey::new_unique());
    assert_err(r, "ConstraintAddress");
    assert_eq!(env.escrow_balance(), 4 * HUNDRED);
}

#[test]
fn batch_hook_matches_solidity_layout() {
    let root = [0xabu8; 32];
    let h = eclyps_gateway::batch_hook(HUNDRED, 0x1112131415161718, 0x2122, &root);
    assert_eq!(h.len(), 51);
    assert_eq!(h[0], 1);
    assert_eq!(&h[1..9], &HUNDRED.to_be_bytes());
    assert_eq!(h[9], 0x11);
    assert_eq!(&h[17..19], &[0x21, 0x22]);
    assert_eq!(&h[19..], &root);
}

// ---------- pause ----------

#[test]
fn pause_blocks_deposits_only_and_expires() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(20 * HUNDRED);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    let stranger = solana_keypair::Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    assert_err(env.pause(&stranger, true), "NotGuardian");
    let g = env.guardian.insecure_clone();
    env.pause(&g, true).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(10)), "DepositsPaused");
    // Exits/batches are never paused.
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    env.send_batch(0, 0).unwrap();
    assert_eq!(env.escrow_balance(), 0);
    // Auto-expiry.
    env.warp_secs(PAUSE_DURATION_SECS);
    env.deposit(&u, &ta, 0, leaf(11)).unwrap();
    // The guardian cannot pause again until the cooldown after the pause has passed.
    assert_err(env.pause(&g, true), "PauseCooldown");
    env.warp_secs(PAUSE_COOLDOWN_SECS);
    env.pause(&g, true).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(12)), "DepositsPaused");
    // Admin may unpause early; the cooldown then runs from the unpause.
    let a = env.admin.insecure_clone();
    env.pause(&a, false).unwrap();
    env.deposit(&u, &ta, 0, leaf(12)).unwrap();
    assert_eq!(
        env.config().pause_cooldown_until,
        env.clock().unix_timestamp + PAUSE_COOLDOWN_SECS
    );
    assert_err(env.pause(&g, true), "PauseCooldown");
}

#[test]
fn guardian_cannot_keep_deposits_closed_and_expires_at_sunset() {
    let mut env = Env::try_new(vec![HUNDRED], default_params(), 60 * 86_400).unwrap();
    let g = env.guardian.insecure_clone();
    let (u, ta) = env.user(56 * HUNDRED_PAID);
    // Over any long stretch the guardian can pause at most half of the time.
    let mut paused_days = 0;
    for day in 0..56 {
        let _ = env.pause(&g, true);
        match env.deposit(&u, &ta, 0, leaf(100 + day)) {
            Ok(_) => {}
            Err(e) if e.contains("DepositsPaused") => paused_days += 1,
            Err(e) => panic!("unexpected deposit failure: {e}"),
        }
        env.warp_secs(86_400);
    }
    assert!(paused_days <= 28, "paused {paused_days} of 56 days");
    // After the sunset the guardian has no power left; unpausing still works.
    env.warp_secs(30 * 86_400);
    assert_err(env.pause(&g, true), "AdminExpired");
    env.pause(&g, false).unwrap();
}

#[test]
fn admin_rotates_guardian_and_hands_over_in_two_steps() {
    let mut env = Env::new(default_params());
    let a = env.admin.insecure_clone();
    let old_g = env.guardian.insecure_clone();
    let new_g = env.stranger();
    let multisig = env.stranger();
    let stranger = env.stranger();

    assert_err(env.set_guardian(&old_g, new_g.pubkey()), "NotAdmin");
    env.set_guardian(&a, new_g.pubkey()).unwrap();
    assert_err(env.pause(&old_g, true), "NotGuardian");
    env.pause(&new_g, true).unwrap();

    assert_err(env.propose_admin(&stranger, stranger.pubkey()), "NotAdmin");
    assert_err(env.accept_admin(&multisig), "NoPendingAdmin");
    env.propose_admin(&a, multisig.pubkey()).unwrap();
    assert_err(env.accept_admin(&stranger), "NotPendingAdmin");
    let sunset = env.config().admin_expiry_ts;
    env.accept_admin(&multisig).unwrap();
    let c = env.config();
    assert_eq!(c.admin, multisig.pubkey());
    assert_eq!(c.pending_admin, None);
    assert_eq!(
        c.admin_expiry_ts, sunset,
        "handing over never extends the sunset"
    );
    assert_err(env.propose(&a, default_params()), "NotAdmin");
    env.propose(
        &multisig,
        Params {
            per_epoch_cap: 64,
            ..default_params()
        },
    )
    .unwrap();

    // Nothing rotates after the sunset.
    env.propose_admin(&multisig, a.pubkey()).unwrap();
    env.warp_secs(730 * 86_400);
    assert_err(env.accept_admin(&a), "AdminExpired");
    assert_err(env.set_guardian(&multisig, a.pubkey()), "AdminExpired");
}

// ---------- refund_deposit ----------

/// An epoch that cannot form a batch: 2 deposits (min batch 8), rolled over once.
fn stuck_epoch() -> (
    Env,
    solana_keypair::Keypair,
    Pubkey,
    solana_keypair::Keypair,
    Pubkey,
) {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED);
    let (v, tb) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    env.deposit(&v, &tb, 0, leaf(2)).unwrap();
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    assert_eq!(env.epoch(0, 0).unwrap().rollovers, 1);
    (env, u, ta, v, tb)
}

#[test]
fn refund_returns_a_stuck_deposit_to_its_depositor_only() {
    let (mut env, u, ta, v, tb) = stuck_epoch();
    // Too early: the epoch has not been open for the refund delay.
    assert_err(env.refund(&u, &ta, 0, leaf(1)), "NotRefundable");
    let opened = env.epoch(0, 0).unwrap().opened_slot;
    let now = env.clock().slot;
    env.warp_slots(opened + REFUND_DELAY_SLOTS - now);

    // Only the depositor, and only their own leaf; nobody else can redirect it.
    let a = env.admin.insecure_clone();
    assert_err(env.refund(&a, &ta, 0, leaf(1)), "ConstraintTokenOwner");
    assert_err(env.refund(&v, &tb, 0, leaf(1)), "LeafNotFound");
    assert_err(env.refund(&u, &ta, 0, leaf(9)), "LeafNotFound");
    assert_err(env.refund(&u, &tb, 0, leaf(1)), "ConstraintTokenOwner");

    // Pausing deposits never blocks a refund.
    let g = env.guardian.insecure_clone();
    env.pause(&g, true).unwrap();
    let size_before = env.svm.get_account(&epoch_pda(0, 0)).unwrap().data.len();
    let lamports_before = env.svm.get_account(&u.pubkey()).unwrap().lamports;
    let meta = env.refund(&u, &ta, 0, leaf(1)).unwrap();
    println!("refund_deposit: {} CU", meta.compute_units_consumed);
    // The note and the fee it paid: nothing is charged when a batch never crosses.
    assert_eq!(env.token_balance(&ta), 10 * HUNDRED);
    assert_eq!(env.escrow_balance(), HUNDRED);
    assert_eq!(env.fee_vault_balance(), 500_000);
    assert_eq!(env.config().net_deposits, HUNDRED);
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.leaves, vec![leaf(2)]);
    assert_eq!(e.depositors, vec![v.pubkey()]);
    let acc = env.svm.get_account(&epoch_pda(0, 0)).unwrap();
    assert_eq!(acc.data.len(), size_before - 64);
    assert!(
        env.svm.get_account(&u.pubkey()).unwrap().lamports + 5_000 > lamports_before,
        "the freed rent goes back to the depositor"
    );
    // Once only.
    assert_err(env.refund(&u, &ta, 0, leaf(1)), "LeafNotFound");
}

#[test]
fn refund_needs_a_rollover_and_never_touches_a_closed_batch() {
    let mut env = Env::new(Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        ..default_params()
    });
    let (u, ta) = env.user(20 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    // Open long enough, but nobody tried to close it: it might still batch.
    env.warp_slots(REFUND_DELAY_SLOTS);
    assert_err(env.refund(&u, &ta, 0, leaf(1)), "NotRefundable");
    // A batch that formed is on its way; it cannot be refunded.
    for i in 2..5 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    env.close_epoch(0).unwrap();
    assert_eq!(env.epoch(0, 0).unwrap().status, EpochStatus::Closed);
    // The refund instruction only addresses the current epoch: the next one, fresh and open.
    env.deposit(&u, &ta, 0, leaf(5)).unwrap();
    assert_err(env.refund(&u, &ta, 0, leaf(1)), "NotRefundable");
    assert_eq!(env.escrow_balance(), 5 * HUNDRED);
    env.send_batch(0, 0).unwrap();
    assert_eq!(env.escrow_balance(), HUNDRED);
}

#[test]
fn epoch_closes_normally_after_a_refund() {
    let (mut env, u, ta, _v, _tb) = stuck_epoch();
    let opened = env.epoch(0, 0).unwrap().opened_slot;
    let now = env.clock().slot;
    env.warp_slots(opened + REFUND_DELAY_SLOTS - now);
    env.refund(&u, &ta, 0, leaf(1)).unwrap();
    let (w, tw) = env.user(20 * HUNDRED);
    for i in 10..17 {
        env.deposit(&w, &tw, 0, leaf(i)).unwrap();
    }
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    let e = env.epoch(0, 0).unwrap();
    assert_eq!(e.status, EpochStatus::Closed);
    assert_eq!(e.leaves.len(), 8);
    let r = eclyps_merkle::root(&e.leaves, eclyps_merkle::BATCH_TREE_DEPTH).unwrap();
    assert_eq!(e.root, r);
    env.send_batch(0, 0).unwrap();
    assert_eq!(env.escrow_balance(), 0);
}

// ---------- fees and the deposit cap (ADR 0012) ----------

#[test]
fn send_batch_pays_the_finisher_and_the_treasury_exactly() {
    // An odd denomination, so every share rounds down: 1_234_567 x 0.5 % = 6_172.8 -> 6_172 per
    // note; the finisher's 0.3 % = 3_703.7 -> 3_703; the treasury gets the rest, 2_469.
    const D: u64 = 1_234_567;
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        ..default_params()
    };
    let mut env = Env::try_new(vec![D], p, 730 * 86_400).unwrap();
    assert_eq!(
        (fee_of(D, FEE_BPS), fee_of(D, FINISHER_BPS)),
        (6_172, 3_703)
    );
    let (u, ta) = env.user(100 * D);
    for i in 0..5 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    assert_eq!(env.token_balance(&ta), 100 * D - 5 * (D + 6_172));
    assert_eq!(env.escrow_balance(), 5 * D);
    assert_eq!(env.fee_vault_balance(), 5 * 6_172);
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    // Closing pays nothing: fees leave the vault only when the batch crosses.
    assert_eq!(env.fee_vault_balance(), 5 * 6_172);
    assert_eq!(env.treasury_balance(), 0);

    let (f, fu) = env.finisher();
    let (r, _) = env.send_batch_by(&f, &fu, 0, 0, TMM);
    r.unwrap();
    assert_eq!(env.token_balance(&fu), 5 * 3_703);
    assert_eq!(env.treasury_balance(), 5 * 2_469);
    assert_eq!(env.fee_vault_balance(), 0);
    assert_eq!(env.escrow_balance(), 0);
}

#[test]
fn the_finisher_is_paid_only_into_its_own_usdc_account() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * HUNDRED);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    env.close_epoch(0).unwrap();
    let (f, _) = env.finisher();
    let (_, someone_else) = env.user(0);
    let (r, _) = env.send_batch_by(&f, &someone_else, 0, 0, TMM);
    assert_err(r, "ConstraintTokenOwner");
    assert_eq!(env.fee_vault_balance(), 4 * 500_000);
    assert_eq!(env.escrow_balance(), 4 * HUNDRED);
}

#[test]
fn a_fee_change_applies_from_the_next_epoch() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        ..default_params()
    };
    let mut env = Env::new(p);
    let a = env.admin.insecure_clone();
    let (u, ta) = env.user(100 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    env.deposit(&u, &ta, 0, leaf(2)).unwrap();

    // A lower fee, another split and another treasury: the fee timelock.
    let (_, t2) = env.user(0);
    let new = Params {
        fee_bps: 20,
        finisher_bps: 5,
        treasury: t2,
        ..p
    };
    env.propose(&a, new).unwrap();
    env.warp_secs(PARAM_DELAY_SECS);
    assert_err(env.apply(), "TimelockActive");
    env.warp_secs(FEE_DELAY_SECS - PARAM_DELAY_SECS);
    env.apply().unwrap();
    assert_eq!(env.config().params, new);

    // Epoch 0 opened at 0.5 %: deposits made into it after the change pay that too.
    env.deposit(&u, &ta, 0, leaf(3)).unwrap();
    env.deposit(&u, &ta, 0, leaf(4)).unwrap();
    assert_eq!(env.fee_vault_balance(), 4 * 500_000);
    env.close_epoch(0).unwrap();
    assert_eq!(env.epoch(0, 0).unwrap().status, EpochStatus::Closed);

    // Epoch 1 opens at the new fee: $0.20 per $100 note.
    for i in 5..9 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    let e1 = env.epoch(0, 1).unwrap();
    assert_eq!((e1.fee_bps, e1.finisher_bps), (20, 5));
    assert_eq!(env.fee_vault_balance(), 4 * 500_000 + 4 * 200_000);
    assert_eq!(
        env.token_balance(&ta),
        100 * HUNDRED - 4 * (HUNDRED + 500_000) - 4 * (HUNDRED + 200_000)
    );

    // Each batch pays out at its own snapshot, to the treasury named now.
    let (f, fu) = env.finisher();
    env.send_batch_by(&f, &fu, 0, 0, TMM).0.unwrap();
    assert_eq!(env.token_balance(&fu), 4 * 300_000);
    assert_eq!(env.token_balance(&t2), 4 * 200_000);
    assert_eq!(env.token_balance(&TREASURY), 0);
    assert_eq!(env.fee_vault_balance(), 4 * 200_000);
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    let (g, gu) = env.finisher();
    env.send_batch_by(&g, &gu, 0, 1, TMM).0.unwrap();
    assert_eq!(env.token_balance(&gu), 4 * 50_000);
    assert_eq!(env.token_balance(&t2), 4 * 200_000 + 4 * 150_000);
    assert_eq!(env.fee_vault_balance(), 0);
}

#[test]
fn fee_split_and_treasury_changes_wait_the_fee_timelock() {
    let mut env = Env::new(default_params());
    let a = env.admin.insecure_clone();
    let p = default_params();
    let (_, t2) = env.user(0);
    for change in [
        Params { fee_bps: 40, ..p },
        Params {
            finisher_bps: 10,
            ..p
        },
        Params { treasury: t2, ..p },
    ] {
        env.propose(&a, change).unwrap();
        let eta = env.config().pending.unwrap().eta;
        assert_eq!(
            eta,
            env.clock().unix_timestamp + FEE_DELAY_SECS,
            "{change:?}"
        );
    }
    env.propose(
        &a,
        Params {
            deposit_cap: 2 * BIG_CAP,
            ..p
        },
    )
    .unwrap();
    let eta = env.config().pending.unwrap().eta;
    assert_eq!(eta, env.clock().unix_timestamp + PARAM_DELAY_SECS);
    // The treasury is never one of the gateway's own vaults.
    for vault in [env.escrow, env.fee_vault] {
        assert_err(
            env.propose(
                &a,
                Params {
                    treasury: vault,
                    ..p
                },
            ),
            "InvalidTreasury",
        );
    }
}

#[test]
fn the_deposit_cap_blocks_the_deposit_past_it_and_refunds_free_room() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        deposit_cap: 5 * HUNDRED,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * THOUSAND);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    env.send_batch(0, 0).unwrap();
    // A batch that crossed still counts: the cap bounds everything that has entered.
    assert_eq!(env.config().net_deposits, 4 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(4)).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(5)), "DepositCapReached");
    assert_err(env.deposit(&u, &ta, 1, leaf(5)), "DepositCapReached");
    assert_eq!(env.config().net_deposits, 5 * HUNDRED);
    assert_eq!(env.escrow_balance(), HUNDRED);

    // The thin epoch rolls over; once refundable, taking the note back frees its room.
    env.warp_slots(9_000);
    env.close_epoch(0).unwrap();
    let opened = env.epoch(0, 1).unwrap().opened_slot;
    let now = env.clock().slot;
    env.warp_slots(opened + REFUND_DELAY_SLOTS - now);
    env.refund(&u, &ta, 0, leaf(4)).unwrap();
    assert_eq!(env.config().net_deposits, 4 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(5)).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(6)), "DepositCapReached");
}

#[test]
fn the_deposit_cap_is_raise_only_and_timelocked() {
    let p = Params {
        deposit_cap: 2 * HUNDRED,
        ..default_params()
    };
    let mut env = Env::new(p);
    let a = env.admin.insecure_clone();
    let (u, ta) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    env.deposit(&u, &ta, 0, leaf(2)).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(3)), "DepositCapReached");
    assert_err(
        env.propose(
            &a,
            Params {
                deposit_cap: HUNDRED,
                ..p
            },
        ),
        "CapLowered",
    );
    let raised = Params {
        deposit_cap: 3 * HUNDRED,
        ..p
    };
    env.propose(&a, raised).unwrap();
    env.warp_secs(PARAM_DELAY_SECS - 1);
    assert_err(env.apply(), "TimelockActive");
    assert_err(env.deposit(&u, &ta, 0, leaf(3)), "DepositCapReached");
    env.warp_secs(1);
    env.apply().unwrap();
    env.deposit(&u, &ta, 0, leaf(3)).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(4)), "DepositCapReached");
}

#[test]
fn a_treasury_that_cannot_receive_never_blocks_a_batch() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        ..default_params()
    };
    for broken in ["frozen", "closed", "another mint"] {
        let mut env = Env::new(p);
        match broken {
            "frozen" => env.set_usdc_account(TREASURY, &TREASURY_OWNER, 0, AccountState::Frozen),
            "closed" => env
                .svm
                .set_account(
                    TREASURY,
                    solana_account::Account {
                        lamports: 0,
                        data: vec![],
                        owner: anchor_lang::system_program::ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap(),
            _ => {
                let mut acc = env.svm.get_account(&TREASURY).unwrap();
                acc.data[..32].copy_from_slice(Pubkey::new_unique().as_ref());
                env.svm.set_account(TREASURY, acc).unwrap();
            }
        }
        let (u, ta) = env.user(10 * HUNDRED);
        for i in 0..4 {
            env.deposit(&u, &ta, 0, leaf(i)).unwrap();
        }
        env.close_epoch(0).unwrap();
        let (f, fu) = env.finisher();
        env.send_batch_by(&f, &fu, 0, 0, TMM).0.unwrap();
        assert_eq!(
            env.token_balance(&fu),
            4 * 500_000,
            "{broken}: the whole fee goes to the finisher"
        );
        assert_eq!(env.fee_vault_balance(), 0, "{broken}");
        assert_eq!(env.escrow_balance(), 0, "{broken}");
        assert_eq!(env.epoch(0, 0).unwrap().status, EpochStatus::Sent);
    }
}

#[test]
fn no_fee_means_no_fee_transfers() {
    let p = Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        fee_bps: 0,
        finisher_bps: 0,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(4 * HUNDRED);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    assert_eq!(env.token_balance(&ta), 0);
    assert_eq!(env.fee_vault_balance(), 0);
    env.close_epoch(0).unwrap();
    let (f, fu) = env.finisher();
    env.send_batch_by(&f, &fu, 0, 0, TMM).0.unwrap();
    assert_eq!(env.token_balance(&fu), 0);
    assert_eq!(env.treasury_balance(), 0);
}

// ---------- governance ----------

#[test]
fn params_are_bounded_timelocked_and_sunset() {
    let mut env = Env::new(default_params());
    let a = env.admin.insecure_clone();
    let g = env.guardian.insecure_clone();
    let p = default_params();

    assert_err(
        env.propose(
            &g,
            Params {
                per_epoch_cap: 64,
                ..p
            },
        ),
        "NotAdmin",
    );
    assert_err(
        env.propose(&a, Params { fee_bps: 51, ..p }),
        "ParamOutOfBounds",
    );
    assert_err(
        env.propose(
            &a,
            Params {
                fee_bps: 20,
                finisher_bps: 25,
                ..p
            },
        ),
        "ParamOutOfBounds",
    );
    assert_err(
        env.propose(
            &a,
            Params {
                per_epoch_cap: 16,
                ..p
            },
        ),
        "CapLowered",
    );

    env.propose(
        &a,
        Params {
            per_epoch_cap: 64,
            ..p
        },
    )
    .unwrap();
    assert_err(env.apply(), "TimelockActive");
    env.warp_secs(7 * 86_400);
    env.apply().unwrap();
    assert_eq!(env.config().params.per_epoch_cap, 64);
    assert_err(env.apply(), "NoPendingParams");

    // Fee changes wait 14 days.
    let p2 = env.config().params;
    env.propose(&a, Params { fee_bps: 30, ..p2 }).unwrap();
    env.warp_secs(7 * 86_400);
    assert_err(env.apply(), "TimelockActive");
    env.warp_secs(7 * 86_400);
    env.apply().unwrap();
    assert_eq!(env.config().params.fee_bps, 30);

    // Sunset: nothing can be proposed or applied after admin_expiry_ts.
    env.propose(
        &a,
        Params {
            per_epoch_cap: 128,
            ..env.config().params
        },
    )
    .unwrap();
    env.warp_secs(730 * 86_400);
    assert_err(env.apply(), "AdminExpired");
    assert_err(
        env.propose(
            &a,
            Params {
                per_epoch_cap: 256,
                ..env.config().params
            },
        ),
        "AdminExpired",
    );
}

// ---------- escrow custody ----------

#[test]
fn nobody_can_move_escrow_directly() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    // Escrow and fee vault authority is the config PDA: a direct SPL transfer signed by anyone
    // else fails.
    for vault in [env.escrow, env.fee_vault] {
        for thief in [
            env.admin.insecure_clone(),
            env.guardian.insecure_clone(),
            u.insecure_clone(),
        ] {
            let ix = spl_token_interface::instruction::transfer(
                &spl_token_interface::ID,
                &vault,
                &ta,
                &thief.pubkey(),
                &[],
                1,
            )
            .unwrap();
            assert!(env.send(&[ix], &thief, &[]).is_err());
        }
    }
    assert_eq!(env.escrow_balance(), HUNDRED);
    assert_eq!(env.fee_vault_balance(), 500_000);
}

/// Tiny reader for circuits/vectors/merkle.json without pulling serde into the program crate.
mod serde_json_lite {
    pub struct Value {
        pub leaves: Vec<[u8; 32]>,
        pub root_batch_16: [u8; 32],
    }

    fn hex32(s: &str) -> [u8; 32] {
        let s = s.trim_start_matches("0x");
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    fn field<'a>(text: &'a str, key: &str) -> &'a str {
        let k = format!("\"{key}\": \"");
        let start = text.find(&k).unwrap() + k.len();
        &text[start..start + 66]
    }

    pub fn load() -> Value {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../circuits/vectors/merkle.json"
        ))
        .unwrap();
        let leaves = text
            .match_indices("\"commitment\": \"")
            .map(|(i, m)| hex32(&text[i + m.len()..i + m.len() + 66]))
            .collect();
        Value {
            leaves,
            root_batch_16: hex32(field(&text, "root_batch_depth_16_leaves")),
        }
    }
}

#[test]
fn open_epoch_is_idempotent_and_survives_prefunded_pda() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED);
    // Griefing attempt: pre-fund the next epoch PDA so a plain create_account would fail.
    let next = epoch_pda(0, 0);
    let griefer = solana_keypair::Keypair::new();
    env.svm.airdrop(&griefer.pubkey(), 1_000_000_000).unwrap();
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &griefer.pubkey(),
        &next,
        1_000_000,
    );
    env.send(&[ix], &griefer, &[]).unwrap();
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    // Re-opening an already open (and grown) epoch is a no-op.
    let ixs = [
        env.ix_open_epoch(&u.pubkey(), 0),
        env.ix_open_epoch(&u.pubkey(), 0),
    ];
    env.send(&ixs, &u, &[]).unwrap();
    env.deposit(&u, &ta, 0, leaf(2)).unwrap();
    assert_eq!(env.epoch(0, 0).unwrap().leaves, vec![leaf(1), leaf(2)]);
}

// ---------- client fixtures ----------

/// Real Config and Epoch account bytes for the TypeScript decoders (sdk/test/accounts.test.ts).
/// `ECLYPS_WRITE_FIXTURES=1 cargo test -p eclyps-gateway account_fixtures` rewrites the file;
/// otherwise the test fails if the program's layout no longer matches it.
#[test]
fn account_fixtures_for_the_sdk() {
    use base64::Engine;
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED);
    let (v, tb) = env.user(10 * HUNDRED);
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    env.deposit(&v, &tb, 0, leaf(2)).unwrap();
    let a = env.admin.insecure_clone();
    let g = env.guardian.insecure_clone();
    env.pause(&g, true).unwrap();
    env.propose(
        &a,
        Params {
            per_epoch_cap: 64,
            ..default_params()
        },
    )
    .unwrap();
    env.propose_admin(&a, v.pubkey()).unwrap();
    let b64 = |k: &Pubkey| {
        base64::engine::general_purpose::STANDARD.encode(&env.svm.get_account(k).unwrap().data)
    };
    let c = env.config();
    let e = env.epoch(0, 0).unwrap();
    let hex = |b: &[u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let fixture = serde_json::json!({
        "config": {
            "data": b64(&env.config),
            "admin": c.admin.to_string(),
            "guardian": c.guardian.to_string(),
            "pendingAdmin": v.pubkey().to_string(),
            "escrow": c.escrow.to_string(),
            "feeVault": c.fee_vault.to_string(),
            "exitCustody": c.exit_custody.to_string(),
            "treasury": c.params.treasury.to_string(),
            "netDeposits": c.net_deposits.to_string(),
            "depositCap": c.params.deposit_cap.to_string(),
        },
        "epoch": {
            "data": b64(&epoch_pda(0, 0)),
            "leaves": e.leaves.iter().map(hex).collect::<Vec<_>>(),
            "depositors": [u.pubkey().to_string(), v.pubkey().to_string()],
            "feeBps": e.fee_bps,
            "finisherBps": e.finisher_bps,
        },
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/test/fixtures/gateway-accounts.json"
    );
    // Keys are random per run, so compare the layout-bearing parts: sizes and the fields the
    // SDK decodes are checked in TypeScript against the values recorded alongside the bytes.
    if std::env::var("ECLYPS_WRITE_FIXTURES").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
    }
    let committed: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(path).expect("fixture: run with ECLYPS_WRITE_FIXTURES=1"),
    )
    .unwrap();
    for k in ["config", "epoch"] {
        let len = |v: &serde_json::Value| {
            base64::engine::general_purpose::STANDARD
                .decode(v[k]["data"].as_str().unwrap())
                .unwrap()
                .len()
        };
        assert_eq!(
            len(&committed),
            len(&fixture),
            "{k} account layout changed: regenerate the fixture"
        );
    }
}
