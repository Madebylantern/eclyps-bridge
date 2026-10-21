use aztec::{
    context::PrivateContext,
    macros::aztec,
    protocol::{
        address::AztecAddress, hash::poseidon2_hash_with_separator,
        storage::map::derive_storage_slot_in_map, traits::ToField,
    },
    utils::WithHash,
};
use eclyps_merkle::{BATCH_TREE_DEPTH, commitment, root_from_path};

/// Claim contracts one Eclyps FPC serves (one per denomination; unused entries are zero).
pub global MAX_CLAIMS: u32 = 4;
/// Most sponsored transactions one note may pay for, whatever its denomination.
pub global MAX_SLOTS: u32 = 64;
/// Gas a sponsored transaction may declare. Measured on Aztec testnet (rc.3, with the testnet's
/// sponsor in place of this one): claim 0.72M mana, exit to Ethereum 0.70M, exit to Solana 0.82M
/// to 1.36M, growing with the exit tree (about 3M for the last leaves of a full tree).
pub global SPONSOR_MAX_L2_GAS: u32 = 3_500_000;
pub global SPONSOR_MAX_DA_GAS: u32 = 16_384;
/// Storage slot of `known_roots` in `EclypsClaim` (its artifact's storage layout). Checked by the
/// TXE tests, which read a real claim contract through this slot.
pub global CLAIM_KNOWN_ROOTS_SLOT: Field = 8;
/// Domain separator for sponsor slot nullifiers (`"eclyps:sponsor"`, truncated to u32).
pub global DOM_SEP__SPONSOR_NULLIFIER: u32 = 0xec15905e;

/// The constructor's checks on the served claim contracts and their slots: at least one claim
/// contract, none twice, slots only for listed contracts and between 1 and `MAX_SLOTS`.
pub fn assert_valid_config(claims: [AztecAddress; MAX_CLAIMS], slots: [u32; MAX_CLAIMS]) {
    let mut served = 0;
    for i in 0..MAX_CLAIMS {
        if claims[i].is_zero() {
            assert(slots[i] == 0, "slots for an empty entry");
        } else {
            assert((slots[i] > 0) & (slots[i] <= MAX_SLOTS), "bad slots");
            for j in 0..MAX_CLAIMS {
                assert((i == j) | (claims[i] != claims[j]), "claim contract listed twice");
            }
            served += 1;
        }
    }
    assert(served > 0, "no claim contract");
}

/// Slots a note of `claim` has; zero when `claim` is not served.
pub fn allowance(
    claims: [AztecAddress; MAX_CLAIMS],
    slots: [u32; MAX_CLAIMS],
    claim: AztecAddress,
) -> u32 {
    let mut allowance = 0;
    for i in 0..MAX_CLAIMS {
        if (!claim.is_zero()) & (claims[i] == claim) {
            allowance = slots[i];
        }
    }
    allowance
}

/// The nullifier that spends slot `slot` of the note with `nullifier_key` deposited through
/// `claim` (siloed to the FPC by the protocol).
pub fn sponsor_nullifier(claim: AztecAddress, nullifier_key: Field, slot: u32) -> Field {
    poseidon2_hash_with_separator(
        [claim.to_field(), nullifier_key, slot as Field],
        DOM_SEP__SPONSOR_NULLIFIER,
    )
}

/// What `EclypsFPC.sponsor` does, given its config (`claims`, `slots`): `elect`, then the end of
/// the setup phase.
pub fn sponsor(
    context: &mut PrivateContext,
    claims: [AztecAddress; MAX_CLAIMS],
    slots: [u32; MAX_CLAIMS],
    claim: AztecAddress,
    root: Field,
    nullifier_key: Field,
    secret: Field,
    leaf_index: Field,
    path: [Field; BATCH_TREE_DEPTH],
    slot: u32,
) {
    elect(
        context,
        claims,
        slots,
        claim,
        root,
        nullifier_key,
        secret,
        leaf_index,
        path,
        slot,
    );
    context.end_setup();
}

/// Checks the transaction's gas settings and the note, spends the slot and elects `context`'s
/// contract as the fee payer (setup phase only).
pub fn elect(
    context: &mut PrivateContext,
    claims: [AztecAddress; MAX_CLAIMS],
    slots: [u32; MAX_CLAIMS],
    claim: AztecAddress,
    root: Field,
    nullifier_key: Field,
    secret: Field,
    leaf_index: Field,
    path: [Field; BATCH_TREE_DEPTH],
    slot: u32,
) {
    let gas = context.gas_settings();
    assert(
        (gas.gas_limits.l2_gas <= SPONSOR_MAX_L2_GAS)
            & (gas.gas_limits.da_gas <= SPONSOR_MAX_DA_GAS),
        "sponsored gas limits too high",
    );
    assert(
        (gas.teardown_gas_limits.l2_gas == 0) & (gas.teardown_gas_limits.da_gas == 0),
        "sponsored tx has teardown gas",
    );
    assert(
        (gas.max_priority_fees_per_gas.fee_per_l2_gas == 0)
            & (gas.max_priority_fees_per_gas.fee_per_da_gas == 0),
        "sponsored tx has a priority fee",
    );

    let slots_of_note = allowance(claims, slots, claim);
    assert(slots_of_note > 0, "not an Eclyps claim contract");
    assert(slot < slots_of_note, "bad sponsor slot");

    // `known_roots[root]` of the claim contract, a PublicImmutable<bool>: the same historical read
    // its own `claim` makes. An unregistered root reads as false.
    let registered: bool = WithHash::<bool, 1>::historical_public_storage_read(
        context.get_anchor_block_header(),
        claim,
        derive_storage_slot_in_map(CLAIM_KNOWN_ROOTS_SLOT, root),
    );
    assert(registered, "unknown root");
    let leaf = commitment(nullifier_key, secret);
    assert_eq(root_from_path(leaf, leaf_index, path), root, "not a member of root");

    context.push_nullifier_unsafe(sponsor_nullifier(claim, nullifier_key, slot));
    context.set_as_fee_payer();
}

/// Eclyps FPC (ADR 0018): pays the Aztec fee of a user's claim or exit from its own Fee Juice,
/// so users need no Fee Juice and no sponsor account learns who they are.
///
/// Aztec mainnet has no sponsored FPC, and only protocol contracts may run public code in a
/// transaction's setup phase. This contract runs no public code in a user's transaction: `sponsor`
/// is private, elects this contract as the fee payer and ends the setup phase, like the testnet's
/// sponsored FPC and the community PrivateFPC. The protocol then charges the fee to this
/// contract's public Fee Juice balance.
///
/// Who may use it: the holder of a note deposited through Eclyps. `sponsor` proves privately that
/// `H(nullifier_key, secret)` is a leaf under a root a served claim contract registered (read from
/// that contract's public storage at the anchor block), and spends one sponsor slot of that note:
/// nullifier `H(claim, nullifier_key, slot)`, with `slot` below the claim contract's allowance.
/// The slot is spent in the setup phase, so it stays spent even if the rest of the transaction
/// reverts. The note can be claimed or not; its slots are its own.
///
/// What one slot can cost: the declared gas is capped, with no teardown and no priority fee, so a
/// slot pays at most `SPONSOR_MAX_L2_GAS` mana at the network's base fee. Every deposited note paid
/// the entry fee (ADR 0012), which covers its slots many times over. Whatever Fee Juice sits here
/// is the most that can ever be lost: keep the balance small and refill it (ADR 0018).
///
/// Privacy: the payer the network sees is this contract, the same for every Eclyps user. Which
/// note, which root and which user stay private; slot nullifiers cannot be linked to each other or
/// to the claim nullifier without the note's secret.
#[aztec]
pub contract EclypsFPC {
    use crate::{assert_valid_config, MAX_CLAIMS};
    use aztec::{
        macros::{functions::{allow_phase_change, external, initializer, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::PublicImmutable,
    };
    use eclyps_merkle::BATCH_TREE_DEPTH;
    use std::meta::derive;

    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        /// Served claim contracts; zero entries are unused.
        pub claims: [AztecAddress; MAX_CLAIMS],
        /// Sponsored transactions one note of `claims[i]` may pay for (its claim, its exits,
        /// retries).
        pub slots: [u32; MAX_CLAIMS],
    }

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(claims: [AztecAddress; MAX_CLAIMS], slots: [u32; MAX_CLAIMS]) {
        assert_valid_config(claims, slots);
        self.storage.config.initialize(Config { claims, slots });
    }

    /// Elects this contract as the fee payer and ends the setup phase. Call it first in the
    /// transaction (aztec.js: as the fee payment method), then the claim or exit itself.
    #[external("private")]
    #[allow_phase_change]
    fn sponsor(
        claim: AztecAddress,
        root: Field,
        nullifier_key: Field,
        secret: Field,
        leaf_index: Field,
        path: [Field; BATCH_TREE_DEPTH],
        slot: u32,
    ) {
        let config = self.storage.config.read();
        crate::sponsor(
            self.context,
            config.claims,
            config.slots,
            claim,
            root,
            nullifier_key,
            secret,
            leaf_index,
            path,
            slot,
        );
    }

    #[external("public")]
    #[view]
    fn get_config() -> Config {
        self.storage.config.read()
    }
}
