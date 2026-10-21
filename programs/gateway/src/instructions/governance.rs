use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GatewayError,
    events::{AdminAccepted, AdminProposed, GuardianSet, ParamsApplied, ParamsProposed},
    state::*,
};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ GatewayError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct ApplyParams<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Admin proposes bounded parameters; 14-day delay if the fee, its finisher share or the
/// treasury changes (ADR 0012), else 7 days. The caps are raise-only. Disabled after the admin
/// sunset.
pub fn handle_propose_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    require!(config.admin_active(now), GatewayError::AdminExpired);
    params.validate(Some(&config.params))?;
    config.check_treasury(&params.treasury)?;
    let delay = if params.changes_fees(&config.params) {
        FEE_DELAY_SECS
    } else {
        PARAM_DELAY_SECS
    };
    let eta = now.checked_add(delay).ok_or(GatewayError::Overflow)?;
    config.pending = Some(PendingParams { params, eta });
    emit!(ParamsProposed { params, eta });
    Ok(())
}

pub fn handle_cancel_params(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.config.pending = None;
    Ok(())
}

/// Permissionless once the timelock has elapsed, but only while the admin role is active.
pub fn handle_apply_params(ctx: Context<ApplyParams>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    require!(config.admin_active(now), GatewayError::AdminExpired);
    let pending = config.pending.ok_or(GatewayError::NoPendingParams)?;
    require!(now >= pending.eta, GatewayError::TimelockActive);
    pending.params.validate(Some(&config.params))?;
    config.check_treasury(&pending.params.treasury)?;
    config.params = pending.params;
    config.pending = None;
    emit!(ParamsApplied {
        params: config.params
    });
    Ok(())
}

/// Admin only, until the sunset: replace the guardian (a lost or compromised key).
pub fn handle_set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.admin_active(Clock::get()?.unix_timestamp),
        GatewayError::AdminExpired
    );
    config.guardian = guardian;
    emit!(GuardianSet { guardian });
    Ok(())
}

/// Admin only, until the sunset: step one of a two-step admin transfer (e.g. to a multisig).
/// Proposing again replaces the pending key.
pub fn handle_propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.admin_active(Clock::get()?.unix_timestamp),
        GatewayError::AdminExpired
    );
    config.pending_admin = Some(new_admin);
    emit!(AdminProposed {
        pending_admin: new_admin
    });
    Ok(())
}

/// Signed by the proposed admin, until the sunset. The sunset date does not move.
pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.admin_active(Clock::get()?.unix_timestamp),
        GatewayError::AdminExpired
    );
    let pending = config.pending_admin.ok_or(GatewayError::NoPendingAdmin)?;
    require_keys_eq!(
        ctx.accounts.new_admin.key(),
        pending,
        GatewayError::NotPendingAdmin
    );
    config.admin = pending;
    config.pending_admin = None;
    emit!(AdminAccepted { admin: pending });
    Ok(())
}
