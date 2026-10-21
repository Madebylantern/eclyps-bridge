use aztec::macros::aztec;

/// Notice a newly listed claim contract waits before it may mint: 7 days, in seconds.
pub global LISTING_DELAY: u64 = 604_800;
/// Claim contracts `wire` can list (one per denomination; unused entries are zero).
pub global MAX_FIRST_CLAIMS: u32 = 4;

/// The only minter of the Eclyps token (ADR 0020). The token (AIP-20) names this contract as its
/// minter when it is created and can never change it, and it has no admin.
///
/// - `mint_to_private` (private) is called by a claim contract. It mints through the token, and an
///   enqueued public check requires that the caller is a listed claim contract, that the amount is
///   that claim's denomination and that its notice has passed. What becomes public is the claim
///   contract and the amount; the amount alone already says which claim contract it was.
/// - `wire` (public, admin, once) gives this contract the token's address and lists the first
///   claim contracts, which may mint at once. The token is created after this contract, and the
///   claims after the token, so none of these addresses can be given at creation.
/// - `list` (public, admin) lists one more claim contract, which may mint `LISTING_DELAY` after.
/// - A listed claim contract is never removed and never changed: removing one would trap notes
///   registered but not yet claimed (SPEC §4).
/// - `renounce` (public, admin) gives up `list` for good: the list is then fixed.
#[aztec]
pub contract EclypsMinter {
    use crate::{LISTING_DELAY, MAX_FIRST_CLAIMS};
    use aztec::{
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use std::meta::derive;
    use token::Token;

    /// A listed claim contract. `denomination` zero: not listed.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Listing {
        /// USDC base units (6 decimals): the one amount this claim contract may mint each time.
        pub denomination: u128,
        /// Block timestamp from which it may mint.
        pub active_from: u64,
    }

    #[storage]
    struct Storage<Context> {
        /// May wire once, list and renounce. Zero once renounced.
        admin: PublicMutable<AztecAddress, Context>,
        token: PublicImmutable<AztecAddress, Context>,
        listings: Map<AztecAddress, PublicMutable<Listing, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        assert(!admin.is_zero(), "invalid admin");
        self.storage.admin.write(admin);
    }

    /// Once (the token can be set only once): the token, and the first claim contracts with their
    /// denominations, minting at once. Unused entries are zero.
    #[external("public")]
    fn wire(
        token: AztecAddress,
        claims: [AztecAddress; MAX_FIRST_CLAIMS],
        denominations: [u128; MAX_FIRST_CLAIMS],
    ) {
        self.internal._only_admin();
        assert(!token.is_zero(), "invalid token");
        self.storage.token.initialize(token);
        let now = self.context.timestamp();
        let mut any = false;
        for i in 0..MAX_FIRST_CLAIMS {
            if !claims[i].is_zero() {
                self.internal._list(claims[i], denominations[i], now);
                any = true;
            } else {
                assert(denominations[i] == 0, "denomination without a claim");
            }
        }
        assert(any, "no claim contract");
    }

    /// One more claim contract. It may mint `LISTING_DELAY` seconds from now, so everyone sees it
    /// coming.
    #[external("public")]
    fn list(claim: AztecAddress, denomination: u128) {
        self.internal._only_admin();
        assert(!self.storage.token.read().is_zero(), "not wired");
        self.internal._list(claim, denomination, self.context.timestamp() + LISTING_DELAY);
    }

    /// Gives up `list` for good.
    #[external("public")]
    fn renounce() {
        self.internal._only_admin();
        self.storage.admin.write(AztecAddress::zero());
    }

    /// Called by a listed claim contract: mints `amount` to `to` as a private note.
    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        self.enqueue_self._check_minter(self.msg_sender(), amount);
        let token = self.storage.token.read();
        self.call(Token::at(token).mint_to_private(to, amount));
    }

    #[external("public")]
    #[only_self]
    fn _check_minter(claim: AztecAddress, amount: u128) {
        let listing = self.storage.listings.at(claim).read();
        assert(
            (listing.denomination != 0) & (listing.denomination == amount),
            "not a listed claim",
        );
        assert(self.context.timestamp() >= listing.active_from, "listing not active yet");
    }

    #[internal("public")]
    fn _only_admin() {
        let admin = self.storage.admin.read();
        assert(!admin.is_zero() & admin.eq(self.msg_sender()), "caller is not admin");
    }

    #[internal("public")]
    fn _list(claim: AztecAddress, denomination: u128, active_from: u64) {
        assert(!claim.is_zero(), "invalid claim");
        assert(denomination > 0, "invalid denomination");
        let listing = self.storage.listings.at(claim);
        assert(listing.read().denomination == 0, "already listed");
        listing.write(Listing { denomination, active_from });
    }

    #[external("public")]
    #[view]
    fn get_admin() -> AztecAddress {
        self.storage.admin.read()
    }

    #[external("public")]
    #[view]
    fn get_token() -> AztecAddress {
        self.storage.token.read()
    }

    #[external("public")]
    #[view]
    fn get_listing(claim: AztecAddress) -> Listing {
        self.storage.listings.at(claim).read()
    }
}
