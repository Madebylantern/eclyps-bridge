use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::GatewayError, events::DepositRefunded, state::*};

/// Returns one deposit that could not cross to the account that made it (ADR 0010; SPEC §4.2,
/// "exits always open"): its denomination from the escrow and the fee it paid from the fee vault
/// (ADR 0012: nothing is charged unless the batch crosses). Only for the current epoch while it
/// is still open, once it has been open for REFUND_DELAY_SLOTS and has rolled over at least once,
/// i.e. it could not form a batch. The depositor signs, so a refund cannot be redirected. Nothing
/// has crossed yet, so no anonymity set is affected; the leaf leaves the epoch and the next batch
/// is built without it. Not affected by the deposit pause.
#[derive(Accounts)]
#[instruction(denomination_index: u8)]
pub struct RefundDeposit<'info> {
    /// The deposit's `authority`; receives the freed rent.
    #[account(mut)]
    pub authority: Signer<'info>,
    /// Writable: the refund frees room under the deposit cap (`net_deposits`).
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, &[denomination_index], &config.current_epoch_seed(denomination_index)],
        bump = epoch.bump,
        realloc = Epoch::space(epoch.leaves.len().saturating_sub(1)),
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub epoch: Account<'info, Epoch>,
    /// Any USDC account the depositor owns.
    #[account(mut, token::mint = usdc_mint, token::authority = authority)]
    pub destination: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.escrow)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_refund_deposit(
    ctx: Context<RefundDeposit>,
    denomination_index: u8,
    commitment: [u8; 32],
) -> Result<()> {
    let denomination = ctx.accounts.config.denomination(denomination_index)?;
    let epoch = &mut ctx.accounts.epoch;
    let slot = Clock::get()?.slot;
    require!(
        epoch.status == EpochStatus::Open
            && epoch.rollovers >= 1
            && slot >= epoch.opened_slot.saturating_add(REFUND_DELAY_SLOTS),
        GatewayError::NotRefundable
    );
    let authority = ctx.accounts.authority.key();
    let i = epoch
        .leaves
        .iter()
        .zip(&epoch.depositors)
        .position(|(l, d)| *l == commitment && *d == authority)
        .ok_or(GatewayError::LeafNotFound)?;
    epoch.leaves.swap_remove(i);
    epoch.depositors.swap_remove(i);
    let epoch_id = epoch.epoch_id;
    // Exactly what this epoch's deposits paid (its snapshot).
    let fee = epoch.fee_per_note();

    let a = &ctx.accounts;
    pay_out(a, a.escrow.to_account_info(), denomination)?;
    if fee > 0 {
        pay_out(a, a.fee_vault.to_account_info(), fee)?;
    }
    let config = &mut ctx.accounts.config;
    config.net_deposits = config
        .net_deposits
        .checked_sub(denomination)
        .ok_or(GatewayError::Overflow)?;
    emit!(DepositRefunded {
        denomination,
        epoch_id,
        leaf: commitment,
        authority,
        fee,
    });
    Ok(())
}

/// `amount` from one of the gateway's vaults (signed by the config PDA) to the depositor.
fn pay_out<'info>(a: &RefundDeposit<'info>, from: AccountInfo<'info>, amount: u64) -> Result<()> {
    let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[a.config.bump]]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from,
                mint: a.usdc_mint.to_account_info(),
                to: a.destination.to_account_info(),
                authority: a.config.to_account_info(),
            },
            signer,
        ),
        amount,
        a.usdc_mint.decimals,
    )
}
