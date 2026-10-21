use anchor_lang::prelude::*;

#[error_code]
pub enum GatewayError {
    #[msg("Unknown denomination index")]
    UnknownDenomination,
    #[msg("Invalid denomination list")]
    InvalidDenominations,
    #[msg("Parameter outside its hard bound")]
    ParamOutOfBounds,
    #[msg("The per-epoch cap and the deposit cap can only be raised")]
    CapLowered,
    #[msg("Admin lifetime outside bounds")]
    InvalidAdminLifetime,
    #[msg("Deposits are paused")]
    DepositsPaused,
    #[msg("Epoch is not open")]
    EpochNotOpen,
    #[msg("Epoch is not the current epoch for this denomination")]
    NotCurrentEpoch,
    #[msg("Epoch is full")]
    EpochFull,
    #[msg("Epoch has not ended")]
    EpochNotEnded,
    #[msg("Epoch is not closed")]
    EpochNotClosed,
    #[msg("Leaf is not a canonical non-zero BN254 field element")]
    InvalidLeaf,
    #[msg("Merkle root computation failed")]
    MerkleFailed,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Signer is not the guardian")]
    NotGuardian,
    #[msg("Admin role has expired")]
    AdminExpired,
    #[msg("No pending parameter change")]
    NoPendingParams,
    #[msg("Timelock has not elapsed")]
    TimelockActive,
    #[msg("Portal must be a non-zero EVM address as bytes32")]
    InvalidPortal,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("This commitment is already in the epoch")]
    DuplicateLeaf,
    #[msg("Only the program's upgrade authority can initialize")]
    NotUpgradeAuthority,
    #[msg("Deposit is not refundable: its epoch must be open, rolled over, and open for REFUND_DELAY_SLOTS")]
    NotRefundable,
    #[msg("No deposit of this commitment by this authority in the epoch")]
    LeafNotFound,
    #[msg("The guardian must wait for the pause cooldown")]
    PauseCooldown,
    #[msg("No admin transfer is pending")]
    NoPendingAdmin,
    #[msg("Signer is not the pending admin")]
    NotPendingAdmin,
    #[msg("This deposit would take the gateway past its deposit cap")]
    DepositCapReached,
    #[msg("The treasury must be a USDC token account other than the gateway's vaults")]
    InvalidTreasury,
    // ---- exit (ADR 0009); appended so earlier codes stay ----
    #[msg("Exit message: wrong length, message or body version, or a malformed amount")]
    ExitMessageMalformed,
    #[msg("Exit message is not a CCTP burn by Ethereum's TokenMessengerV2 to Solana's TokenMessengerMinterV2")]
    ExitWrongOrigin,
    #[msg("Exit message must name the exit authority as destination caller and exit custody as mint recipient")]
    ExitWrongDestination,
    #[msg("Exit message was not sent by the configured portal")]
    ExitWrongPortal,
    #[msg("Exit transfer was not a finalized, fee-free (standard) transfer")]
    ExitNotStandard,
    #[msg(
        "Exit hook: wrong length or version, unknown denomination, bad count or non-canonical root"
    )]
    ExitBadHook,
    #[msg("Exit amount is not count x denomination, or exit custody did not receive exactly it")]
    ExitAmountMismatch,
    #[msg("Exit leaf or Merkle path does not match the exit batch")]
    InvalidExitProof,
    #[msg("This exit has already been paid")]
    ExitAlreadyClaimed,
    #[msg("The destination accounts do not match the destination in the exit")]
    ExitDestinationMismatch,
    // ---- V2 lanes (ADR 0015, 0017); appended so earlier codes stay ----
    #[msg("Lane parameter outside its hard bound")]
    LaneParamOutOfBounds,
    #[msg("The crossing pool cannot pay the express fee and it is above what the user allowed")]
    ExpressFeeTooHigh,
    #[msg("Express epoch is not closed")]
    ExpressNotClosed,
    #[msg("This exit batch has already arrived on Solana: claim it instead of fronting it")]
    ExitBatchArrived,
    #[msg("Front fee above the cap")]
    FrontFeeTooHigh,
    #[msg("The front record does not match the accounts given")]
    FrontMismatch,
    #[msg("Signer is not the pool's keeper, or pool fronts are off")]
    NotKeeper,
    #[msg("The liquidity pool does not have enough idle funds")]
    PoolInsufficient,
    #[msg("The pool's outstanding fronts would exceed their bound")]
    PoolOutstandingCap,
    #[msg("Amount too small for one share, or shares worth nothing")]
    LpZero,
    #[msg("Not a pool front, already written off, or not old enough")]
    NotWriteOffable,
    #[msg("The payee must be a USDC account other than the gateway's vaults")]
    InvalidPayee,
    // ---- screening (ADR 0019); appended so earlier codes stay ----
    #[msg("This address is on the gateway's screening list and cannot deposit")]
    DepositorBlocked,
    #[msg("Unknown list, or an address that cannot be listed")]
    InvalidScreeningEntry,
    #[msg("No removal of this address has been announced")]
    NoUnblockPending,
    #[msg("Only the admin or the guardian can do this before the sunset")]
    NotScreener,
}
