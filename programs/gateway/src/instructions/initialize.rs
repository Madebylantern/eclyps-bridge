use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, error::GatewayError, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub guardian: Pubkey,
    /// Ethereum portal address, left-padded to 32 bytes (ADR 0002).
    pub portal: [u8; 32],
    /// Strictly increasing, non-zero, 1..=MAX_DENOMINATIONS entries (USDC base units).
    pub denominations: Vec<u64>,
    /// Includes the fee, its finisher share, the deposit cap and the treasury (ADR 0012).
    pub params: Params,
    /// Admin sunset, seconds from now (<= MAX_ADMIN_LIFETIME_SECS).
    pub admin_lifetime_secs: i64,
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    /// Becomes the admin. Must be the program's upgrade authority, so nobody can front-run
    /// initialization and choose the portal that receives every batch (ADR 0010).
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// Escrow: owned by the config PDA. Only `send_batch` and `refund_deposit` sign for it.
    #[account(
        init,
        payer = admin,
        seeds = [ESCROW_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// Fee vault (ADR 0012): owned by the config PDA. Only `send_batch` (pays the fees out) and
    /// `refund_deposit` (gives a fee back) sign for it.
    #[account(
        init,
        payer = admin,
        seeds = [FEE_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: exit authority PDA (ADR 0009); holds nothing. It is the CCTP destinationCaller of
    /// every exit and owns exit custody.
    #[account(seeds = [EXIT_AUTHORITY_SEED], bump)]
    pub exit_authority: UncheckedAccount<'info>,
    /// Exit custody (ADR 0009): owned by the exit authority. CCTP pays exits in (`receive_exit`);
    /// only `claim_exit` signs for it.
    #[account(
        init,
        payer = admin,
        seeds = [EXIT_CUSTODY_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = exit_authority,
    )]
    pub exit_custody: Box<Account<'info, TokenAccount>>,
    /// The treasury named in the params: it must already be a USDC token account.
    #[account(
        address = args.params.treasury @ GatewayError::InvalidTreasury,
        token::mint = usdc_mint,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ GatewayError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::EclypsGateway>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ GatewayError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    let n = args.denominations.len();
    require!(
        (1..=MAX_DENOMINATIONS).contains(&n),
        GatewayError::InvalidDenominations
    );
    require!(
        args.denominations[0] > 0 && args.denominations.windows(2).all(|w| w[0] < w[1]),
        GatewayError::InvalidDenominations
    );
    args.params.validate(None)?;
    require!(
        args.portal[..12] == [0u8; 12] && args.portal != [0u8; 32],
        GatewayError::InvalidPortal
    );
    require!(
        args.admin_lifetime_secs > 0 && args.admin_lifetime_secs <= MAX_ADMIN_LIFETIME_SECS,
        GatewayError::InvalidAdminLifetime
    );

    let now = Clock::get()?.unix_timestamp;
    let mut denominations = [0u64; MAX_DENOMINATIONS];
    denominations[..n].copy_from_slice(&args.denominations);

    let config = &mut ctx.accounts.config;
    config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        guardian: args.guardian,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        escrow: ctx.accounts.escrow.key(),
        fee_vault: ctx.accounts.fee_vault.key(),
        exit_custody: ctx.accounts.exit_custody.key(),
        portal: args.portal,
        denominations,
        current_epoch: [0; MAX_DENOMINATIONS],
        net_deposits: 0,
        params: args.params,
        pending: None,
        paused_deposits: false,
        pause_expiry: 0,
        admin_expiry_ts: now
            .checked_add(args.admin_lifetime_secs)
            .ok_or(GatewayError::Overflow)?,
        bump: ctx.bumps.config,
        escrow_bump: ctx.bumps.escrow,
        fee_vault_bump: ctx.bumps.fee_vault,
        exit_authority_bump: ctx.bumps.exit_authority,
        exit_custody_bump: ctx.bumps.exit_custody,
        pause_cooldown_until: 0,
        pending_admin: None,
    });
    config.check_treasury(&args.params.treasury)
}
