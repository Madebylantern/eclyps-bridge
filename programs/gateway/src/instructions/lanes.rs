use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::GatewayError,
    events::{LaneParamsApplied, LaneParamsProposed, LanesInitialized, PoolFrontsDisabled},
    state::*,
};

/// Admin only, before the sunset, once: turns the V2 lanes on (ADR 0015, 0017). Creates `Lanes`
/// with its parameters, the crossing pool (a USDC account owned by the config PDA), and the
/// liquidity pool with its vault (owned by the liquidity PDA). The V1 accounts are not touched.
#[derive(Accounts)]
pub struct InitLanes<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ GatewayError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + Lanes::INIT_SPACE, seeds = [LANES_SEED], bump)]
    pub lanes: Box<Account<'info, Lanes>>,
    #[account(
        init,
        payer = admin,
        seeds = [CROSSING_POOL_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub crossing_pool: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, space = 8 + Liquidity::INIT_SPACE, seeds = [LIQUIDITY_SEED], bump)]
    pub liquidity: Box<Account<'info, Liquidity>>,
    #[account(
        init,
        payer = admin,
        seeds = [LIQUIDITY_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = liquidity,
    )]
    pub liquidity_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_lanes(ctx: Context<InitLanes>, params: LaneParams) -> Result<()> {
    require!(
        ctx.accounts
            .config
            .admin_active(Clock::get()?.unix_timestamp),
        GatewayError::AdminExpired
    );
    params.validate()?;
    let crossing_pool = ctx.accounts.crossing_pool.key();
    let vault = ctx.accounts.liquidity_vault.key();
    ctx.accounts.lanes.set_inner(Lanes {
        version: LANES_VERSION,
        bump: ctx.bumps.lanes,
        crossing_pool_bump: ctx.bumps.crossing_pool,
        crossing_pool,
        params,
        pending: None,
        express_next: [0; MAX_DENOMINATIONS],
        pool_paid: 0,
        reserved: [0; 64],
    });
    ctx.accounts.liquidity.set_inner(Liquidity {
        version: LANES_VERSION,
        bump: ctx.bumps.liquidity,
        vault_bump: ctx.bumps.liquidity_vault,
        vault,
        total_shares: 0,
        liquid: 0,
        outstanding: 0,
        fees_earned: 0,
        written_off: 0,
        recovered: 0,
        fronts: 0,
        reserved: [0; 64],
    });
    emit!(LanesInitialized {
        params,
        crossing_pool,
        liquidity_vault: vault,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct LanesAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ GatewayError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LANES_SEED], bump = lanes.bump)]
    pub lanes: Box<Account<'info, Lanes>>,
}

/// Admin only, before the sunset: propose new lane params. 14 days when a fee rate changes, else 7.
pub fn handle_propose_lane_params(ctx: Context<LanesAdmin>, params: LaneParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.config.admin_active(now),
        GatewayError::AdminExpired
    );
    params.validate()?;
    let lanes = &mut ctx.accounts.lanes;
    let delay = if params.changes_fees(&lanes.params) {
        FEE_DELAY_SECS
    } else {
        PARAM_DELAY_SECS
    };
    let eta = now.checked_add(delay).ok_or(GatewayError::Overflow)?;
    lanes.pending = Some(PendingLaneParams { params, eta });
    emit!(LaneParamsProposed { params, eta });
    Ok(())
}

pub fn handle_cancel_lane_params(ctx: Context<LanesAdmin>) -> Result<()> {
    ctx.accounts.lanes.pending = None;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyLaneParams<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LANES_SEED], bump = lanes.bump)]
    pub lanes: Box<Account<'info, Lanes>>,
}

/// Permissionless once the timelock has elapsed, while the admin role is active.
pub fn handle_apply_lane_params(ctx: Context<ApplyLaneParams>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.config.admin_active(now),
        GatewayError::AdminExpired
    );
    let lanes = &mut ctx.accounts.lanes;
    let pending = lanes.pending.ok_or(GatewayError::NoPendingParams)?;
    require!(now >= pending.eta, GatewayError::TimelockActive);
    pending.params.validate()?;
    lanes.params = pending.params;
    lanes.pending = None;
    emit!(LaneParamsApplied {
        params: lanes.params
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DisablePoolFronts<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LANES_SEED], bump = lanes.bump)]
    pub lanes: Box<Account<'info, Lanes>>,
}

/// Admin or guardian, at once, also after the sunset: stops fronts paid from the liquidity pool
/// (a lost or misbehaving keeper key). It only ever stops spending: repayments, write-offs and
/// withdrawals go on. Naming a keeper again goes through the timelock.
pub fn handle_disable_pool_fronts(ctx: Context<DisablePoolFronts>) -> Result<()> {
    let k = ctx.accounts.signer.key();
    let config = &ctx.accounts.config;
    require!(
        k == config.guardian || k == config.admin,
        GatewayError::NotGuardian
    );
    let lanes = &mut ctx.accounts.lanes;
    lanes.params.keeper = Pubkey::default();
    if let Some(p) = lanes.pending.as_mut() {
        p.params.keeper = Pubkey::default();
    }
    emit!(PoolFrontsDisabled { by: k });
    Ok(())
}
