//! The CCTP V2 message of an exit batch, as Ethereum's TokenMessengerV2 emits it for
//! `EclypsPortal.exitBatch` and Iris attests it (ADR 0009): the MessageV2 header, the
//! BurnMessageV2 body and the 51-byte exit hook. All integers are big-endian. Offsets are those of
//! Circle's `message.rs` / `burn_message.rs` (solana-cctp-contracts, programs/v2) and of the
//! portal's `CctpMessageV2.sol` (ADR 0002).
//!
//! `parse` makes every check that does not need the attestation; `receive_exit` then has
//! MessageTransmitterV2 verify the attestation over these exact bytes.

use anchor_lang::prelude::*;

use crate::{constants::*, error::GatewayError};

// Header
pub const VERSION: usize = 0;
pub const SOURCE_DOMAIN: usize = 4;
pub const DESTINATION_DOMAIN: usize = 8;
pub const NONCE: usize = 12;
pub const SENDER: usize = 44;
pub const RECIPIENT: usize = 76;
pub const DESTINATION_CALLER: usize = 108;
pub const MIN_FINALITY: usize = 140;
pub const FINALITY_EXECUTED: usize = 144;
pub const BODY: usize = 148;
// Body (absolute offsets)
pub const BODY_VERSION: usize = BODY;
pub const BURN_TOKEN: usize = BODY + 4;
pub const MINT_RECIPIENT: usize = BODY + 36;
pub const AMOUNT: usize = BODY + 68;
pub const MESSAGE_SENDER: usize = BODY + 100;
pub const MAX_FEE: usize = BODY + 132;
pub const FEE_EXECUTED: usize = BODY + 164;
pub const EXPIRATION_BLOCK: usize = BODY + 196;
/// The hook runs to the end of the message, with no length prefix.
pub const HOOK_DATA: usize = BODY + 228;
/// Every exit message is exactly this long: 376 + 51 = 427 bytes.
pub const EXIT_MESSAGE_LEN: usize = HOOK_DATA + HOOK_LEN;

/// The exit hook: version 2 | denomination u64 | exit_epoch_id u64 | count u16 | root bytes32.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExitHook {
    pub denomination: u64,
    pub exit_epoch_id: u64,
    pub count: u16,
    pub root: [u8; 32],
}

/// The 51-byte exit hook. The portal's `exitBatch` must produce exactly these bytes.
pub fn exit_hook(h: &ExitHook) -> [u8; HOOK_LEN] {
    let mut out = [0u8; HOOK_LEN];
    out[0] = EXIT_HOOK_VERSION;
    out[1..9].copy_from_slice(&h.denomination.to_be_bytes());
    out[9..17].copy_from_slice(&h.exit_epoch_id.to_be_bytes());
    out[17..19].copy_from_slice(&h.count.to_be_bytes());
    out[19..51].copy_from_slice(&h.root);
    out
}

/// What a valid exit message must name, from the gateway's state.
pub struct ExitExpected {
    /// Ethereum's TokenMessengerV2 as registered in CCTP (`remote_token_messenger` for domain 0).
    pub eth_token_messenger: [u8; 32],
    pub exit_authority: Pubkey,
    pub exit_custody: Pubkey,
    pub portal: [u8; 32],
    pub denominations: [u64; MAX_DENOMINATIONS],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParsedExit {
    pub hook: ExitHook,
    pub denomination_index: u8,
    /// count x denomination.
    pub amount: u64,
    pub nonce: [u8; 32],
}

fn u32_at(m: &[u8], o: usize) -> u32 {
    u32::from_be_bytes(m[o..o + 4].try_into().unwrap())
}

fn b32_at(m: &[u8], o: usize) -> [u8; 32] {
    m[o..o + 32].try_into().unwrap()
}

/// A uint256 field that must fit a u64 (Solana amounts are u64).
fn u64_of_u256(m: &[u8], o: usize) -> Option<u64> {
    if m[o..o + 24].iter().any(|b| *b != 0) {
        return None;
    }
    Some(u64::from_be_bytes(m[o + 24..o + 32].try_into().unwrap()))
}

fn denomination_index(denominations: &[u64; MAX_DENOMINATIONS], d: u64) -> Option<u8> {
    if d == 0 {
        return None;
    }
    denominations.iter().position(|x| *x == d).map(|i| i as u8)
}

/// All checks of an exit message that do not need the attestation (ADR 0009).
pub fn parse(m: &[u8], e: &ExitExpected) -> Result<ParsedExit> {
    require!(
        m.len() == EXIT_MESSAGE_LEN
            && u32_at(m, VERSION) == CCTP_MESSAGE_VERSION
            && u32_at(m, BODY_VERSION) == CCTP_MESSAGE_VERSION,
        GatewayError::ExitMessageMalformed
    );
    // A burn from Ethereum's TokenMessengerV2 to Solana's TokenMessengerMinterV2: no other pair
    // carries a burn body (a generic message could mimic one).
    require!(
        u32_at(m, SOURCE_DOMAIN) == CCTP_DOMAIN_ETHEREUM
            && u32_at(m, DESTINATION_DOMAIN) == CCTP_DOMAIN_SOLANA
            && b32_at(m, SENDER) == e.eth_token_messenger
            && b32_at(m, RECIPIENT) == CCTP_TOKEN_MESSENGER_MINTER_V2.to_bytes(),
        GatewayError::ExitWrongOrigin
    );
    // Only receive_exit can consume it (MessageTransmitterV2 requires the destinationCaller to
    // sign), and the USDC lands in exit custody.
    require!(
        b32_at(m, DESTINATION_CALLER) == e.exit_authority.to_bytes()
            && b32_at(m, MINT_RECIPIENT) == e.exit_custody.to_bytes(),
        GatewayError::ExitWrongDestination
    );
    require!(
        b32_at(m, MESSAGE_SENDER) == e.portal,
        GatewayError::ExitWrongPortal
    );
    // Exact denominations: only a finalized, fee-free (standard) transfer.
    require!(
        u32_at(m, FINALITY_EXECUTED) >= CCTP_FINALITY_STANDARD
            && b32_at(m, FEE_EXECUTED) == [0u8; 32],
        GatewayError::ExitNotStandard
    );
    let amount = u64_of_u256(m, AMOUNT).ok_or(GatewayError::ExitMessageMalformed)?;

    let h = &m[HOOK_DATA..];
    require!(h[0] == EXIT_HOOK_VERSION, GatewayError::ExitBadHook);
    let hook = ExitHook {
        denomination: u64::from_be_bytes(h[1..9].try_into().unwrap()),
        exit_epoch_id: u64::from_be_bytes(h[9..17].try_into().unwrap()),
        count: u16::from_be_bytes(h[17..19].try_into().unwrap()),
        root: h[19..51].try_into().unwrap(),
    };
    let denomination_index =
        denomination_index(&e.denominations, hook.denomination).ok_or(GatewayError::ExitBadHook)?;
    require!(
        (1..=MAX_EXIT_LEAVES).contains(&hook.count) && eclyps_merkle::is_canonical(&hook.root),
        GatewayError::ExitBadHook
    );
    require!(
        Some(amount) == hook.denomination.checked_mul(hook.count as u64),
        GatewayError::ExitAmountMismatch
    );
    Ok(ParsedExit {
        hook,
        denomination_index,
        amount,
        nonce: b32_at(m, NONCE),
    })
}

/// `ExitBatch` seeds read from a message before it is validated: the denomination index and
/// exit epoch id of its hook. A message `parse` rejects gives values no real batch uses
/// (index 255, epoch u64::MAX), and `receive_exit` fails before anything is kept.
pub fn batch_seed_index(m: &[u8], denominations: &[u64; MAX_DENOMINATIONS]) -> [u8; 1] {
    if m.len() != EXIT_MESSAGE_LEN {
        return [u8::MAX];
    }
    let d = u64::from_be_bytes(m[HOOK_DATA + 1..HOOK_DATA + 9].try_into().unwrap());
    [denomination_index(denominations, d).unwrap_or(u8::MAX)]
}

/// See [`batch_seed_index`]; little-endian, like the epoch seeds.
pub fn batch_seed_epoch(m: &[u8]) -> [u8; 8] {
    if m.len() != EXIT_MESSAGE_LEN {
        return u64::MAX.to_le_bytes();
    }
    u64::from_be_bytes(m[HOOK_DATA + 9..HOOK_DATA + 17].try_into().unwrap()).to_le_bytes()
}

/// The `token_messenger` of TMM's `RemoteTokenMessenger` for domain 0 (Ethereum): disc (8) |
/// domain u32 LE | token_messenger bytes32. The caller pins the account's address and owner.
pub fn remote_token_messenger(data: &[u8]) -> Result<[u8; 32]> {
    require!(
        data.len() >= 44
            && data[..8] == CCTP_REMOTE_TOKEN_MESSENGER_DISC
            && u32::from_le_bytes(data[8..12].try_into().unwrap()) == CCTP_DOMAIN_ETHEREUM,
        GatewayError::ExitWrongOrigin
    );
    Ok(data[12..44].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ETH_TM: [u8; 32] = [7; 32];
    const PORTAL: [u8; 32] = {
        let mut p = [0u8; 32];
        p[31] = 0x75;
        p
    };

    fn expected() -> ExitExpected {
        ExitExpected {
            eth_token_messenger: ETH_TM,
            exit_authority: Pubkey::new_from_array([1; 32]),
            exit_custody: Pubkey::new_from_array([2; 32]),
            portal: PORTAL,
            denominations: [100, 1_000, 0, 0],
        }
    }

    fn message(hook: &ExitHook) -> Vec<u8> {
        let e = expected();
        let mut m = vec![0u8; EXIT_MESSAGE_LEN];
        m[VERSION..VERSION + 4].copy_from_slice(&1u32.to_be_bytes());
        m[SOURCE_DOMAIN..SOURCE_DOMAIN + 4].copy_from_slice(&0u32.to_be_bytes());
        m[DESTINATION_DOMAIN..DESTINATION_DOMAIN + 4].copy_from_slice(&5u32.to_be_bytes());
        m[NONCE..NONCE + 32].copy_from_slice(&[9; 32]);
        m[SENDER..SENDER + 32].copy_from_slice(&ETH_TM);
        m[RECIPIENT..RECIPIENT + 32].copy_from_slice(CCTP_TOKEN_MESSENGER_MINTER_V2.as_ref());
        m[DESTINATION_CALLER..DESTINATION_CALLER + 32].copy_from_slice(e.exit_authority.as_ref());
        m[MIN_FINALITY..MIN_FINALITY + 4].copy_from_slice(&2000u32.to_be_bytes());
        m[FINALITY_EXECUTED..FINALITY_EXECUTED + 4].copy_from_slice(&2000u32.to_be_bytes());
        m[BODY_VERSION..BODY_VERSION + 4].copy_from_slice(&1u32.to_be_bytes());
        m[MINT_RECIPIENT..MINT_RECIPIENT + 32].copy_from_slice(e.exit_custody.as_ref());
        let amount = hook.denomination * hook.count as u64;
        m[AMOUNT + 24..AMOUNT + 32].copy_from_slice(&amount.to_be_bytes());
        m[MESSAGE_SENDER..MESSAGE_SENDER + 32].copy_from_slice(&PORTAL);
        m[HOOK_DATA..].copy_from_slice(&exit_hook(hook));
        m
    }

    fn hook() -> ExitHook {
        ExitHook {
            denomination: 1_000,
            exit_epoch_id: 0x0102030405060708,
            count: 3,
            root: eclyps_merkle::field_from_u64(42),
        }
    }

    fn err(r: Result<ParsedExit>) -> String {
        format!("{:?}", r.unwrap_err())
    }

    #[test]
    fn parses_a_valid_exit_and_its_seeds() {
        let m = message(&hook());
        assert_eq!(m.len(), 427);
        let p = parse(&m, &expected()).unwrap();
        assert_eq!(p.hook, hook());
        assert_eq!(
            (p.denomination_index, p.amount, p.nonce),
            (1, 3_000, [9; 32])
        );
        assert_eq!(batch_seed_index(&m, &expected().denominations), [1]);
        assert_eq!(batch_seed_epoch(&m), 0x0102030405060708u64.to_le_bytes());
        assert_eq!(
            batch_seed_index(&m[..426], &expected().denominations),
            [255]
        );
    }

    #[test]
    fn rejects_each_wrong_field() {
        let e = expected();
        let cases: Vec<(usize, Vec<u8>, &str)> = vec![
            (VERSION, 2u32.to_be_bytes().to_vec(), "ExitMessageMalformed"),
            (
                BODY_VERSION,
                2u32.to_be_bytes().to_vec(),
                "ExitMessageMalformed",
            ),
            (
                SOURCE_DOMAIN,
                5u32.to_be_bytes().to_vec(),
                "ExitWrongOrigin",
            ),
            (
                DESTINATION_DOMAIN,
                0u32.to_be_bytes().to_vec(),
                "ExitWrongOrigin",
            ),
            (SENDER, vec![8; 32], "ExitWrongOrigin"),
            (RECIPIENT, vec![8; 32], "ExitWrongOrigin"),
            (DESTINATION_CALLER, vec![0; 32], "ExitWrongDestination"),
            (MINT_RECIPIENT, vec![8; 32], "ExitWrongDestination"),
            (MESSAGE_SENDER, vec![8; 32], "ExitWrongPortal"),
            (
                FINALITY_EXECUTED,
                1000u32.to_be_bytes().to_vec(),
                "ExitNotStandard",
            ),
            (FEE_EXECUTED + 31, vec![1], "ExitNotStandard"),
            (AMOUNT, vec![1], "ExitMessageMalformed"),
            (AMOUNT + 31, vec![0xb9], "ExitAmountMismatch"),
            (HOOK_DATA, vec![1], "ExitBadHook"),
            (HOOK_DATA + 8, vec![0xff], "ExitBadHook"),
            (HOOK_DATA + 17, vec![0, 0], "ExitBadHook"),
            (HOOK_DATA + 17, vec![1, 1], "ExitBadHook"),
            (HOOK_DATA + 19, vec![0xff; 32], "ExitBadHook"),
        ];
        for (offset, bytes, want) in cases {
            let mut m = message(&hook());
            m[offset..offset + bytes.len()].copy_from_slice(&bytes);
            let got = err(parse(&m, &e));
            assert!(got.contains(want), "offset {offset}: {got}");
        }
        let mut long = message(&hook());
        long.push(0);
        assert!(err(parse(&long, &e)).contains("ExitMessageMalformed"));
        assert!(err(parse(&long[..426], &e)).contains("ExitMessageMalformed"));
        // A denomination 0 never matches an unused slot.
        let zero = ExitHook {
            denomination: 0,
            ..hook()
        };
        assert!(err(parse(&message(&zero), &e)).contains("ExitBadHook"));
        assert_eq!(batch_seed_index(&message(&zero), &e.denominations), [255]);
        // Count 256 (a full tree) is fine.
        let full = ExitHook {
            count: 256,
            ..hook()
        };
        assert_eq!(parse(&message(&full), &e).unwrap().amount, 256_000);
    }

    fn unhex(s: &str) -> Vec<u8> {
        let s = s.trim_start_matches("0x");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    /// circuits/vectors/exit.json, shared with the portal (Solidity) and the SDK.
    #[test]
    fn exit_hook_matches_the_shared_vectors() {
        let v = json(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../circuits/vectors/exit.json"
        )));
        let vectors = v["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 4);
        for x in vectors {
            let hook = ExitHook {
                denomination: x["denomination"].as_str().unwrap().parse().unwrap(),
                exit_epoch_id: x["exitEpochId"].as_str().unwrap().parse().unwrap(),
                count: x["count"].as_u64().unwrap() as u16,
                root: unhex(x["root"].as_str().unwrap()).try_into().unwrap(),
            };
            assert_eq!(
                exit_hook(&hook).to_vec(),
                unhex(x["hook"].as_str().unwrap())
            );
        }
    }

    /// The bytes Circle's real TokenMessengerV2 emitted for `EclypsPortal.exitBatch` on a Sepolia
    /// fork (contracts/portal/test/ExitBatchFork.t.sol), once Iris fills the nonce and the executed
    /// finality, pass `parse` for this program's exit accounts.
    #[test]
    fn parses_the_message_the_portal_burned_on_a_sepolia_fork() {
        let f = json(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/portal/test/fixtures/exit-burn-sepolia-fork.json"
        )));
        let mut m = unhex(f["message"].as_str().unwrap());
        assert_eq!(m.len(), EXIT_MESSAGE_LEN);
        // As emitted on Ethereum: Iris has not filled these yet, and parse refuses them.
        assert!(format!("{:?}", parse(&m, &sepolia()).unwrap_err()).contains("ExitNotStandard"));
        m[NONCE..NONCE + 32].copy_from_slice(&[0x5a; 32]);
        m[FINALITY_EXECUTED..FINALITY_EXECUTED + 4].copy_from_slice(&2000u32.to_be_bytes());

        let p = parse(&m, &sepolia()).unwrap();
        let root: [u8; 32] = unhex(f["root"].as_str().unwrap()).try_into().unwrap();
        assert_eq!(
            p.hook,
            ExitHook {
                denomination: 1_000_000_000,
                exit_epoch_id: 7,
                count: 3,
                root
            }
        );
        assert_eq!(
            (p.denomination_index, p.amount, p.nonce),
            (1, 3_000_000_000, [0x5a; 32])
        );
        assert_eq!(u32_at(&m, MIN_FINALITY), CCTP_FINALITY_STANDARD);
        assert_eq!(b32_at(&m, MAX_FEE), [0u8; 32]);
        assert_eq!(b32_at(&m, EXPIRATION_BLOCK), [0u8; 32]);
    }

    /// What `receive_exit` would expect for the fork's portal (0x…0ec175, the tests' placeholder)
    /// on Sepolia, for this program id.
    fn sepolia() -> ExitExpected {
        let evm = |hex: &str| -> [u8; 32] {
            let mut out = [0u8; 32];
            out[12..].copy_from_slice(&unhex(hex));
            out
        };
        let pda = |seed: &[u8]| Pubkey::find_program_address(&[seed], &crate::ID).0;
        ExitExpected {
            // TokenMessengerV2 on Sepolia: CCTP's remote_token_messenger for domain 0 on devnet.
            eth_token_messenger: evm("8fe6b999dc680ccfdd5bf7eb0974218be2542daa"),
            exit_authority: pda(EXIT_AUTHORITY_SEED),
            exit_custody: pda(EXIT_CUSTODY_SEED),
            portal: evm("00000000000000000000000000000000000ec175"),
            denominations: [100_000_000, 1_000_000_000, 0, 0],
        }
    }

    #[test]
    fn reads_the_remote_token_messenger() {
        let mut d = CCTP_REMOTE_TOKEN_MESSENGER_DISC.to_vec();
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&ETH_TM);
        assert_eq!(remote_token_messenger(&d).unwrap(), ETH_TM);
        d[8] = 6; // another domain
        assert!(remote_token_messenger(&d).is_err());
        assert!(remote_token_messenger(&d[..40]).is_err());
    }
}
