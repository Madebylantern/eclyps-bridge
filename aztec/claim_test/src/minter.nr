//! The token's only minter (ADR 0020): who may mint, how much, and when. Minting through a claim
//! is tested with the claims themselves (`lib.nr`); exits mint their money through the admin,
//! which the setup lists like a claim contract.

use crate::{DENOMINATION, private_balance, setup, Setup};
use aztec::protocol::address::AztecAddress;
use eclyps_minter_contract::{EclypsMinter, LISTING_DELAY};
use token::Token;

unconstrained fn mint(s: Setup, from: AztecAddress, amount: u128) {
    s.env.call_private(from, EclypsMinter::at(s.minter).mint_to_private(s.recipient, amount));
}

#[test]
unconstrained fn a_listed_contract_mints_its_denomination() {
    let s = setup();
    mint(s, s.admin, DENOMINATION);
    assert_eq(private_balance(s, s.recipient), DENOMINATION);
    assert_eq(s.env.view_public(Token::at(s.token).total_supply()), DENOMINATION);
}

#[test(should_fail_with = "not a listed claim")]
unconstrained fn nobody_else_mints() {
    let s = setup();
    mint(s, s.claimer, DENOMINATION);
}

#[test(should_fail_with = "not a listed claim")]
unconstrained fn only_the_denomination() {
    let s = setup();
    mint(s, s.admin, DENOMINATION * 2);
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn the_token_takes_mints_only_from_the_minter() {
    let s = setup();
    s.env.call_private(s.admin, Token::at(s.token).mint_to_private(s.recipient, DENOMINATION));
}

#[test]
unconstrained fn the_wiring_is_readable() {
    let s = setup();
    let minter = EclypsMinter::at(s.minter);
    assert_eq(s.env.view_public(minter.get_token()), s.token);
    assert_eq(s.env.view_public(minter.get_admin()), s.admin);
    assert_eq(s.env.view_public(minter.get_listing(s.claim)).denomination, DENOMINATION);
    assert_eq(s.env.view_public(minter.get_listing(s.claimer)).denomination, 0);
}

#[test(should_fail)]
unconstrained fn wiring_happens_once() {
    let s = setup();
    let zero = AztecAddress::zero();
    s.env.call_public(
        s.admin,
        EclypsMinter::at(s.minter).wire(s.token, [s.claimer, zero, zero, zero], [1, 0, 0, 0]),
    );
}

#[test(should_fail_with = "caller is not admin")]
unconstrained fn only_the_admin_lists() {
    let s = setup();
    s.env.call_public(s.claimer, EclypsMinter::at(s.minter).list(s.claimer, DENOMINATION));
}

#[test(should_fail_with = "already listed")]
unconstrained fn a_listing_never_changes() {
    let s = setup();
    s.env.call_public(s.admin, EclypsMinter::at(s.minter).list(s.claim, DENOMINATION * 10));
}

#[test(should_fail_with = "listing not active yet")]
unconstrained fn a_new_contract_waits_for_its_notice() {
    let mut s = setup();
    let newcomer = s.env.create_light_account();
    s.env.call_public(s.admin, EclypsMinter::at(s.minter).list(newcomer, DENOMINATION));
    s.env.advance_next_block_timestamp_by(LISTING_DELAY - 60);
    mint(s, newcomer, DENOMINATION);
}

#[test]
unconstrained fn a_new_contract_mints_once_its_notice_has_passed() {
    let mut s = setup();
    let newcomer = s.env.create_light_account();
    s.env.call_public(s.admin, EclypsMinter::at(s.minter).list(newcomer, DENOMINATION));
    s.env.advance_next_block_timestamp_by(LISTING_DELAY);
    mint(s, newcomer, DENOMINATION);
    assert_eq(private_balance(s, s.recipient), DENOMINATION);
}

#[test(should_fail_with = "caller is not admin")]
unconstrained fn after_renouncing_the_list_is_fixed() {
    let s = setup();
    s.env.call_public(s.admin, EclypsMinter::at(s.minter).renounce());
    assert_eq(s.env.view_public(EclypsMinter::at(s.minter).get_admin()), AztecAddress::zero());
    s.env.call_public(s.admin, EclypsMinter::at(s.minter).list(s.claimer, DENOMINATION));
}

#[test]
unconstrained fn renouncing_leaves_minting_as_it_was() {
    let s = setup();
    s.env.call_public(s.admin, EclypsMinter::at(s.minter).renounce());
    mint(s, s.admin, DENOMINATION);
    assert_eq(private_balance(s, s.recipient), DENOMINATION);
}
