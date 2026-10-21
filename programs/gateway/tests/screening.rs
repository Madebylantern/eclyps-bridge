//! Screening deposits (ADR 0019) in LiteSVM: the guardian's denylist of depositor addresses,
//! checked by `deposit` (and `deposit_express`, in lanes.rs). Run `anchor build` first.

mod common;
use anchor_lang::{AccountDeserialize, InstructionData, Space, ToAccountMetas};
use common::*;
use eclyps_gateway::{
    accounts, instruction, BlockedAddress, Screening, LIST_OTHER, LIST_SANCTIONS,
    LIST_STOLEN_FUNDS, SCREENING_SEED, UNBLOCK_DELAY_SECS,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const REF: [u8; 32] = [0xab; 32];

fn screening_pda() -> Pubkey {
    pda(&[SCREENING_SEED])
}

trait Screen {
    fn init_screening(&mut self, signer: &Keypair) -> TxResult;
    fn block(&mut self, signer: &Keypair, address: Pubkey, list: u8) -> TxResult;
    fn propose_unblock(&mut self, signer: &Keypair, address: Pubkey) -> TxResult;
    fn cancel_unblock(&mut self, signer: &Keypair, address: Pubkey) -> TxResult;
    fn unblock(&mut self, signer: &Keypair, address: Pubkey, rent_payer: Pubkey) -> TxResult;
    fn screening(&self) -> Screening;
    fn record(&self, address: &Pubkey) -> Option<BlockedAddress>;
}

impl Screen for Env {
    fn init_screening(&mut self, signer: &Keypair) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::InitScreening {
                admin: signer.pubkey(),
                config: self.config,
                screening: screening_pda(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::InitScreening {}.data(),
        };
        self.send(&[ix], signer, &[])
    }

    fn block(&mut self, signer: &Keypair, address: Pubkey, list: u8) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::BlockAddress {
                signer: signer.pubkey(),
                config: self.config,
                screening: screening_pda(),
                blocked: blocked_pda(&address),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::BlockAddress {
                address,
                list,
                reference: REF,
            }
            .data(),
        };
        self.send(&[ix], signer, &[])
    }

    fn propose_unblock(&mut self, signer: &Keypair, address: Pubkey) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::ChangeBlock {
                signer: signer.pubkey(),
                config: self.config,
                blocked: blocked_pda(&address),
            }
            .to_account_metas(None),
            data: instruction::ProposeUnblock { address }.data(),
        };
        self.send(&[ix], signer, &[])
    }

    fn cancel_unblock(&mut self, signer: &Keypair, address: Pubkey) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::ChangeBlock {
                signer: signer.pubkey(),
                config: self.config,
                blocked: blocked_pda(&address),
            }
            .to_account_metas(None),
            data: instruction::CancelUnblock { address }.data(),
        };
        self.send(&[ix], signer, &[])
    }

    fn unblock(&mut self, signer: &Keypair, address: Pubkey, rent_payer: Pubkey) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::Unblock {
                screening: screening_pda(),
                blocked: blocked_pda(&address),
                rent_payer,
            }
            .to_account_metas(None),
            data: instruction::Unblock { address }.data(),
        };
        self.send(&[ix], signer, &[])
    }

    fn screening(&self) -> Screening {
        let a = self.svm.get_account(&screening_pda()).unwrap();
        Screening::try_deserialize(&mut &a.data[..]).unwrap()
    }

    fn record(&self, address: &Pubkey) -> Option<BlockedAddress> {
        let a = self.svm.get_account(&blocked_pda(address))?;
        if a.data.is_empty() {
            return None;
        }
        Some(BlockedAddress::try_deserialize(&mut &a.data[..]).unwrap())
    }
}

fn screened_env() -> Env {
    let mut env = Env::new(default_params());
    let admin = env.admin.insecure_clone();
    env.init_screening(&admin).unwrap();
    env
}

#[test]
fn nothing_is_blocked_before_init_and_init_is_admin_only_once() {
    let mut env = Env::new(default_params());
    let before = env.svm.get_account(&env.config).unwrap().data;
    let guardian = env.guardian.insecure_clone();
    let (u, ta) = env.user(10 * HUNDRED);
    // No Screening account: nothing can be added, and deposits work as in V1.
    assert!(env.block(&guardian, u.pubkey(), LIST_SANCTIONS).is_err());
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();

    let stranger = env.stranger();
    assert_err(env.init_screening(&stranger), "NotAdmin");
    assert_err(env.init_screening(&guardian), "NotAdmin");
    let admin = env.admin.insecure_clone();
    env.init_screening(&admin).unwrap();
    let s = env.screening();
    assert_eq!((s.version, s.blocked, s.added, s.removed), (1, 0, 0, 0));
    // The size the SDK filters records by (sdk/src/gateway.ts BLOCKED_ADDRESS_LEN).
    assert_eq!(8 + BlockedAddress::INIT_SPACE, 187);
    assert!(env.init_screening(&admin).is_err());
    // The V1 config keeps its layout, byte for byte (only net_deposits moved, by the deposit).
    let after = env.svm.get_account(&env.config).unwrap().data;
    assert_eq!(after.len(), before.len());
}

#[test]
fn a_blocked_depositor_is_refused_and_everyone_else_deposits() {
    let mut env = screened_env();
    let guardian = env.guardian.insecure_clone();
    let (bad, bad_ta) = env.user(10 * HUNDRED);
    let (good, good_ta) = env.user(10 * HUNDRED);
    env.block(&guardian, bad.pubkey(), LIST_STOLEN_FUNDS)
        .unwrap();

    let r = env.record(&bad.pubkey()).unwrap();
    assert_eq!(r.address, bad.pubkey());
    assert_eq!(r.list, LIST_STOLEN_FUNDS);
    assert_eq!(r.reference, REF);
    assert_eq!(r.added_by, guardian.pubkey());
    assert_eq!(r.rent_payer, guardian.pubkey());
    assert_eq!(r.unblock_eta, 0);
    assert_eq!(env.screening().blocked, 1);

    let escrow = env.escrow_balance();
    assert_err(env.deposit(&bad, &bad_ta, 0, leaf(1)), "DepositorBlocked");
    assert_eq!(env.token_balance(&bad_ta), 10 * HUNDRED);
    assert_eq!(env.escrow_balance(), escrow);

    env.deposit(&good, &good_ta, 0, leaf(2)).unwrap();
    assert_eq!(env.escrow_balance(), escrow + HUNDRED);
}

#[test]
fn the_check_cannot_be_dodged_with_another_account() {
    let mut env = screened_env();
    let guardian = env.guardian.insecure_clone();
    let (bad, bad_ta) = env.user(10 * HUNDRED);
    env.block(&guardian, bad.pubkey(), LIST_SANCTIONS).unwrap();
    // Pass someone else's (empty) record in place of the depositor's own.
    let mut ix = env.ix_deposit(&bad.pubkey(), &bad_ta, 0, leaf(1));
    let last = ix.accounts.len() - 1;
    ix.accounts[last].pubkey = blocked_pda(&Pubkey::new_unique());
    let open = env.ix_open_epoch(&bad.pubkey(), 0);
    assert_err(env.send(&[open, ix], &bad, &[]), "ConstraintSeeds");
    // Or leave it out.
    let mut ix = env.ix_deposit(&bad.pubkey(), &bad_ta, 0, leaf(1));
    ix.accounts.pop();
    let open = env.ix_open_epoch(&bad.pubkey(), 0);
    assert!(env.send(&[open, ix], &bad, &[]).is_err());
    assert_eq!(env.token_balance(&bad_ta), 10 * HUNDRED);
}

#[test]
fn only_the_guardian_or_admin_adds_and_entries_are_checked() {
    let mut env = screened_env();
    let guardian = env.guardian.insecure_clone();
    let admin = env.admin.insecure_clone();
    let stranger = env.stranger();
    let target = Pubkey::new_unique();
    assert_err(env.block(&stranger, target, LIST_SANCTIONS), "NotScreener");
    assert_err(
        env.block(&guardian, target, LIST_OTHER + 1),
        "InvalidScreeningEntry",
    );
    assert_err(
        env.block(&guardian, Pubkey::default(), LIST_SANCTIONS),
        "InvalidScreeningEntry",
    );
    env.block(&admin, target, LIST_OTHER).unwrap();
    // Twice: the record exists.
    assert!(env.block(&guardian, target, LIST_SANCTIONS).is_err());
    env.block(&guardian, Pubkey::new_unique(), LIST_SANCTIONS)
        .unwrap();
    let s = env.screening();
    assert_eq!((s.blocked, s.added), (2, 2));
}

#[test]
fn removal_is_announced_then_anyone_carries_it_out() {
    let mut env = screened_env();
    let guardian = env.guardian.insecure_clone();
    let admin = env.admin.insecure_clone();
    let stranger = env.stranger();
    let (u, ta) = env.user(10 * HUNDRED);
    let addr = u.pubkey();
    env.block(&guardian, addr, LIST_SANCTIONS).unwrap();

    // Nothing announced yet.
    assert_err(
        env.unblock(&stranger, addr, guardian.pubkey()),
        "NoUnblockPending",
    );
    assert_err(env.cancel_unblock(&guardian, addr), "NoUnblockPending");
    assert_err(env.propose_unblock(&stranger, addr), "NotScreener");

    // Announced by the admin, cancelled by the guardian.
    env.propose_unblock(&admin, addr).unwrap();
    let eta = env.record(&addr).unwrap().unblock_eta;
    assert_eq!(eta, env.clock().unix_timestamp + UNBLOCK_DELAY_SECS);
    assert_err(env.cancel_unblock(&stranger, addr), "NotScreener");
    env.cancel_unblock(&guardian, addr).unwrap();
    assert_eq!(env.record(&addr).unwrap().unblock_eta, 0);
    env.warp_secs(UNBLOCK_DELAY_SECS + 1);
    assert_err(
        env.unblock(&stranger, addr, guardian.pubkey()),
        "NoUnblockPending",
    );

    // Announced again: not before the delay, still blocked meanwhile.
    env.propose_unblock(&guardian, addr).unwrap();
    env.warp_secs(UNBLOCK_DELAY_SECS - 60);
    assert_err(
        env.unblock(&stranger, addr, guardian.pubkey()),
        "TimelockActive",
    );
    assert_err(env.deposit(&u, &ta, 0, leaf(1)), "DepositorBlocked");
    env.warp_secs(60);
    // The rent goes back to whoever paid it, nobody else.
    assert_err(
        env.unblock(&stranger, addr, stranger.pubkey()),
        "ConstraintHasOne",
    );
    let lamports = env.svm.get_balance(&guardian.pubkey()).unwrap();
    env.unblock(&stranger, addr, guardian.pubkey()).unwrap();
    assert!(env.svm.get_balance(&guardian.pubkey()).unwrap() > lamports);
    assert!(env.record(&addr).is_none());
    let s = env.screening();
    assert_eq!((s.blocked, s.added, s.removed), (0, 1, 1));

    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
    // And it can be listed again later.
    env.block(&guardian, addr, LIST_STOLEN_FUNDS).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(2)), "DepositorBlocked");
}

#[test]
fn the_pause_and_the_list_are_independent() {
    let mut env = screened_env();
    let guardian = env.guardian.insecure_clone();
    let (u, ta) = env.user(10 * HUNDRED);
    env.pause(&guardian, true).unwrap();
    // The guardian can still list while deposits are paused.
    env.block(&guardian, u.pubkey(), LIST_SANCTIONS).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(1)), "DepositsPaused");
    env.pause(&guardian, false).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(1)), "DepositorBlocked");
}

#[test]
fn after_the_sunset_the_list_can_only_shrink() {
    let lifetime = 30 * 86_400;
    let mut env = Env::try_new(vec![HUNDRED, THOUSAND], default_params(), lifetime).unwrap();
    let admin = env.admin.insecure_clone();
    let guardian = env.guardian.insecure_clone();
    env.init_screening(&admin).unwrap();
    let (u, ta) = env.user(10 * HUNDRED);
    let addr = u.pubkey();
    env.block(&guardian, addr, LIST_SANCTIONS).unwrap();
    env.propose_unblock(&guardian, addr).unwrap();
    env.warp_secs(lifetime + 1);

    // No more additions, no more cancellations.
    assert_err(
        env.block(&guardian, Pubkey::new_unique(), LIST_SANCTIONS),
        "AdminExpired",
    );
    assert_err(env.cancel_unblock(&guardian, addr), "AdminExpired");
    // Existing entries still hold until removed; anyone may announce a removal now.
    assert_err(env.deposit(&u, &ta, 0, leaf(1)), "DepositorBlocked");
    let stranger = env.stranger();
    env.propose_unblock(&stranger, addr).unwrap();
    env.warp_secs(UNBLOCK_DELAY_SECS);
    env.unblock(&stranger, addr, guardian.pubkey()).unwrap();
    env.deposit(&u, &ta, 0, leaf(1)).unwrap();
}
