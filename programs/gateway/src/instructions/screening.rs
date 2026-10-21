use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GatewayError,
    events::{
        AddressAdded, AddressRemoved, ScreeningInitialized, UnblockCancelled, UnblockProposed,
    },
    state::*,
};

/// Screening deposits (ADR 0019): a denylist of depositor addresses kept by the guardian.
/// `deposit` and `deposit_express` refuse an `authority` that has a `BlockedAddress` record.
/// Nothing else reads it: refunds, batches, claims and exits are never blocked (SPEC §4).
///
/// Admin only, before the sunset, once: creates `Screening`. Until then no address can be added.
#[derive(Accounts)]
pub struct InitScreening<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ GatewayError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + Screening::INIT_SPACE, seeds = [SCREENING_SEED], bump)]
    pub screening: Box<Account<'info, Screening>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_screening(ctx: Context<InitScreening>) -> Result<()> {
    require!(
        ctx.accounts
            .config
            .admin_active(Clock::get()?.unix_timestamp),
        GatewayError::AdminExpired
    );
    ctx.accounts.screening.set_inner(Screening {
        version: SCREENING_VERSION,
        bump: ctx.bumps.screening,
        blocked: 0,
        added: 0,
        removed: 0,
        reserved: [0; 64],
    });
    emit!(ScreeningInitialized {});
    Ok(())
}

/// The guardian or the admin, while their roles are active.
fn require_screener(config: &Config, signer: &Pubkey, now: i64) -> Result<()> {
    require!(
        *signer == config.guardian || *signer == config.admin,
        GatewayError::NotScreener
    );
    require!(config.admin_active(now), GatewayError::AdminExpired);
    Ok(())
}

#[derive(Accounts)]
#[instruction(address: Pubkey)]
pub struct BlockAddress<'info> {
    /// The guardian or the admin; pays the record's rent (about 0.0022 SOL) and gets it back on
    /// removal.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SCREENING_SEED], bump = screening.bump)]
    pub screening: Box<Account<'info, Screening>>,
    #[account(
        init,
        payer = signer,
        space = 8 + BlockedAddress::INIT_SPACE,
        seeds = [BLOCKED_SEED, address.as_ref()],
        bump,
    )]
    pub blocked: Box<Account<'info, BlockedAddress>>,
    pub system_program: Program<'info, System>,
}

/// Guardian or admin, before the sunset: `address` can no longer deposit, at once. No timelock:
/// stolen funds move within hours of a hack.
pub fn handle_block_address(
    ctx: Context<BlockAddress>,
    address: Pubkey,
    list: u8,
    reference: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let by = ctx.accounts.signer.key();
    require_screener(&ctx.accounts.config, &by, now)?;
    require!(
        list <= LIST_OTHER && address != Pubkey::default(),
        GatewayError::InvalidScreeningEntry
    );
    ctx.accounts.blocked.set_inner(BlockedAddress {
        version: SCREENING_VERSION,
        bump: ctx.bumps.blocked,
        address,
        list,
        reference,
        added_at: now,
        added_by: by,
        rent_payer: by,
        unblock_eta: 0,
        reserved: [0; 32],
    });
    let s = &mut ctx.accounts.screening;
    s.blocked = s.blocked.checked_add(1).ok_or(GatewayError::Overflow)?;
    s.added = s.added.saturating_add(1);
    emit!(AddressAdded {
        address,
        list,
        reference,
        by,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(address: Pubkey)]
pub struct ChangeBlock<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BLOCKED_SEED, address.as_ref()], bump = blocked.bump)]
    pub blocked: Box<Account<'info, BlockedAddress>>,
}

/// Announces the removal of `address`; `unblock` carries it out after UNBLOCK_DELAY_SECS.
/// The guardian or the admin; after the sunset anyone (nobody maintains the list any more, so it
/// may only shrink). Announcing again restarts the delay.
pub fn handle_propose_unblock(ctx: Context<ChangeBlock>, address: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let by = ctx.accounts.signer.key();
    let config = &ctx.accounts.config;
    if config.admin_active(now) {
        require!(
            by == config.guardian || by == config.admin,
            GatewayError::NotScreener
        );
    }
    let eta = now
        .checked_add(UNBLOCK_DELAY_SECS)
        .ok_or(GatewayError::Overflow)?;
    ctx.accounts.blocked.unblock_eta = eta;
    emit!(UnblockProposed { address, eta, by });
    Ok(())
}

/// Guardian or admin, before the sunset: keeps `address` blocked (cancels an announced removal).
pub fn handle_cancel_unblock(ctx: Context<ChangeBlock>, address: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let by = ctx.accounts.signer.key();
    require_screener(&ctx.accounts.config, &by, now)?;
    let b = &mut ctx.accounts.blocked;
    require!(b.unblock_eta != 0, GatewayError::NoUnblockPending);
    b.unblock_eta = 0;
    emit!(UnblockCancelled { address, by });
    Ok(())
}

#[derive(Accounts)]
#[instruction(address: Pubkey)]
pub struct Unblock<'info> {
    #[account(mut, seeds = [SCREENING_SEED], bump = screening.bump)]
    pub screening: Box<Account<'info, Screening>>,
    #[account(
        mut,
        seeds = [BLOCKED_SEED, address.as_ref()],
        bump = blocked.bump,
        has_one = rent_payer,
        close = rent_payer,
    )]
    pub blocked: Box<Account<'info, BlockedAddress>>,
    /// CHECK: pinned to `blocked.rent_payer`; receives the record's rent.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// Anyone, once an announced removal is due: closes the record; `address` can deposit again.
pub fn handle_unblock(ctx: Context<Unblock>, address: Pubkey) -> Result<()> {
    let eta = ctx.accounts.blocked.unblock_eta;
    require!(eta != 0, GatewayError::NoUnblockPending);
    require!(
        Clock::get()?.unix_timestamp >= eta,
        GatewayError::TimelockActive
    );
    let s = &mut ctx.accounts.screening;
    s.blocked = s.blocked.saturating_sub(1);
    s.removed = s.removed.saturating_add(1);
    emit!(AddressRemoved { address });
    Ok(())
}
