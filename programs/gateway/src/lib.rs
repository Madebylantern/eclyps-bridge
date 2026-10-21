//! Eclyps gateway (Phase 0 skeleton, S4). SPEC §5.3; decisions in ADR 0002 (transport),
//! ADR 0004 (hash), ADR 0005 (this program), ADR 0009 (exit), ADR 0012 (fees and cap), ADR 0019 (screening deposits).

pub mod constants;
pub mod error;
pub mod events;
pub mod exit_message;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf");

#[program]
pub mod eclyps_gateway {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, args)
    }

    pub fn open_epoch(ctx: Context<OpenEpoch>, denomination_index: u8) -> Result<()> {
        instructions::open_epoch::handle_open_epoch(ctx, denomination_index)
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        denomination_index: u8,
        secret_hash: [u8; 32],
    ) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, denomination_index, secret_hash)
    }

    pub fn close_epoch(ctx: Context<CloseEpoch>, denomination_index: u8) -> Result<()> {
        instructions::close_epoch::handle_close_epoch(ctx, denomination_index)
    }

    pub fn send_batch(
        ctx: Context<SendBatch>,
        denomination_index: u8,
        epoch_id: u64,
    ) -> Result<()> {
        instructions::send_batch::handle_send_batch(ctx, denomination_index, epoch_id)
    }

    pub fn pause_deposits(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handle_pause_deposits(ctx)
    }

    pub fn unpause_deposits(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handle_unpause_deposits(ctx)
    }

    pub fn propose_params(ctx: Context<AdminOnly>, params: Params) -> Result<()> {
        instructions::governance::handle_propose_params(ctx, params)
    }

    pub fn cancel_params(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::governance::handle_cancel_params(ctx)
    }

    pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
        instructions::governance::handle_apply_params(ctx)
    }

    pub fn refund_deposit(
        ctx: Context<RefundDeposit>,
        denomination_index: u8,
        commitment: [u8; 32],
    ) -> Result<()> {
        instructions::refund::handle_refund_deposit(ctx, denomination_index, commitment)
    }

    pub fn set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
        instructions::governance::handle_set_guardian(ctx, guardian)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::governance::handle_propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::governance::handle_accept_admin(ctx)
    }

    pub fn receive_exit(
        ctx: Context<ReceiveExit>,
        message: Vec<u8>,
        attestation: Vec<u8>,
    ) -> Result<()> {
        instructions::receive_exit::handle_receive_exit(ctx, message, attestation)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn claim_exit(
        ctx: Context<ClaimExit>,
        denomination_index: u8,
        exit_epoch_id: u64,
        leaf_index: u16,
        path: [[u8; 32]; 8],
        destination: Pubkey,
        secret: [u8; 32],
    ) -> Result<()> {
        instructions::claim_exit::handle_claim_exit(
            ctx,
            denomination_index,
            exit_epoch_id,
            leaf_index,
            path,
            destination,
            secret,
        )
    }

    // ---- V2 lanes (ADR 0015 Cross now, ADR 0017 fronted exits and the liquidity pool) ----

    pub fn init_lanes(ctx: Context<InitLanes>, params: LaneParams) -> Result<()> {
        instructions::lanes::handle_init_lanes(ctx, params)
    }

    pub fn propose_lane_params(ctx: Context<LanesAdmin>, params: LaneParams) -> Result<()> {
        instructions::lanes::handle_propose_lane_params(ctx, params)
    }

    pub fn cancel_lane_params(ctx: Context<LanesAdmin>) -> Result<()> {
        instructions::lanes::handle_cancel_lane_params(ctx)
    }

    pub fn apply_lane_params(ctx: Context<ApplyLaneParams>) -> Result<()> {
        instructions::lanes::handle_apply_lane_params(ctx)
    }

    pub fn disable_pool_fronts(ctx: Context<DisablePoolFronts>) -> Result<()> {
        instructions::lanes::handle_disable_pool_fronts(ctx)
    }

    pub fn deposit_express(
        ctx: Context<DepositExpress>,
        denomination_index: u8,
        secret_hash: [u8; 32],
        max_express_fee: u64,
    ) -> Result<()> {
        instructions::express::handle_deposit_express(
            ctx,
            denomination_index,
            secret_hash,
            max_express_fee,
        )
    }

    pub fn send_express_batch(
        ctx: Context<SendExpressBatch>,
        denomination_index: u8,
        express_id: u64,
    ) -> Result<()> {
        instructions::express::handle_send_express_batch(ctx, denomination_index, express_id)
    }

    pub fn front_exit(
        ctx: Context<FrontExit>,
        denomination_index: u8,
        exit_epoch_id: u64,
        destination: Pubkey,
        secret: [u8; 32],
        fee: u64,
    ) -> Result<()> {
        instructions::front::handle_front_exit(
            ctx,
            denomination_index,
            exit_epoch_id,
            destination,
            secret,
            fee,
        )
    }

    pub fn front_exit_from_pool(
        ctx: Context<FrontExitFromPool>,
        denomination_index: u8,
        exit_epoch_id: u64,
        destination: Pubkey,
        secret: [u8; 32],
    ) -> Result<()> {
        instructions::front::handle_front_exit_from_pool(
            ctx,
            denomination_index,
            exit_epoch_id,
            destination,
            secret,
        )
    }

    pub fn write_off_front(ctx: Context<WriteOffFront>, leaf: [u8; 32]) -> Result<()> {
        instructions::front::handle_write_off_front(ctx, leaf)
    }

    pub fn lp_deposit(ctx: Context<LpDeposit>, amount: u64) -> Result<()> {
        instructions::liquidity::handle_lp_deposit(ctx, amount)
    }

    pub fn lp_withdraw(ctx: Context<LpWithdraw>, shares: u64) -> Result<()> {
        instructions::liquidity::handle_lp_withdraw(ctx, shares)
    }

    // ---- Screening deposits (ADR 0019) ----

    pub fn init_screening(ctx: Context<InitScreening>) -> Result<()> {
        instructions::screening::handle_init_screening(ctx)
    }

    pub fn block_address(
        ctx: Context<BlockAddress>,
        address: Pubkey,
        list: u8,
        reference: [u8; 32],
    ) -> Result<()> {
        instructions::screening::handle_block_address(ctx, address, list, reference)
    }

    pub fn propose_unblock(ctx: Context<ChangeBlock>, address: Pubkey) -> Result<()> {
        instructions::screening::handle_propose_unblock(ctx, address)
    }

    pub fn cancel_unblock(ctx: Context<ChangeBlock>, address: Pubkey) -> Result<()> {
        instructions::screening::handle_cancel_unblock(ctx, address)
    }

    pub fn unblock(ctx: Context<Unblock>, address: Pubkey) -> Result<()> {
        instructions::screening::handle_unblock(ctx, address)
    }
}
