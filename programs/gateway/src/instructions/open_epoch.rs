use anchor_lang::{
    prelude::*,
    system_program::{
        allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
    },
};

use crate::{constants::*, events::EpochOpened, state::*};

/// Creates the current epoch account for a denomination if it does not exist yet.
/// Permissionless and idempotent, so clients can always prepend it to a deposit.
/// (`init_if_needed` cannot be used: the account grows by 32 bytes per deposit.)
#[derive(Accounts)]
#[instruction(denomination_index: u8)]
pub struct OpenEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: address fixed by the seeds; created and initialized here when empty. Only this
    /// program can allocate data at this PDA, so non-empty data means it is already open.
    #[account(
        mut,
        seeds = [EPOCH_SEED, &[denomination_index], &config.current_epoch_seed(denomination_index)],
        bump,
    )]
    pub epoch: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_epoch(ctx: Context<OpenEpoch>, denomination_index: u8) -> Result<()> {
    let config = &ctx.accounts.config;
    let denomination = config.denomination(denomination_index)?;
    let epoch_info = ctx.accounts.epoch.to_account_info();
    if !epoch_info.data_is_empty() {
        return Ok(()); // already open
    }

    let epoch_id = config.current_epoch[denomination_index as usize];
    let id_bytes = epoch_id.to_le_bytes();
    let bump = [ctx.bumps.epoch];
    let seeds: &[&[u8]] = &[EPOCH_SEED, &[denomination_index], &id_bytes, &bump];
    let signer = &[seeds];
    let space = Epoch::space(0);
    let rent = Rent::get()?.minimum_balance(space);
    let sys = ctx.accounts.system_program.key();
    let payer = ctx.accounts.payer.to_account_info();

    if epoch_info.lamports() == 0 {
        create_account(
            CpiContext::new_with_signer(
                sys,
                CreateAccount {
                    from: payer,
                    to: epoch_info.clone(),
                },
                signer,
            ),
            rent,
            space as u64,
            ctx.program_id,
        )?;
    } else {
        // Someone pre-funded the PDA (which would make create_account fail): top up, then
        // allocate and assign it ourselves.
        let missing = rent.saturating_sub(epoch_info.lamports());
        if missing > 0 {
            transfer(
                CpiContext::new(
                    sys,
                    Transfer {
                        from: payer,
                        to: epoch_info.clone(),
                    },
                ),
                missing,
            )?;
        }
        allocate(
            CpiContext::new_with_signer(
                sys,
                Allocate {
                    account_to_allocate: epoch_info.clone(),
                },
                signer,
            ),
            space as u64,
        )?;
        assign(
            CpiContext::new_with_signer(
                sys,
                Assign {
                    account_to_assign: epoch_info.clone(),
                },
                signer,
            ),
            ctx.program_id,
        )?;
    }

    let slot = Clock::get()?.slot;
    let epoch = Epoch {
        denomination_index,
        denomination,
        epoch_id,
        opened_slot: slot,
        end_slot: slot.saturating_add(config.params.epoch_len_slots),
        rollovers: 0,
        status: EpochStatus::Open,
        root: [0; 32],
        bump: ctx.bumps.epoch,
        // Snapshot: every deposit, payout and refund of this epoch uses these (ADR 0012).
        fee_bps: config.params.fee_bps,
        finisher_bps: config.params.finisher_bps,
        leaves: Vec::new(),
        depositors: Vec::new(),
    };
    let mut data = epoch_info.try_borrow_mut_data()?;
    epoch.try_serialize(&mut &mut data[..])?;
    emit!(EpochOpened {
        denomination,
        epoch_id,
        end_slot: epoch.end_slot,
    });
    Ok(())
}
