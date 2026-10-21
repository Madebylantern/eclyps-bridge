//! Batch Merkle tree shared by the Solana gateway program and off-chain tooling.
//!
//! Hash: Poseidon over the BN254 scalar field with circom parameters (x^5 S-box,
//! 8 full rounds, width = inputs + 1). Field elements are 32-byte big-endian and
//! must be canonical (strictly below the field modulus). See ADR 0004.
//!
//! Tree: fixed depth, leaves filled left to right, empty positions hold the zero
//! leaf `[0; 32]`, internal node = `H(left, right)`. The same definition is
//! implemented in TypeScript (`sdk/src/merkle.ts`) and Noir (`circuits/merkle-nr`)
//! and checked against `circuits/vectors/merkle.json`.

use solana_poseidon::{hashv, Endianness, Parameters};

pub type Hash = [u8; 32];

/// Depth of a per-batch tree: at most 2^8 = 256 deposits per (epoch, denomination).
pub const BATCH_TREE_DEPTH: usize = 8;

/// Maximum number of leaves in a batch tree.
pub const MAX_BATCH_LEAVES: usize = 1 << BATCH_TREE_DEPTH;

/// The zero leaf used for empty positions.
pub const ZERO_LEAF: Hash = [0u8; 32];

/// BN254 scalar field modulus r, big-endian.
/// r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
pub const BN254_MODULUS_BE: Hash = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MerkleError {
    /// An input is not a canonical field element (>= modulus).
    NonCanonical,
    /// More leaves than the tree can hold.
    TooManyLeaves,
    /// Leaf index outside the tree.
    IndexOutOfRange,
    /// The Poseidon implementation (or syscall) returned an error.
    Hash,
}

/// True if `x` is strictly below the BN254 modulus (big-endian comparison).
pub fn is_canonical(x: &Hash) -> bool {
    x < &BN254_MODULUS_BE
}

/// Poseidon(a, b).
pub fn hash_pair(a: &Hash, b: &Hash) -> Result<Hash, MerkleError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b])
        .map(|h| h.to_bytes())
        .map_err(|_| MerkleError::Hash)
}

/// Note commitment stored as a leaf: `Poseidon(nullifier_key, secret)`.
/// Computed by clients; the gateway program only stores the result.
pub fn commitment(nullifier_key: &Hash, secret: &Hash) -> Result<Hash, MerkleError> {
    if !is_canonical(nullifier_key) || !is_canonical(secret) {
        return Err(MerkleError::NonCanonical);
    }
    hash_pair(nullifier_key, secret)
}

/// The two 128-bit halves of a 32-byte Solana address, each as a big-endian field element
/// (16 zero bytes, then 16 address bytes). A 32-byte address does not fit one BN254 element.
pub fn address_halves(address: &[u8; 32]) -> (Hash, Hash) {
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&address[..16]);
    lo[16..].copy_from_slice(&address[16..]);
    (hi, lo)
}

/// Exit destination commitment (ADR 0009): `Poseidon(dest_hi, dest_lo, secret)`, circom
/// parameters, 3 inputs. It is a leaf of an exit tree, which uses the batch tree's node hash and
/// depth. Same definition as `exitCommitment` in `sdk/src/exit.ts`.
pub fn exit_commitment(destination: &[u8; 32], secret: &Hash) -> Result<Hash, MerkleError> {
    if !is_canonical(secret) {
        return Err(MerkleError::NonCanonical);
    }
    let (hi, lo) = address_halves(destination);
    hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&hi, &lo, secret],
    )
    .map(|h| h.to_bytes())
    .map_err(|_| MerkleError::Hash)
}

/// Roots of all-empty subtrees: `zeros[0] = ZERO_LEAF`, `zeros[i+1] = H(zeros[i], zeros[i])`.
pub fn zero_hashes(depth: usize) -> Result<Vec<Hash>, MerkleError> {
    let mut zeros = Vec::with_capacity(depth + 1);
    zeros.push(ZERO_LEAF);
    for i in 0..depth {
        let z = hash_pair(&zeros[i], &zeros[i])?;
        zeros.push(z);
    }
    Ok(zeros)
}

/// Computes the root of a depth-`depth` tree whose first `buf.len()` leaves are
/// `buf` and whose remaining leaves are zero. Overwrites `buf` (no allocation),
/// which is what the on-chain program wants. Hash count: (n - 1) + (padding per level) + depth.
pub fn root_in_place(buf: &mut [Hash], depth: usize) -> Result<Hash, MerkleError> {
    if depth >= usize::BITS as usize || buf.len() > (1usize << depth) {
        return Err(MerkleError::TooManyLeaves);
    }
    if buf.iter().any(|l| !is_canonical(l)) {
        return Err(MerkleError::NonCanonical);
    }
    let mut zero = ZERO_LEAF;
    let mut n = buf.len();
    for _ in 0..depth {
        let parents = n.div_ceil(2);
        for i in 0..parents {
            let left = buf[2 * i];
            let right = if 2 * i + 1 < n { buf[2 * i + 1] } else { zero };
            buf[i] = hash_pair(&left, &right)?;
        }
        n = parents;
        zero = hash_pair(&zero, &zero)?;
    }
    Ok(if n == 0 { zero } else { buf[0] })
}

/// Same root as [`root_in_place`] without copying the leaves: one pending node per level
/// (O(depth) memory). The gateway uses it on-chain, where a full batch's leaves and depositors
/// already fill most of the 32 KiB SBF heap (ADR 0010).
pub fn root_streaming(leaves: &[Hash], depth: usize) -> Result<Hash, MerkleError> {
    if depth >= usize::BITS as usize || leaves.len() > (1usize << depth) {
        return Err(MerkleError::TooManyLeaves);
    }
    if leaves.iter().any(|l| !is_canonical(l)) {
        return Err(MerkleError::NonCanonical);
    }
    // frontier[l]: a complete subtree of height l still waiting for its right sibling.
    let mut frontier: Vec<Option<Hash>> = vec![None; depth + 1];
    for leaf in leaves {
        let mut node = *leaf;
        let mut level = 0;
        while let Some(left) = frontier[level].take() {
            node = hash_pair(&left, &node)?;
            level += 1;
        }
        frontier[level] = Some(node);
    }
    // Close the right edge with empty subtrees, bottom up. `carry` is the partial subtree on the
    // right; with no frontier node beside it at this level it is a left child.
    let mut zero = ZERO_LEAF;
    let mut carry: Option<Hash> = None;
    for pending in frontier.iter_mut().take(depth) {
        carry = match (pending.take(), carry) {
            (Some(left), Some(right)) => Some(hash_pair(&left, &right)?),
            (Some(left), None) => Some(hash_pair(&left, &zero)?),
            (None, Some(left)) => Some(hash_pair(&left, &zero)?),
            (None, None) => None,
        };
        zero = hash_pair(&zero, &zero)?;
    }
    Ok(frontier[depth].or(carry).unwrap_or(zero))
}

/// Convenience wrapper around [`root_in_place`].
pub fn root(leaves: &[Hash], depth: usize) -> Result<Hash, MerkleError> {
    let mut buf = leaves.to_vec();
    root_in_place(&mut buf, depth)
}

/// Sibling path for `index`, bottom-up. Bit `i` of `index` is 1 when the node at
/// level `i` is a right child. Off-chain helper (clients build paths locally).
pub fn path(leaves: &[Hash], index: usize, depth: usize) -> Result<Vec<Hash>, MerkleError> {
    if depth >= usize::BITS as usize || leaves.len() > (1usize << depth) {
        return Err(MerkleError::TooManyLeaves);
    }
    if index >= (1usize << depth) {
        return Err(MerkleError::IndexOutOfRange);
    }
    let zeros = zero_hashes(depth)?;
    let mut level = leaves.to_vec();
    let mut idx = index;
    let mut siblings = Vec::with_capacity(depth);
    for z in zeros.iter().take(depth) {
        let sib = idx ^ 1;
        siblings.push(level.get(sib).copied().unwrap_or(*z));
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let right = pair.get(1).copied().unwrap_or(*z);
            next.push(hash_pair(&pair[0], &right)?);
        }
        level = next;
        idx >>= 1;
    }
    Ok(siblings)
}

/// Recomputes the root from a leaf, its index and its sibling path.
pub fn root_from_path(leaf: &Hash, index: usize, siblings: &[Hash]) -> Result<Hash, MerkleError> {
    if siblings.len() < usize::BITS as usize && index >= (1usize << siblings.len()) {
        return Err(MerkleError::IndexOutOfRange);
    }
    let mut node = *leaf;
    for (i, sib) in siblings.iter().enumerate() {
        node = if (index >> i) & 1 == 0 {
            hash_pair(&node, sib)?
        } else {
            hash_pair(sib, &node)?
        };
    }
    Ok(node)
}

/// Encodes a small integer as a 32-byte big-endian field element.
pub fn field_from_u64(x: u64) -> Hash {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(h: &Hash) -> String {
        h.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn circomlib_reference_vector() {
        // circomlib poseidon([1, 2]); also the light-poseidon / circomlibjs reference.
        let h = hash_pair(&field_from_u64(1), &field_from_u64(2)).unwrap();
        assert_eq!(
            hex(&h),
            "115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a"
        );
    }

    #[test]
    fn exit_commitment_is_three_input_poseidon_of_the_address_halves() {
        // circomlib poseidon([1, 2, 3]).
        let mut address = [0u8; 32];
        address[15] = 1;
        address[31] = 2;
        let h = exit_commitment(&address, &field_from_u64(3)).unwrap();
        assert_eq!(
            hex(&h),
            "0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732"
        );
        let (hi, lo) = address_halves(&[0xab; 32]);
        assert_eq!(&hi[..16], &[0u8; 16]);
        assert_eq!(&hi[16..], &[0xab; 16]);
        assert_eq!(hi, lo);
        assert_eq!(
            exit_commitment(&address, &BN254_MODULUS_BE),
            Err(MerkleError::NonCanonical)
        );
    }

    #[test]
    fn modulus_is_not_canonical() {
        assert!(!is_canonical(&BN254_MODULUS_BE));
        let mut below = BN254_MODULUS_BE;
        below[31] = 0;
        assert!(is_canonical(&below));
        assert_eq!(root(&[BN254_MODULUS_BE], 2), Err(MerkleError::NonCanonical));
    }

    #[test]
    fn empty_tree_root_is_zero_hash() {
        let zeros = zero_hashes(BATCH_TREE_DEPTH).unwrap();
        assert_eq!(
            root(&[], BATCH_TREE_DEPTH).unwrap(),
            zeros[BATCH_TREE_DEPTH]
        );
    }

    #[test]
    fn too_many_leaves() {
        let leaves = vec![field_from_u64(1); 5];
        assert_eq!(root(&leaves, 2), Err(MerkleError::TooManyLeaves));
    }

    #[test]
    fn paths_verify_for_every_index() {
        let leaves: Vec<Hash> = (0..11u64).map(|i| field_from_u64(i + 7)).collect();
        let r = root(&leaves, 5).unwrap();
        for (i, leaf) in leaves.iter().enumerate() {
            let p = path(&leaves, i, 5).unwrap();
            assert_eq!(root_from_path(leaf, i, &p).unwrap(), r, "index {i}");
        }
        // An empty position proves the zero leaf.
        let p = path(&leaves, 20, 5).unwrap();
        assert_eq!(root_from_path(&ZERO_LEAF, 20, &p).unwrap(), r);
    }

    #[test]
    fn streaming_root_matches_in_place_for_every_size() {
        let leaves: Vec<Hash> = (0..256u64).map(|i| field_from_u64(i * 7 + 1)).collect();
        for n in 0..=16 {
            assert_eq!(
                root_streaming(&leaves[..n], 4).unwrap(),
                root(&leaves[..n], 4).unwrap(),
                "depth 4, {n} leaves"
            );
        }
        for n in [0, 1, 2, 3, 5, 31, 32, 33, 100, 255, 256] {
            assert_eq!(
                root_streaming(&leaves[..n], BATCH_TREE_DEPTH).unwrap(),
                root(&leaves[..n], BATCH_TREE_DEPTH).unwrap(),
                "depth 8, {n} leaves"
            );
        }
        assert_eq!(
            root_streaming(&leaves[..17], 4),
            Err(MerkleError::TooManyLeaves)
        );
        assert_eq!(
            root_streaming(&[BN254_MODULUS_BE], 4),
            Err(MerkleError::NonCanonical)
        );
    }

    #[test]
    fn padding_matches_explicit_zero_leaves() {
        let leaves: Vec<Hash> = (0..3u64).map(field_from_u64).collect();
        let mut padded = leaves.clone();
        padded.resize(8, ZERO_LEAF);
        assert_eq!(root(&leaves, 3).unwrap(), root(&padded, 3).unwrap());
    }
}
