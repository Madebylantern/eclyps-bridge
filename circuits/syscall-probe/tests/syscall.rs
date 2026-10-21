//! Runs the SBF probe in LiteSVM with the mainnet feature set and checks the
//! syscall-computed roots against `circuits/vectors/merkle.json`.
//! Requires `cargo build-sbf --manifest-path circuits/syscall-probe/Cargo.toml` first.

use eclyps_merkle::{commitment, Hash, BATCH_TREE_DEPTH, MAX_BATCH_LEAVES};
use litesvm::LiteSVM;
use serde_json::Value;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROBE_SO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/eclyps_syscall_probe.so"
);

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

struct Probe {
    svm: LiteSVM,
    payer: Keypair,
    program: Address,
}

impl Probe {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_mainnet_features();
        let program = Address::new_unique();
        svm.add_program(
            program,
            &std::fs::read(PROBE_SO).expect("build the probe with cargo build-sbf"),
        )
        .unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        Probe {
            svm,
            payer,
            program,
        }
    }

    /// Returns (return data, compute units consumed).
    fn call(&mut self, data: Vec<u8>) -> (Vec<u8>, u64) {
        // ComputeBudget::SetComputeUnitLimit(1_400_000)
        let mut cu = vec![2u8];
        cu.extend_from_slice(&1_400_000u32.to_le_bytes());
        let budget = Instruction::new_with_bytes(
            "ComputeBudget111111111111111111111111111111"
                .parse()
                .unwrap(),
            &cu,
            vec![],
        );
        let ix = Instruction::new_with_bytes(self.program, &data, vec![]);
        let msg = Message::new(&[budget, ix], Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        let meta = self.svm.send_transaction(tx).expect("probe tx failed");
        self.svm.expire_blockhash();
        (meta.return_data.data, meta.compute_units_consumed)
    }

    fn root(&mut self, leaves: &[Hash], depth: u8) -> (Hash, u64) {
        let mut data = vec![0u8, depth];
        leaves.iter().for_each(|l| data.extend_from_slice(l));
        let (out, cu) = self.call(data);
        (out.try_into().unwrap(), cu)
    }
}

#[test]
fn syscall_roots_match_vectors() {
    let v = vectors();
    let leaves: Vec<Hash> = v["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| parse(&n["commitment"]))
        .collect();
    let mut p = Probe::new();

    let (r4, cu4) = p.root(&leaves, 4);
    assert_eq!(r4, parse(&v["root_depth4_16_leaves"]));
    let (r8, cu8) = p.root(&leaves, BATCH_TREE_DEPTH as u8);
    assert_eq!(r8, parse(&v["root_batch_depth_16_leaves"]));
    let (r11, _) = p.root(&leaves[..11], BATCH_TREE_DEPTH as u8);
    assert_eq!(r11, parse(&v["root_batch_depth_first_11_leaves"]));
    println!("CU: 16 leaves depth 4 = {cu4}; 16 leaves depth 8 = {cu8}");
}

#[test]
fn syscall_pair_hash_matches_and_cost() {
    let v = vectors();
    let mut p = Probe::new();
    for pair in v["pairs"].as_array().unwrap() {
        let mut data = vec![1u8, 1];
        data.extend_from_slice(&parse(&pair["a"]));
        data.extend_from_slice(&parse(&pair["b"]));
        let (out, _) = p.call(data);
        assert_eq!(out, parse(&pair["out"]));
    }
    // Marginal cost per 2-to-1 hash: difference between 101 and 1 iterations.
    let pair = &v["pairs"][0];
    let mut cost = |n: u8| {
        let mut data = vec![1u8, n];
        data.extend_from_slice(&parse(&pair["a"]));
        data.extend_from_slice(&parse(&pair["b"]));
        p.call(data).1
    };
    let (c1, c101) = (cost(1), cost(101));
    println!("CU per Poseidon(2) syscall ≈ {}", (c101 - c1) / 100);
}

#[test]
fn root_cost_32_leaves() {
    let leaves: Vec<Hash> = (0..MAX_BATCH_LEAVES as u64)
        .map(|i| {
            let k = eclyps_merkle::field_from_u64(i + 1);
            commitment(&k, &k).unwrap()
        })
        .collect();
    let mut p = Probe::new();
    // 8 KiB of leaves does not fit in instruction data (1232-byte packets), so
    // compute the root over 32 leaves and extrapolate: the program in S4 reads
    // leaves from an account instead.
    let (r, cu32) = p.root(&leaves[..32], BATCH_TREE_DEPTH as u8);
    assert_eq!(
        r,
        eclyps_merkle::root(&leaves[..32], BATCH_TREE_DEPTH).unwrap()
    );
    println!("CU: 32 leaves depth 8 = {cu32}");
}
