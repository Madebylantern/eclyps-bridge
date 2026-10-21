//! Hard bounds (SPEC §5.8). Changing any of these requires a program upgrade, not a parameter change.

pub const CONFIG_SEED: &[u8] = b"config";
pub const ESCROW_SEED: &[u8] = b"escrow";
/// Holds the fees of deposits that have not crossed yet (ADR 0012).
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const EPOCH_SEED: &[u8] = b"epoch";
/// Exit (ADR 0009). The exit authority is the CCTP destinationCaller of every exit message and
/// the owner of exit custody, the token account CCTP pays exits into and `claim_exit` pays out of.
pub const EXIT_AUTHORITY_SEED: &[u8] = b"exit_authority";
pub const EXIT_CUSTODY_SEED: &[u8] = b"exit_custody";
/// One `ExitBatch` per (denomination index, exit epoch id).
pub const EXIT_BATCH_SEED: &[u8] = b"exit_batch";

/// Denomination slots ($100, $1,000 now; $10,000 later).
pub const MAX_DENOMINATIONS: usize = 4;
/// User fee ceiling (basis points), paid on top of the denomination (ADR 0012).
pub const FEE_CAP_BPS: u16 = 50;
pub const BPS_DENOMINATOR: u64 = 10_000;
/// Epoch length bounds in slots (~400 ms): 15 min .. 24 h.
pub const MIN_EPOCH_SLOTS: u64 = 2_250;
pub const MAX_EPOCH_SLOTS: u64 = 216_000;
/// Minimum batch size bounds.
pub const MIN_BATCH_FLOOR: u16 = 4;
pub const MIN_BATCH_CEIL: u16 = 64;
/// Leaves per batch tree (ADR 0004).
pub const MAX_BATCH_LEAVES: u16 = eclyps_merkle::MAX_BATCH_LEAVES as u16;
/// Guardian pause auto-expires.
pub const PAUSE_DURATION_SECS: i64 = 7 * 86_400;
/// After a pause ends (expiry or unpause) the guardian must wait this long before pausing again,
/// so deposits are open at least half of the time whatever the guardian does (ADR 0010).
pub const PAUSE_COOLDOWN_SECS: i64 = 7 * 86_400;
/// A deposit that has not crossed can be refunded to its depositor once its epoch has been open
/// this long (~24 h at 400 ms) and has rolled over at least once (ADR 0010).
pub const REFUND_DELAY_SLOTS: u64 = 216_000;
/// Timelocks.
pub const PARAM_DELAY_SECS: i64 = 7 * 86_400;
pub const FEE_DELAY_SECS: i64 = 14 * 86_400;
/// Admin sunset: at most ~24 months after initialization.
pub const MAX_ADMIN_LIFETIME_SECS: i64 = 730 * 86_400;
pub const BATCH_HOOK_VERSION: u8 = 1;
/// The exit hook has the batch hook's 51-byte layout with version 2 (ADR 0009).
pub const EXIT_HOOK_VERSION: u8 = 2;
pub const HOOK_LEN: usize = 51;
/// Leaves per exit tree: the batch tree's depth (ADR 0004, 0009).
pub const MAX_EXIT_LEAVES: u16 = MAX_BATCH_LEAVES;
const _: () = assert!(
    eclyps_merkle::BATCH_TREE_DEPTH == 8,
    "claim_exit takes an 8-node path"
);

// ---- V2 lanes (ADR 0015 Cross now, ADR 0017 fronted exits and the liquidity pool). New
// accounts only: the V1 accounts (Config, Epoch, ExitBatch) keep their layout, so the upgrade
// needs no migration. Nothing here is reachable until the admin runs `init_lanes`. ----
/// `Lanes`: the V2 parameters, their timelock, and the express epoch counters.
pub const LANES_SEED: &[u8] = b"lanes";
/// The crossing pool (ADR 0015): a USDC account owned by the config PDA. Anyone can top it up
/// with a plain token transfer; it pays the express fee while it holds at least one.
pub const CROSSING_POOL_SEED: &[u8] = b"crossing_pool";
/// One `ExpressEpoch` per express crossing: ["express", denomination index, express id (u64 LE)].
pub const EXPRESS_SEED: &[u8] = b"express";
/// Express epoch ids carry this bit, so they never collide with a normal epoch id in the batch
/// hook, the portal's replay lock or the Aztec claim (all keyed by denomination and epoch id).
pub const EXPRESS_EPOCH_BIT: u64 = 1 << 63;
/// One `Front` per exit leaf: ["front", leaf] (ADR 0017).
pub const FRONT_SEED: &[u8] = b"front";
/// The liquidity pool state (ADR 0017) and its USDC vault (owned by the liquidity PDA).
pub const LIQUIDITY_SEED: &[u8] = b"liquidity";
pub const LIQUIDITY_VAULT_SEED: &[u8] = b"liquidity_vault";
/// One `LpPosition` per liquidity provider: ["lp", owner].
pub const LP_SEED: &[u8] = b"lp";
/// Layout version of every V2 account (first byte after the discriminator).
pub const LANES_VERSION: u8 = 1;
/// Hard bound on `express_fee` (USDC base units): $50.
pub const MAX_EXPRESS_FEE: u64 = 50_000_000;
/// Hard bound on `front_fee_cap_bps` (ADR 0017: proposed 30, hard cap 50).
pub const FRONT_FEE_HARD_CAP_BPS: u16 = 50;
/// A pool front that is still unpaid this long after it was made can be written off by anyone,
/// so the share price stops counting it (worst case on mainnet: about an hour; 7 days is ample).
pub const FRONT_WRITE_OFF_SECS: i64 = 7 * 86_400;
/// Virtual shares and assets in the share price (`shares × (A + V) / (S + V)`), so the first
/// deposit cannot set a price that rounds later deposits to nothing.
pub const LP_VIRTUAL: u64 = 1_000_000;

// ---- Screening deposits (ADR 0019). New accounts only, like the V2 lanes: nothing is blocked
// until the admin runs `init_screening` and the guardian adds an address. ----
/// `Screening`: the counters of the denylist. Its existence is what lets addresses be added.
pub const SCREENING_SEED: &[u8] = b"screening";
/// One `BlockedAddress` per blocked depositor: ["blocked", address]. `deposit` and
/// `deposit_express` take this PDA of their `authority` and refuse when it holds a record.
pub const BLOCKED_SEED: &[u8] = b"blocked";
/// Layout version of the screening accounts.
pub const SCREENING_VERSION: u8 = 1;
/// A removal is announced this long before it takes effect, so a stolen guardian key cannot
/// quietly let an address through: the admin or guardian can cancel it in that time.
pub const UNBLOCK_DELAY_SECS: i64 = 2 * 86_400;
/// Which list an entry comes from (informational; the check is the same for all).
pub const LIST_SANCTIONS: u8 = 0;
pub const LIST_STOLEN_FUNDS: u8 = 1;
pub const LIST_OTHER: u8 = 2;

// ---- Transport: Circle CCTP V2 (ADR 0002). Same program ids on devnet and mainnet. ----
pub const CCTP_TOKEN_MESSENGER_MINTER_V2: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
pub const CCTP_MESSAGE_TRANSMITTER_V2: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
/// sha256("global:deposit_for_burn_with_hook")[0..8]
pub const CCTP_DEPOSIT_FOR_BURN_WITH_HOOK: [u8; 8] = [111, 245, 62, 131, 204, 108, 223, 155];
/// CCTP domain of Ethereum (mainnet and Sepolia).
pub const CCTP_DOMAIN_ETHEREUM: u32 = 0;
/// CCTP domain of Solana.
pub const CCTP_DOMAIN_SOLANA: u32 = 5;
/// "Standard" (finalized) transfer: fee-free, exact mint, no expiry.
pub const CCTP_FINALITY_STANDARD: u32 = 2000;
/// MessageV2 and BurnMessageV2 version (MessageTransmitterV2.version, TokenMessenger
/// message_body_version).
pub const CCTP_MESSAGE_VERSION: u32 = 1;
/// sha256("global:receive_message")[0..8] (MessageTransmitterV2).
pub const CCTP_RECEIVE_MESSAGE: [u8; 8] = [38, 144, 127, 225, 31, 225, 238, 25];

// ---- CCTP V2 accounts a receive reads that do not depend on the mint. They are PDAs of the
// pinned program ids, so they are the same on devnet and mainnet; tests re-derive them. ----
/// MessageTransmitterV2 state `["message_transmitter"]` (attesters, threshold, local domain).
pub const CCTP_MESSAGE_TRANSMITTER_STATE: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU");
/// MT PDA `["message_transmitter_authority", TokenMessengerMinterV2]`: signs MT's call into TMM.
pub const CCTP_MT_AUTHORITY_TMM: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up");
/// MT PDA `["__event_authority"]`.
pub const CCTP_MT_EVENT_AUTHORITY: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV");
/// TMM PDA `["token_messenger"]`.
pub const CCTP_TOKEN_MESSENGER: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W");
/// TMM PDA `["remote_token_messenger", "0"]`: Ethereum's TokenMessengerV2, the only sender of
/// exit messages.
pub const CCTP_REMOTE_TOKEN_MESSENGER_ETHEREUM: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9");
/// TMM PDA `["token_minter"]`.
pub const CCTP_TOKEN_MINTER: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux");
/// TMM PDA `["__event_authority"]`.
pub const CCTP_TMM_EVENT_AUTHORITY: anchor_lang::prelude::Pubkey =
    anchor_lang::pubkey!("6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd");
/// Anchor account discriminator of TMM's `RemoteTokenMessenger`.
pub const CCTP_REMOTE_TOKEN_MESSENGER_DISC: [u8; 8] = [105, 115, 174, 34, 95, 233, 138, 252];
