use anchor_lang::prelude::*;

use crate::{constants::*, error::GatewayError};

/// Tunable parameters, each inside a hard bound (constants.rs). Changes are timelocked.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Params {
    pub epoch_len_slots: u64,
    pub min_batch_size: u16,
    /// Max deposits per (epoch, denomination); raise-only; <= MAX_BATCH_LEAVES.
    pub per_epoch_cap: u16,
    /// User fee on each note, paid on top of the denomination; <= FEE_CAP_BPS (ADR 0012).
    /// Each epoch snapshots it when it opens.
    pub fee_bps: u16,
    /// The part of `fee_bps` paid to whoever sends the batch; <= fee_bps. The rest goes to
    /// `treasury`. Snapshotted per epoch with `fee_bps`.
    pub finisher_bps: u16,
    /// Bound on the principal that has entered and not been refunded (`Config::net_deposits`),
    /// in USDC base units; raise-only.
    pub deposit_cap: u64,
    /// USDC token account that receives the rest of each batch's fees at `send_batch`.
    pub treasury: Pubkey,
}

/// `amount × bps / 10_000`, rounded down (USDC base units).
pub fn bps_of(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / BPS_DENOMINATOR as u128) as u64
}

impl Params {
    /// Validates hard bounds; `current` enforces raise-only rules for an update.
    pub fn validate(&self, current: Option<&Params>) -> Result<()> {
        require!(
            (MIN_EPOCH_SLOTS..=MAX_EPOCH_SLOTS).contains(&self.epoch_len_slots),
            GatewayError::ParamOutOfBounds
        );
        require!(
            (MIN_BATCH_FLOOR..=MIN_BATCH_CEIL).contains(&self.min_batch_size),
            GatewayError::ParamOutOfBounds
        );
        require!(
            self.per_epoch_cap >= self.min_batch_size && self.per_epoch_cap <= MAX_BATCH_LEAVES,
            GatewayError::ParamOutOfBounds
        );
        require!(self.fee_bps <= FEE_CAP_BPS, GatewayError::ParamOutOfBounds);
        require!(
            self.finisher_bps <= self.fee_bps,
            GatewayError::ParamOutOfBounds
        );
        require!(self.deposit_cap > 0, GatewayError::ParamOutOfBounds);
        require!(
            self.treasury != Pubkey::default(),
            GatewayError::InvalidTreasury
        );
        if let Some(cur) = current {
            require!(
                self.per_epoch_cap >= cur.per_epoch_cap && self.deposit_cap >= cur.deposit_cap,
                GatewayError::CapLowered
            );
        }
        Ok(())
    }

    /// Whether `self` changes who is paid what: the fee, its split or the treasury. Such a change
    /// waits FEE_DELAY_SECS; any other waits PARAM_DELAY_SECS.
    pub fn changes_fees(&self, current: &Params) -> bool {
        self.fee_bps != current.fee_bps
            || self.finisher_bps != current.finisher_bps
            || self.treasury != current.treasury
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PendingParams {
    pub params: Params,
    /// Unix timestamp after which `apply_params` may execute.
    pub eta: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub guardian: Pubkey,
    pub usdc_mint: Pubkey,
    /// Principal of deposits that have not crossed. Only send_batch and refund_deposit move it.
    pub escrow: Pubkey,
    /// Fees of deposits that have not crossed (ADR 0012). Only send_batch (pays them out) and
    /// refund_deposit (gives them back) move it.
    pub fee_vault: Pubkey,
    /// Exit custody (ADR 0009): CCTP pays exit batches in here; only `claim_exit` pays out of it.
    /// A token account at PDA ["exit_custody"] owned by the exit authority PDA ["exit_authority"],
    /// which is also every exit message's destinationCaller.
    pub exit_custody: Pubkey,
    /// Ethereum portal as a CCTP bytes32 (12 zero bytes + address): mint_recipient and
    /// destination_caller of every batch. Fixed at initialization.
    pub portal: [u8; 32],
    /// USDC base units; 0 = unused slot. Fixed at initialization in Phase 0.
    pub denominations: [u64; MAX_DENOMINATIONS],
    /// Id of the open epoch per denomination.
    pub current_epoch: [u64; MAX_DENOMINATIONS],
    /// Principal that has entered and not been refunded: + denomination per deposit,
    /// - denomination per refund. Bounded by `params.deposit_cap` (ADR 0012).
    pub net_deposits: u64,
    pub params: Params,
    pub pending: Option<PendingParams>,
    pub paused_deposits: bool,
    pub pause_expiry: i64,
    pub admin_expiry_ts: i64,
    pub bump: u8,
    pub escrow_bump: u8,
    pub fee_vault_bump: u8,
    pub exit_authority_bump: u8,
    pub exit_custody_bump: u8,
    /// The guardian cannot pause again before this time (ADR 0010).
    pub pause_cooldown_until: i64,
    /// Two-step admin transfer: proposed by the admin, accepted by this key.
    pub pending_admin: Option<Pubkey>,
}

impl Config {
    pub fn denomination(&self, index: u8) -> Result<u64> {
        let d = *self
            .denominations
            .get(index as usize)
            .ok_or(GatewayError::UnknownDenomination)?;
        require!(d != 0, GatewayError::UnknownDenomination);
        Ok(d)
    }

    /// Seed bytes of the current epoch for `index`; u64::MAX for an invalid index, so the
    /// derived address never matches a real epoch and the handler's check fails cleanly.
    pub fn current_epoch_seed(&self, index: u8) -> [u8; 8] {
        self.current_epoch
            .get(index as usize)
            .copied()
            .unwrap_or(u64::MAX)
            .to_le_bytes()
    }

    /// A treasury must be a plain account of its own, never one of the gateway's vaults.
    pub fn check_treasury(&self, treasury: &Pubkey) -> Result<()> {
        require!(
            *treasury != self.escrow
                && *treasury != self.fee_vault
                && *treasury != self.exit_custody,
            GatewayError::InvalidTreasury
        );
        Ok(())
    }

    pub fn deposits_paused(&self, now: i64) -> bool {
        self.paused_deposits && now < self.pause_expiry
    }

    /// Admin and guardian powers end at the sunset (SPEC §5.8: all admin roles expire).
    pub fn admin_active(&self, now: i64) -> bool {
        now < self.admin_expiry_ts
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum EpochStatus {
    Open,
    /// Root computed; waiting for a finisher to send the batch.
    Closed,
    /// Burned over the transport (stub in Phase 0).
    Sent,
}

/// One epoch of one denomination. Grows by one leaf per deposit (depositor pays the rent);
/// once closed it is the batch record: leaves stay readable so anyone can build Merkle paths.
/// `depositors[i]` signed the deposit of `leaves[i]`; only they can refund it (ADR 0010). It is
/// the transaction signer, which is public anyway.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub denomination_index: u8,
    pub denomination: u64,
    pub epoch_id: u64,
    pub opened_slot: u64,
    pub end_slot: u64,
    pub rollovers: u32,
    pub status: EpochStatus,
    /// Batch root; meaningful once status != Open.
    pub root: [u8; 32],
    pub bump: u8,
    /// `params.fee_bps` and `params.finisher_bps` when the epoch opened: every deposit, payout
    /// and refund of this epoch uses them, so a fee change applies from the next epoch (ADR 0012).
    pub fee_bps: u16,
    pub finisher_bps: u16,
    #[max_len(0)]
    pub leaves: Vec<[u8; 32]>,
    #[max_len(0)]
    pub depositors: Vec<Pubkey>,
}

impl Epoch {
    /// Account size with `leaves` deposits: 32 bytes of leaf and 32 of depositor each.
    pub fn space(leaves: usize) -> usize {
        8 + Epoch::INIT_SPACE + 64 * leaves
    }

    /// The fee each deposit of this epoch pays on top of the denomination.
    pub fn fee_per_note(&self) -> u64 {
        bps_of(self.denomination, self.fee_bps)
    }

    /// The finisher's part of `fee_per_note`; the rest (rounding included) goes to the treasury.
    pub fn finisher_fee_per_note(&self) -> u64 {
        bps_of(self.denomination, self.finisher_bps)
    }
}

/// One exit batch (ADR 0009): an Aztec exit epoch of one denomination that crossed through CCTP.
/// `receive_exit` creates it, with exactly `count x denomination` in exit custody; `claim_exit`
/// pays each leaf once. PDA ["exit_batch", denomination_index, exit_epoch_id (u64 LE)], so a
/// second message for the same exit epoch can never be received.
#[account]
#[derive(InitSpace)]
pub struct ExitBatch {
    pub denomination_index: u8,
    pub denomination: u64,
    pub exit_epoch_id: u64,
    /// Root of the exit tree: leaves `Poseidon(dest_hi, dest_lo, secret)`, batch node hash,
    /// depth 8 (ADR 0004).
    pub root: [u8; 32],
    /// Exits in the batch, leaves 0..count.
    pub count: u16,
    /// Exits paid so far.
    pub claimed_count: u16,
    /// Bit `i % 8` of byte `i / 8` is set once leaf `i` is paid.
    pub claimed: [u8; 32],
    /// The CCTP nonce of the message that carried the batch.
    pub cctp_nonce: [u8; 32],
    pub received_slot: u64,
    pub bump: u8,
}

impl ExitBatch {
    pub fn is_claimed(&self, leaf_index: u16) -> bool {
        self.claimed[leaf_index as usize / 8] & (1 << (leaf_index % 8)) != 0
    }

    pub fn set_claimed(&mut self, leaf_index: u16) {
        self.claimed[leaf_index as usize / 8] |= 1 << (leaf_index % 8);
    }
}

// ================================================================= V2 lanes (ADR 0015, 0017)
//
// New accounts only, each starting with a layout `version` and ending with reserved bytes, so the
// deployed V1 accounts never change and later fields can be added in place.

/// The V2 parameters, each inside a hard bound (constants.rs). Changes are timelocked like
/// `Params`: 14 days when a fee rate changes (`front_fee_cap_bps`, `pool_fee_bps`), 7 days
/// otherwise. Turning pool fronts off (`disable_pool_fronts`) is immediate.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct LaneParams {
    /// What an express crossing pays the finisher who sends it (USDC base units), from the
    /// crossing pool while it holds at least this much, else from the user (ADR 0015).
    pub express_fee: u64,
    /// The most any front may keep from an exit, in basis points of the denomination (ADR 0017).
    pub front_fee_cap_bps: u16,
    /// What a front paid from the liquidity pool keeps (<= front_fee_cap_bps). Fixed, so every
    /// pool payout of a denomination is the same amount.
    pub pool_fee_bps: u16,
    /// Bound on what the pool has advanced and not been repaid (USDC base units).
    pub pool_max_outstanding: u64,
    /// The key that signs pool fronts after checking the exit on Aztec. `Pubkey::default()` turns
    /// pool fronts off.
    pub keeper: Pubkey,
}

impl LaneParams {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.express_fee <= MAX_EXPRESS_FEE,
            GatewayError::LaneParamOutOfBounds
        );
        require!(
            self.front_fee_cap_bps <= FRONT_FEE_HARD_CAP_BPS,
            GatewayError::LaneParamOutOfBounds
        );
        require!(
            self.pool_fee_bps <= self.front_fee_cap_bps,
            GatewayError::LaneParamOutOfBounds
        );
        Ok(())
    }

    /// A change of a fee rate waits FEE_DELAY_SECS; any other change PARAM_DELAY_SECS.
    pub fn changes_fees(&self, current: &LaneParams) -> bool {
        self.front_fee_cap_bps != current.front_fee_cap_bps
            || self.pool_fee_bps != current.pool_fee_bps
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PendingLaneParams {
    pub params: LaneParams,
    pub eta: i64,
}

/// PDA ["lanes"]: created once by `init_lanes`. Its existence is what turns the V2 instructions on.
#[account]
#[derive(InitSpace)]
pub struct Lanes {
    pub version: u8,
    pub bump: u8,
    pub crossing_pool_bump: u8,
    /// USDC account at PDA ["crossing_pool"], owned by the config PDA (ADR 0015).
    pub crossing_pool: Pubkey,
    pub params: LaneParams,
    pub pending: Option<PendingLaneParams>,
    /// Next express counter per denomination (the id is `EXPRESS_EPOCH_BIT | counter`).
    pub express_next: [u64; MAX_DENOMINATIONS],
    /// Express fees the crossing pool has paid so far (public, for the app's "on us").
    pub pool_paid: u64,
    pub reserved: [u8; 64],
}

impl Lanes {
    pub fn express_id(&self, index: u8) -> u64 {
        EXPRESS_EPOCH_BIT
            | self
                .express_next
                .get(index as usize)
                .copied()
                .unwrap_or(u64::MAX >> 1)
    }
}

/// One express crossing (ADR 0015): a batch of one leaf, closed when it is made, sent by
/// `send_express_batch`. PDA ["express", denomination index, express id (u64 LE)].
#[account]
#[derive(InitSpace)]
pub struct ExpressEpoch {
    pub version: u8,
    pub bump: u8,
    pub denomination_index: u8,
    pub denomination: u64,
    /// With EXPRESS_EPOCH_BIT set: the epoch id of the batch hook.
    pub express_id: u64,
    pub opened_slot: u64,
    /// Closed (ready to send) or Sent.
    pub status: EpochStatus,
    /// Root of the one-leaf tree (depth 8, ADR 0004).
    pub root: [u8; 32],
    pub leaf: [u8; 32],
    pub depositor: Pubkey,
    /// The ADR 0012 fee and its finisher share, at the params of the deposit.
    pub fee: u64,
    pub finisher_fee: u64,
    /// The express fee, paid to the finisher at send (ADR 0015).
    pub express_fee: u64,
    /// The crossing pool paid `express_fee` ("on us"); otherwise the user did.
    pub paid_by_pool: bool,
    pub reserved: [u8; 16],
}

/// One fronted exit (ADR 0017): someone paid the destination early and is repaid by `claim_exit`.
/// PDA ["front", leaf], so a leaf is fronted at most once and `claim_exit` always finds it.
#[account]
#[derive(InitSpace)]
pub struct Front {
    pub version: u8,
    pub bump: u8,
    pub leaf: [u8; 32],
    pub denomination_index: u8,
    pub denomination: u64,
    /// The exit epoch the fronter named (informational: the leaf is what binds).
    pub exit_epoch_id: u64,
    pub fee: u64,
    /// What the destination received: denomination − fee.
    pub advanced: u64,
    /// USDC account `claim_exit` pays the whole denomination to.
    pub payee: Pubkey,
    /// Gets the record's rent back when it closes.
    pub rent_payer: Pubkey,
    /// Paid from the liquidity pool (payee = the pool's vault).
    pub from_pool: bool,
    /// A pool front no longer counted in the share price (`write_off_front`).
    pub written_off: bool,
    pub fronted_at: i64,
    pub reserved: [u8; 16],
}

/// PDA ["liquidity"]: the pool that funds fronts (ADR 0017, amended). Accounting is internal, so
/// a token transfer straight to the vault changes nothing:
/// assets = liquid + outstanding; a share is worth (assets + V) / (shares + V).
#[account]
#[derive(InitSpace)]
pub struct Liquidity {
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    /// USDC account at PDA ["liquidity_vault"], owned by this PDA.
    pub vault: Pubkey,
    pub total_shares: u64,
    /// Idle USDC in the vault that belongs to the pool: what can be fronted or withdrawn.
    pub liquid: u64,
    /// Advanced by pool fronts, not yet repaid nor written off.
    pub outstanding: u64,
    /// Front fees realized at repayment: the only source of share price growth.
    pub fees_earned: u64,
    /// Advanced amounts written off, and what came back later for written-off fronts.
    pub written_off: u64,
    pub recovered: u64,
    pub fronts: u64,
    pub reserved: [u8; 64],
}

impl Liquidity {
    pub fn assets(&self) -> Result<u64> {
        self.liquid
            .checked_add(self.outstanding)
            .ok_or_else(|| GatewayError::Overflow.into())
    }

    /// Shares for `amount` deposited, rounded down.
    pub fn shares_for(&self, amount: u64) -> Result<u64> {
        let s = (amount as u128)
            .checked_mul(self.total_shares as u128 + LP_VIRTUAL as u128)
            .ok_or(GatewayError::Overflow)?
            / (self.assets()? as u128 + LP_VIRTUAL as u128);
        u64::try_from(s).map_err(|_| GatewayError::Overflow.into())
    }

    /// USDC for `shares` withdrawn, rounded down.
    pub fn amount_for(&self, shares: u64) -> Result<u64> {
        let a = (shares as u128)
            .checked_mul(self.assets()? as u128 + LP_VIRTUAL as u128)
            .ok_or(GatewayError::Overflow)?
            / (self.total_shares as u128 + LP_VIRTUAL as u128);
        u64::try_from(a).map_err(|_| GatewayError::Overflow.into())
    }

    /// A pool front was repaid with `amount` (normally the denomination).
    pub fn repaid(&mut self, front: &Front, amount: u64) -> Result<()> {
        self.liquid = self
            .liquid
            .checked_add(amount)
            .ok_or(GatewayError::Overflow)?;
        if front.written_off {
            self.recovered = self.recovered.saturating_add(amount);
        } else {
            self.outstanding = self.outstanding.saturating_sub(front.advanced);
            self.fees_earned = self
                .fees_earned
                .saturating_add(amount.saturating_sub(front.advanced));
        }
        Ok(())
    }
}

/// PDA ["lp", owner]: one liquidity provider's shares.
#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    pub shares: u64,
    pub reserved: [u8; 16],
}

/// The exit leaf `Poseidon(dest_hi, dest_lo, secret)` as a PDA seed; all zeros when the secret is
/// not canonical (no real leaf is zero, and the handlers recompute it and fail).
pub fn front_seed(destination: &Pubkey, secret: &[u8; 32]) -> [u8; 32] {
    eclyps_merkle::exit_commitment(&destination.to_bytes(), secret).unwrap_or([0u8; 32])
}

// ================================================================= Screening (ADR 0019)
//
// New accounts only, each with a layout version and reserved bytes; V1 and V2 accounts unchanged.

/// PDA ["screening"]: created once by `init_screening`; counts the entries.
#[account]
#[derive(InitSpace)]
pub struct Screening {
    pub version: u8,
    pub bump: u8,
    /// Entries in force now (added and not removed).
    pub blocked: u32,
    pub added: u64,
    pub removed: u64,
    pub reserved: [u8; 64],
}

/// PDA ["blocked", address]: `address` cannot be the `authority` of a deposit while this exists.
/// Added at once by the guardian or admin; removed by `unblock` once an announced removal is due.
#[account]
#[derive(InitSpace)]
pub struct BlockedAddress {
    pub version: u8,
    pub bump: u8,
    pub address: Pubkey,
    /// LIST_SANCTIONS, LIST_STOLEN_FUNDS or LIST_OTHER.
    pub list: u8,
    /// Free-form pointer to the public source of the entry (scripts/screening: sha256 of the
    /// source record, e.g. "ofac-sdn:feature:94579").
    pub reference: [u8; 32],
    pub added_at: i64,
    pub added_by: Pubkey,
    /// Paid the rent; gets it back when the entry is removed.
    pub rent_payer: Pubkey,
    /// 0 = no removal announced; otherwise `unblock` works from this time.
    pub unblock_eta: i64,
    pub reserved: [u8; 32],
}

/// Whether `blocked` (the PDA ["blocked", authority] a deposit takes) holds a record. The address
/// is a PDA of this program, so only `block_address` can have given it data; `unblock` closes it.
pub fn is_blocked(blocked: &AccountInfo) -> bool {
    blocked.owner == &crate::ID && !blocked.data_is_empty()
}
