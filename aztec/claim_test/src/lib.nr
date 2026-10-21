//! S5 acceptance (TXE): a valid claim succeeds once, a second claim of the same note fails,
//! a wrong secret fails. Plus: registration needs the exact portal message, roots stay unique.
//! Notes, leaves, root and paths come from circuits/vectors/merkle.json (ADR 0004).
//! Exits (ADR 0009, ADR 0014 §4) are tested in `exit.nr`, the Eclyps FPC (ADR 0018) in `sponsor.nr`.

mod exit;
mod exit_vectors;
mod minter;
mod sponsor;

use aztec::{
    protocol::{address::{AztecAddress, EthAddress}, traits::FromField},
    test::helpers::test_environment::TestEnvironment,
};
use eclyps_claim_contract::{batch_content_hash, EclypsClaim};
use eclyps_merkle::vectors;
use eclyps_minter_contract::EclypsMinter;
use token::Token;

pub global DENOMINATION: u128 = 100_000_000; // $100
pub global EPOCH: u64 = 7;
pub global LEAVES: u16 = 16;
/// Exit epochs of the default setup: 10 blocks, at least 4 exits (Solana's minimum batch).
pub global EXIT_EPOCH_BLOCKS: u32 = 10;
pub global MIN_EXIT_BATCH: u32 = 4;

pub struct Setup {
    pub env: TestEnvironment,
    pub token: AztecAddress,
    pub minter: AztecAddress,
    pub claim: AztecAddress,
    pub portal: EthAddress,
    pub admin: AztecAddress,
    pub denomination: u128,
    pub claimer: AztecAddress,
    pub recipient: AztecAddress,
}

pub unconstrained fn setup() -> Setup {
    setup_with(DENOMINATION, EXIT_EPOCH_BLOCKS, MIN_EXIT_BATCH)
}

pub unconstrained fn setup_with(
    denomination: u128,
    exit_epoch_blocks: u32,
    min_exit_batch: u32,
) -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    // Contract accounts: exits authorize the claim contract to burn with an authwit, which
    // light accounts cannot verify.
    let claimer = env.create_contract_account();
    let recipient = env.create_contract_account();
    let portal = EthAddress::from_field(0xec1795);

    // ADR 0020: the minter first, then the token naming it, then the claim naming both.
    let minter = env.deploy("@eclyps_minter_contract/EclypsMinter").with_public_initializer(
        admin,
        EclypsMinter::interface().constructor(admin),
    );
    let token = env.deploy("@token_contract/Token").with_public_initializer(
        admin,
        Token::interface().constructor_with_minter(
            "Eclyps test USDC000000000000000",
            "eUSDC00000000000000000000000000",
            6,
            minter,
            AztecAddress::zero(),
        ),
    );
    let claim = env.deploy("@eclyps_claim_contract/EclypsClaim").with_public_initializer(
        admin,
        EclypsClaim::interface().constructor(
            token,
            minter,
            portal,
            denomination,
            exit_epoch_blocks,
            min_exit_batch,
        ),
    );
    // The admin is listed too: it mints the exit tests' money (`exit::fund`), as claims would.
    let zero = AztecAddress::zero();
    env.call_public(
        admin,
        EclypsMinter::at(minter).wire(
            token,
            [claim, admin, zero, zero],
            [denomination, denomination, 0, 0],
        ),
    );
    Setup { env, token, minter, claim, portal, admin, denomination, claimer, recipient }
}

/// What the Ethereum portal does after receiving the CCTP batch: one L1->L2 message.
unconstrained fn portal_sends(s: Setup, root: Field, epoch: u64, leaves: u16) -> Field {
    let total = DENOMINATION * (leaves as u128);
    let content = batch_content_hash(root, total, epoch, DENOMINATION);
    s.env.send_l1_to_l2_message(content, 0, s.portal, s.claim)
}

pub unconstrained fn registered() -> Setup {
    let s = setup();
    let idx = portal_sends(s, vectors::ROOT_BATCH_16, EPOCH, LEAVES);
    s.env.call_public(
        s.claimer,
        EclypsClaim::at(s.claim).register_batch(vectors::ROOT_BATCH_16, EPOCH, LEAVES, idx),
    );
    s
}

unconstrained fn claim_note(s: Setup, p: u32, secret: Field) {
    let i = vectors::PATH_INDICES[p];
    s.env.call_private(
        s.claimer,
        EclypsClaim::at(s.claim).claim(
            vectors::ROOT_BATCH_16,
            vectors::NOTE_KEYS[i],
            secret,
            i as Field,
            vectors::PATH_SIBLINGS[p],
            s.recipient,
        ),
    );
}

pub unconstrained fn private_balance(s: Setup, who: AztecAddress) -> u128 {
    s.env.execute_utility(Token::at(s.token).balance_of_private(who))
}

#[test]
unconstrained fn register_then_claim_mints_private_note() {
    let s = registered();
    assert(s.env.view_public(EclypsClaim::at(s.claim).is_registered(vectors::ROOT_BATCH_16)));

    let i = vectors::PATH_INDICES[1];
    claim_note(s, 1, vectors::NOTE_SECRETS[i]);
    assert_eq(private_balance(s, s.recipient), DENOMINATION);
    assert_eq(private_balance(s, s.claimer), 0);
    // Nothing became public: the claim contract holds no public balance and minted privately.
    assert_eq(s.env.view_public(Token::at(s.token).balance_of_public(s.recipient)), 0);
    assert_eq(s.env.view_public(Token::at(s.token).total_supply()), DENOMINATION);
}

#[test]
unconstrained fn distinct_notes_each_claim_once() {
    let s = registered();
    for p in 0..3 {
        let i = vectors::PATH_INDICES[p];
        claim_note(s, p, vectors::NOTE_SECRETS[i]);
    }
    assert_eq(private_balance(s, s.recipient), 3 * DENOMINATION);
}

#[test(should_fail_with = "Nullifier collision")]
unconstrained fn second_claim_of_same_note_fails() {
    let s = registered();
    let i = vectors::PATH_INDICES[0];
    claim_note(s, 0, vectors::NOTE_SECRETS[i]);
    claim_note(s, 0, vectors::NOTE_SECRETS[i]);
}

#[test(should_fail_with = "not a member of root")]
unconstrained fn wrong_secret_fails() {
    let s = registered();
    let i = vectors::PATH_INDICES[0];
    claim_note(s, 0, vectors::NOTE_SECRETS[i] + 1);
}

#[test(should_fail_with = "uninitialized PublicImmutable")]
unconstrained fn claim_against_unregistered_root_fails() {
    let s = setup();
    let i = vectors::PATH_INDICES[0];
    claim_note(s, 0, vectors::NOTE_SECRETS[i]);
}

#[test(should_fail_with = "Tried to consume nonexistent L1-to-L2 message")]
unconstrained fn register_without_matching_portal_message_fails() {
    let s = setup();
    // Portal committed to 16 leaves; registering 17 changes the content hash.
    let idx = portal_sends(s, vectors::ROOT_BATCH_16, EPOCH, LEAVES);
    s.env.call_public(
        s.claimer,
        EclypsClaim::at(s.claim).register_batch(vectors::ROOT_BATCH_16, EPOCH, LEAVES + 1, idx),
    );
}

#[test(should_fail_with = "Tried to consume nonexistent L1-to-L2 message")]
unconstrained fn message_from_other_l1_sender_is_rejected() {
    let s = setup();
    let total = DENOMINATION * (LEAVES as u128);
    let content = batch_content_hash(vectors::ROOT_BATCH_16, total, EPOCH, DENOMINATION);
    let idx = s.env.send_l1_to_l2_message(content, 0, EthAddress::from_field(0xbad), s.claim);
    s.env.call_public(
        s.claimer,
        EclypsClaim::at(s.claim).register_batch(vectors::ROOT_BATCH_16, EPOCH, LEAVES, idx),
    );
}

#[test(should_fail_with = "L1-to-L2 message is already nullified")]
unconstrained fn same_message_cannot_register_twice() {
    let s = setup();
    // Reuse the index the Inbox returned: the first message's leaf index is 0 on 6.x but not on
    // 5.2 (different L1->L2 leaf-index semantics), so never hard-code it.
    let idx = portal_sends(s, vectors::ROOT_BATCH_16, EPOCH, LEAVES);
    let register =
        EclypsClaim::at(s.claim).register_batch(vectors::ROOT_BATCH_16, EPOCH, LEAVES, idx);
    s.env.call_public(s.claimer, register);
    s.env.call_public(s.claimer, register);
}

/// Same vector as contracts/portal/test/EclypsPortal.t.sol (Solidity `batchContent`).
#[test]
unconstrained fn content_hash_matches_solidity_vector() {
    let total = DENOMINATION * (LEAVES as u128);
    assert_eq(
        batch_content_hash(vectors::ROOT_BATCH_16, total, EPOCH, DENOMINATION),
        0x00eff7e0b0702dd21fdef9972fb9871e273d657bbd90796281fabce77f6477c8,
    );
}

/// The portal hard-codes computeSecretHash([0]) as computed by aztec.js
/// (scripts/s2-aztec/secret-hash.ts). A message sent with that hash must be consumable here
/// with secret [0], otherwise every batch would be stuck.
#[test]
unconstrained fn portal_secret_hash_constant_is_consumable() {
    let s = setup();
    let total = DENOMINATION * (LEAVES as u128);
    let content = batch_content_hash(vectors::ROOT_BATCH_16, total, EPOCH, DENOMINATION);
    let idx = s.env.send_l1_to_l2_message_from_secret_hash(
        content,
        0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250,
        s.portal,
        s.claim,
    );
    s.env.call_public(
        s.claimer,
        EclypsClaim::at(s.claim).register_batch(vectors::ROOT_BATCH_16, EPOCH, LEAVES, idx),
    );
    assert(s.env.view_public(EclypsClaim::at(s.claim).is_registered(vectors::ROOT_BATCH_16)));
}
