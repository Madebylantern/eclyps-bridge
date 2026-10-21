//! Host-side check against the shared vector file (light-poseidon backend).
//! The SBF/syscall backend is checked in `circuits/syscall-probe`.

use eclyps_merkle::*;
use serde_json::Value;

fn parse(v: &Value) -> Hash {
    let s = v.as_str().unwrap().trim_start_matches("0x");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/merkle.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn pairs() {
    for p in vectors()["pairs"].as_array().unwrap() {
        assert_eq!(
            hash_pair(&parse(&p["a"]), &parse(&p["b"])).unwrap(),
            parse(&p["out"])
        );
    }
}

#[test]
fn commitments_and_roots() {
    let v = vectors();
    let leaves: Vec<Hash> = v["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            let c = commitment(&parse(&n["nullifier_key"]), &parse(&n["secret"])).unwrap();
            assert_eq!(c, parse(&n["commitment"]));
            c
        })
        .collect();
    assert_eq!(leaves.len(), 16);
    assert_eq!(
        root(&leaves, 4).unwrap(),
        parse(&v["root_depth4_16_leaves"])
    );
    assert_eq!(
        root(&leaves, BATCH_TREE_DEPTH).unwrap(),
        parse(&v["root_batch_depth_16_leaves"])
    );
    assert_eq!(
        root(&leaves[..11], BATCH_TREE_DEPTH).unwrap(),
        parse(&v["root_batch_depth_first_11_leaves"])
    );
    let zeros = zero_hashes(BATCH_TREE_DEPTH).unwrap();
    for (z, e) in zeros.iter().zip(v["zero_hashes"].as_array().unwrap()) {
        assert_eq!(*z, parse(e));
    }
    for p in v["paths_batch_depth"].as_array().unwrap() {
        let i = p["index"].as_u64().unwrap() as usize;
        let sibs: Vec<Hash> = p["siblings"]
            .as_array()
            .unwrap()
            .iter()
            .map(parse)
            .collect();
        assert_eq!(path(&leaves, i, BATCH_TREE_DEPTH).unwrap(), sibs);
        assert_eq!(
            root_from_path(&leaves[i], i, &sibs).unwrap(),
            parse(&v["root_batch_depth_16_leaves"])
        );
    }
}
