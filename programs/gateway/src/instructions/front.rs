use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke,
    },
};
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    error::GatewayError,
    events::{ExitFronted, FrontWrittenOff},
    state::*,
};

/// Fast exits (ADR 0017): a solver pays the destination of an exit now, `denomination − fee`, and
/// takes the destination's place as payee of that leaf: `claim_exit` later pays the whole
/// denomination to the solver's `payee_usdc`. Permissionless; signed by the solver, from its own
/// USDC.
///
/// - The leaf is `Poseidon(dest_hi, dest_lo, secret)`, computed as `claim_exit` does, so the money
///   can only go to the destination the leaf binds.
/// - One front per leaf: the Front PDA ["front", leaf] is created here and creation fails if it
///   exists.
/// - Refused once the exit batch named by `exit_epoch_id` has arrived on Solana: from then on the
///   slow path is open, and a claimed leaf can never be fronted.
/// - `fee <= denomination × front_fee_cap_bps / 10_000` (timelocked lane parameter).
/// - Not affected by the deposit pause. Nothing on chain can see Aztec before its proof, so the
///   solver checks the exit there itself, and carries the risk of an Aztec reorg.
#[derive(Accounts)]
#[instruction(denomination_index: u8, exit_epoch_id: u64, destination: Pubkey, secret: [u8; 32])]
pub struct FrontExit<'info> {
    /// Pays the destination, the Front rent and, if missing, the destination's USDC account.
    #[account(mut)]
    pub solver: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [LANES_SEED], bump = lanes.bump)]
    pub lanes: Box<Account<'info, Lanes>>,
    /// CHECK: the ExitBatch address of (denomination, exit epoch); must not exist yet.
    #[account(seeds = [EXIT_BATCH_SEED, &[denomination_index], &exit_epoch_id.to_le_bytes()], bump)]
    pub exit_batch: UncheckedAccount<'info>,
    #[account(
        init,
        payer = solver,
        space = 8 + Front::INIT_SPACE,
        seeds = [FRONT_SEED, &front_seed(&destination, &secret)],
        bump,
    )]
    pub front: Box<Account<'info, Front>>,
    #[account(mut, token::mint = usdc_mint, token::authority = solver)]
    pub solver_usdc: Box<Account<'info, TokenAccount>>,
    /// Where `claim_exit` repays the solver: any USDC account but the gateway's own.
    #[account(token::mint = usdc_mint)]
    pub payee_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: must be `destination` (checked in the handler).
    pub destination_wallet: UncheckedAccount<'info>,
    /// CHECK: must be the USDC associated account of `destination`; created when missing.
    #[account(mut)]
    pub destination_usdc: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_front_exit(
    ctx: Context<FrontExit>,
    denomination_index: u8,
    exit_epoch_id: u64,
    destination: Pubkey,
    secret: [u8; 32],
    fee: u64,
) -> Result<()> {
    let a = &ctx.accounts;
    let denomination = a.config.denomination(denomination_index)?;
    require!(
        fee <= bps_of(denomination, a.lanes.params.front_fee_cap_bps),
        GatewayError::FrontFeeTooHigh
    );
    let payee = a.payee_usdc.key();
    require!(
        payee != a.config.escrow
            && payee != a.config.fee_vault
            && payee != a.config.exit_custody
            && payee != a.lanes.crossing_pool,
        GatewayError::InvalidPayee
    );
    let leaf = check_frontable(
        &a.exit_batch,
        &a.destination_wallet,
        &a.destination_usdc,
        &a.usdc_mint.key(),
        &destination,
        &secret,
    )?;
    let advanced = denomination - fee;
    create_destination_usdc(
        &a.solver.to_account_info(),
        &a.destination_usdc,
        &a.destination_wallet,
        &a.usdc_mint.to_account_info(),
        &a.token_program,
        &a.associated_token_program,
        &a.system_program,
    )?;
    token::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.solver_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.destination_usdc.to_account_info(),
                authority: a.solver.to_account_info(),
            },
        ),
        advanced,
        a.usdc_mint.decimals,
    )?;
    let rent_payer = a.solver.key();
    let bump = ctx.bumps.front;
    ctx.accounts.front.set_inner(Front {
        version: LANES_VERSION,
        bump,
        leaf,
        denomination_index,
        denomination,
        exit_epoch_id,
        fee,
        advanced,
        payee,
        rent_payer,
        from_pool: false,
        written_off: false,
        fronted_at: Clock::get()?.unix_timestamp,
        reserved: [0; 16],
    });
    emit!(ExitFronted {
        leaf,
        denomination,
        exit_epoch_id,
        destination,
        advanced,
        fee,
        payee,
        from_pool: false,
    });
    Ok(())
}

/// `front_exit` paid from the liquidity pool (ADR 0017, amended). Signed by the pool's keeper
/// (`lanes.params.keeper`), the key that checks the exit on Aztec first: Solana cannot see Aztec
/// before the proof, so a permissionless pool front would let anyone drain the pool with an
/// invented leaf. The fee is the fixed `pool_fee_bps`; the pool's vault is the payee, so the
/// repayment returns to the pool. Bounded by the pool's idle funds and `pool_max_outstanding`.
#[derive(Accounts)]
#[instruction(denomination_index: u8, exit_epoch_id: u64, destination: Pubkey, secret: [u8; 32])]
pub struct FrontExitFromPool<'info> {
    /// Pays the Front rent and, if missing, the destination's USDC account; gets the rent back.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [LANES_SEED], bump = lanes.bump)]
    pub lanes: Box<Account<'info, Lanes>>,
    #[account(mut, seeds = [LIQUIDITY_SEED], bump = liquidity.bump)]
    pub liquidity: Box<Account<'info, Liquidity>>,
    #[account(mut, address = liquidity.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: the ExitBatch address of (denomination, exit epoch); must not exist yet.
    #[account(seeds = [EXIT_BATCH_SEED, &[denomination_index], &exit_epoch_id.to_le_bytes()], bump)]
    pub exit_batch: UncheckedAccount<'info>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Front::INIT_SPACE,
        seeds = [FRONT_SEED, &front_seed(&destination, &secret)],
        bump,
    )]
    pub front: Box<Account<'info, Front>>,
    /// CHECK: must be `destination` (checked in the handler).
    pub destination_wallet: UncheckedAccount<'info>,
    /// CHECK: must be the USDC associated account of `destination`; created when missing.
    #[account(mut)]
    pub destination_usdc: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_front_exit_from_pool(
    ctx: Context<FrontExitFromPool>,
    denomination_index: u8,
    exit_epoch_id: u64,
    destination: Pubkey,
    secret: [u8; 32],
) -> Result<()> {
    let a = &ctx.accounts;
    let keeper = a.lanes.params.keeper;
    require!(
        keeper != Pubkey::default() && a.keeper.key() == keeper,
        GatewayError::NotKeeper
    );
    let denomination = a.config.denomination(denomination_index)?;
    let fee = bps_of(denomination, a.lanes.params.pool_fee_bps);
    let advanced = denomination - fee;
    require!(
        a.liquidity.liquid >= advanced,
        GatewayError::PoolInsufficient
    );
    let outstanding = a
        .liquidity
        .outstanding
        .checked_add(advanced)
        .ok_or(GatewayError::Overflow)?;
    require!(
        outstanding <= a.lanes.params.pool_max_outstanding,
        GatewayError::PoolOutstandingCap
    );
    let leaf = check_frontable(
        &a.exit_batch,
        &a.destination_wallet,
        &a.destination_usdc,
        &a.usdc_mint.key(),
        &destination,
        &secret,
    )?;
    create_destination_usdc(
        &a.keeper.to_account_info(),
        &a.destination_usdc,
        &a.destination_wallet,
        &a.usdc_mint.to_account_info(),
        &a.token_program,
        &a.associated_token_program,
        &a.system_program,
    )?;
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.vault.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.destination_usdc.to_account_info(),
                authority: a.liquidity.to_account_info(),
            },
            &[&[LIQUIDITY_SEED, &[a.liquidity.bump]]],
        ),
        advanced,
        a.usdc_mint.decimals,
    )?;
    let payee = a.vault.key();
    let rent_payer = a.keeper.key();
    let liquidity = &mut ctx.accounts.liquidity;
    liquidity.liquid -= advanced;
    liquidity.outstanding = outstanding;
    liquidity.fronts = liquidity.fronts.saturating_add(1);
    let bump = ctx.bumps.front;
    ctx.accounts.front.set_inner(Front {
        version: LANES_VERSION,
        bump,
        leaf,
        denomination_index,
        denomination,
        exit_epoch_id,
        fee,
        advanced,
        payee,
        rent_payer,
        from_pool: true,
        written_off: false,
        fronted_at: Clock::get()?.unix_timestamp,
        reserved: [0; 16],
    });
    emit!(ExitFronted {
        leaf,
        denomination,
        exit_epoch_id,
        destination,
        advanced,
        fee,
        payee,
        from_pool: true,
    });
    Ok(())
}

/// Permissionless: a pool front still unpaid FRONT_WRITE_OFF_SECS after it was made stops being
/// counted in the share price (an Aztec reorg lost the exit, or the slow path is stuck). The
/// record stays, so if the repayment comes after all, `claim_exit` still pays the pool (and never
/// the destination a second time).
#[derive(Accounts)]
#[instruction(leaf: [u8; 32])]
pub struct WriteOffFront<'info> {
    #[account(mut, seeds = [FRONT_SEED, &leaf], bump = front.bump)]
    pub front: Box<Account<'info, Front>>,
    #[account(mut, seeds = [LIQUIDITY_SEED], bump = liquidity.bump)]
    pub liquidity: Box<Account<'info, Liquidity>>,
}

pub fn handle_write_off_front(ctx: Context<WriteOffFront>, leaf: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let f = &mut ctx.accounts.front;
    require!(
        f.from_pool && !f.written_off && now >= f.fronted_at.saturating_add(FRONT_WRITE_OFF_SECS),
        GatewayError::NotWriteOffable
    );
    f.written_off = true;
    let l = &mut ctx.accounts.liquidity;
    l.outstanding = l.outstanding.saturating_sub(f.advanced);
    l.written_off = l.written_off.saturating_add(f.advanced);
    emit!(FrontWrittenOff {
        leaf,
        advanced: f.advanced,
    });
    Ok(())
}

/// The checks every front makes: the exit batch has not arrived, the destination accounts match
/// `destination`, and the leaf is a real one. Returns the leaf.
fn check_frontable(
    exit_batch: &AccountInfo,
    destination_wallet: &AccountInfo,
    destination_usdc: &AccountInfo,
    mint: &Pubkey,
    destination: &Pubkey,
    secret: &[u8; 32],
) -> Result<[u8; 32]> {
    require!(exit_batch.data_is_empty(), GatewayError::ExitBatchArrived);
    require_keys_eq!(
        destination_wallet.key(),
        *destination,
        GatewayError::ExitDestinationMismatch
    );
    require_keys_eq!(
        destination_usdc.key(),
        get_associated_token_address(destination, mint),
        GatewayError::ExitDestinationMismatch
    );
    let leaf = eclyps_merkle::exit_commitment(&destination.to_bytes(), secret)
        .map_err(|_| GatewayError::InvalidExitProof)?;
    require!(leaf != [0u8; 32], GatewayError::InvalidExitProof);
    Ok(leaf)
}

/// Idempotent creation of the destination's USDC account (ATA program, CreateIdempotent).
pub(crate) fn create_destination_usdc<'info>(
    payer: &AccountInfo<'info>,
    destination_usdc: &AccountInfo<'info>,
    destination_wallet: &AccountInfo<'info>,
    usdc_mint: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    invoke(
        &Instruction {
            program_id: associated_token_program.key(),
            accounts: vec![
                AccountMeta::new(payer.key(), true),
                AccountMeta::new(destination_usdc.key(), false),
                AccountMeta::new_readonly(destination_wallet.key(), false),
                AccountMeta::new_readonly(usdc_mint.key(), false),
                AccountMeta::new_readonly(system_program.key(), false),
                AccountMeta::new_readonly(token_program.key(), false),
            ],
            data: vec![1],
        },
        &[
            payer.clone(),
            destination_usdc.clone(),
            destination_wallet.clone(),
            usdc_mint.clone(),
            system_program.clone(),
            token_program.clone(),
            associated_token_program.clone(),
        ],
    )?;
    Ok(())
}
