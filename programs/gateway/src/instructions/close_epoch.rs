use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::GatewayError,
    events::{EpochClosed, EpochRolledOver},
    state::*,
};

/// Permissionless. After the end slot (or once the epoch is full): if it holds fewer than
/// `min_batch_size` leaves, the epoch stays open for another epoch length (its leaves roll
/// over); otherwise the batch root is computed with the Poseidon syscall and the next epoch
/// becomes current. Not affected by the deposit pause.
#[derive(Accounts)]
#[instruction(denomination_index: u8)]
pub struct CloseEpoch<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, &[denomination_index], &config.current_epoch_seed(denomination_index)],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,
}

pub fn handle_close_epoch(ctx: Context<CloseEpoch>, denomination_index: u8) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.denomination(denomination_index)?;
    let epoch = &mut ctx.accounts.epoch;
    require!(
        epoch.status == EpochStatus::Open,
        GatewayError::EpochNotOpen
    );

    let slot = Clock::get()?.slot;
    let count = epoch.leaves.len();
    let full = count >= config.params.per_epoch_cap.min(MAX_BATCH_LEAVES) as usize;
    require!(slot >= epoch.end_slot || full, GatewayError::EpochNotEnded);

    if count < config.params.min_batch_size as usize {
        epoch.end_slot = slot.saturating_add(config.params.epoch_len_slots);
        epoch.rollovers = epoch.rollovers.saturating_add(1);
        emit!(EpochRolledOver {
            denomination: epoch.denomination,
            epoch_id: epoch.epoch_id,
            leaf_count: count as u16,
            new_end_slot: epoch.end_slot,
        });
        return Ok(());
    }

    // Streaming: no copy of the leaves. A full batch's leaves and depositors already take 16 KiB
    // of the 32 KiB heap (ADR 0010).
    epoch.root = eclyps_merkle::root_streaming(&epoch.leaves, eclyps_merkle::BATCH_TREE_DEPTH)
        .map_err(|_| GatewayError::MerkleFailed)?;
    epoch.status = EpochStatus::Closed;
    let idx = denomination_index as usize;
    config.current_epoch[idx] = config.current_epoch[idx]
        .checked_add(1)
        .ok_or(GatewayError::Overflow)?;
    emit!(EpochClosed {
        denomination: epoch.denomination,
        epoch_id: epoch.epoch_id,
        leaf_count: count as u16,
        root: epoch.root,
    });
    Ok(())
}
