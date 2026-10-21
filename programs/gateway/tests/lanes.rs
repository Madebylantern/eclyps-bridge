//! V2 lanes in LiteSVM against Circle's real CCTP V2 programs: Cross now (ADR 0015: express
//! epochs paid by the crossing pool, then by the user), fronted exits (ADR 0017: `front_exit`,
//! the Front check in `claim_exit`) and the liquidity pool that funds fronts (ADR 0017, amended).
//! Run `anchor build` (or `cargo build-sbf`) first.

mod common;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use common::*;
use eclyps_gateway::{
    accounts, instruction, EpochStatus, ExpressEpoch, Front, LaneParams, Lanes, Liquidity,
    LpPosition, Params, CROSSING_POOL_SEED, EXPRESS_EPOCH_BIT, EXPRESS_SEED, FEE_DELAY_SECS,
    FRONT_FEE_HARD_CAP_BPS, FRONT_WRITE_OFF_SECS, LANES_SEED, LIQUIDITY_SEED, LIQUIDITY_VAULT_SEED,
    LP_SEED, MAX_EXPRESS_FEE, PARAM_DELAY_SECS,
};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_token_interface::state::AccountState;

const EXPRESS_FEE: u64 = 1_200_000; // $1.20
const FRONT_CAP_BPS: u16 = 30;
const POOL_FEE_BPS: u16 = 10;

fn lanes_pda() -> Pubkey {
    pda(&[LANES_SEED])
}
fn crossing_pool() -> Pubkey {
    pda(&[CROSSING_POOL_SEED])
}
fn liquidity_pda() -> Pubkey {
    pda(&[LIQUIDITY_SEED])
}
fn liquidity_vault() -> Pubkey {
    pda(&[LIQUIDITY_VAULT_SEED])
}
fn express_pda(idx: u8, id: u64) -> Pubkey {
    pda(&[EXPRESS_SEED, &[idx], &id.to_le_bytes()])
}
fn lp_pda(owner: &Pubkey) -> Pubkey {
    pda(&[LP_SEED, owner.as_ref()])
}

fn lane_params(keeper: Pubkey) -> LaneParams {
    LaneParams {
        express_fee: EXPRESS_FEE,
        front_fee_cap_bps: FRONT_CAP_BPS,
        pool_fee_bps: POOL_FEE_BPS,
        pool_max_outstanding: 10 * THOUSAND,
        keeper,
    }
}

/// Small batches so normal epochs can close in a test.
fn params() -> Params {
    Params {
        min_batch_size: 4,
        per_epoch_cap: 8,
        ..default_params()
    }
}

struct V2 {
    env: Env,
    keeper: Keypair,
}

impl V2 {
    fn new() -> Self {
        let mut env = Env::new(params());
        let keeper = env.stranger();
        let admin = env.admin.insecure_clone();
        let mut v = V2 { env, keeper };
        v.init_lanes(&admin, lane_params(v.keeper.pubkey()))
            .unwrap();
        v
    }

    fn init_lanes(&mut self, signer: &Keypair, p: LaneParams) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::InitLanes {
                admin: signer.pubkey(),
                config: self.env.config,
                lanes: lanes_pda(),
                crossing_pool: crossing_pool(),
                liquidity: liquidity_pda(),
                liquidity_vault: liquidity_vault(),
                usdc_mint: self.env.mint,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::InitLanes { params: p }.data(),
        };
        self.env.send(&[ix], signer, &[])
    }

    fn lanes(&self) -> Lanes {
        let a = self.env.svm.get_account(&lanes_pda()).unwrap();
        Lanes::try_deserialize(&mut &a.data[..]).unwrap()
    }
    fn liquidity(&self) -> Liquidity {
        let a = self.env.svm.get_account(&liquidity_pda()).unwrap();
        Liquidity::try_deserialize(&mut &a.data[..]).unwrap()
    }
    fn express(&self, idx: u8, id: u64) -> ExpressEpoch {
        let a = self.env.svm.get_account(&express_pda(idx, id)).unwrap();
        ExpressEpoch::try_deserialize(&mut &a.data[..]).unwrap()
    }
    fn front_rec(&self, leaf: &[u8; 32]) -> Option<Front> {
        let a = self.env.svm.get_account(&front_pda(leaf))?;
        if a.data.is_empty() {
            return None;
        }
        Some(Front::try_deserialize(&mut &a.data[..]).unwrap())
    }
    fn position(&self, owner: &Pubkey) -> LpPosition {
        let a = self.env.svm.get_account(&lp_pda(owner)).unwrap();
        LpPosition::try_deserialize(&mut &a.data[..]).unwrap()
    }

    /// Tops up the crossing pool, as anyone can: a plain SPL transfer.
    fn fund_pool(&mut self, amount: u64) {
        let have = self.env.token_balance(&crossing_pool());
        let cfg = self.env.config;
        self.env.set_usdc_account(
            crossing_pool(),
            &cfg,
            have + amount,
            AccountState::Initialized,
        );
    }

    fn ix_deposit_express(
        &self,
        user: &Pubkey,
        source: &Pubkey,
        idx: u8,
        leaf: [u8; 32],
        max_express_fee: u64,
    ) -> Instruction {
        let id = self.lanes().express_id(idx);
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::DepositExpress {
                payer: *user,
                authority: *user,
                config: self.env.config,
                lanes: lanes_pda(),
                express: express_pda(idx, id),
                source: *source,
                escrow: self.env.escrow,
                fee_vault: self.env.fee_vault,
                crossing_pool: crossing_pool(),
                usdc_mint: self.env.mint,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
                blocked: blocked_pda(user),
            }
            .to_account_metas(None),
            data: instruction::DepositExpress {
                denomination_index: idx,
                secret_hash: leaf,
                max_express_fee,
            }
            .data(),
        }
    }

    fn deposit_express(
        &mut self,
        user: &Keypair,
        source: &Pubkey,
        idx: u8,
        leaf: [u8; 32],
        max_express_fee: u64,
    ) -> TxResult {
        let ix = self.ix_deposit_express(&user.pubkey(), source, idx, leaf, max_express_fee);
        self.env.send(&[ix], user, &[])
    }

    fn send_express(
        &mut self,
        finisher: &Keypair,
        finisher_usdc: &Pubkey,
        idx: u8,
        id: u64,
    ) -> (TxResult, Pubkey) {
        let event = Keypair::new();
        let env = &self.env;
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::SendExpressBatch {
                payer: finisher.pubkey(),
                config: env.config,
                express: express_pda(idx, id),
                escrow: env.escrow,
                fee_vault: env.fee_vault,
                finisher_usdc: *finisher_usdc,
                treasury: env.config().params.treasury,
                usdc_mint: env.mint,
                message_sent_event_data: event.pubkey(),
                cctp_sender_authority: tmm_pda(&[b"sender_authority"]),
                cctp_denylist: tmm_pda(&[b"denylist_account", env.config.as_ref()]),
                cctp_message_transmitter: Pubkey::find_program_address(
                    &[b"message_transmitter"],
                    &MT,
                )
                .0,
                cctp_token_messenger: tmm_pda(&[b"token_messenger"]),
                cctp_remote_token_messenger: tmm_pda(&[b"remote_token_messenger", b"0"]),
                cctp_token_minter: tmm_pda(&[b"token_minter"]),
                cctp_local_token: tmm_pda(&[b"local_token", env.mint.as_ref()]),
                cctp_event_authority: tmm_pda(&[b"__event_authority"]),
                cctp_message_transmitter_program: MT,
                cctp_token_messenger_minter_program: TMM,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::SendExpressBatch {
                denomination_index: idx,
                express_id: id,
            }
            .data(),
        };
        let r = self
            .env
            .send(&[compute_budget(400_000), ix], finisher, &[&event]);
        (r, event.pubkey())
    }

    #[allow(clippy::too_many_arguments)]
    fn ix_front(
        &self,
        solver: &Pubkey,
        solver_usdc: &Pubkey,
        payee: &Pubkey,
        idx: u8,
        exit_epoch_id: u64,
        destination: Pubkey,
        secret: [u8; 32],
        fee: u64,
    ) -> Instruction {
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::FrontExit {
                solver: *solver,
                config: self.env.config,
                lanes: lanes_pda(),
                exit_batch: exit_batch_pda(idx, exit_epoch_id),
                front: front_pda(&eclyps_gateway::front_seed(&destination, &secret)),
                solver_usdc: *solver_usdc,
                payee_usdc: *payee,
                destination_wallet: destination,
                destination_usdc: ata(&destination, &self.env.mint),
                usdc_mint: self.env.mint,
                token_program: spl_token_interface::ID,
                associated_token_program: ATA_PROGRAM,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::FrontExit {
                denomination_index: idx,
                exit_epoch_id,
                destination,
                secret,
                fee,
            }
            .data(),
        }
    }

    /// A solver fronts leaf `i` of `tree` from its own USDC, repaid to the same account.
    #[allow(clippy::too_many_arguments)]
    fn front(
        &mut self,
        solver: &Keypair,
        solver_usdc: &Pubkey,
        idx: u8,
        exit_epoch_id: u64,
        tree: &ExitTree,
        i: usize,
        fee: u64,
    ) -> TxResult {
        let ix = self.ix_front(
            &solver.pubkey(),
            solver_usdc,
            solver_usdc,
            idx,
            exit_epoch_id,
            tree.destinations[i],
            tree.secrets[i],
            fee,
        );
        self.env.send(&[ix], solver, &[])
    }

    fn front_from_pool(
        &mut self,
        keeper: &Keypair,
        idx: u8,
        exit_epoch_id: u64,
        tree: &ExitTree,
        i: usize,
    ) -> TxResult {
        let (destination, secret) = (tree.destinations[i], tree.secrets[i]);
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::FrontExitFromPool {
                keeper: keeper.pubkey(),
                config: self.env.config,
                lanes: lanes_pda(),
                liquidity: liquidity_pda(),
                vault: liquidity_vault(),
                exit_batch: exit_batch_pda(idx, exit_epoch_id),
                front: front_pda(&eclyps_gateway::front_seed(&destination, &secret)),
                destination_wallet: destination,
                destination_usdc: ata(&destination, &self.env.mint),
                usdc_mint: self.env.mint,
                token_program: spl_token_interface::ID,
                associated_token_program: ATA_PROGRAM,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::FrontExitFromPool {
                denomination_index: idx,
                exit_epoch_id,
                destination,
                secret,
            }
            .data(),
        };
        self.env.send(&[ix], keeper, &[])
    }

    /// claim_exit naming the fronted leaf's payee, rent payer and the liquidity pool.
    fn claim_fronted(
        &mut self,
        idx: u8,
        exit_epoch_id: u64,
        tree: &ExitTree,
        i: usize,
        payee: Pubkey,
        rent: Pubkey,
    ) -> TxResult {
        let payer = self.env.stranger();
        let mut ix = self.env.ix_claim_exit(
            &payer.pubkey(),
            idx,
            exit_epoch_id,
            i as u16,
            tree.path(i),
            tree.destinations[i],
            tree.secrets[i],
        );
        let n = ix.accounts.len();
        ix.accounts[n - 3].pubkey = payee;
        ix.accounts[n - 2].pubkey = rent;
        ix.accounts[n - 1].pubkey = liquidity_pda();
        self.env.send(&[ix], &payer, &[])
    }

    fn lp_deposit(&mut self, owner: &Keypair, source: &Pubkey, amount: u64) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::LpDeposit {
                owner: owner.pubkey(),
                config: self.env.config,
                liquidity: liquidity_pda(),
                vault: liquidity_vault(),
                position: lp_pda(&owner.pubkey()),
                source: *source,
                usdc_mint: self.env.mint,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::LpDeposit { amount }.data(),
        };
        self.env.send(&[ix], owner, &[])
    }

    fn lp_withdraw(&mut self, owner: &Keypair, destination: &Pubkey, shares: u64) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::LpWithdraw {
                owner: owner.pubkey(),
                config: self.env.config,
                liquidity: liquidity_pda(),
                vault: liquidity_vault(),
                position: lp_pda(&owner.pubkey()),
                destination: *destination,
                usdc_mint: self.env.mint,
                token_program: spl_token_interface::ID,
            }
            .to_account_metas(None),
            data: instruction::LpWithdraw { shares }.data(),
        };
        self.env.send(&[ix], owner, &[])
    }

    fn write_off(&mut self, leaf: [u8; 32]) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::WriteOffFront {
                front: front_pda(&leaf),
                liquidity: liquidity_pda(),
            }
            .to_account_metas(None),
            data: instruction::WriteOffFront { leaf }.data(),
        };
        let p = self.env.stranger();
        self.env.send(&[ix], &p, &[])
    }

    fn propose_lanes(&mut self, signer: &Keypair, p: LaneParams) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::LanesAdmin {
                admin: signer.pubkey(),
                config: self.env.config,
                lanes: lanes_pda(),
            }
            .to_account_metas(None),
            data: instruction::ProposeLaneParams { params: p }.data(),
        };
        self.env.send(&[ix], signer, &[])
    }

    fn apply_lanes(&mut self) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::ApplyLaneParams {
                config: self.env.config,
                lanes: lanes_pda(),
            }
            .to_account_metas(None),
            data: instruction::ApplyLaneParams {}.data(),
        };
        let p = self.env.stranger();
        self.env.send(&[ix], &p, &[])
    }

    fn disable_pool_fronts(&mut self, signer: &Keypair) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::DisablePoolFronts {
                signer: signer.pubkey(),
                config: self.env.config,
                lanes: lanes_pda(),
            }
            .to_account_metas(None),
            data: instruction::DisablePoolFronts {}.data(),
        };
        self.env.send(&[ix], signer, &[])
    }
}

// =============================================================== init

#[test]
fn init_lanes_is_admin_only_once_and_leaves_v1_alone() {
    let mut env = Env::new(params());
    let before = env.svm.get_account(&env.config).unwrap().data;
    let stranger = env.stranger();
    let mut v = V2 {
        env,
        keeper: Keypair::new(),
    };
    assert_err(
        v.init_lanes(&stranger, lane_params(Pubkey::default())),
        "NotAdmin",
    );
    let admin = v.env.admin.insecure_clone();
    // Hard bounds.
    for bad in [
        LaneParams {
            express_fee: MAX_EXPRESS_FEE + 1,
            ..lane_params(Pubkey::default())
        },
        LaneParams {
            front_fee_cap_bps: FRONT_FEE_HARD_CAP_BPS + 1,
            pool_fee_bps: 0,
            ..lane_params(Pubkey::default())
        },
        LaneParams {
            pool_fee_bps: FRONT_CAP_BPS + 1,
            ..lane_params(Pubkey::default())
        },
    ] {
        assert_err(v.init_lanes(&admin, bad), "LaneParamOutOfBounds");
    }
    v.init_lanes(&admin, lane_params(Pubkey::default()))
        .unwrap();
    let l = v.lanes();
    assert_eq!(l.version, 1);
    assert_eq!(l.params, lane_params(Pubkey::default()));
    assert_eq!(l.crossing_pool, crossing_pool());
    assert_eq!(l.express_next, [0; 4]);
    assert_eq!(v.liquidity().vault, liquidity_vault());
    assert_eq!(v.env.token_balance(&crossing_pool()), 0);
    // Once.
    v.env.svm.expire_blockhash();
    assert!(v
        .init_lanes(&admin, lane_params(Pubkey::default()))
        .is_err());
    // The V1 config account is byte for byte the same: no migration.
    assert_eq!(v.env.svm.get_account(&v.env.config).unwrap().data, before);
}

// =============================================================== Cross now (ADR 0015)

#[test]
fn express_crossing_paid_by_the_pool_burns_a_batch_of_one_through_real_cctp() {
    let mut v = V2::new();
    v.fund_pool(2 * EXPRESS_FEE);
    let fee = fee_of(THOUSAND, FEE_BPS);
    let finisher_fee = fee_of(THOUSAND, FINISHER_BPS);
    let (u, ta) = v.env.user(THOUSAND + fee);
    // The user asks for "on us": no express fee from the wallet.
    let meta = v.deposit_express(&u, &ta, 1, leaf(1), 0).unwrap();
    println!("deposit_express: {} CU", meta.compute_units_consumed);
    assert_eq!(
        v.env.token_balance(&ta),
        0,
        "denomination + fee, nothing more"
    );
    assert_eq!(v.env.token_balance(&crossing_pool()), EXPRESS_FEE);
    assert_eq!(v.env.escrow_balance(), THOUSAND);
    assert_eq!(v.env.fee_vault_balance(), fee + EXPRESS_FEE);
    let id = EXPRESS_EPOCH_BIT;
    let x = v.express(1, id);
    assert_eq!(x.status, EpochStatus::Closed);
    assert_eq!(x.express_id, id);
    assert_eq!(x.leaf, leaf(1));
    assert!(x.paid_by_pool);
    let root = eclyps_merkle::root(&[leaf(1)], 8).unwrap();
    assert_eq!(x.root, root);
    assert_eq!(v.lanes().express_next, [0, 1, 0, 0]);
    assert_eq!(v.lanes().pool_paid, EXPRESS_FEE);
    assert_eq!(v.env.config().net_deposits, THOUSAND);
    // Normal epochs untouched.
    assert_eq!(v.env.config().current_epoch, [0; 4]);
    assert!(v.env.epoch(1, 0).is_none());

    let (f, fu) = v.env.finisher();
    let (r, message_sent) = v.send_express(&f, &fu, 1, id);
    let meta = r.unwrap();
    println!(
        "send_express_batch (CCTP CPI): {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(v.env.escrow_balance(), 0);
    assert_eq!(v.env.fee_vault_balance(), 0);
    assert_eq!(v.env.token_balance(&fu), finisher_fee + EXPRESS_FEE);
    assert_eq!(v.env.treasury_balance(), fee - finisher_fee);
    assert_eq!(v.express(1, id).status, EpochStatus::Sent);
    let m = v.env.cctp_message(&message_sent);
    let b32 = |o: usize| <[u8; 32]>::try_from(&m[o..o + 32]).unwrap();
    assert_eq!(b32(184), PORTAL, "mint recipient = portal");
    assert_eq!(b32(108), PORTAL, "destination caller = portal");
    let mut amount = [0u8; 32];
    amount[24..].copy_from_slice(&THOUSAND.to_be_bytes());
    assert_eq!(b32(216), amount);
    assert_eq!(
        &m[376..],
        &eclyps_gateway::batch_hook(THOUSAND, id, 1, &root)[..],
        "a batch of one, its id carrying the express bit"
    );
    // Once.
    let (r, _) = v.send_express(&f, &fu, 1, id);
    assert_err(r, "ExpressNotClosed");
}

#[test]
fn the_pool_pays_until_it_runs_dry_then_the_user_pays_within_their_limit() {
    let mut v = V2::new();
    v.fund_pool(EXPRESS_FEE + EXPRESS_FEE / 2);
    let fee = fee_of(HUNDRED, FEE_BPS);
    let (u, ta) = v.env.user(10 * HUNDRED);
    v.deposit_express(&u, &ta, 0, leaf(1), 0).unwrap();
    assert!(v.express(0, EXPRESS_EPOCH_BIT).paid_by_pool);
    // Half a fee left: the pool cannot pay. A user who expected "on us" is not charged.
    let before = v.env.token_balance(&ta);
    assert_err(
        v.deposit_express(&u, &ta, 0, leaf(2), 0),
        "ExpressFeeTooHigh",
    );
    assert_err(
        v.deposit_express(&u, &ta, 0, leaf(2), EXPRESS_FEE - 1),
        "ExpressFeeTooHigh",
    );
    assert_eq!(v.env.token_balance(&ta), before);
    // A user who accepts the price pays it.
    v.deposit_express(&u, &ta, 0, leaf(2), EXPRESS_FEE).unwrap();
    let x = v.express(0, EXPRESS_EPOCH_BIT | 1);
    assert!(!x.paid_by_pool);
    assert_eq!(x.express_fee, EXPRESS_FEE);
    assert_eq!(
        v.env.token_balance(&ta),
        before - HUNDRED - fee - EXPRESS_FEE
    );
    assert_eq!(v.env.token_balance(&crossing_pool()), EXPRESS_FEE / 2);
    assert_eq!(v.lanes().pool_paid, EXPRESS_FEE);
    // Topped up by anyone: on us again.
    v.fund_pool(EXPRESS_FEE);
    v.deposit_express(&u, &ta, 0, leaf(3), 0).unwrap();
    assert!(v.express(0, EXPRESS_EPOCH_BIT | 2).paid_by_pool);
    // Every express epoch can be sent; the fee vault ends empty.
    for k in 0..3 {
        let (f, fu) = v.env.finisher();
        v.send_express(&f, &fu, 0, EXPRESS_EPOCH_BIT | k).0.unwrap();
        assert_eq!(
            v.env.token_balance(&fu),
            fee_of(HUNDRED, FINISHER_BPS) + EXPRESS_FEE
        );
    }
    assert_eq!(v.env.fee_vault_balance(), 0);
    assert_eq!(v.env.escrow_balance(), 0);
}

#[test]
fn express_crossings_never_touch_a_normal_epoch() {
    let mut v = V2::new();
    v.fund_pool(10 * EXPRESS_FEE);
    let (u, ta) = v.env.user(20 * HUNDRED);
    // Three people wait in the normal epoch (below the minimum of 4).
    for i in 0..3 {
        v.env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    let before = v.env.epoch(0, 0).unwrap();
    // Two others cross now.
    v.deposit_express(&u, &ta, 0, leaf(10), 0).unwrap();
    v.deposit_express(&u, &ta, 0, leaf(11), 0).unwrap();
    let after = v.env.epoch(0, 0).unwrap();
    assert_eq!(after.leaves, before.leaves);
    assert_eq!(after.status, EpochStatus::Open);
    assert_eq!(after.end_slot, before.end_slot);
    assert_eq!(v.env.config().current_epoch[0], 0);
    // The normal epoch still needs its fourth note, and then closes as usual.
    v.env.warp_slots(9_000);
    v.env.close_epoch(0).unwrap();
    assert_eq!(
        v.env.epoch(0, 0).unwrap().status,
        EpochStatus::Open,
        "rolled over"
    );
    v.env.deposit(&u, &ta, 0, leaf(3)).unwrap();
    v.env.warp_slots(9_000);
    v.env.close_epoch(0).unwrap();
    assert_eq!(v.env.epoch(0, 0).unwrap().status, EpochStatus::Closed);
    v.env.send_batch(0, 0).unwrap();
    // Escrow: only the two express notes remain until they are sent.
    assert_eq!(v.env.escrow_balance(), 2 * HUNDRED);
}

#[test]
fn express_deposits_respect_the_pause_the_cap_and_the_leaf_rules() {
    let mut v = V2::new();
    v.fund_pool(10 * EXPRESS_FEE);
    let (u, ta) = v.env.user(20 * THOUSAND);
    assert_err(v.deposit_express(&u, &ta, 0, [0u8; 32], 0), "InvalidLeaf");
    assert_err(v.deposit_express(&u, &ta, 0, [0xff; 32], 0), "InvalidLeaf");
    assert!(v.deposit_express(&u, &ta, 3, leaf(1), 0).is_err());
    let g = v.env.guardian.insecure_clone();
    v.env.pause(&g, true).unwrap();
    assert_err(v.deposit_express(&u, &ta, 0, leaf(1), 0), "DepositsPaused");
    v.env.pause(&g, false).unwrap();
    v.deposit_express(&u, &ta, 0, leaf(1), 0).unwrap();
    // The deposit cap counts express notes too.
    let admin = v.env.admin.insecure_clone();
    let env2 = Env::try_new(
        vec![HUNDRED, THOUSAND],
        Params {
            deposit_cap: HUNDRED,
            ..params()
        },
        730 * 86_400,
    )
    .unwrap();
    let admin2 = env2.admin.insecure_clone();
    let mut w = V2 {
        env: env2,
        keeper: Keypair::new(),
    };
    w.init_lanes(&admin2, lane_params(Pubkey::default()))
        .unwrap();
    let (u2, ta2) = w.env.user(10 * HUNDRED);
    w.deposit_express(&u2, &ta2, 0, leaf(1), EXPRESS_FEE)
        .unwrap();
    assert_err(
        w.deposit_express(&u2, &ta2, 0, leaf(2), EXPRESS_FEE),
        "DepositCapReached",
    );
    let _ = admin;
}

#[test]
fn express_deposits_respect_the_screening_list() {
    let mut v = V2::new();
    v.fund_pool(10 * EXPRESS_FEE);
    let (bad, bad_ta) = v.env.user(10 * HUNDRED);
    let (good, good_ta) = v.env.user(10 * HUNDRED);
    let admin = v.env.admin.insecure_clone();
    let g = v.env.guardian.insecure_clone();
    let screening = pda(&[eclyps_gateway::SCREENING_SEED]);
    let init = Instruction {
        program_id: eclyps_gateway::ID,
        accounts: accounts::InitScreening {
            admin: admin.pubkey(),
            config: v.env.config,
            screening,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitScreening {}.data(),
    };
    v.env.send(&[init], &admin, &[]).unwrap();
    let block = Instruction {
        program_id: eclyps_gateway::ID,
        accounts: accounts::BlockAddress {
            signer: g.pubkey(),
            config: v.env.config,
            screening,
            blocked: blocked_pda(&bad.pubkey()),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::BlockAddress {
            address: bad.pubkey(),
            list: eclyps_gateway::LIST_SANCTIONS,
            reference: [0; 32],
        }
        .data(),
    };
    v.env.send(&[block], &g, &[]).unwrap();
    assert_err(
        v.deposit_express(&bad, &bad_ta, 0, leaf(1), EXPRESS_FEE),
        "DepositorBlocked",
    );
    assert_eq!(v.env.token_balance(&bad_ta), 10 * HUNDRED);
    assert_eq!(v.lanes().express_next[0], 0);
    v.deposit_express(&good, &good_ta, 0, leaf(2), 0).unwrap();
}

#[test]
fn deposit_express_needs_the_lanes() {
    let mut env = Env::new(params());
    let (u, ta) = env.user(10 * HUNDRED);
    let v = V2 {
        env,
        keeper: Keypair::new(),
    };
    // No Lanes account: the instruction cannot even be built from chain state; send one anyway.
    let ix = Instruction {
        program_id: eclyps_gateway::ID,
        accounts: accounts::DepositExpress {
            payer: u.pubkey(),
            authority: u.pubkey(),
            config: v.env.config,
            lanes: lanes_pda(),
            express: express_pda(0, EXPRESS_EPOCH_BIT),
            source: ta,
            escrow: v.env.escrow,
            fee_vault: v.env.fee_vault,
            crossing_pool: crossing_pool(),
            usdc_mint: v.env.mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
            blocked: blocked_pda(&u.pubkey()),
        }
        .to_account_metas(None),
        data: instruction::DepositExpress {
            denomination_index: 0,
            secret_hash: leaf(1),
            max_express_fee: u64::MAX,
        }
        .data(),
    };
    let mut env = v.env;
    assert!(env.send(&[ix], &u, &[]).is_err());
    assert_eq!(env.token_balance(&ta), 10 * HUNDRED);
}

#[test]
fn lane_params_are_timelocked_and_pool_fronts_stop_at_once() {
    let mut v = V2::new();
    let admin = v.env.admin.insecure_clone();
    let stranger = v.env.stranger();
    let cheaper = LaneParams {
        express_fee: 900_000,
        ..v.lanes().params
    };
    assert_err(v.propose_lanes(&stranger, cheaper), "NotAdmin");
    v.propose_lanes(&admin, cheaper).unwrap();
    assert_err(v.apply_lanes(), "TimelockActive");
    v.env.warp_secs(PARAM_DELAY_SECS);
    v.apply_lanes().unwrap();
    assert_eq!(v.lanes().params.express_fee, 900_000);
    // A fee rate waits 14 days.
    let dearer = LaneParams {
        front_fee_cap_bps: 40,
        ..v.lanes().params
    };
    v.propose_lanes(&admin, dearer).unwrap();
    v.env.warp_secs(PARAM_DELAY_SECS);
    assert_err(v.apply_lanes(), "TimelockActive");
    v.env.warp_secs(FEE_DELAY_SECS - PARAM_DELAY_SECS);
    v.apply_lanes().unwrap();
    assert_eq!(v.lanes().params.front_fee_cap_bps, 40);
    // The guardian turns pool fronts off at once, pending changes included.
    let k2 = Keypair::new().pubkey();
    v.propose_lanes(
        &admin,
        LaneParams {
            keeper: k2,
            ..v.lanes().params
        },
    )
    .unwrap();
    let g = v.env.guardian.insecure_clone();
    assert_err(v.disable_pool_fronts(&stranger), "NotGuardian");
    v.disable_pool_fronts(&g).unwrap();
    assert_eq!(v.lanes().params.keeper, Pubkey::default());
    assert_eq!(v.lanes().pending.unwrap().params.keeper, Pubkey::default());
}

// =============================================================== fronted exits (ADR 0017)

#[test]
fn front_then_claim_pays_the_solver_and_the_destination_once() {
    let mut v = V2::new();
    let tree = ExitTree::new(5, 3);
    let (solver, su) = v.env.user(5 * THOUSAND);
    let fee = fee_of(THOUSAND, 10);
    let d = tree.destinations[2];
    // Before the exit batch exists on Solana (Aztec has the exit; the proof is pending).
    let meta = v.front(&solver, &su, 1, 4, &tree, 2, fee).unwrap();
    println!(
        "front_exit (creates the destination's USDC account): {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(v.env.usdc_of(&d), THOUSAND - fee);
    assert_eq!(v.env.token_balance(&su), 4 * THOUSAND + fee);
    let f = v.front_rec(&tree.leaves[2]).unwrap();
    assert_eq!(
        (f.advanced, f.fee, f.payee, f.from_pool),
        (THOUSAND - fee, fee, su, false)
    );
    let rent = v
        .env
        .svm
        .get_account(&front_pda(&tree.leaves[2]))
        .unwrap()
        .lamports;
    let solver_sol = v.env.svm.get_account(&solver.pubkey()).unwrap().lamports;

    // The slow path lands; the claim (sent by anyone) pays the solver the whole note.
    v.env.exit(1, 4, &tree).unwrap();
    // The claim must name the record's payee and rent payer.
    assert_err(
        v.claim_fronted(1, 4, &tree, 2, d, solver.pubkey()),
        "FrontMismatch",
    );
    assert_err(
        v.claim_fronted(1, 4, &tree, 2, su, Pubkey::new_unique()),
        "FrontMismatch",
    );
    // A plain claim (payer in the last slots) is refused too: it cannot skip the record.
    assert_err(v.env.claim_exit(1, 4, &tree, 2), "FrontMismatch");
    let meta = v
        .claim_fronted(1, 4, &tree, 2, su, solver.pubkey())
        .unwrap();
    println!("claim_exit (fronted): {} CU", meta.compute_units_consumed);
    assert_eq!(
        v.env.token_balance(&su),
        5 * THOUSAND + fee,
        "solver: + fee"
    );
    assert_eq!(v.env.usdc_of(&d), THOUSAND - fee, "destination paid once");
    assert!(v.front_rec(&tree.leaves[2]).is_none(), "record closed");
    assert_eq!(
        v.env.svm.get_account(&solver.pubkey()).unwrap().lamports,
        solver_sol + rent
    );
    assert!(v.env.exit_batch(1, 4).unwrap().is_claimed(2));
    assert_err(
        v.claim_fronted(1, 4, &tree, 2, su, solver.pubkey()),
        "ExitAlreadyClaimed",
    );
    // The other exits of the batch are claimed as before.
    for i in [0, 1, 3, 4] {
        v.env.claim_exit(1, 4, &tree, i).unwrap();
    }
    assert_eq!(v.env.exit_custody_balance(), 0);
}

#[test]
fn a_leaf_is_fronted_once_never_after_its_batch_arrived_and_within_the_cap() {
    let mut v = V2::new();
    let tree = ExitTree::new(4, 5);
    let (s1, u1) = v.env.user(5 * THOUSAND);
    let (s2, u2) = v.env.user(5 * THOUSAND);
    let cap = fee_of(THOUSAND, FRONT_CAP_BPS);
    assert_err(
        v.front(&s1, &u1, 1, 2, &tree, 0, cap + 1),
        "FrontFeeTooHigh",
    );
    v.front(&s1, &u1, 1, 2, &tree, 0, cap).unwrap();
    // Double front: the record exists.
    assert!(v.front(&s2, &u2, 1, 2, &tree, 0, 0).is_err());
    assert_eq!(v.env.token_balance(&u2), 5 * THOUSAND);
    // Once the batch is on Solana, nobody fronts (a claimed leaf can never be fronted).
    v.env.exit(1, 2, &tree).unwrap();
    v.env.claim_exit(1, 2, &tree, 1).unwrap();
    assert_err(v.front(&s2, &u2, 1, 2, &tree, 1, 0), "ExitBatchArrived");
    assert_err(v.front(&s2, &u2, 1, 2, &tree, 3, 0), "ExitBatchArrived");
    assert_eq!(v.env.token_balance(&u2), 5 * THOUSAND);
    // Wrong destination account, gateway vault as payee.
    let tree2 = ExitTree::new(2, 6);
    let mut ix = v.ix_front(
        &s2.pubkey(),
        &u2,
        &u2,
        1,
        3,
        tree2.destinations[0],
        tree2.secrets[0],
        0,
    );
    ix.accounts[8].pubkey = ata(&tree2.destinations[1], &v.env.mint);
    assert_err(v.env.send(&[ix], &s2, &[]), "ExitDestinationMismatch");
    let custody = v.env.exit_custody;
    let ix = v.ix_front(
        &s2.pubkey(),
        &u2,
        &custody,
        1,
        3,
        tree2.destinations[0],
        tree2.secrets[0],
        0,
    );
    assert!(v.env.send(&[ix], &s2, &[]).is_err());
}

#[test]
fn the_deposit_pause_never_blocks_fronts_or_claims() {
    let mut v = V2::new();
    let tree = ExitTree::new(4, 7);
    let (s, u) = v.env.user(5 * THOUSAND);
    let g = v.env.guardian.insecure_clone();
    v.env.pause(&g, true).unwrap();
    v.front(&s, &u, 0, 1, &tree, 0, 0).unwrap();
    v.env.exit(0, 1, &tree).unwrap();
    v.claim_fronted(0, 1, &tree, 0, u, s.pubkey()).unwrap();
    v.env.claim_exit(0, 1, &tree, 1).unwrap();
}

#[test]
fn unfronted_claims_work_as_before_with_the_new_accounts() {
    let mut v = V2::new();
    let tree = ExitTree::new(3, 8);
    v.env.exit(0, 0, &tree).unwrap();
    for i in 0..3 {
        v.env.claim_exit(0, 0, &tree, i).unwrap();
        assert_eq!(v.env.usdc_of(&tree.destinations[i]), HUNDRED);
    }
}

// =============================================================== the liquidity pool

#[test]
fn the_pool_fronts_and_its_share_price_grows_only_from_real_fees() {
    let mut v = V2::new();
    let (lp1, a1) = v.env.user(10 * THOUSAND);
    let (lp2, a2) = v.env.user(10 * THOUSAND);
    v.lp_deposit(&lp1, &a1, 3 * THOUSAND).unwrap();
    assert_eq!(
        v.position(&lp1.pubkey()).shares,
        3 * THOUSAND,
        "1:1 at first"
    );
    let l = v.liquidity();
    assert_eq!(
        (l.liquid, l.outstanding, l.total_shares),
        (3 * THOUSAND, 0, 3 * THOUSAND)
    );

    // The keeper fronts two $1,000 exits.
    let tree = ExitTree::new(4, 11);
    let keeper = v.keeper.insecure_clone();
    let fee = fee_of(THOUSAND, POOL_FEE_BPS);
    v.front_from_pool(&keeper, 1, 6, &tree, 0).unwrap();
    v.front_from_pool(&keeper, 1, 6, &tree, 1).unwrap();
    assert_eq!(v.env.usdc_of(&tree.destinations[0]), THOUSAND - fee);
    let l = v.liquidity();
    assert_eq!(l.liquid, THOUSAND + 2 * fee);
    assert_eq!(l.outstanding, 2 * (THOUSAND - fee));
    assert_eq!(l.fronts, 2);
    // The price has not moved: nothing is earned before repayment.
    assert_eq!(l.liquid + l.outstanding, 3 * THOUSAND);

    // Withdrawals: only from idle funds.
    let all = v.position(&lp1.pubkey()).shares;
    assert_err(v.lp_withdraw(&lp1, &a1, all), "PoolInsufficient");
    // Someone else joins at the same price.
    v.lp_deposit(&lp2, &a2, THOUSAND).unwrap();
    assert_eq!(v.position(&lp2.pubkey()).shares, THOUSAND);

    // Repayment: the slow path lands and pays the vault the whole notes.
    v.env.exit(1, 6, &tree).unwrap();
    let kp = keeper.pubkey();
    v.claim_fronted(1, 6, &tree, 0, liquidity_vault(), kp)
        .unwrap();
    v.claim_fronted(1, 6, &tree, 1, liquidity_vault(), kp)
        .unwrap();
    let l = v.liquidity();
    assert_eq!(l.outstanding, 0);
    assert_eq!(l.liquid, 4 * THOUSAND + 2 * fee);
    assert_eq!(l.fees_earned, 2 * fee);
    assert_eq!(v.env.token_balance(&liquidity_vault()), l.liquid);

    // Both providers leave with their share of the fees (rounded down, never more than there is).
    v.lp_withdraw(&lp1, &a1, all).unwrap();
    let got1 = v.env.token_balance(&a1) - 7 * THOUSAND;
    let s2 = v.position(&lp2.pubkey()).shares;
    v.lp_withdraw(&lp2, &a2, s2).unwrap();
    let got2 = v.env.token_balance(&a2) - 9 * THOUSAND;
    assert!(
        got1 > 3 * THOUSAND && got1 <= 3 * THOUSAND + 2 * fee,
        "{got1}"
    );
    assert!(got2 >= THOUSAND && got2 < THOUSAND + fee, "{got2}");
    assert!(got1 + got2 <= 4 * THOUSAND + 2 * fee);
    assert_eq!(v.liquidity().total_shares, 0);
    assert_eq!(v.position(&lp1.pubkey()).shares, 0);
    // A donation straight to the vault does not move the price.
    assert_eq!(
        v.env.token_balance(&liquidity_vault()),
        v.liquidity().liquid
    );
}

#[test]
fn only_the_keeper_fronts_from_the_pool_within_its_funds_and_bound() {
    let mut v = V2::new();
    let (lp, a) = v.env.user(20 * THOUSAND);
    let tree = ExitTree::new(8, 12);
    let keeper = v.keeper.insecure_clone();
    // Empty pool.
    assert_err(
        v.front_from_pool(&keeper, 1, 0, &tree, 0),
        "PoolInsufficient",
    );
    v.lp_deposit(&lp, &a, 15 * THOUSAND).unwrap();
    let stranger = v.env.stranger();
    assert_err(v.front_from_pool(&stranger, 1, 0, &tree, 0), "NotKeeper");
    // pool_max_outstanding is $10,000 and each $1,000 front advances $999: ten fit, the eleventh
    // does not.
    for i in 0..8 {
        v.front_from_pool(&keeper, 1, 0, &tree, i).unwrap();
    }
    let more = ExitTree::new(4, 13);
    v.front_from_pool(&keeper, 1, 1, &more, 0).unwrap();
    v.front_from_pool(&keeper, 1, 1, &more, 1).unwrap();
    assert_err(
        v.front_from_pool(&keeper, 1, 1, &more, 2),
        "PoolOutstandingCap",
    );
    // Off at once.
    let admin = v.env.admin.insecure_clone();
    v.disable_pool_fronts(&admin).unwrap();
    assert_err(v.front_from_pool(&keeper, 0, 1, &more, 3), "NotKeeper");
    // Repayments go on while fronts are off.
    v.env.exit(1, 0, &tree).unwrap();
    v.claim_fronted(1, 0, &tree, 0, liquidity_vault(), keeper.pubkey())
        .unwrap();
}

#[test]
fn a_lost_pool_front_is_written_off_after_a_week_and_counted_back_if_it_lands() {
    let mut v = V2::new();
    let (lp, a) = v.env.user(10 * THOUSAND);
    v.lp_deposit(&lp, &a, 2 * THOUSAND).unwrap();
    let tree = ExitTree::new(4, 14);
    let keeper = v.keeper.insecure_clone();
    v.front_from_pool(&keeper, 1, 9, &tree, 0).unwrap();
    let adv = THOUSAND - fee_of(THOUSAND, POOL_FEE_BPS);
    assert_err(v.write_off(tree.leaves[0]), "NotWriteOffable");
    v.env.warp_secs(FRONT_WRITE_OFF_SECS);
    v.write_off(tree.leaves[0]).unwrap();
    let l = v.liquidity();
    assert_eq!((l.outstanding, l.written_off), (0, adv));
    assert_eq!(
        l.liquid + l.outstanding,
        2 * THOUSAND - adv,
        "the loss is in the price"
    );
    assert_err(v.write_off(tree.leaves[0]), "NotWriteOffable");
    // It lands after all: the pool is paid, never the destination twice.
    v.env.exit(1, 9, &tree).unwrap();
    assert_err(v.env.claim_exit(1, 9, &tree, 0), "FrontMismatch");
    v.claim_fronted(1, 9, &tree, 0, liquidity_vault(), keeper.pubkey())
        .unwrap();
    let l = v.liquidity();
    assert_eq!(l.recovered, THOUSAND);
    assert_eq!(l.liquid, 2 * THOUSAND - adv + THOUSAND);
    assert_eq!(v.env.usdc_of(&tree.destinations[0]), adv);
    // Solver fronts are not the pool's to write off.
    let (s, su) = v.env.user(THOUSAND);
    v.front(&s, &su, 1, 10, &tree, 1, 0).unwrap();
    v.env.warp_secs(FRONT_WRITE_OFF_SECS);
    assert_err(v.write_off(tree.leaves[1]), "NotWriteOffable");
}

#[test]
fn lp_rules_zero_amounts_and_foreign_positions() {
    let mut v = V2::new();
    let (lp, a) = v.env.user(10 * THOUSAND);
    let (other, b) = v.env.user(10 * THOUSAND);
    assert_err(v.lp_deposit(&lp, &a, 0), "LpZero");
    v.lp_deposit(&lp, &a, THOUSAND).unwrap();
    assert_err(v.lp_withdraw(&lp, &a, 0), "LpZero");
    assert_err(v.lp_withdraw(&lp, &a, THOUSAND + 1), "LpZero");
    // Another signer cannot use lp's position (its own PDA is empty).
    assert!(v.lp_withdraw(&other, &b, 1).is_err());
    v.lp_withdraw(&lp, &a, THOUSAND).unwrap();
    assert_eq!(v.env.token_balance(&a), 10 * THOUSAND);
}

// =============================================================== SDK fixture

/// Writes sdk/test/fixtures/lanes.json: V2 instructions that succeeded here (accounts and data)
/// and the V2 accounts they left, for the SDK's builders and decoders (sdk/test/lanes.test.ts).
/// Deterministic signers and accounts, so the committed file must match exactly;
/// `ECLYPS_WRITE_FIXTURES=1 cargo test -p eclyps-gateway --test lanes lanes_fixture` rewrites it.
#[test]
fn lanes_fixture_for_the_sdk() {
    use base64::Engine;
    let b64 = |d: &[u8]| base64::engine::general_purpose::STANDARD.encode(d);
    let ix_json = |ix: &Instruction| {
        serde_json::json!({
            "accounts": ix.accounts.iter().map(|a| serde_json::json!({
                "address": a.pubkey.to_string(), "writable": a.is_writable, "signer": a.is_signer,
            })).collect::<Vec<_>>(),
            "data": b64(&ix.data),
        })
    };
    let kp = |b: u8| Keypair::new_from_array([b; 32]);
    let mut env = Env::new(params());
    let keeper = kp(0x51);
    let user = kp(0x52);
    let finisher = kp(0x53);
    let solver = kp(0x54);
    let lp = kp(0x55);
    for k in [&keeper, &user, &finisher, &solver, &lp] {
        env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let user_usdc = Pubkey::new_from_array([0x62; 32]);
    let finisher_usdc = Pubkey::new_from_array([0x63; 32]);
    let solver_usdc = Pubkey::new_from_array([0x64; 32]);
    let lp_usdc = Pubkey::new_from_array([0x65; 32]);
    env.set_usdc_account(
        user_usdc,
        &user.pubkey(),
        2 * THOUSAND,
        AccountState::Initialized,
    );
    env.set_usdc_account(
        finisher_usdc,
        &finisher.pubkey(),
        0,
        AccountState::Initialized,
    );
    env.set_usdc_account(
        solver_usdc,
        &solver.pubkey(),
        5 * THOUSAND,
        AccountState::Initialized,
    );
    env.set_usdc_account(
        lp_usdc,
        &lp.pubkey(),
        5 * THOUSAND,
        AccountState::Initialized,
    );
    let admin = env.admin.insecure_clone();
    let mut v = V2 {
        env,
        keeper: keeper.insecure_clone(),
    };
    v.init_lanes(&admin, lane_params(keeper.pubkey())).unwrap();
    v.fund_pool(EXPRESS_FEE);

    // Cross now, then sent by a finisher.
    let deposit = v.ix_deposit_express(&user.pubkey(), &user_usdc, 1, leaf(7), 0);
    v.env
        .send(std::slice::from_ref(&deposit), &user, &[])
        .unwrap();
    let event = kp(0x56);
    let id = EXPRESS_EPOCH_BIT;
    // Same accounts as `send_express`, with a fixed event keypair.
    let send = {
        let env = &v.env;
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::SendExpressBatch {
                payer: finisher.pubkey(),
                config: env.config,
                express: express_pda(1, id),
                escrow: env.escrow,
                fee_vault: env.fee_vault,
                finisher_usdc,
                treasury: env.config().params.treasury,
                usdc_mint: env.mint,
                message_sent_event_data: event.pubkey(),
                cctp_sender_authority: tmm_pda(&[b"sender_authority"]),
                cctp_denylist: tmm_pda(&[b"denylist_account", env.config.as_ref()]),
                cctp_message_transmitter: Pubkey::find_program_address(
                    &[b"message_transmitter"],
                    &MT,
                )
                .0,
                cctp_token_messenger: tmm_pda(&[b"token_messenger"]),
                cctp_remote_token_messenger: tmm_pda(&[b"remote_token_messenger", b"0"]),
                cctp_token_minter: tmm_pda(&[b"token_minter"]),
                cctp_local_token: tmm_pda(&[b"local_token", env.mint.as_ref()]),
                cctp_event_authority: tmm_pda(&[b"__event_authority"]),
                cctp_message_transmitter_program: MT,
                cctp_token_messenger_minter_program: TMM,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::SendExpressBatch {
                denomination_index: 1,
                express_id: id,
            }
            .data(),
        }
    };
    v.env
        .send(
            &[compute_budget(400_000), send.clone()],
            &finisher,
            &[&event],
        )
        .unwrap();

    // Liquidity, a solver front and a pool front, then the batch and both claims.
    let lp_dep = Instruction {
        program_id: eclyps_gateway::ID,
        accounts: accounts::LpDeposit {
            owner: lp.pubkey(),
            config: v.env.config,
            liquidity: liquidity_pda(),
            vault: liquidity_vault(),
            position: lp_pda(&lp.pubkey()),
            source: lp_usdc,
            usdc_mint: v.env.mint,
            token_program: spl_token_interface::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::LpDeposit {
            amount: 3 * THOUSAND,
        }
        .data(),
    };
    v.env.send(std::slice::from_ref(&lp_dep), &lp, &[]).unwrap();
    let destinations: Vec<Pubkey> = (1..=3u8)
        .map(|i| Pubkey::new_from_array([0x70 + i; 32]))
        .collect();
    let tree = ExitTree::to(destinations, 55);
    let fee = fee_of(THOUSAND, 20);
    let front = v.ix_front(
        &solver.pubkey(),
        &solver_usdc,
        &solver_usdc,
        1,
        3,
        tree.destinations[0],
        tree.secrets[0],
        fee,
    );
    v.env
        .send(std::slice::from_ref(&front), &solver, &[])
        .unwrap();
    let front_bytes = v
        .env
        .svm
        .get_account(&front_pda(&tree.leaves[0]))
        .unwrap()
        .data;
    v.front_from_pool(&keeper, 1, 3, &tree, 1).unwrap();
    let pool_front_bytes = v
        .env
        .svm
        .get_account(&front_pda(&tree.leaves[1]))
        .unwrap()
        .data;
    let pool_front = {
        let (destination, secret) = (tree.destinations[1], tree.secrets[1]);
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::FrontExitFromPool {
                keeper: keeper.pubkey(),
                config: v.env.config,
                lanes: lanes_pda(),
                liquidity: liquidity_pda(),
                vault: liquidity_vault(),
                exit_batch: exit_batch_pda(1, 3),
                front: front_pda(&eclyps_gateway::front_seed(&destination, &secret)),
                destination_wallet: destination,
                destination_usdc: ata(&destination, &v.env.mint),
                usdc_mint: v.env.mint,
                token_program: spl_token_interface::ID,
                associated_token_program: ATA_PROGRAM,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::FrontExitFromPool {
                denomination_index: 1,
                exit_epoch_id: 3,
                destination,
                secret,
            }
            .data(),
        }
    };
    v.env.exit(1, 3, &tree).unwrap();
    let mut claim = v.env.ix_claim_exit(
        &solver.pubkey(),
        1,
        3,
        0,
        tree.path(0),
        tree.destinations[0],
        tree.secrets[0],
    );
    let n = claim.accounts.len();
    claim.accounts[n - 3].pubkey = solver_usdc;
    claim.accounts[n - 2].pubkey = solver.pubkey();
    claim.accounts[n - 1].pubkey = liquidity_pda();
    v.env
        .send(std::slice::from_ref(&claim), &solver, &[])
        .unwrap();
    v.claim_fronted(1, 3, &tree, 1, liquidity_vault(), keeper.pubkey())
        .unwrap();
    let lp_wd = Instruction {
        program_id: eclyps_gateway::ID,
        accounts: accounts::LpWithdraw {
            owner: lp.pubkey(),
            config: v.env.config,
            liquidity: liquidity_pda(),
            vault: liquidity_vault(),
            position: lp_pda(&lp.pubkey()),
            destination: lp_usdc,
            usdc_mint: v.env.mint,
            token_program: spl_token_interface::ID,
        }
        .to_account_metas(None),
        data: instruction::LpWithdraw { shares: THOUSAND }.data(),
    };
    v.env.send(std::slice::from_ref(&lp_wd), &lp, &[]).unwrap();

    let bytes = |k: &Pubkey| b64(&v.env.svm.get_account(k).unwrap().data);
    let l = v.liquidity();
    let fixture = serde_json::json!({
        "programId": eclyps_gateway::ID.to_string(),
        "usdcMint": v.env.mint.to_string(),
        "treasury": TREASURY.to_string(),
        "laneParams": {
            "expressFee": EXPRESS_FEE.to_string(),
            "frontFeeCapBps": FRONT_CAP_BPS,
            "poolFeeBps": POOL_FEE_BPS,
            "poolMaxOutstanding": (10 * THOUSAND).to_string(),
            "keeper": keeper.pubkey().to_string(),
        },
        "signers": {
            "user": user.pubkey().to_string(),
            "finisher": finisher.pubkey().to_string(),
            "solver": solver.pubkey().to_string(),
            "keeper": keeper.pubkey().to_string(),
            "lp": lp.pubkey().to_string(),
            "event": event.pubkey().to_string(),
        },
        "tokenAccounts": {
            "user": user_usdc.to_string(),
            "finisher": finisher_usdc.to_string(),
            "solver": solver_usdc.to_string(),
            "lp": lp_usdc.to_string(),
        },
        "depositExpress": { "denominationIndex": 1, "expressId": id.to_string(), "commitment": format!("0x{}", leaf(7).iter().map(|x| format!("{x:02x}")).collect::<String>()), "maxExpressFee": "0", "ix": ix_json(&deposit) },
        "sendExpressBatch": ix_json(&send),
        "exits": tree.destinations.iter().zip(&tree.secrets).zip(&tree.leaves).map(|((d, s), lf)| serde_json::json!({
            "destination": d.to_string(),
            "secret": format!("0x{}", s.iter().map(|x| format!("{x:02x}")).collect::<String>()),
            "leaf": format!("0x{}", lf.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        })).collect::<Vec<_>>(),
        "frontExit": { "exitEpochId": "3", "fee": fee.to_string(), "ix": ix_json(&front) },
        "frontExitFromPool": { "ix": ix_json(&pool_front) },
        "claimFronted": { "leafIndex": 0, "path": tree.path(0).iter().map(|p| format!("0x{}", p.iter().map(|x| format!("{x:02x}")).collect::<String>())).collect::<Vec<_>>(), "ix": ix_json(&claim) },
        "lpDeposit": { "amount": (3 * THOUSAND).to_string(), "ix": ix_json(&lp_dep) },
        "lpWithdraw": { "shares": THOUSAND.to_string(), "ix": ix_json(&lp_wd) },
        "accounts": {
            "lanes": { "address": lanes_pda().to_string(), "data": bytes(&lanes_pda()) },
            "express": { "address": express_pda(1, id).to_string(), "data": bytes(&express_pda(1, id)) },
            "front": { "address": front_pda(&tree.leaves[0]).to_string(), "data": b64(&front_bytes) },
            "poolFront": { "address": front_pda(&tree.leaves[1]).to_string(), "data": b64(&pool_front_bytes) },
            "liquidity": { "address": liquidity_pda().to_string(), "data": bytes(&liquidity_pda()), "liquid": l.liquid.to_string(), "outstanding": l.outstanding.to_string(), "totalShares": l.total_shares.to_string(), "feesEarned": l.fees_earned.to_string() },
            "lpPosition": { "address": lp_pda(&lp.pubkey()).to_string(), "data": bytes(&lp_pda(&lp.pubkey())), "shares": v.position(&lp.pubkey()).shares.to_string() },
            "crossingPool": crossing_pool().to_string(),
            "liquidityVault": liquidity_vault().to_string(),
        },
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/test/fixtures/lanes.json"
    );
    let text = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
    if std::env::var("ECLYPS_WRITE_FIXTURES").is_ok() {
        std::fs::write(path, &text).unwrap();
    }
    let committed =
        std::fs::read_to_string(path).expect("fixture: run with ECLYPS_WRITE_FIXTURES=1");
    assert_eq!(
        committed, text,
        "lanes fixture changed: regenerate it with ECLYPS_WRITE_FIXTURES=1"
    );
}

// =============================================================== invariants (property test)
//
// Random sequences of fronts (solver or pool), the batch arriving, claims, LP deposits and
// withdrawals and write-offs, checked after every step against a reference model:
// X1 one payment per leaf: a destination holds exactly `advanced` if its leaf was fronted, the
//    denomination if it was claimed unfronted, nothing otherwise; claims never pay it twice
// X2 exit custody = unclaimed exits × denomination once the batch has arrived
// X3 a solver gets back exactly what it advanced plus its fee, at the claim, and nothing else
// X4 the pool's vault holds exactly `liquid`; `outstanding` is the sum of the pool's unpaid,
//    not written-off advances; shares add up across positions; no withdrawal takes more than
//    `liquid`, and the share price never falls except by a write-off

#[derive(Debug, Clone)]
enum XOp {
    FrontSolver { leaf: usize, fee_bps: u16 },
    FrontPool { leaf: usize },
    Arrive,
    Claim { leaf: usize },
    LpDeposit { lp: usize, amount: u64 },
    LpWithdraw { lp: usize, pct: u64 },
    WriteOff { leaf: usize },
}

fn xop() -> impl proptest::strategy::Strategy<Value = XOp> {
    use proptest::prelude::*;
    prop_oneof![
        3 => (0..6usize, 0..=40u16).prop_map(|(leaf, fee_bps)| XOp::FrontSolver { leaf, fee_bps }),
        3 => (0..6usize).prop_map(|leaf| XOp::FrontPool { leaf }),
        1 => Just(XOp::Arrive),
        4 => (0..6usize).prop_map(|leaf| XOp::Claim { leaf }),
        2 => (0..2usize, 1..4_000u64).prop_map(|(lp, d)| XOp::LpDeposit { lp, amount: d * 1_000_000 }),
        2 => (0..2usize, 1..=100u64).prop_map(|(lp, pct)| XOp::LpWithdraw { lp, pct }),
        1 => (0..6usize).prop_map(|leaf| XOp::WriteOff { leaf }),
    ]
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum LeafState {
    Open,
    Solver { advanced: u64 },
    Pool { advanced: u64, written_off: bool },
}

fn run_fronts(ops: Vec<XOp>) {
    const N: usize = 6;
    let mut v = V2::new();
    let tree = ExitTree::new(N, 99);
    let keeper = v.keeper.insecure_clone();
    let (solver, su) = v.env.user(100 * THOUSAND);
    let lps: Vec<(Keypair, Pubkey)> = (0..2).map(|_| v.env.user(10 * THOUSAND)).collect();
    let mut state = [LeafState::Open; N];
    let mut claimed = [false; N];
    let mut arrived = false;
    let mut solver_bal = 100 * THOUSAND;
    let mut lp_bal = [10 * THOUSAND; 2];
    let price = |l: &Liquidity| {
        (l.liquid as u128 + l.outstanding as u128 + LP_V) * 1_000_000_000
            / (l.total_shares as u128 + LP_V)
    };
    const LP_V: u128 = eclyps_gateway::LP_VIRTUAL as u128;
    let mut last_price = price(&v.liquidity());
    let mut wrote_off = false;
    for op in ops {
        match op {
            XOp::FrontSolver { leaf, fee_bps } => {
                let fee = fee_of(THOUSAND, fee_bps);
                let r = v.front(&solver, &su, 1, 0, &tree, leaf, fee);
                let ok = state[leaf] == LeafState::Open && !arrived && fee_bps <= FRONT_CAP_BPS;
                assert_eq!(r.is_ok(), ok, "{op:?} {r:?}");
                if ok {
                    state[leaf] = LeafState::Solver {
                        advanced: THOUSAND - fee,
                    };
                    solver_bal -= THOUSAND - fee;
                }
            }
            XOp::FrontPool { leaf } => {
                let adv = THOUSAND - fee_of(THOUSAND, POOL_FEE_BPS);
                let l = v.liquidity();
                let r = v.front_from_pool(&keeper, 1, 0, &tree, leaf);
                let ok = state[leaf] == LeafState::Open
                    && !arrived
                    && l.liquid >= adv
                    && l.outstanding + adv <= 10 * THOUSAND;
                assert_eq!(r.is_ok(), ok, "{op:?} {r:?}");
                if ok {
                    state[leaf] = LeafState::Pool {
                        advanced: adv,
                        written_off: false,
                    };
                }
            }
            XOp::Arrive => {
                let r = v.env.exit(1, 0, &tree);
                assert_eq!(r.is_ok(), !arrived, "{r:?}");
                arrived = true;
            }
            XOp::Claim { leaf } => {
                let r = match state[leaf] {
                    LeafState::Open => {
                        let r = v.env.claim_exit(1, 0, &tree, leaf);
                        // Claiming with the record's accounts is refused when there is no record.
                        r
                    }
                    LeafState::Solver { .. } => {
                        v.claim_fronted(1, 0, &tree, leaf, su, solver.pubkey())
                    }
                    LeafState::Pool { .. } => {
                        v.claim_fronted(1, 0, &tree, leaf, liquidity_vault(), keeper.pubkey())
                    }
                };
                let ok = arrived && !claimed[leaf];
                assert_eq!(r.is_ok(), ok, "{op:?} {state:?} {r:?}");
                if ok {
                    claimed[leaf] = true;
                    if let LeafState::Solver { .. } = state[leaf] {
                        solver_bal += THOUSAND;
                    }
                }
            }
            XOp::LpDeposit { lp, amount } => {
                let amount = amount.min(lp_bal[lp]);
                let r = v.lp_deposit(&lps[lp].0, &lps[lp].1, amount);
                if amount > 0 {
                    r.unwrap();
                    lp_bal[lp] -= amount;
                }
            }
            XOp::LpWithdraw { lp, pct } => {
                let owner = lps[lp].0.pubkey();
                let Some(acc) = v.env.svm.get_account(&lp_pda(&owner)) else {
                    continue;
                };
                if acc.data.is_empty() {
                    continue;
                }
                let shares = v.position(&owner).shares * pct / 100;
                let l = v.liquidity();
                let want = if shares == 0 {
                    0
                } else {
                    l.amount_for(shares).unwrap()
                };
                let r = v.lp_withdraw(&lps[lp].0, &lps[lp].1, shares);
                let ok = shares > 0 && want > 0 && want <= l.liquid;
                assert_eq!(
                    r.is_ok(),
                    ok,
                    "{op:?} want {want} liquid {} {r:?}",
                    l.liquid
                );
                if ok {
                    lp_bal[lp] += want;
                }
            }
            XOp::WriteOff { leaf } => {
                v.env.warp_secs(FRONT_WRITE_OFF_SECS);
                let r = v.write_off(tree.leaves[leaf]);
                let ok = matches!(
                    state[leaf],
                    LeafState::Pool {
                        written_off: false,
                        ..
                    }
                ) && !claimed[leaf];
                assert_eq!(r.is_ok(), ok, "{op:?} {r:?}");
                if ok {
                    if let LeafState::Pool { advanced, .. } = state[leaf] {
                        state[leaf] = LeafState::Pool {
                            advanced,
                            written_off: true,
                        };
                    }
                    wrote_off = true;
                }
            }
        }
        // X1
        for i in 0..N {
            let want = match state[i] {
                LeafState::Open => {
                    if claimed[i] {
                        THOUSAND
                    } else {
                        0
                    }
                }
                LeafState::Solver { advanced } | LeafState::Pool { advanced, .. } => advanced,
            };
            assert_eq!(
                v.env.usdc_of(&tree.destinations[i]),
                want,
                "destination {i}"
            );
        }
        // X2
        if arrived {
            let unclaimed = claimed.iter().filter(|c| !**c).count() as u64;
            assert_eq!(v.env.exit_custody_balance(), unclaimed * THOUSAND);
        }
        // X3
        assert_eq!(v.env.token_balance(&su), solver_bal);
        // X4
        let l = v.liquidity();
        assert_eq!(v.env.token_balance(&liquidity_vault()), l.liquid);
        let outstanding: u64 = (0..N)
            .filter(|&i| !claimed[i])
            .filter_map(|i| match state[i] {
                LeafState::Pool {
                    advanced,
                    written_off: false,
                } => Some(advanced),
                _ => None,
            })
            .sum();
        assert_eq!(l.outstanding, outstanding);
        let shares: u64 = lps
            .iter()
            .filter_map(|(k, _)| v.env.svm.get_account(&lp_pda(&k.pubkey())))
            .filter(|a| !a.data.is_empty())
            .map(|a| {
                LpPosition::try_deserialize(&mut &a.data[..])
                    .unwrap()
                    .shares
            })
            .sum();
        assert_eq!(l.total_shares, shares);
        for (k, (_, ta)) in lps.iter().enumerate() {
            assert_eq!(v.env.token_balance(ta), lp_bal[k]);
        }
        let p = price(&l);
        if !wrote_off {
            assert!(
                p + 1 >= last_price,
                "price fell without a write-off: {last_price} -> {p}"
            );
        }
        wrote_off = false;
        last_price = p;
    }
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig {
        cases: std::env::var("PROPTEST_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(32),
        ..proptest::prelude::ProptestConfig::default()
    })]

    #[test]
    fn front_and_pool_invariants_hold_for_random_sequences(ops in proptest::collection::vec(xop(), 1..40)) {
        run_fronts(ops);
    }
}
