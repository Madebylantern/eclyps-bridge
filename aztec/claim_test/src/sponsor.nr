//! Eclyps FPC (TXE, ADR 0018): who may make it pay, how often, and with which gas settings.
//!
//! TXE starts every `call_private` in the revertible phase, where no contract may elect itself fee
//! payer, and it charges no fees. So:
//! - the accepted cases run `eclyps_fpc_contract::elect` (`EclypsFPC.sponsor` without its last line,
//!   `end_setup`, which TXE private contexts refuse) as the FPC, in the setup phase, and check what
//!   it hands the kernel: the fee payer flag and the slot nullifier;
//! - the refused cases call the deployed contract and fail before the election;
//! - one test calls the deployed contract with valid inputs and gets as far as the election.
//! That the network then charges the FPC's Fee Juice is the protocol's part, checked on a local
//! network before mainnet (ADR 0018, follow-ups).

use crate::{DENOMINATION, EPOCH, LEAVES, registered, Setup};
use aztec::{
    protocol::{
        abis::{gas::Gas, gas_fees::GasFees, gas_settings::GasSettings},
        address::AztecAddress,
        hash::{compute_siloed_nullifier, poseidon2_hash_with_separator},
    },
    test::helpers::test_environment::{CallPrivateOptions, PrivateContextOptions},
};
use eclyps_claim_contract::{batch_content_hash, EclypsClaim};
use eclyps_fpc_contract::{
    EclypsFPC::{self, Config},
    SPONSOR_MAX_DA_GAS,
    SPONSOR_MAX_L2_GAS,
    sponsor_nullifier,
};
use eclyps_merkle::vectors;

global SLOTS: u32 = 4;

unconstrained fn only(claim: AztecAddress) -> Config {
    let zero = AztecAddress::zero();
    Config { claims: [claim, zero, zero, zero], slots: [SLOTS, 0, 0, 0] }
}

unconstrained fn deploy_fpc(mut s: Setup, config: Config) -> AztecAddress {
    s.env.deploy("@eclyps_fpc_contract/EclypsFPC").with_public_initializer(
        s.admin,
        EclypsFPC::interface().constructor(config.claims, config.slots),
    )
}

/// A claim contract with the 16-note batch registered, and an FPC serving it.
unconstrained fn served() -> (Setup, AztecAddress) {
    let s = registered();
    let fpc = deploy_fpc(s, only(s.claim));
    (s, fpc)
}

/// Another claim contract ($1,000) on the same token; `register` also registers the batch on it.
unconstrained fn second_claim(mut s: Setup, register: bool) -> AztecAddress {
    let other = s.env.deploy("@eclyps_claim_contract/EclypsClaim").with_public_initializer(
        s.admin,
        EclypsClaim::interface().constructor(
            s.token,
            s.minter,
            s.portal,
            DENOMINATION * 10,
            10,
            4,
        ),
    );
    if register {
        let total = DENOMINATION * 10 * (LEAVES as u128);
        let content = batch_content_hash(vectors::ROOT_BATCH_16, total, EPOCH, DENOMINATION * 10);
        let idx = s.env.send_l1_to_l2_message(content, 0, s.portal, other);
        s.env.call_public(
            s.claimer,
            EclypsClaim::at(other).register_batch(vectors::ROOT_BATCH_16, EPOCH, LEAVES, idx),
        );
    }
    other
}

/// What the app declares for a sponsored transaction: capped limits, no teardown, no priority fee.
fn sponsored_gas() -> GasSettings {
    GasSettings::new(
        Gas::new(SPONSOR_MAX_DA_GAS, SPONSOR_MAX_L2_GAS),
        Gas::new(0, 0),
        GasFees::new(1, 1),
        GasFees::new(0, 0),
    )
}

fn secret_of(p: u32) -> Field {
    vectors::NOTE_SECRETS[vectors::PATH_INDICES[p]]
}

fn key_of(p: u32) -> Field {
    vectors::NOTE_KEYS[vectors::PATH_INDICES[p]]
}

/// Runs the sponsor logic as `fpc`, in the setup phase; returns the nullifier it spent.
unconstrained fn sponsor_in_setup(
    s: Setup,
    fpc: AztecAddress,
    config: Config,
    claim: AztecAddress,
    p: u32,
    slot: u32,
) -> Field {
    let mut opts = PrivateContextOptions::new();
    let opts = opts.at_contract_address(fpc).with_gas_settings(sponsored_gas());
    s.env.private_context_opts(opts, |context| {
        assert(!context.in_revertible_phase());
        eclyps_fpc_contract::elect(
            context,
            config.claims,
            config.slots,
            claim,
            vectors::ROOT_BATCH_16,
            key_of(p),
            secret_of(p),
            vectors::PATH_INDICES[p] as Field,
            vectors::PATH_SIBLINGS[p],
            slot,
        );
        // Still in setup, so the election stands; `sponsor` ends setup right after this.
        assert(!context.in_revertible_phase());
        let out = (*context).finish();
        assert(out.is_fee_payer, "the FPC must pay");
        assert_eq(out.nullifiers.length, 1);
        let n = out.nullifiers.array[0].inner.value;
        assert_eq(n, sponsor_nullifier(claim, key_of(p), slot));
        n
    })
}

/// Calls the deployed FPC (TXE: in the revertible phase).
unconstrained fn call_sponsor(
    s: Setup,
    fpc: AztecAddress,
    claim: AztecAddress,
    p: u32,
    secret: Field,
    slot: u32,
    gas: GasSettings,
) {
    s.env.call_private_opts(
        s.claimer,
        CallPrivateOptions::new().with_gas_settings(gas),
        EclypsFPC::at(fpc).sponsor(
            claim,
            vectors::ROOT_BATCH_16,
            key_of(p),
            secret,
            vectors::PATH_INDICES[p] as Field,
            vectors::PATH_SIBLINGS[p],
            slot,
        ),
    );
}

unconstrained fn refused(s: Setup, fpc: AztecAddress, slot: u32, gas: GasSettings) {
    call_sponsor(s, fpc, s.claim, 0, secret_of(0), slot, gas);
}

// ---------------- accepted ----------------

#[test]
unconstrained fn a_deposited_note_makes_the_fpc_pay() {
    let (s, fpc) = served();
    let _ = sponsor_in_setup(s, fpc, only(s.claim), s.claim, 0, 0);
}

#[test]
unconstrained fn each_slot_and_each_note_spends_its_own_nullifier() {
    let (s, fpc) = served();
    let config = only(s.claim);
    let mut seen: BoundedVec<Field, 5> = BoundedVec::new();
    for slot in 0..SLOTS {
        seen.push(sponsor_in_setup(s, fpc, config, s.claim, 0, slot));
    }
    seen.push(sponsor_in_setup(s, fpc, config, s.claim, 1, 0));
    for i in 0..5 {
        for j in 0..5 {
            assert((i == j) | (seen.get(i) != seen.get(j)), "slots must not share a nullifier");
        }
    }
    // No slot nullifier is the note's claim nullifier (EclypsClaim's separator), siloed or not.
    let claim_nullifier = poseidon2_hash_with_separator([key_of(0)], 0xec1c1a17 as u32);
    for i in 0..5 {
        assert(seen.get(i) != claim_nullifier);
        assert(
            compute_siloed_nullifier(fpc, seen.get(i))
                != compute_siloed_nullifier(s.claim, claim_nullifier),
        );
    }
}

#[test]
unconstrained fn each_served_contract_has_its_own_allowance() {
    let s = registered();
    let other = second_claim(s, true);
    let zero = AztecAddress::zero();
    let config = Config { claims: [s.claim, other, zero, zero], slots: [SLOTS, 13, 0, 0] };
    let fpc = deploy_fpc(s, config);
    // Slot 12 exists for a $1,000 note only; slot 0 of the same note on two contracts is two slots.
    let a = sponsor_in_setup(s, fpc, config, other, 0, 12);
    let b = sponsor_in_setup(s, fpc, config, other, 0, 0);
    let c = sponsor_in_setup(s, fpc, config, s.claim, 0, 0);
    assert((a != b) & (b != c) & (a != c));
}

#[test(should_fail_with = "fee payer must be elected during the setup phase")]
unconstrained fn the_deployed_contract_gets_as_far_as_the_election() {
    // Every check of the deployed contract passes (config read, allowance, root on the claim
    // contract, membership); TXE then refuses the election because it runs calls as revertible.
    let (s, fpc) = served();
    refused(s, fpc, 0, sponsored_gas());
}

// ---------------- refused ----------------

#[test(should_fail_with = "bad sponsor slot")]
unconstrained fn no_slot_past_the_allowance() {
    let (s, fpc) = served();
    refused(s, fpc, SLOTS, sponsored_gas());
}

#[test(should_fail_with = "not a member of root")]
unconstrained fn a_wrong_secret_gets_nothing() {
    let (s, fpc) = served();
    call_sponsor(s, fpc, s.claim, 0, secret_of(0) + 1, 0, sponsored_gas());
}

#[test(should_fail_with = "unknown root")]
unconstrained fn an_unregistered_root_gets_nothing() {
    // The FPC serves a claim contract on which the batch was never registered.
    let s = crate::setup();
    let fpc = deploy_fpc(s, only(s.claim));
    refused(s, fpc, 0, sponsored_gas());
}

#[test(should_fail_with = "unknown root")]
unconstrained fn a_root_counts_only_on_the_claim_contract_that_registered_it() {
    let s = registered();
    let other = second_claim(s, false);
    let zero = AztecAddress::zero();
    let fpc = deploy_fpc(
        s,
        Config { claims: [s.claim, other, zero, zero], slots: [SLOTS, 13, 0, 0] },
    );
    call_sponsor(s, fpc, other, 0, secret_of(0), 0, sponsored_gas());
}

#[test(should_fail_with = "not an Eclyps claim contract")]
unconstrained fn only_served_claim_contracts() {
    let (s, fpc) = served();
    call_sponsor(s, fpc, s.token, 0, secret_of(0), 0, sponsored_gas());
}

#[test(should_fail_with = "not an Eclyps claim contract")]
unconstrained fn the_zero_address_is_not_served() {
    let (s, fpc) = served();
    call_sponsor(
        s,
        fpc,
        AztecAddress::zero(),
        0,
        secret_of(0),
        0,
        sponsored_gas(),
    );
}

#[test(should_fail_with = "sponsored gas limits too high")]
unconstrained fn l2_gas_is_capped() {
    let (s, fpc) = served();
    let mut gas = sponsored_gas();
    gas.gas_limits = Gas::new(SPONSOR_MAX_DA_GAS, SPONSOR_MAX_L2_GAS + 1);
    refused(s, fpc, 0, gas);
}

#[test(should_fail_with = "sponsored gas limits too high")]
unconstrained fn da_gas_is_capped() {
    let (s, fpc) = served();
    let mut gas = sponsored_gas();
    gas.gas_limits = Gas::new(SPONSOR_MAX_DA_GAS + 1, SPONSOR_MAX_L2_GAS);
    refused(s, fpc, 0, gas);
}

#[test(should_fail_with = "sponsored tx has teardown gas")]
unconstrained fn no_teardown() {
    let (s, fpc) = served();
    let mut gas = sponsored_gas();
    gas.teardown_gas_limits = Gas::new(0, 1);
    refused(s, fpc, 0, gas);
}

#[test(should_fail_with = "sponsored tx has a priority fee")]
unconstrained fn no_priority_fee() {
    let (s, fpc) = served();
    let mut gas = sponsored_gas();
    gas.max_priority_fees_per_gas = GasFees::new(0, 1);
    refused(s, fpc, 0, gas);
}

// ---------------- constructor ----------------

#[test(should_fail_with = "claim contract listed twice")]
unconstrained fn a_claim_contract_is_listed_once() {
    let s = crate::setup();
    let zero = AztecAddress::zero();
    let _ = deploy_fpc(
        s,
        Config { claims: [s.claim, s.claim, zero, zero], slots: [SLOTS, SLOTS, 0, 0] },
    );
}

#[test(should_fail_with = "no claim contract")]
unconstrained fn an_fpc_serves_someone() {
    let s = crate::setup();
    let zero = AztecAddress::zero();
    let _ = deploy_fpc(
        s,
        Config { claims: [zero, zero, zero, zero], slots: [0, 0, 0, 0] },
    );
}

#[test(should_fail_with = "bad slots")]
unconstrained fn slots_are_bounded() {
    let s = crate::setup();
    let zero = AztecAddress::zero();
    let _ = deploy_fpc(
        s,
        Config { claims: [s.claim, zero, zero, zero], slots: [65, 0, 0, 0] },
    );
}

#[test]
unconstrained fn the_config_reads_back() {
    let (s, fpc) = served();
    let c = s.env.view_public(EclypsFPC::at(fpc).get_config());
    assert(c == only(s.claim));
}
