//! Batch Merkle tree, identical to circuits/merkle-rs (Rust / Solana syscall)
//! and sdk/src/merkle.ts. Poseidon over BN254 with circom parameters (the
//! original Poseidon, not Poseidon2), via noir-lang/poseidon. See ADR 0004.

pub mod vectors;

use poseidon::poseidon::bn254::hash_2;

/// Per-batch tree depth (256 leaves). Must match BATCH_TREE_DEPTH in Rust and TS.
pub global BATCH_TREE_DEPTH: u32 = 8;

/// ZERO_HASHES[h] is the root of an empty subtree of height h: ZERO_HASHES[0] = 0 (the empty leaf),
/// ZERO_HASHES[h + 1] = H(ZERO_HASHES[h], ZERO_HASHES[h]). Checked against the vectors below.
pub global ZERO_HASHES: [Field; 9] = [
    0x0000000000000000000000000000000000000000000000000000000000000000,
    0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864,
    0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1,
    0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238,
    0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a,
    0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55,
    0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78,
    0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d,
    0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61,
];

pub fn hash_pair(a: Field, b: Field) -> Field {
    hash_2([a, b])
}

/// Leaf stored by the gateway: commitment = H(nullifier_key, secret).
pub fn commitment(nullifier_key: Field, secret: Field) -> Field {
    hash_pair(nullifier_key, secret)
}

/// Recomputes a root from a leaf, its index and its bottom-up sibling path.
/// `index.to_le_bits()` constrains index < 2^N.
pub fn root_from_path<let N: u32>(leaf: Field, index: Field, siblings: [Field; N]) -> Field {
    let bits: [bool; N] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..N {
        node = if !bits[i] {
            hash_pair(node, siblings[i])
        } else {
            hash_pair(siblings[i], node)
        };
    }
    node
}

/// Root of a full subtree over `leaves` (N must be a power of two), then
/// extended with empty siblings up to `DEPTH` levels. Test/tooling helper.
pub fn root<let N: u32, let DEPTH: u32>(leaves: [Field; N]) -> Field {
    let mut level = leaves;
    let mut n = N;
    let mut zero = 0;
    let mut height = 0;
    for _ in 0..DEPTH {
        if n > 1 {
            for i in 0..N / 2 {
                if i < n / 2 {
                    level[i] = hash_pair(level[2 * i], level[2 * i + 1]);
                }
            }
            n = n / 2;
        } else {
            level[0] = hash_pair(level[0], zero);
        }
        zero = hash_pair(zero, zero);
        height += 1;
    }
    assert(n == 1, "too many leaves for DEPTH");
    assert(height == DEPTH);
    level[0]
}

#[test]
fn pair_vectors() {
    for i in 0..vectors::PAIRS_A.len() {
        assert_eq(hash_pair(vectors::PAIRS_A[i], vectors::PAIRS_B[i]), vectors::PAIRS_OUT[i]);
    }
}

#[test]
fn commitments_and_roots() {
    let mut leaves = [0; 16];
    for i in 0..16 {
        leaves[i] = commitment(vectors::NOTE_KEYS[i], vectors::NOTE_SECRETS[i]);
        assert_eq(leaves[i], vectors::NOTE_COMMITMENTS[i]);
    }
    assert_eq(root::<16, 4>(leaves), vectors::ROOT_DEPTH4_16);
    assert_eq(root::<16, BATCH_TREE_DEPTH>(leaves), vectors::ROOT_BATCH_16);

    // First 11 leaves, zero-padded.
    let mut first11 = [0; 16];
    for i in 0..11 {
        first11[i] = leaves[i];
    }
    assert_eq(root::<16, BATCH_TREE_DEPTH>(first11), vectors::ROOT_BATCH_FIRST_11);
}

#[test]
fn zero_hashes() {
    let mut z = 0;
    for i in 0..BATCH_TREE_DEPTH + 1 {
        assert_eq(z, vectors::ZERO_HASHES[i]);
        assert_eq(z, ZERO_HASHES[i]);
        z = hash_pair(z, z);
    }
}

#[test]
fn paths() {
    for p in 0..vectors::PATH_INDICES.len() {
        let index = vectors::PATH_INDICES[p];
        let leaf = vectors::NOTE_COMMITMENTS[index];
        assert_eq(
            root_from_path(leaf, index as Field, vectors::PATH_SIBLINGS[p]),
            vectors::ROOT_BATCH_16,
        );
    }
}

#[test(should_fail)]
fn wrong_leaf_fails() {
    let leaf = vectors::NOTE_COMMITMENTS[0] + 1;
    assert_eq(root_from_path(leaf, 0, vectors::PATH_SIBLINGS[0]), vectors::ROOT_BATCH_16);
}

#[test(should_fail)]
fn index_out_of_range_fails() {
    // 256 does not fit in 8 bits.
    let _ = root_from_path(vectors::NOTE_COMMITMENTS[0], 256, vectors::PATH_SIBLINGS[0]);
}
