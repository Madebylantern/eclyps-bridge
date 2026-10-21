use aztec::{macros::aztec, protocol::{address::EthAddress, hash::sha256_to_field, traits::ToField}};

/// Solidity's `sha256ToField(abi.encode(w0, w1, ...))`: each word is 32 bytes, big-endian.
pub fn sha256_to_field_of_words<let N: u32>(words: [Field; N]) -> Field {
    let mut bytes = [0 as u8; 32 * N];
    for w in 0..N {
        let b: [u8; 32] = words[w].to_be_bytes();
        for i in 0..32 {
            bytes[32 * w + i] = b[i];
        }
    }
    sha256_to_field(bytes)
}

/// L1->L2 content for a batch. Must equal the portal's
/// `sha256ToField(abi.encode(root, total, epochId, denomination))`.
pub fn batch_content_hash(root: Field, total: u128, epoch_id: u64, denomination: u128) -> Field {
    sha256_to_field_of_words(
        [root, total as Field, epoch_id as Field, denomination as Field],
    )
}

/// L2->L1 content of a closed exit epoch (ADR 0009). Must equal the portal's
/// `exitContent(root, count, exitEpochId, denomination)`; checked against circuits/vectors/exit.json.
pub fn exit_content(root: Field, count: u32, exit_epoch_id: u64, denomination: u128) -> Field {
    sha256_to_field_of_words(
        [root, count as Field, exit_epoch_id as Field, denomination as Field],
    )
}

/// First word of an Ethereum exit's content: the ASCII bytes of "eclyps:exit-to-ethereum" as a
/// big-endian integer (the portal's `ETHEREUM_EXIT_TAG`). It keeps this message kind apart from
/// every other content by its first word, not only by its length (ADR 0014 §4).
pub global ETHEREUM_EXIT_TAG: Field = 0x65636c7970733a657869742d746f2d657468657265756d;

/// L2->L1 content of one exit to Ethereum (ADR 0014 §4). Must equal the portal's
/// `ethereumExitContent(commitment, denomination)` =
/// `sha256ToField(abi.encode(ETHEREUM_EXIT_TAG, commitment, denomination))`.
pub fn ethereum_exit_content(commitment: Field, denomination: u128) -> Field {
    sha256_to_field_of_words([ETHEREUM_EXIT_TAG, commitment, denomination as Field])
}

/// What the app computes off-chain: `sha256ToField(abi.encode(recipient, exitSecret))`. A full
/// sha256 does not fit a field, so it is truncated like every Aztec content. Here for tests.
pub fn ethereum_exit_commitment(recipient: EthAddress, exit_secret: Field) -> Field {
    sha256_to_field_of_words([recipient.to_field(), exit_secret])
}

/// Eclyps claim contract. One instance per denomination.
///
/// Enter (ADR 0003):
/// - `register_batch` (public, permissionless) consumes the L1->L2 message the Ethereum portal
///   sends for a batch received over CCTP, and records the batch root.
/// - `claim` (private) proves knowledge of a note `(nullifier_key, secret)` whose commitment
///   `H(nullifier_key, secret)` is a leaf under *some* registered root (which root stays private),
///   emits a nullifier so the note can be claimed once, and mints one denomination as a private
///   note to `recipient` through `EclypsMinter`, the token's only minter (ADR 0020; recipient
///   hidden; amount and this claim contract public).
///
/// Leave to Solana (ADR 0009):
/// - `exit` (private) burns one denomination from the caller and enqueues `_append_exit`, which
///   appends the destination commitment to the open exit epoch's tree. The public call comes from
///   this contract, so the caller is not revealed.
/// - `close_exit_epoch` (public, permissionless) sends the epoch's root to the portal as one L2->L1
///   message, or rolls the epoch over if it holds fewer than `min_exit_batch` exits.
///
/// Leave to Ethereum (ADR 0014 §4):
/// - `exit_to_ethereum` (private) burns one denomination from the caller and sends one L2->L1
///   message to the portal, committing to the recipient.
///
/// Hash and tree: Poseidon BN254 (circom), depth 8, shared with Solana (ADR 0004).
#[aztec]
pub contract EclypsClaim {
    use crate::{batch_content_hash, ethereum_exit_content, exit_content};
    use aztec::{
        macros::{functions::{external, initializer, only_self, view}, storage::storage},
        protocol::{
            address::{AztecAddress, EthAddress},
            hash::poseidon2_hash_with_separator,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use eclyps_merkle::{BATCH_TREE_DEPTH, commitment, hash_pair, root_from_path, ZERO_HASHES};
    use eclyps_minter_contract::EclypsMinter;
    use std::meta::derive;
    use token::Token;

    /// Domain separator for claim nullifiers (`"eclyps:claim"` truncated to u32 space).
    global DOM_SEP__CLAIM_NULLIFIER: u32 = 0xec1c1a17;
    /// The L1->L2 message secret is a public constant: anyone may register a batch; the message
    /// content (root, total, epoch, denomination) is what authenticates it.
    global REGISTER_SECRET: Field = 0;
    /// Exits per exit epoch: a full tree of depth 8.
    global MAX_EXITS: u32 = 256;

    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        pub token: AztecAddress,
        /// Mints for this contract (`EclypsMinter`, ADR 0020); burns go to the token directly.
        pub minter: AztecAddress,
        pub portal: EthAddress,
        /// USDC base units (6 decimals).
        pub denomination: u128,
        /// An exit epoch may close this many blocks after it opened or last rolled over.
        pub exit_epoch_blocks: u32,
        /// Fewer exits than this at close: the epoch rolls over instead of being sent.
        pub min_exit_batch: u32,
    }

    /// The open exit epoch. `count` exits so far; `close_exit_epoch` may run from block `ends_at`
    /// (or as soon as the tree is full).
    #[derive(Deserialize, Eq, Serialize)]
    pub struct ExitEpoch {
        pub id: u64,
        pub count: u32,
        pub ends_at: u32,
    }

    /// One storage slot instead of three: every exit reads and writes it.
    impl Packable for ExitEpoch {
        let N: u32 = 1;

        fn pack(self) -> [Field; 1] {
            [
                (((self.id as u128) << 64) + ((self.count as u128) << 32) + (self.ends_at as u128))
                     as Field,
            ]
        }

        fn unpack(packed: [Field; 1]) -> Self {
            let v = packed[0] as u128;
            ExitEpoch {
                id: (v >> 64) as u64,
                count: ((v >> 32) & 0xffffffff) as u32,
                ends_at: (v & 0xffffffff) as u32,
            }
        }
    }

    /// A closed exit epoch, as sent to the portal. `closed_at` is the block of the L2->L1 message.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClosedExitEpoch {
        pub root: Field,
        pub count: u32,
        pub content: Field,
        pub closed_at: u32,
    }

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
        /// root -> registered. PublicImmutable: private reads cost one historical read and do not
        /// set a tx expiration (ADR 0003).
        known_roots: Map<Field, PublicImmutable<bool, Context>, Context>,
        exit_epoch: PublicMutable<ExitEpoch, Context>,
        /// Append-only tree of the open exit epoch (the Ethereum deposit contract's algorithm):
        /// `exit_branch[h]` is the root of the last complete left subtree of height h; [8] is the
        /// root of a full tree. Entries from earlier epochs are never read.
        exit_branch: Map<Field, PublicMutable<Field, Context>, Context>,
        /// exit_leaves[id][i]: the i-th commitment of exit epoch `id`. Public, so a claimer can
        /// build its path (SDK `exitClaimInputs`).
        exit_leaves: Map<u64, Map<u32, PublicMutable<Field, Context>, Context>, Context>,
        closed_exit_epochs: Map<u64, PublicMutable<ClosedExitEpoch, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        token: AztecAddress,
        minter: AztecAddress,
        portal: EthAddress,
        denomination: u128,
        exit_epoch_blocks: u32,
        min_exit_batch: u32,
    ) {
        // A full exit epoch must fit the u64 amount the portal burns and Solana pays.
        assert(
            (denomination > 0) & (denomination * (MAX_EXITS as u128) <= 0xffffffffffffffff),
            "bad denomination",
        );
        assert(exit_epoch_blocks > 0, "bad exit_epoch_blocks");
        assert((min_exit_batch > 0) & (min_exit_batch <= MAX_EXITS), "bad min_exit_batch");
        self.storage.config.initialize(
            Config { token, minter, portal, denomination, exit_epoch_blocks, min_exit_batch },
        );
        self.storage.exit_epoch.write(
            ExitEpoch {
                id: 0,
                count: 0,
                ends_at: self.context.block_number() + exit_epoch_blocks,
            },
        );
    }

    #[external("public")]
    fn register_batch(root: Field, epoch_id: u64, leaf_count: u16, message_leaf_index: Field) {
        let config = self.storage.config.read();
        assert((leaf_count as u32) > 0, "empty batch");
        assert((leaf_count as u32) <= (1 << BATCH_TREE_DEPTH), "batch too large");
        let total = config.denomination * (leaf_count as u128);
        let content = batch_content_hash(root, total, epoch_id, config.denomination);
        self.context.consume_l1_to_l2_message(
            content,
            [REGISTER_SECRET],
            config.portal,
            message_leaf_index,
        );
        // Fails if the root is already registered (initialization nullifier already exists).
        self.storage.known_roots.at(root).initialize(true);
    }

    #[external("private")]
    fn claim(
        root: Field,
        nullifier_key: Field,
        secret: Field,
        leaf_index: Field,
        path: [Field; BATCH_TREE_DEPTH],
        recipient: AztecAddress,
    ) {
        assert(self.storage.known_roots.at(root).read(), "unknown root");
        let leaf = commitment(nullifier_key, secret);
        assert_eq(root_from_path(leaf, leaf_index, path), root, "not a member of root");

        // One claim per note, independent of which batch it was in.
        self.context.push_nullifier_unsafe(poseidon2_hash_with_separator(
            [nullifier_key],
            DOM_SEP__CLAIM_NULLIFIER,
        ));

        let config = self.storage.config.read();
        self.call(EclypsMinter::at(config.minter).mint_to_private(recipient, config.denomination));
    }

    /// Leave to Solana. Burns one denomination from the caller's private balance (the caller
    /// authorizes this contract with an authwit for `Token.burn_private`) and appends `commitment`
    /// = Poseidon(dest_hi, dest_lo, exitSecret) (SDK `exitCommitment`) to the open exit epoch.
    #[external("private")]
    fn exit(commitment: Field, authwit_nonce: Field) {
        assert(commitment != 0, "zero exit commitment");
        let config = self.storage.config.read();
        self.call(Token::at(config.token).burn_private(
            self.msg_sender(),
            config.denomination,
            authwit_nonce,
        ));
        self.enqueue_self._append_exit(commitment);
    }

    /// Appends one leaf: one hash per trailing zero bit of the new count (on average one), one
    /// branch write, one leaf write, one epoch write. Reverts when the tree is full, which also
    /// undoes the burn: the epoch must be closed first.
    #[external("public")]
    #[only_self]
    fn _append_exit(commitment: Field) {
        let mut epoch = self.storage.exit_epoch.read();
        assert(epoch.count < MAX_EXITS, "exit epoch full");
        self.storage.exit_leaves.at(epoch.id).at(epoch.count).write(commitment);
        epoch.count += 1;

        let mut size = epoch.count;
        let mut node = commitment;
        let mut stored = false;
        for height in 0..BATCH_TREE_DEPTH + 1 {
            if !stored {
                if (size & 1) == 1 {
                    self.storage.exit_branch.at(height as Field).write(node);
                    stored = true;
                } else {
                    node = hash_pair(self.storage.exit_branch.at(height as Field).read(), node);
                    size = size >> 1;
                }
            }
        }
        self.storage.exit_epoch.write(epoch);
    }

    /// Permissionless, from block `ends_at` or as soon as the tree is full. With fewer than
    /// `min_exit_batch` exits the epoch rolls over (same id and exits, a new end). Otherwise it
    /// sends one L2->L1 message to the portal, content = `exit_content(root, count, id,
    /// denomination)`, every value from this contract's state, and the next epoch opens.
    #[external("public")]
    fn close_exit_epoch() {
        let config = self.storage.config.read();
        let epoch = self.storage.exit_epoch.read();
        let now = self.context.block_number();
        assert((epoch.count == MAX_EXITS) | (now >= epoch.ends_at), "exit epoch still open");
        let ends_at = now + config.exit_epoch_blocks;

        if epoch.count < config.min_exit_batch {
            self.storage.exit_epoch.write(ExitEpoch { id: epoch.id, count: epoch.count, ends_at });
        } else {
            let root = if epoch.count == MAX_EXITS {
                self.storage.exit_branch.at(BATCH_TREE_DEPTH as Field).read()
            } else {
                // Leaves past `count` are empty (0), as in the gateway's batch trees.
                let mut node = 0;
                let mut size = epoch.count;
                for height in 0..BATCH_TREE_DEPTH {
                    if (size & 1) == 1 {
                        node = hash_pair(self.storage.exit_branch.at(height as Field).read(), node);
                    } else {
                        node = hash_pair(node, ZERO_HASHES[height]);
                    }
                    size = size >> 1;
                }
                node
            };
            let content = exit_content(root, epoch.count, epoch.id, config.denomination);
            self.context.message_portal(config.portal, content);
            self.storage.closed_exit_epochs.at(epoch.id).write(
                ClosedExitEpoch { root, count: epoch.count, content, closed_at: now },
            );
            self.storage.exit_epoch.write(ExitEpoch { id: epoch.id + 1, count: 0, ends_at });
        }
    }

    /// Leave to Ethereum. Burns one denomination from the caller's private balance (authwit for
    /// `Token.burn_private`) and sends one L2->L1 message to the portal with content
    /// `ethereum_exit_content(commitment, denomination)`, where `commitment` =
    /// sha256ToField(abi.encode(recipient, exitSecret)) is made by the app. The portal pays
    /// `recipient` in `claimToEthereum`. This function enqueues no public call of its own.
    #[external("private")]
    fn exit_to_ethereum(commitment: Field, authwit_nonce: Field) {
        assert(commitment != 0, "zero exit commitment");
        let config = self.storage.config.read();
        self.call(Token::at(config.token).burn_private(
            self.msg_sender(),
            config.denomination,
            authwit_nonce,
        ));
        self.context.message_portal(
            config.portal,
            ethereum_exit_content(commitment, config.denomination),
        );
    }

    #[external("public")]
    #[view]
    fn is_registered(root: Field) -> bool {
        self.storage.known_roots.at(root).read_unsafe()
    }

    #[external("public")]
    #[view]
    fn get_config() -> Config {
        self.storage.config.read()
    }

    #[external("public")]
    #[view]
    fn get_exit_epoch() -> ExitEpoch {
        self.storage.exit_epoch.read()
    }

    /// Zero for an epoch that is not closed yet.
    #[external("public")]
    #[view]
    fn get_closed_exit_epoch(exit_epoch_id: u64) -> ClosedExitEpoch {
        self.storage.closed_exit_epochs.at(exit_epoch_id).read()
    }

    /// The commitments of an exit epoch in order (open or closed), for `exitClaimInputs`.
    #[external("utility")]
    unconstrained fn get_exit_leaves(exit_epoch_id: u64) -> BoundedVec<Field, 256> {
        let open = self.storage.exit_epoch.read();
        let count = if exit_epoch_id == open.id {
            open.count
        } else if exit_epoch_id < open.id {
            self.storage.closed_exit_epochs.at(exit_epoch_id).read().count
        } else {
            0
        };
        let mut leaves = BoundedVec::new();
        for i in 0..MAX_EXITS {
            if i < count {
                leaves.push(self.storage.exit_leaves.at(exit_epoch_id).at(i).read());
            }
        }
        leaves
    }
}
