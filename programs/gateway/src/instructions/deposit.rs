use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::GatewayError, events::Deposited, state::*};

/// Deposits exactly one denomination of USDC into the escrow, plus the epoch's fee into the fee
/// vault (ADR 0012), and appends `secret_hash` (the note commitment `H(nullifier_key, secret)`,
/// ADR 0004) to the open epoch. Callable by a wallet or via CPI from an integrated shielded pool
/// (`authority` may be a PDA signer).
#[derive(Accounts)]
#[instruction(denomination_index: u8)]
pub struct Deposit<'info> {
    /// Pays the rent for the 64 bytes this deposit adds to the epoch account.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns `source`; recorded as the depositor, the only signer who can refund this leaf.
    pub authority: Signer<'info>,
    /// Writable: the deposit counts towards `net_deposits` (deposit cap).
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, &[denomination_index], &config.current_epoch_seed(denomination_index)],
        bump = epoch.bump,
        realloc = Epoch::space(epoch.leaves.len() + 1),
        realloc::payer = payer,
        realloc::zero = false,
    )]
    pub epoch: Account<'info, Epoch>,
    #[account(mut, token::mint = usdc_mint, token::authority = authority)]
    pub source: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.escrow)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: the screening record of `authority` (ADR 0019), PDA ["blocked", authority]. Empty
    /// unless the guardian listed that address; the deposit is refused when it holds a record.
    /// Last, so clients that pass it also work with a gateway built before it (extra accounts are
    /// ignored there).
    #[account(seeds = [BLOCKED_SEED, authority.key().as_ref()], bump)]
    pub blocked: UncheckedAccount<'info>,
}

pub fn handle_deposit(
    ctx: Context<Deposit>,
    denomination_index: u8,
    secret_hash: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.config;
    let denomination = config.denomination(denomination_index)?;
    let now = Clock::get()?.unix_timestamp;
    require!(!config.deposits_paused(now), GatewayError::DepositsPaused);
    require!(
        !is_blocked(&ctx.accounts.blocked),
        GatewayError::DepositorBlocked
    );
    // The deposit cap bounds the principal that has entered while the code is young (ADR 0012).
    let net_deposits = config
        .net_deposits
        .checked_add(denomination)
        .ok_or(GatewayError::Overflow)?;
    require!(
        net_deposits <= config.params.deposit_cap,
        GatewayError::DepositCapReached
    );

    let epoch = &ctx.accounts.epoch;
    require!(
        epoch.status == EpochStatus::Open,
        GatewayError::EpochNotOpen
    );
    let cap = config.params.per_epoch_cap.min(MAX_BATCH_LEAVES) as usize;
    require!(epoch.leaves.len() < cap, GatewayError::EpochFull);
    // A non-canonical leaf would make close_epoch fail for the whole batch (ADR 0004); a zero
    // leaf is indistinguishable from padding and could never be claimed.
    require!(
        eclyps_merkle::is_canonical(&secret_hash) && secret_hash != eclyps_merkle::ZERO_LEAF,
        GatewayError::InvalidLeaf
    );
    // A repeated commitment could never be claimed twice (the claim nullifier depends only on
    // the note's keys) and would link both deposits. Other epochs are checked by the client
    // (sdk/src/recovery.ts findCommitment); at most 256 comparisons here.
    require!(
        !epoch.leaves.contains(&secret_hash),
        GatewayError::DuplicateLeaf
    );
    // The epoch's snapshot, not the current params: a fee change applies from the next epoch.
    let fee = epoch.fee_per_note();

    let a = &ctx.accounts;
    pay_in(a, a.escrow.to_account_info(), denomination)?;
    if fee > 0 {
        pay_in(a, a.fee_vault.to_account_info(), fee)?;
    }

    ctx.accounts.config.net_deposits = net_deposits;
    let epoch = &mut ctx.accounts.epoch;
    let leaf_index = epoch.leaves.len() as u16;
    epoch.leaves.push(secret_hash);
    epoch.depositors.push(ctx.accounts.authority.key());
    emit!(Deposited {
        denomination,
        epoch_id: epoch.epoch_id,
        leaf_index,
        leaf: secret_hash,
        fee,
    });
    Ok(())
}

/// `amount` from the depositor's `source` to one of the gateway's vaults.
fn pay_in<'info>(a: &Deposit<'info>, to: AccountInfo<'info>, amount: u64) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.source.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to,
                authority: a.authority.to_account_info(),
            },
        ),
        amount,
        a.usdc_mint.decimals,
    )
}
