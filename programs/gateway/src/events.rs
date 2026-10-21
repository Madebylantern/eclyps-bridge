use anchor_lang::prelude::*;

#[event]
pub struct EpochOpened {
    pub denomination: u64,
    pub epoch_id: u64,
    pub end_slot: u64,
}

#[event]
pub struct Deposited {
    pub denomination: u64,
    pub epoch_id: u64,
    pub leaf_index: u16,
    pub leaf: [u8; 32],
    /// Paid on top of the denomination into the fee vault (ADR 0012).
    pub fee: u64,
}

#[event]
pub struct EpochRolledOver {
    pub denomination: u64,
    pub epoch_id: u64,
    pub leaf_count: u16,
    pub new_end_slot: u64,
}

#[event]
pub struct EpochClosed {
    pub denomination: u64,
    pub epoch_id: u64,
    pub leaf_count: u16,
    pub root: [u8; 32],
}

/// Emitted by `send_batch`. `hook` is the exact 51-byte CCTP hook (ADR 0002).
#[event]
pub struct BatchSent {
    pub denomination: u64,
    pub epoch_id: u64,
    pub leaf_count: u16,
    pub total: u64,
    pub root: [u8; 32],
    pub hook: [u8; 51],
}

/// Emitted by `send_batch`: the batch's fees left the fee vault (ADR 0012). `finisher` and
/// `treasury` are the USDC token accounts paid. `treasury_skipped`: the treasury account could
/// not receive (closed, frozen, not USDC), so its share went to the finisher instead.
#[event]
pub struct BatchFeesPaid {
    pub denomination: u64,
    pub epoch_id: u64,
    pub finisher: Pubkey,
    pub finisher_amount: u64,
    pub treasury: Pubkey,
    pub treasury_amount: u64,
    pub treasury_skipped: bool,
}

#[event]
pub struct DepositsPaused {
    pub expiry: i64,
}

#[event]
pub struct DepositsUnpaused {}

#[event]
pub struct ParamsProposed {
    pub params: crate::state::Params,
    pub eta: i64,
}

#[event]
pub struct ParamsApplied {
    pub params: crate::state::Params,
}

#[event]
pub struct DepositRefunded {
    pub denomination: u64,
    pub epoch_id: u64,
    pub leaf: [u8; 32],
    pub authority: Pubkey,
    /// The fee paid at deposit, returned with the denomination.
    pub fee: u64,
}

#[event]
pub struct GuardianSet {
    pub guardian: Pubkey,
}

#[event]
pub struct AdminProposed {
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}

/// Emitted by `receive_exit`: an exit batch arrived through CCTP and its root is stored
/// (ADR 0009). `amount` = count x denomination, now in exit custody.
#[event]
pub struct ExitReceived {
    pub denomination: u64,
    pub exit_epoch_id: u64,
    pub count: u16,
    pub root: [u8; 32],
    pub amount: u64,
    pub cctp_nonce: [u8; 32],
}

// ---- V2 lanes (ADR 0015, 0017) ----

#[event]
pub struct LanesInitialized {
    pub params: crate::state::LaneParams,
    pub crossing_pool: Pubkey,
    pub liquidity_vault: Pubkey,
}

#[event]
pub struct LaneParamsProposed {
    pub params: crate::state::LaneParams,
    pub eta: i64,
}

#[event]
pub struct LaneParamsApplied {
    pub params: crate::state::LaneParams,
}

#[event]
pub struct PoolFrontsDisabled {
    pub by: Pubkey,
}

/// Emitted by `deposit_express` (ADR 0015). The express epoch is closed at once with this one
/// leaf; `express_id` has EXPRESS_EPOCH_BIT set. `paid_by_pool`: the crossing pool paid
/// `express_fee`, otherwise the user did. `send_express_batch` then emits the usual `BatchSent`
/// and `BatchFeesPaid` with this id (the bit is the express flag).
#[event]
pub struct ExpressDeposited {
    pub denomination: u64,
    pub express_id: u64,
    pub leaf: [u8; 32],
    pub root: [u8; 32],
    pub fee: u64,
    pub express_fee: u64,
    pub paid_by_pool: bool,
}

/// Emitted by `front_exit` and `front_exit_from_pool` (ADR 0017).
#[event]
pub struct ExitFronted {
    pub leaf: [u8; 32],
    pub denomination: u64,
    pub exit_epoch_id: u64,
    pub destination: Pubkey,
    pub advanced: u64,
    pub fee: u64,
    pub payee: Pubkey,
    pub from_pool: bool,
}

/// Emitted by `claim_exit` for a fronted leaf: the whole denomination went to the fronter.
#[event]
pub struct FrontRepaid {
    pub leaf: [u8; 32],
    pub payee: Pubkey,
    pub amount: u64,
    pub from_pool: bool,
}

#[event]
pub struct FrontWrittenOff {
    pub leaf: [u8; 32],
    pub advanced: u64,
}

#[event]
pub struct LiquidityDeposited {
    pub owner: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct LiquidityWithdrawn {
    pub owner: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

/// Emitted by `claim_exit`: leaf `leaf_index` of an exit batch paid one denomination to
/// `destination`'s USDC account (ADR 0009).
#[event]
pub struct ExitClaimed {
    pub denomination: u64,
    pub exit_epoch_id: u64,
    pub leaf_index: u16,
    pub destination: Pubkey,
    pub amount: u64,
}

// ---- Screening deposits (ADR 0019) ----

#[event]
pub struct ScreeningInitialized {}

/// An address can no longer deposit, effective at once.
#[event]
pub struct AddressAdded {
    pub address: Pubkey,
    pub list: u8,
    pub reference: [u8; 32],
    pub by: Pubkey,
}

/// The removal of an address is announced; anyone can carry it out from `eta`.
#[event]
pub struct UnblockProposed {
    pub address: Pubkey,
    pub eta: i64,
    pub by: Pubkey,
}

#[event]
pub struct UnblockCancelled {
    pub address: Pubkey,
    pub by: Pubkey,
}

/// The address can deposit again.
#[event]
pub struct AddressRemoved {
    pub address: Pubkey,
}
