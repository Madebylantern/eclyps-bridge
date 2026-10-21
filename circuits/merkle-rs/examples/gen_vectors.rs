//! Regenerates `circuits/vectors/merkle.json`:
//! `cargo run -p eclyps-merkle --example gen_vectors > circuits/vectors/merkle.json`
//! Every implementation (Rust host, Rust SBF syscall, TypeScript, Noir) must
//! reproduce these values independently from the same preimages.

use eclyps_merkle::*;
use serde_json::json;

fn hex(h: &Hash) -> String {
    format!(
        "0x{}",
        h.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn main() {
    let pairs: Vec<_> = [(1u64, 2u64), (0, 0), (7, 13)]
        .iter()
        .map(|&(a, b)| {
            let (a, b) = (field_from_u64(a), field_from_u64(b));
            json!({ "a": hex(&a), "b": hex(&b), "out": hex(&hash_pair(&a, &b).unwrap()) })
        })
        .collect();

    // Full-width, deterministic note preimages.
    let notes: Vec<(Hash, Hash, Hash)> = (0..16u64)
        .map(|i| {
            let k = hash_pair(&field_from_u64(1000 + i), &field_from_u64(1)).unwrap();
            let s = hash_pair(&field_from_u64(2000 + i), &field_from_u64(2)).unwrap();
            (k, s, commitment(&k, &s).unwrap())
        })
        .collect();
    let leaves: Vec<Hash> = notes.iter().map(|n| n.2).collect();

    let paths: Vec<_> = [0usize, 5, 15]
        .iter()
        .map(|&i| {
            let p = path(&leaves, i, BATCH_TREE_DEPTH).unwrap();
            json!({ "index": i, "siblings": p.iter().map(hex).collect::<Vec<_>>() })
        })
        .collect();

    let out = json!({
        "hash": "poseidon-bn254-circom-x5",
        "encoding": "field elements as 32-byte big-endian hex; must be < BN254 r",
        "leaf": "commitment = H(nullifier_key, secret)",
        "node": "H(left, right); empty leaf = 0",
        "pairs": pairs,
        "notes": notes.iter().map(|(k, s, c)| json!({
            "nullifier_key": hex(k), "secret": hex(s), "commitment": hex(c)
        })).collect::<Vec<_>>(),
        "root_depth4_16_leaves": hex(&root(&leaves, 4).unwrap()),
        "batch_depth": BATCH_TREE_DEPTH,
        "root_batch_depth_16_leaves": hex(&root(&leaves, BATCH_TREE_DEPTH).unwrap()),
        "root_batch_depth_first_11_leaves": hex(&root(&leaves[..11], BATCH_TREE_DEPTH).unwrap()),
        "zero_hashes": zero_hashes(BATCH_TREE_DEPTH).unwrap().iter().map(hex).collect::<Vec<_>>(),
        "paths_batch_depth": paths,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
