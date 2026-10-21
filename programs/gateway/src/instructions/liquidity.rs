use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::GatewayError,
    events::{LiquidityDeposited, LiquidityWithdrawn},
    state::*,
};

/// The liquidity pool that funds fronts (ADR 0017, amended). Anyone can add USDC and receives
/// shares at the current price, `(liquid + outstanding + V) / (shares + V)`. The price grows only
/// when a pool front is repaid with more than it advanced (the front fee); a write-off lowers it.
/// No yield is promised. Not affected by the deposit pause or the admin sunset.
#[derive(Accounts)]
pub struct LpDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LIQUIDITY_SEED], bump = liquidity.bump)]
    pub liquidity: Box<Account<'info, Liquidity>>,
    #[account(mut, address = liquidity.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + LpPosition::INIT_SPACE,
        seeds = [LP_SEED, owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, LpPosition>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub source: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_lp_deposit(ctx: Context<LpDeposit>, amount: u64) -> Result<()> {
    let shares = ctx.accounts.liquidity.shares_for(amount)?;
    require!(shares > 0, GatewayError::LpZero);
    let a = &ctx.accounts;
    token::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.source.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let owner = a.owner.key();
    let l = &mut ctx.accounts.liquidity;
    l.liquid = l.liquid.checked_add(amount).ok_or(GatewayError::Overflow)?;
    l.total_shares = l
        .total_shares
        .checked_add(shares)
        .ok_or(GatewayError::Overflow)?;
    let p = &mut ctx.accounts.position;
    if p.version == 0 {
        p.version = LANES_VERSION;
        p.bump = ctx.bumps.position;
        p.owner = owner;
    }
    p.shares = p.shares.checked_add(shares).ok_or(GatewayError::Overflow)?;
    emit!(LiquidityDeposited {
        owner,
        amount,
        shares,
    });
    Ok(())
}

/// Burns `shares` for USDC at the current price, only from idle funds: what is advanced to fronts
/// comes back when they are repaid (about an hour on mainnet), so a withdrawal larger than the
/// idle funds waits (the app shows how much is idle). Signed by the position's owner.
#[derive(Accounts)]
pub struct LpWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LIQUIDITY_SEED], bump = liquidity.bump)]
    pub liquidity: Box<Account<'info, Liquidity>>,
    #[account(mut, address = liquidity.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [LP_SEED, owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Box<Account<'info, LpPosition>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub destination: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_lp_withdraw(ctx: Context<LpWithdraw>, shares: u64) -> Result<()> {
    require!(
        shares > 0 && shares <= ctx.accounts.position.shares,
        GatewayError::LpZero
    );
    let amount = ctx.accounts.liquidity.amount_for(shares)?;
    require!(amount > 0, GatewayError::LpZero);
    require!(
        amount <= ctx.accounts.liquidity.liquid,
        GatewayError::PoolInsufficient
    );
    let a = &ctx.accounts;
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.vault.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.destination.to_account_info(),
                authority: a.liquidity.to_account_info(),
            },
            &[&[LIQUIDITY_SEED, &[a.liquidity.bump]]],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let owner = a.owner.key();
    let l = &mut ctx.accounts.liquidity;
    l.liquid -= amount;
    l.total_shares -= shares;
    ctx.accounts.position.shares -= shares;
    emit!(LiquidityWithdrawn {
        owner,
        amount,
        shares,
    });
    Ok(())
}
