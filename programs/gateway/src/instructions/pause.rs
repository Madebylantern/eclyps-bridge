use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GatewayError,
    events::{DepositsPaused, DepositsUnpaused},
    state::*,
};

#[derive(Accounts)]
pub struct Pause<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Guardian only, until the sunset. Pauses deposits only; expires on its own after
/// PAUSE_DURATION_SECS, and the guardian cannot pause again until PAUSE_COOLDOWN_SECS after the
/// pause ends. close_epoch / send_batch / refund_deposit / receive_exit / claim_exit
/// never check the pause.
pub fn handle_pause_deposits(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_keys_eq!(
        ctx.accounts.signer.key(),
        config.guardian,
        GatewayError::NotGuardian
    );
    let now = Clock::get()?.unix_timestamp;
    require!(config.admin_active(now), GatewayError::AdminExpired);
    require!(
        now >= config.pause_cooldown_until,
        GatewayError::PauseCooldown
    );
    config.paused_deposits = true;
    config.pause_expiry = now
        .checked_add(PAUSE_DURATION_SECS)
        .ok_or(GatewayError::Overflow)?;
    config.pause_cooldown_until = config
        .pause_expiry
        .checked_add(PAUSE_COOLDOWN_SECS)
        .ok_or(GatewayError::Overflow)?;
    emit!(DepositsPaused {
        expiry: config.pause_expiry
    });
    Ok(())
}

/// Guardian or admin, also after the sunset (unpausing only ever reopens deposits). Ending a
/// pause early starts the cooldown from now.
pub fn handle_unpause_deposits(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let k = ctx.accounts.signer.key();
    require!(
        k == config.guardian || k == config.admin,
        GatewayError::NotGuardian
    );
    let now = Clock::get()?.unix_timestamp;
    if config.deposits_paused(now) {
        config.pause_cooldown_until = now
            .checked_add(PAUSE_COOLDOWN_SECS)
            .ok_or(GatewayError::Overflow)?;
    }
    config.paused_deposits = false;
    config.pause_expiry = 0;
    emit!(DepositsUnpaused {});
    Ok(())
}
