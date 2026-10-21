//! LiteSVM harness for the gateway: real SBF build (`anchor build`), real SPL Token program,
//! Anchor-generated instruction/account types.
#![allow(dead_code)]

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use eclyps_gateway::{
    accounts, exit_message, instruction, Config, Epoch, ExitBatch, InitializeArgs, Params,
    CONFIG_SEED, EPOCH_SEED, ESCROW_SEED, EXIT_AUTHORITY_SEED, EXIT_BATCH_SEED, EXIT_CUSTODY_SEED,
    FEE_VAULT_SEED,
};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState};

pub use anchor_lang::prelude::Pubkey;
pub use anchor_lang::solana_program::instruction::Instruction;

pub const HUNDRED: u64 = 100_000_000;
pub const THOUSAND: u64 = 1_000_000_000;
/// The treasury USDC account every test deployment names (created in `Env::deployed`).
pub const TREASURY: Pubkey = Pubkey::new_from_array([0x7e; 32]);
pub const TREASURY_OWNER: Pubkey = Pubkey::new_from_array([0x7f; 32]);
/// Default fee and finisher share for new deployments (ADR 0012): 0.5 %, of which 0.3 % to the
/// finisher.
pub const FEE_BPS: u16 = 50;
pub const FINISHER_BPS: u16 = 30;
/// A deposit cap no test reaches unless it means to.
pub const BIG_CAP: u64 = 1_000_000 * THOUSAND;

/// What a note of `denomination` pays on top at `bps`, rounded down (the program's rule).
pub fn fee_of(denomination: u64, bps: u16) -> u64 {
    (denomination as u128 * bps as u128 / 10_000) as u64
}
pub const SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/eclyps_gateway.so"
);
const CCTP_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cctp-devnet");

/// Ethereum portal as CCTP bytes32 (placeholder address 0x…ec175, as in the S1 scripts).
pub const PORTAL: [u8; 32] = {
    let mut p = [0u8; 32];
    p[29] = 0x0e;
    p[30] = 0xc1;
    p[31] = 0x75;
    p
};

pub const TMM: Pubkey = eclyps_gateway::CCTP_TOKEN_MESSENGER_MINTER_V2;
pub const MT: Pubkey = eclyps_gateway::CCTP_MESSAGE_TRANSMITTER_V2;
/// Devnet USDC: the CCTP local_token fixture is keyed by this mint.
pub const DEVNET_USDC: Pubkey =
    anchor_lang::pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

pub const BPF_LOADER_UPGRADEABLE: Pubkey =
    anchor_lang::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

pub fn program_data_pda() -> Pubkey {
    Pubkey::find_program_address(&[eclyps_gateway::ID.as_ref()], &BPF_LOADER_UPGRADEABLE).0
}

/// LiteSVM deploys under the upgradeable loader with no upgrade authority; set one, as a real
/// `solana program deploy` does (ProgramData: tag u32 | slot u64 | Option<Pubkey>).
pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: &Pubkey) {
    let key = program_data_pda();
    let mut acc = svm.get_account(&key).expect("ProgramData");
    acc.data[12] = 1;
    acc.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(key, acc).unwrap();
}

pub fn tmm_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &TMM).0
}

/// Loads Circle's deployed CCTP V2 programs and the devnet state a burn to Ethereum reads
/// (tests/fixtures/cctp-devnet, refreshed by fetch-cctp-devnet.sh).
fn load_cctp(svm: &mut LiteSVM) {
    use base64::Engine;
    use std::io::Read;
    for id in [TMM, MT] {
        let gz = std::fs::read(format!("{CCTP_FIXTURES}/{id}.so.gz")).expect("CCTP fixture");
        let mut so = vec![];
        flate2::read::GzDecoder::new(&gz[..])
            .read_to_end(&mut so)
            .unwrap();
        svm.add_program(id, &so).unwrap();
    }
    for entry in std::fs::read_dir(CCTP_FIXTURES).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let j: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let key: Pubkey = j["pubkey"].as_str().unwrap().parse().unwrap();
        let acc = &j["account"];
        let data = base64::engine::general_purpose::STANDARD
            .decode(acc["data"][0].as_str().unwrap())
            .unwrap();
        svm.set_account(
            key,
            solana_account::Account {
                lamports: acc["lamports"].as_u64().unwrap(),
                data,
                owner: acc["owner"].as_str().unwrap().parse().unwrap(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }
}

pub fn default_params() -> Params {
    Params {
        epoch_len_slots: 9_000, // 1 h
        min_batch_size: 8,
        per_epoch_cap: 32,
        fee_bps: FEE_BPS,
        finisher_bps: FINISHER_BPS,
        deposit_cap: BIG_CAP,
        treasury: TREASURY,
    }
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &eclyps_gateway::ID).0
}

/// The screening record of a depositor (ADR 0019): ["blocked", address].
pub fn blocked_pda(address: &Pubkey) -> Pubkey {
    pda(&[eclyps_gateway::BLOCKED_SEED, address.as_ref()])
}

pub fn epoch_pda(idx: u8, epoch_id: u64) -> Pubkey {
    pda(&[EPOCH_SEED, &[idx], &epoch_id.to_le_bytes()])
}

/// The Front PDA of an exit leaf (ADR 0017).
pub fn front_pda(leaf: &[u8; 32]) -> Pubkey {
    pda(&[eclyps_gateway::FRONT_SEED, leaf])
}

/// A canonical, non-zero leaf derived from a seed (Poseidon of the seed).
pub fn leaf(seed: u64) -> [u8; 32] {
    eclyps_merkle::hash_pair(
        &eclyps_merkle::field_from_u64(seed + 1),
        &eclyps_merkle::field_from_u64(7),
    )
    .unwrap()
}

pub type TxResult = Result<TransactionMetadata, String>;

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub guardian: Keypair,
    pub mint: Pubkey,
    pub config: Pubkey,
    pub escrow: Pubkey,
    pub fee_vault: Pubkey,
    pub exit_authority: Pubkey,
    pub exit_custody: Pubkey,
    /// CCTP nonces handed out to exit messages (each message needs its own).
    pub next_nonce: u64,
    /// Address lookup table for receive_exit, created on first use.
    pub exit_alt: Option<Pubkey>,
}

impl Env {
    pub fn new(params: Params) -> Self {
        Self::try_new(vec![HUNDRED, THOUSAND], params, 730 * 86_400).expect("initialize")
    }

    pub fn try_new(denominations: Vec<u64>, params: Params, lifetime: i64) -> Result<Self, String> {
        let mut env = Self::deployed();
        let admin = env.admin.insecure_clone();
        env.initialize(&admin, denominations, params, lifetime)
            .map(|_| env)
    }

    /// Program deployed (upgrade authority = `admin`) but not initialized.
    pub fn deployed() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            eclyps_gateway::ID,
            &std::fs::read(SO).expect("run `anchor build` first"),
        )
        .unwrap();
        let admin = Keypair::new();
        let guardian = Keypair::new();
        set_upgrade_authority(&mut svm, &admin.pubkey());
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&guardian.pubkey(), 1_000_000_000).unwrap();
        load_cctp(&mut svm);
        set_test_attesters(&mut svm);
        let mut env = Env {
            svm,
            admin,
            guardian,
            mint: DEVNET_USDC,
            config: pda(&[CONFIG_SEED]),
            escrow: pda(&[ESCROW_SEED]),
            fee_vault: pda(&[FEE_VAULT_SEED]),
            exit_authority: pda(&[EXIT_AUTHORITY_SEED]),
            exit_custody: pda(&[EXIT_CUSTODY_SEED]),
            next_nonce: 1,
            exit_alt: None,
        };
        env.set_usdc_account(TREASURY, &TREASURY_OWNER, 0, AccountState::Initialized);
        env
    }

    /// `signer` becomes the admin; it must be the upgrade authority.
    pub fn initialize(
        &mut self,
        signer: &Keypair,
        denominations: Vec<u64>,
        params: Params,
        lifetime: i64,
    ) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::Initialize {
                admin: signer.pubkey(),
                config: self.config,
                usdc_mint: self.mint,
                escrow: self.escrow,
                fee_vault: self.fee_vault,
                exit_authority: self.exit_authority,
                exit_custody: self.exit_custody,
                treasury: params.treasury,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
                program: eclyps_gateway::ID,
                program_data: program_data_pda(),
            }
            .to_account_metas(None),
            data: instruction::Initialize {
                args: InitializeArgs {
                    guardian: self.guardian.pubkey(),
                    portal: PORTAL,
                    denominations,
                    params,
                    admin_lifetime_secs: lifetime,
                },
            }
            .data(),
        };
        self.send(&[ix], signer, &[])
    }

    pub fn send(&mut self, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> TxResult {
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let msg = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r.map_err(|e| format!("{:?} {}", e.err, e.meta.logs.join("\n")))
    }

    /// A funded user wallet with a USDC token account holding `usdc`.
    pub fn user(&mut self, usdc: u64) -> (Keypair, Pubkey) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let ta = Pubkey::new_unique();
        self.set_usdc_account(ta, &kp.pubkey(), usdc, AccountState::Initialized);
        (kp, ta)
    }

    /// Writes a USDC token account at `key` (any state, e.g. Frozen).
    pub fn set_usdc_account(
        &mut self,
        key: Pubkey,
        owner: &Pubkey,
        usdc: u64,
        state: AccountState,
    ) {
        let mut data = vec![0u8; TokenAccount::LEN];
        TokenAccount {
            mint: self.mint,
            owner: *owner,
            amount: usdc,
            delegate: COption::None,
            state,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        set_token_owned(&mut self.svm, key, data);
    }

    pub fn config(&self) -> Config {
        let a = self.svm.get_account(&self.config).unwrap();
        Config::try_deserialize(&mut &a.data[..]).unwrap()
    }

    pub fn epoch(&self, idx: u8, id: u64) -> Option<Epoch> {
        let a = self.svm.get_account(&epoch_pda(idx, id))?;
        if a.data.is_empty() {
            return None;
        }
        Some(Epoch::try_deserialize(&mut &a.data[..]).unwrap())
    }

    pub fn token_balance(&self, ta: &Pubkey) -> u64 {
        let a = self.svm.get_account(ta).unwrap();
        TokenAccount::unpack(&a.data).unwrap().amount
    }

    pub fn escrow_balance(&self) -> u64 {
        self.token_balance(&self.escrow)
    }

    pub fn fee_vault_balance(&self) -> u64 {
        self.token_balance(&self.fee_vault)
    }

    /// The treasury the config names now (0 when its account is gone).
    pub fn treasury_balance(&self) -> u64 {
        let t = self.config().params.treasury;
        self.svm
            .get_account(&t)
            .and_then(|a| TokenAccount::unpack(&a.data).ok())
            .map_or(0, |a| a.amount)
    }

    pub fn clock(&self) -> Clock {
        self.svm.get_sysvar::<Clock>()
    }

    pub fn warp_slots(&mut self, n: u64) {
        let mut c = self.clock();
        c.slot += n;
        c.unix_timestamp += (n as i64 * 2) / 5; // ~400 ms per slot
        self.svm.set_sysvar(&c);
    }

    pub fn warp_secs(&mut self, secs: i64) {
        let mut c = self.clock();
        c.unix_timestamp += secs;
        c.slot += (secs as u64 * 5) / 2;
        self.svm.set_sysvar(&c);
    }

    // ---- instruction builders ----

    pub fn ix_open_epoch(&self, payer: &Pubkey, idx: u8) -> Instruction {
        let id = self
            .config()
            .current_epoch
            .get(idx as usize)
            .copied()
            .unwrap_or(u64::MAX);
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::OpenEpoch {
                payer: *payer,
                config: self.config,
                epoch: epoch_pda(idx, id),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::OpenEpoch {
                denomination_index: idx,
            }
            .data(),
        }
    }

    pub fn ix_deposit(
        &self,
        user: &Pubkey,
        source: &Pubkey,
        idx: u8,
        leaf: [u8; 32],
    ) -> Instruction {
        let id = self
            .config()
            .current_epoch
            .get(idx as usize)
            .copied()
            .unwrap_or(u64::MAX);
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::Deposit {
                payer: *user,
                authority: *user,
                config: self.config,
                epoch: epoch_pda(idx, id),
                source: *source,
                escrow: self.escrow,
                fee_vault: self.fee_vault,
                usdc_mint: self.mint,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
                blocked: blocked_pda(user),
            }
            .to_account_metas(None),
            data: instruction::Deposit {
                denomination_index: idx,
                secret_hash: leaf,
            }
            .data(),
        }
    }

    /// Client flow: open the current epoch if needed, then deposit (one tx).
    pub fn deposit(
        &mut self,
        user: &Keypair,
        source: &Pubkey,
        idx: u8,
        leaf: [u8; 32],
    ) -> TxResult {
        let ixs = [
            self.ix_open_epoch(&user.pubkey(), idx),
            self.ix_deposit(&user.pubkey(), source, idx, leaf),
        ];
        self.send(&ixs, user, &[])
    }

    pub fn close_epoch(&mut self, idx: u8) -> TxResult {
        let id = self
            .config()
            .current_epoch
            .get(idx as usize)
            .copied()
            .unwrap_or(u64::MAX);
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::CloseEpoch {
                config: self.config,
                epoch: epoch_pda(idx, id),
            }
            .to_account_metas(None),
            data: instruction::CloseEpoch {
                denomination_index: idx,
            }
            .data(),
        };
        let budget = compute_budget(1_400_000);
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        self.send(&[budget, ix], &payer, &[])
    }

    pub fn ix_send_batch(
        &self,
        payer: &Pubkey,
        finisher_usdc: &Pubkey,
        event: &Pubkey,
        idx: u8,
        epoch_id: u64,
        tmm: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::SendBatch {
                payer: *payer,
                config: self.config,
                epoch: epoch_pda(idx, epoch_id),
                escrow: self.escrow,
                fee_vault: self.fee_vault,
                finisher_usdc: *finisher_usdc,
                treasury: self.config().params.treasury,
                usdc_mint: self.mint,
                message_sent_event_data: *event,
                cctp_sender_authority: tmm_pda(&[b"sender_authority"]),
                cctp_denylist: tmm_pda(&[b"denylist_account", self.config.as_ref()]),
                cctp_message_transmitter: Pubkey::find_program_address(
                    &[b"message_transmitter"],
                    &MT,
                )
                .0,
                cctp_token_messenger: tmm_pda(&[b"token_messenger"]),
                cctp_remote_token_messenger: tmm_pda(&[b"remote_token_messenger", b"0"]),
                cctp_token_minter: tmm_pda(&[b"token_minter"]),
                cctp_local_token: tmm_pda(&[b"local_token", self.mint.as_ref()]),
                cctp_event_authority: tmm_pda(&[b"__event_authority"]),
                cctp_message_transmitter_program: MT,
                cctp_token_messenger_minter_program: tmm,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::SendBatch {
                denomination_index: idx,
                epoch_id,
            }
            .data(),
        }
    }

    /// A finisher: a funded wallet with an empty USDC account for its share of the fees.
    pub fn finisher(&mut self) -> (Keypair, Pubkey) {
        self.user(0)
    }

    /// Finisher flow by `finisher`, paid to `finisher_usdc`; returns the tx result and the
    /// MessageSent account address.
    pub fn send_batch_by(
        &mut self,
        finisher: &Keypair,
        finisher_usdc: &Pubkey,
        idx: u8,
        epoch_id: u64,
        tmm: Pubkey,
    ) -> (TxResult, Pubkey) {
        let event = Keypair::new();
        let ixs = [
            compute_budget(400_000),
            self.ix_send_batch(
                &finisher.pubkey(),
                finisher_usdc,
                &event.pubkey(),
                idx,
                epoch_id,
                tmm,
            ),
        ];
        (self.send(&ixs, finisher, &[&event]), event.pubkey())
    }

    /// Finisher flow by a fresh finisher; returns the tx result and the MessageSent account address.
    pub fn send_batch_with(&mut self, idx: u8, epoch_id: u64, tmm: Pubkey) -> (TxResult, Pubkey) {
        let (f, fu) = self.finisher();
        self.send_batch_by(&f, &fu, idx, epoch_id, tmm)
    }

    pub fn send_batch(&mut self, idx: u8, epoch_id: u64) -> TxResult {
        self.send_batch_with(idx, epoch_id, TMM).0
    }

    /// The CCTP message bytes stored in a MessageSent account (ADR 0002 layout).
    pub fn cctp_message(&self, message_sent: &Pubkey) -> Vec<u8> {
        let a = self
            .svm
            .get_account(message_sent)
            .expect("MessageSent account");
        let len = u32::from_le_bytes(a.data[48..52].try_into().unwrap()) as usize;
        a.data[52..52 + len].to_vec()
    }

    pub fn pause(&mut self, signer: &Keypair, pause: bool) -> TxResult {
        let accounts = accounts::Pause {
            signer: signer.pubkey(),
            config: self.config,
        }
        .to_account_metas(None);
        let data = if pause {
            instruction::PauseDeposits {}.data()
        } else {
            instruction::UnpauseDeposits {}.data()
        };
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts,
            data,
        };
        self.send(&[ix], signer, &[])
    }

    /// Refunds `leaf` from the current epoch of `idx` to `destination`, signed by `user`.
    pub fn refund(
        &mut self,
        user: &Keypair,
        destination: &Pubkey,
        idx: u8,
        leaf: [u8; 32],
    ) -> TxResult {
        let id = self
            .config()
            .current_epoch
            .get(idx as usize)
            .copied()
            .unwrap_or(u64::MAX);
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::RefundDeposit {
                authority: user.pubkey(),
                config: self.config,
                epoch: epoch_pda(idx, id),
                destination: *destination,
                escrow: self.escrow,
                fee_vault: self.fee_vault,
                usdc_mint: self.mint,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::RefundDeposit {
                denomination_index: idx,
                commitment: leaf,
            }
            .data(),
        };
        self.send(&[ix], user, &[])
    }

    pub fn set_guardian(&mut self, signer: &Keypair, guardian: Pubkey) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::AdminOnly {
                admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: instruction::SetGuardian { guardian }.data(),
        };
        self.send(&[ix], signer, &[])
    }

    pub fn propose_admin(&mut self, signer: &Keypair, new_admin: Pubkey) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::AdminOnly {
                admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: instruction::ProposeAdmin { new_admin }.data(),
        };
        self.send(&[ix], signer, &[])
    }

    pub fn accept_admin(&mut self, signer: &Keypair) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::AcceptAdmin {
                new_admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: instruction::AcceptAdmin {}.data(),
        };
        self.send(&[ix], signer, &[])
    }

    /// A funded keypair with no role.
    pub fn stranger(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap();
        kp
    }

    pub fn propose(&mut self, signer: &Keypair, params: Params) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::AdminOnly {
                admin: signer.pubkey(),
                config: self.config,
            }
            .to_account_metas(None),
            data: instruction::ProposeParams { params }.data(),
        };
        self.send(&[ix], signer, &[])
    }

    pub fn apply(&mut self) -> TxResult {
        let ix = Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::ApplyParams {
                config: self.config,
            }
            .to_account_metas(None),
            data: instruction::ApplyParams {}.data(),
        };
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        self.send(&[ix], &payer, &[])
    }
}

pub fn compute_budget(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap(),
        accounts: vec![],
        data,
    }
}

fn set_token_owned(svm: &mut LiteSVM, key: Pubkey, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        key,
        solana_account::Account {
            lamports,
            data,
            owner: spl_token_interface::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn assert_err(r: TxResult, needle: &str) {
    match r {
        Ok(_) => panic!("expected failure containing {needle:?}, got success"),
        Err(e) => assert!(e.contains(needle), "expected {needle:?} in:\n{e}"),
    }
}

// ---------- exit (ADR 0009) ----------

/// Hex of an EVM address (no 0x) -> CCTP bytes32 (12 zero bytes + 20).
pub fn evm32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..20 {
        out[12 + i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

/// Ethereum's TokenMessengerV2 on testnets (0x8FE6…2DAA), as registered in the devnet
/// remote_token_messenger for domain 0 (fixture 3EzN2…).
pub fn eth_token_messenger() -> [u8; 32] {
    evm32("8fe6b999dc680ccfdd5bf7eb0974218be2542daa")
}

/// Sepolia USDC, the burn token of an exit; the devnet token_pair (domain 0) maps it to
/// devnet USDC.
pub fn sepolia_usdc() -> [u8; 32] {
    evm32("1c7d4b196cb0c7b01d743fbc6116a902379c7238")
}

pub const ATA_PROGRAM: Pubkey =
    anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const ALT_PROGRAM: Pubkey = anchor_lang::pubkey!("AddressLookupTab1e1111111111111111111111111");
/// Solana's packet limit for a serialized transaction.
pub const PACKET_DATA_SIZE: usize = 1232;

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            spl_token_interface::ID.as_ref(),
            mint.as_ref(),
        ],
        &ATA_PROGRAM,
    )
    .0
}

pub fn mt_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &MT).0
}

pub fn exit_batch_pda(idx: u8, exit_epoch_id: u64) -> Pubkey {
    pda(&[EXIT_BATCH_SEED, &[idx], &exit_epoch_id.to_le_bytes()])
}

pub fn keccak(data: &[u8]) -> [u8; 32] {
    use sha3::Digest;
    sha3::Keccak256::digest(data).into()
}

/// A test attester: a secp256k1 key and its EVM address as CCTP stores it (bytes32).
pub struct Attester {
    pub key: k256::ecdsa::SigningKey,
    pub address: [u8; 32],
}

/// Two fixed attesters, replacing devnet's two (threshold 2 stays, as on devnet).
pub fn test_attesters() -> Vec<Attester> {
    [[0x11u8; 32], [0x22u8; 32]]
        .iter()
        .map(|k| {
            let key = k256::ecdsa::SigningKey::from_slice(k).unwrap();
            let point = key.verifying_key().to_encoded_point(false);
            let mut address = [0u8; 32];
            address[12..].copy_from_slice(&keccak(&point.as_bytes()[1..])[12..]);
            Attester { key, address }
        })
        .collect()
}

/// Replaces the enabled attesters in the MessageTransmitterV2 state account. Layout (Anchor
/// `MessageTransmitter`, circlefin/solana-cctp-contracts programs/v2): disc 8 | owner 32 |
/// pending_owner 32 | attester_manager 32 | pauser 32 | paused u8 @136 | local_domain u32 @137 |
/// version u32 @141 | signature_threshold u32 @145 | enabled_attesters Vec<Pubkey> (u32 len @149,
/// then 32 bytes each from @153) | max_message_body_size u64. The current values are asserted
/// first, so a fixture refresh that changes the layout fails here.
pub fn set_test_attesters(svm: &mut LiteSVM) {
    let key = eclyps_gateway::CCTP_MESSAGE_TRANSMITTER_STATE;
    assert_eq!(key, mt_pda(&[b"message_transmitter"]));
    let mut acc = svm.get_account(&key).expect("MessageTransmitter state");
    let u32_at = |d: &[u8], o: usize| u32::from_le_bytes(d[o..o + 4].try_into().unwrap());
    assert_eq!(acc.data.len(), 225);
    assert_eq!(acc.data[136], 0, "not paused");
    assert_eq!(u32_at(&acc.data, 137), 5, "local domain Solana");
    assert_eq!(u32_at(&acc.data, 141), 1, "message version");
    assert_eq!(u32_at(&acc.data, 145), 2, "signature threshold");
    assert_eq!(u32_at(&acc.data, 149), 2, "two enabled attesters");
    for (i, a) in test_attesters().iter().enumerate() {
        acc.data[153 + 32 * i..185 + 32 * i].copy_from_slice(&a.address);
    }
    svm.set_account(key, acc).unwrap();
}

/// Iris's attestation: one 65-byte (r, s, v) signature over keccak256(message) per attester,
/// ordered by attester address (MessageTransmitterV2 requires increasing order and low s).
pub fn attest(message: &[u8]) -> Vec<u8> {
    let hash = keccak(message);
    let mut attesters = test_attesters();
    attesters.sort_by_key(|a| a.address);
    let mut out = vec![];
    for a in attesters {
        let (sig, recid) = a.key.sign_prehash_recoverable(&hash).unwrap();
        assert!(sig.normalize_s().is_none(), "low s");
        out.extend_from_slice(&sig.to_bytes());
        out.push(27 + recid.to_byte());
    }
    out
}

/// An exit message field by field, as Ethereum's TokenMessengerV2 builds it for the portal's
/// `depositForBurnWithHook` and Iris fills it in (MessageV2 + BurnMessageV2, big-endian).
#[derive(Clone)]
pub struct ExitMsg {
    pub version: u32,
    pub source_domain: u32,
    pub destination_domain: u32,
    pub nonce: [u8; 32],
    pub sender: [u8; 32],
    pub recipient: [u8; 32],
    pub destination_caller: [u8; 32],
    pub min_finality: u32,
    pub finality_executed: u32,
    pub body_version: u32,
    pub burn_token: [u8; 32],
    pub mint_recipient: [u8; 32],
    pub amount: u64,
    pub message_sender: [u8; 32],
    pub max_fee: u64,
    pub fee_executed: u64,
    pub expiration_block: u64,
    pub hook: Vec<u8>,
}

fn u256(x: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

impl ExitMsg {
    pub fn bytes(&self) -> Vec<u8> {
        let mut m = vec![];
        m.extend_from_slice(&self.version.to_be_bytes());
        m.extend_from_slice(&self.source_domain.to_be_bytes());
        m.extend_from_slice(&self.destination_domain.to_be_bytes());
        m.extend_from_slice(&self.nonce);
        m.extend_from_slice(&self.sender);
        m.extend_from_slice(&self.recipient);
        m.extend_from_slice(&self.destination_caller);
        m.extend_from_slice(&self.min_finality.to_be_bytes());
        m.extend_from_slice(&self.finality_executed.to_be_bytes());
        assert_eq!(m.len(), 148, "MessageV2 header");
        m.extend_from_slice(&self.body_version.to_be_bytes());
        m.extend_from_slice(&self.burn_token);
        m.extend_from_slice(&self.mint_recipient);
        m.extend_from_slice(&u256(self.amount));
        m.extend_from_slice(&self.message_sender);
        m.extend_from_slice(&u256(self.max_fee));
        m.extend_from_slice(&u256(self.fee_executed));
        m.extend_from_slice(&u256(self.expiration_block));
        assert_eq!(m.len(), 376, "BurnMessageV2 body before the hook");
        m.extend_from_slice(&self.hook);
        m
    }
}

/// The exit hook, written out field by field (ADR 0009: the batch hook layout, version 2).
pub fn exit_hook(
    version: u8,
    denomination: u64,
    exit_epoch_id: u64,
    count: u16,
    root: &[u8; 32],
) -> Vec<u8> {
    let mut h = vec![version];
    h.extend_from_slice(&denomination.to_be_bytes());
    h.extend_from_slice(&exit_epoch_id.to_be_bytes());
    h.extend_from_slice(&count.to_be_bytes());
    h.extend_from_slice(root);
    assert_eq!(h.len(), 51);
    h
}

/// A canonical exit secret derived from a seed (Poseidon of the seed).
pub fn exit_secret(seed: u64) -> [u8; 32] {
    eclyps_merkle::hash_pair(
        &eclyps_merkle::field_from_u64(seed + 1),
        &eclyps_merkle::field_from_u64(3),
    )
    .unwrap()
}

/// An exit tree: destinations, secrets and their leaves (ADR 0009).
#[derive(Clone)]
pub struct ExitTree {
    pub destinations: Vec<Pubkey>,
    pub secrets: Vec<[u8; 32]>,
    pub leaves: Vec<[u8; 32]>,
    pub root: [u8; 32],
}

impl ExitTree {
    /// `n` exits to fresh destinations, secrets from `seed`.
    pub fn new(n: usize, seed: u64) -> Self {
        Self::to((0..n).map(|_| Pubkey::new_unique()).collect(), seed)
    }

    pub fn to(destinations: Vec<Pubkey>, seed: u64) -> Self {
        let secrets: Vec<[u8; 32]> = (0..destinations.len() as u64)
            .map(|i| exit_secret(seed * 1_000 + i))
            .collect();
        let leaves: Vec<[u8; 32]> = destinations
            .iter()
            .zip(&secrets)
            .map(|(d, s)| eclyps_merkle::exit_commitment(&d.to_bytes(), s).unwrap())
            .collect();
        let root = eclyps_merkle::root(&leaves, eclyps_merkle::BATCH_TREE_DEPTH).unwrap();
        ExitTree {
            destinations,
            secrets,
            leaves,
            root,
        }
    }

    pub fn path(&self, i: usize) -> [[u8; 32]; 8] {
        eclyps_merkle::path(&self.leaves, i, eclyps_merkle::BATCH_TREE_DEPTH)
            .unwrap()
            .try_into()
            .unwrap()
    }

    pub fn count(&self) -> u16 {
        self.leaves.len() as u16
    }
}

fn cu16(n: usize) -> usize {
    if n < 0x80 {
        1
    } else if n < 0x4000 {
        2
    } else {
        3
    }
}

/// Wire size of a transaction (compact-u16 lengths), as the cluster's packet limit counts it.
pub fn wire_size(tx: &solana_transaction::versioned::VersionedTransaction) -> usize {
    use solana_message::VersionedMessage;
    let (prefix, keys, ixs, lookups) = match &tx.message {
        VersionedMessage::Legacy(m) => (0, m.account_keys.len(), &m.instructions, None),
        VersionedMessage::V0(m) => (
            1,
            m.account_keys.len(),
            &m.instructions,
            Some(&m.address_table_lookups),
        ),
        _ => panic!("only legacy and v0 messages are sized here"),
    };
    let ixs_len: usize = cu16(ixs.len())
        + ixs
            .iter()
            .map(|ix| {
                1 + cu16(ix.accounts.len())
                    + ix.accounts.len()
                    + cu16(ix.data.len())
                    + ix.data.len()
            })
            .sum::<usize>();
    let lookups_len = lookups.map_or(0, |ls| {
        cu16(ls.len())
            + ls.iter()
                .map(|l| {
                    32 + cu16(l.writable_indexes.len())
                        + l.writable_indexes.len()
                        + cu16(l.readonly_indexes.len())
                        + l.readonly_indexes.len()
                })
                .sum::<usize>()
    });
    cu16(tx.signatures.len())
        + 64 * tx.signatures.len()
        + prefix
        + 3
        + cu16(keys)
        + 32 * keys
        + 32
        + ixs_len
        + lookups_len
}

impl Env {
    /// A fresh CCTP nonce (Iris assigns a unique one per message).
    pub fn nonce(&mut self) -> [u8; 32] {
        self.next_nonce += 1;
        keccak(&self.next_nonce.to_be_bytes())
    }

    /// A valid exit message for `tree` as exit epoch `exit_epoch_id` of denomination `idx`.
    pub fn exit_msg(&mut self, idx: u8, exit_epoch_id: u64, tree: &ExitTree) -> ExitMsg {
        let denomination = self.config().denominations[idx as usize];
        ExitMsg {
            version: 1,
            source_domain: 0,
            destination_domain: 5,
            nonce: self.nonce(),
            sender: eth_token_messenger(),
            recipient: TMM.to_bytes(),
            destination_caller: self.exit_authority.to_bytes(),
            min_finality: 2000,
            finality_executed: 2000,
            body_version: 1,
            burn_token: sepolia_usdc(),
            mint_recipient: self.exit_custody.to_bytes(),
            amount: denomination * tree.count() as u64,
            message_sender: PORTAL,
            max_fee: 0,
            fee_executed: 0,
            expiration_block: 0,
            hook: exit_hook(2, denomination, exit_epoch_id, tree.count(), &tree.root),
        }
    }

    /// The USDC account of CCTP's `token_messenger.fee_recipient`.
    pub fn cctp_fee_recipient_usdc(&self) -> Pubkey {
        let tm = self
            .svm
            .get_account(&eclyps_gateway::CCTP_TOKEN_MESSENGER)
            .unwrap();
        // disc 8 | denylister 32 | owner 32 | pending_owner 32 | message_body_version u32 |
        // authority_bump u8 | fee_recipient 32 | ...
        let fee_recipient = Pubkey::new_from_array(tm.data[109..141].try_into().unwrap());
        ata(&fee_recipient, &self.mint)
    }

    /// receive_exit for `message`, with the accounts a client derives from it.
    pub fn ix_receive_exit(
        &self,
        payer: &Pubkey,
        message: &[u8],
        attestation: &[u8],
    ) -> Instruction {
        let denominations = self.config().denominations;
        let exit_batch = pda(&[
            EXIT_BATCH_SEED,
            &exit_message::batch_seed_index(message, &denominations),
            &exit_message::batch_seed_epoch(message),
        ]);
        let burn_token = message.get(152..184).unwrap_or(&[0u8; 32]);
        let nonce = message.get(12..44).unwrap_or(&[0u8; 32]);
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::ReceiveExit {
                payer: *payer,
                config: self.config,
                exit_authority: self.exit_authority,
                exit_custody: self.exit_custody,
                exit_batch,
                cctp_message_transmitter: mt_pda(&[b"message_transmitter"]),
                cctp_used_nonce: mt_pda(&[b"used_nonce", nonce]),
                cctp_authority_pda: mt_pda(&[b"message_transmitter_authority", TMM.as_ref()]),
                cctp_mt_event_authority: mt_pda(&[b"__event_authority"]),
                cctp_token_messenger: tmm_pda(&[b"token_messenger"]),
                cctp_remote_token_messenger: tmm_pda(&[b"remote_token_messenger", b"0"]),
                cctp_token_minter: tmm_pda(&[b"token_minter"]),
                cctp_local_token: tmm_pda(&[b"local_token", self.mint.as_ref()]),
                cctp_token_pair: tmm_pda(&[b"token_pair", b"0", burn_token]),
                cctp_fee_recipient_token_account: self.cctp_fee_recipient_usdc(),
                cctp_custody: tmm_pda(&[b"custody", self.mint.as_ref()]),
                cctp_tmm_event_authority: tmm_pda(&[b"__event_authority"]),
                cctp_message_transmitter_program: MT,
                cctp_token_messenger_minter_program: TMM,
                token_program: spl_token_interface::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::ReceiveExit {
                message: message.to_vec(),
                attestation: attestation.to_vec(),
            }
            .data(),
        }
    }

    /// The lookup table a finisher creates once per deployment: every receive_exit account
    /// except the payer, the two per-message PDAs (exit_batch, used_nonce) and the invoked
    /// gateway program. Written directly into LiteSVM, already active.
    pub fn exit_lookup_table(&mut self) -> solana_message::AddressLookupTableAccount {
        use solana_address_lookup_table_interface::state::{AddressLookupTable, LookupTableMeta};
        let mut message = [0u8; 427];
        message[152..184].copy_from_slice(&sepolia_usdc()); // the burn token picks token_pair
        let probe = self.ix_receive_exit(&Pubkey::default(), &message, &[]);
        let per_message = [probe.accounts[4].pubkey, probe.accounts[6].pubkey];
        let addresses: Vec<Pubkey> = probe.accounts[1..]
            .iter()
            .map(|a| a.pubkey)
            .filter(|k| !per_message.contains(k))
            .collect();
        assert_eq!(addresses.len(), 18);
        let key = *self.exit_alt.get_or_insert_with(Pubkey::new_unique);
        let data = AddressLookupTable {
            meta: LookupTableMeta {
                deactivation_slot: u64::MAX,
                last_extended_slot: 0,
                last_extended_slot_start_index: addresses.len() as u8,
                authority: None,
                _padding: 0,
            },
            addresses: std::borrow::Cow::Owned(addresses.clone()),
        }
        .serialize_for_tests()
        .unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                key,
                solana_account::Account {
                    lamports,
                    data,
                    owner: ALT_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        solana_message::AddressLookupTableAccount { key, addresses }
    }

    /// Sends `ixs` as a v0 transaction with the exit lookup table, and asserts that it fits a
    /// packet.
    pub fn send_v0(&mut self, ixs: &[Instruction], payer: &Keypair) -> TxResult {
        use solana_message::{v0, VersionedMessage};
        use solana_transaction::versioned::VersionedTransaction;
        let alt = self.exit_lookup_table();
        let msg =
            v0::Message::try_compile(&payer.pubkey(), ixs, &[alt], self.svm.latest_blockhash())
                .unwrap();
        let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[payer]).unwrap();
        let size = wire_size(&tx);
        assert!(size <= PACKET_DATA_SIZE, "transaction is {size} bytes");
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r.map_err(|e| format!("{:?} {}", e.err, e.meta.logs.join("\n")))
    }

    /// Relays an exit message: receive_exit in a v0 transaction, as a finisher does.
    pub fn receive_exit_by(
        &mut self,
        payer: &Keypair,
        message: &[u8],
        attestation: &[u8],
    ) -> TxResult {
        let ixs = [
            compute_budget(400_000),
            self.ix_receive_exit(&payer.pubkey(), message, attestation),
        ];
        self.send_v0(&ixs, payer)
    }

    pub fn receive_exit(&mut self, message: &[u8]) -> TxResult {
        let payer = self.stranger();
        self.receive_exit_by(&payer, message, &attest(message))
    }

    /// Builds, attests and relays a valid exit for `tree`.
    pub fn exit(&mut self, idx: u8, exit_epoch_id: u64, tree: &ExitTree) -> TxResult {
        let m = self.exit_msg(idx, exit_epoch_id, tree).bytes();
        self.receive_exit(&m)
    }

    pub fn exit_batch(&self, idx: u8, exit_epoch_id: u64) -> Option<ExitBatch> {
        let a = self.svm.get_account(&exit_batch_pda(idx, exit_epoch_id))?;
        if a.data.is_empty() {
            return None;
        }
        Some(ExitBatch::try_deserialize(&mut &a.data[..]).unwrap())
    }

    pub fn exit_custody_balance(&self) -> u64 {
        self.token_balance(&self.exit_custody)
    }

    /// USDC in `owner`'s associated account (0 if it does not exist).
    pub fn usdc_of(&self, owner: &Pubkey) -> u64 {
        self.svm
            .get_account(&ata(owner, &self.mint))
            .and_then(|a| TokenAccount::unpack(&a.data).ok())
            .map_or(0, |a| a.amount)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_claim_exit(
        &self,
        payer: &Pubkey,
        idx: u8,
        exit_epoch_id: u64,
        leaf_index: u16,
        path: [[u8; 32]; 8],
        destination: Pubkey,
        secret: [u8; 32],
    ) -> Instruction {
        Instruction {
            program_id: eclyps_gateway::ID,
            accounts: accounts::ClaimExit {
                payer: *payer,
                config: self.config,
                exit_batch: exit_batch_pda(idx, exit_epoch_id),
                exit_authority: self.exit_authority,
                exit_custody: self.exit_custody,
                destination_wallet: destination,
                destination_usdc: ata(&destination, &self.mint),
                usdc_mint: self.mint,
                token_program: spl_token_interface::ID,
                associated_token_program: ATA_PROGRAM,
                system_program: anchor_lang::system_program::ID,
                // Not fronted: the Front PDA is empty and the last three are the payer (ADR 0017).
                front: front_pda(&eclyps_gateway::front_seed(&destination, &secret)),
                front_payee: *payer,
                front_rent_receiver: *payer,
                liquidity: *payer,
            }
            .to_account_metas(None),
            data: instruction::ClaimExit {
                denomination_index: idx,
                exit_epoch_id,
                leaf_index,
                path,
                destination,
                secret,
            }
            .data(),
        }
    }

    /// Claims leaf `i` of `tree` with its own destination and secret, relayed by a stranger.
    pub fn claim_exit(
        &mut self,
        idx: u8,
        exit_epoch_id: u64,
        tree: &ExitTree,
        i: usize,
    ) -> TxResult {
        let payer = self.stranger();
        let ix = self.ix_claim_exit(
            &payer.pubkey(),
            idx,
            exit_epoch_id,
            i as u16,
            tree.path(i),
            tree.destinations[i],
            tree.secrets[i],
        );
        self.send(&[ix], &payer, &[])
    }
}
