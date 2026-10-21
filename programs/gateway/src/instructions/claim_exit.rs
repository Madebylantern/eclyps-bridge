use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    error::GatewayError,
    events::{ExitClaimed, FrontRepaid},
    instructions::front::create_destination_usdc,
    state::*,
};

/// Permissionless: anyone can relay it, and front-running is harmless because the destination is
/// inside the leaf (ADR 0009). Recomputes the leaf `Poseidon(dest_hi, dest_lo, secret)`, checks
/// its depth-8 path to the batch root with the same Poseidon syscall code as deposit batches,
/// marks it paid, and pays one denomination from exit custody to `destination`'s USDC associated
/// token account, creating that account if needed (rent paid by `payer`). Each leaf is paid
/// once. Not affected by the deposit pause; no admin path can move exit custody.
///
/// Fronted exits (ADR 0017): the Front PDA ["front", leaf] is derived from the same leaf, so the
/// caller cannot skip it. If it exists, a solver already paid the destination: the denomination
/// goes to the recorded payee instead, a pool front is credited back to the liquidity pool, and
/// the record closes (rent to whoever paid it). If it does not, the last three accounts are not
/// read and can be any accounts (clients pass the payer).
#[derive(Accounts)]
#[instruction(
    denomination_index: u8,
    exit_epoch_id: u64,
    leaf_index: u16,
    path: [[u8; 32]; 8],
    destination: Pubkey,
    secret: [u8; 32],
)]
pub struct ClaimExit<'info> {
    /// The user or a relayer; pays the rent of the destination's USDC account if it is missing.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [EXIT_BATCH_SEED, &[denomination_index], &exit_epoch_id.to_le_bytes()],
        bump = exit_batch.bump,
    )]
    pub exit_batch: Box<Account<'info, ExitBatch>>,
    /// CHECK: PDA ["exit_authority"]; signs the transfer out of exit custody.
    #[account(seeds = [EXIT_AUTHORITY_SEED], bump = config.exit_authority_bump)]
    pub exit_authority: UncheckedAccount<'info>,
    #[account(mut, address = config.exit_custody)]
    pub exit_custody: Box<Account<'info, TokenAccount>>,
    /// CHECK: must be the `destination` argument (checked in the handler); it does not sign.
    pub destination_wallet: UncheckedAccount<'info>,
    /// CHECK: must be the USDC associated token account of `destination` (checked in the
    /// handler); created here when missing.
    #[account(mut)]
    pub destination_usdc: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the Front PDA of this leaf (ADR 0017), fixed by the seeds; empty when not fronted.
    #[account(mut, seeds = [FRONT_SEED, &front_seed(&destination, &secret)], bump)]
    pub front: UncheckedAccount<'info>,
    /// CHECK: when fronted, must be the record's payee (checked in the handler).
    #[account(mut)]
    pub front_payee: UncheckedAccount<'info>,
    /// CHECK: when fronted, must be the record's rent payer (checked in the handler).
    #[account(mut)]
    pub front_rent_receiver: UncheckedAccount<'info>,
    /// CHECK: when fronted from the pool, must be the liquidity PDA (checked in the handler).
    #[account(mut)]
    pub liquidity: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_claim_exit(
    ctx: Context<ClaimExit>,
    _denomination_index: u8,
    _exit_epoch_id: u64,
    leaf_index: u16,
    path: [[u8; 32]; 8],
    destination: Pubkey,
    secret: [u8; 32],
) -> Result<()> {
    let a = &ctx.accounts;
    require_keys_eq!(
        a.destination_wallet.key(),
        destination,
        GatewayError::ExitDestinationMismatch
    );
    let usdc = get_associated_token_address(&destination, &a.usdc_mint.key());
    require_keys_eq!(
        a.destination_usdc.key(),
        usdc,
        GatewayError::ExitDestinationMismatch
    );

    let batch = &a.exit_batch;
    require!(leaf_index < batch.count, GatewayError::InvalidExitProof);
    let leaf = eclyps_merkle::exit_commitment(&destination.to_bytes(), &secret)
        .map_err(|_| GatewayError::InvalidExitProof)?;
    let root = eclyps_merkle::root_from_path(&leaf, leaf_index as usize, &path)
        .map_err(|_| GatewayError::InvalidExitProof)?;
    require!(root == batch.root, GatewayError::InvalidExitProof);
    require!(
        !batch.is_claimed(leaf_index),
        GatewayError::ExitAlreadyClaimed
    );
    let denomination = batch.denomination;
    let exit_epoch_id = batch.exit_epoch_id;

    // A front exists only if this program created it at this PDA.
    let fronted = !a.front.data_is_empty() && *a.front.owner == crate::ID;
    let front = if fronted {
        let data = a.front.try_borrow_data()?;
        let f = Front::try_deserialize(&mut &data[..])?;
        require!(f.leaf == leaf, GatewayError::FrontMismatch);
        require_keys_eq!(a.front_payee.key(), f.payee, GatewayError::FrontMismatch);
        require_keys_eq!(
            a.front_rent_receiver.key(),
            f.rent_payer,
            GatewayError::FrontMismatch
        );
        Some(f)
    } else {
        create_destination_usdc(
            &a.payer.to_account_info(),
            &a.destination_usdc,
            &a.destination_wallet,
            &a.usdc_mint.to_account_info(),
            &a.token_program,
            &a.associated_token_program,
            &a.system_program,
        )?;
        None
    };

    let batch = &mut ctx.accounts.exit_batch;
    batch.set_claimed(leaf_index);
    batch.claimed_count = batch
        .claimed_count
        .checked_add(1)
        .ok_or(GatewayError::Overflow)?;

    let a = &ctx.accounts;
    let to = match &front {
        Some(_) => a.front_payee.to_account_info(),
        None => a.destination_usdc.to_account_info(),
    };
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.exit_custody.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to,
                authority: a.exit_authority.to_account_info(),
            },
            &[&[EXIT_AUTHORITY_SEED, &[a.config.exit_authority_bump]]],
        ),
        denomination,
        a.usdc_mint.decimals,
    )?;

    if let Some(f) = front {
        if f.from_pool {
            let (pool, _) = Pubkey::find_program_address(&[LIQUIDITY_SEED], &crate::ID);
            require_keys_eq!(a.liquidity.key(), pool, GatewayError::FrontMismatch);
            require!(*a.liquidity.owner == crate::ID, GatewayError::FrontMismatch);
            let mut data = a.liquidity.try_borrow_mut_data()?;
            let mut l = Liquidity::try_deserialize(&mut &data[..])?;
            l.repaid(&f, denomination)?;
            l.try_serialize(&mut &mut data[..])?;
        }
        // Close the record: its rent back to whoever paid it.
        let info = a.front.to_account_info();
        let rent = a.front_rent_receiver.to_account_info();
        **rent.try_borrow_mut_lamports()? = rent
            .lamports()
            .checked_add(info.lamports())
            .ok_or(GatewayError::Overflow)?;
        **info.try_borrow_mut_lamports()? = 0;
        info.assign(&System::id());
        info.resize(0)?;
        emit!(FrontRepaid {
            leaf,
            payee: f.payee,
            amount: denomination,
            from_pool: f.from_pool,
        });
    }
    emit!(ExitClaimed {
        denomination,
        exit_epoch_id,
        leaf_index,
        destination,
        amount: denomination,
    });
    Ok(())
}
