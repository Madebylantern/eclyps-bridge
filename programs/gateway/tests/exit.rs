//! Exit (ADR 0009): `receive_exit` through Circle's real CCTP V2 programs (devnet binaries and
//! state; the two enabled attesters are replaced by test keys) and `claim_exit`. Run
//! `anchor build` first, then `cargo test -p eclyps-gateway --test exit`.

mod common;
use common::*;
use eclyps_gateway::ExitBatch;
use solana_keypair::Keypair;
use solana_message::{v0, Message, VersionedMessage};
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_interface::state::AccountState;

/// What one $100 note costs the depositor at the default fee: $100.50.
const HUNDRED_PAID: u64 = HUNDRED + HUNDRED * FEE_BPS as u64 / 10_000;

/// An attestation by keys that are not CCTP's enabled attesters, in address order.
fn forged_attestation(message: &[u8]) -> Vec<u8> {
    let hash = keccak(message);
    let mut keys: Vec<_> = [[0x33u8; 32], [0x44u8; 32]]
        .iter()
        .map(|k| {
            let key = k256::ecdsa::SigningKey::from_slice(k).unwrap();
            let point = key.verifying_key().to_encoded_point(false);
            (keccak(&point.as_bytes()[1..])[12..].to_vec(), key)
        })
        .collect();
    keys.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = vec![];
    for (_, key) in keys {
        let (sig, recid) = key.sign_prehash_recoverable(&hash).unwrap();
        out.extend_from_slice(&sig.to_bytes());
        out.push(27 + recid.to_byte());
    }
    out
}

fn no_batch_and_nothing_moved(env: &Env, idx: u8, exit_epoch_id: u64) {
    assert!(env.exit_batch(idx, exit_epoch_id).is_none());
    assert_eq!(env.exit_custody_balance(), 0);
}

// ---------- receive_exit ----------

/// An exit message built as Ethereum's TokenMessengerV2 builds it, attested, is received by the
/// gateway through MessageTransmitterV2 -> TokenMessengerMinterV2: the batch lands in exit custody
/// and its root is stored.
#[test]
fn receive_exit_mints_into_exit_custody_and_stores_the_batch() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(5, 1);
    let circle_custody = tmm_pda(&[b"custody", DEVNET_USDC.as_ref()]);
    let circle_before = env.token_balance(&circle_custody);
    let m = env.exit_msg(1, 7, &tree);
    let message = m.bytes();
    assert_eq!(message.len(), 427);
    let payer = env.stranger();
    let meta = env
        .receive_exit_by(&payer, &message, &attest(&message))
        .unwrap();
    println!(
        "receive_exit (CCTP receive_message CPI, 2 attesters): {} CU",
        meta.compute_units_consumed
    );
    assert!(meta.compute_units_consumed < 400_000);
    assert_eq!(env.exit_custody_balance(), 5 * THOUSAND);
    assert_eq!(
        env.token_balance(&circle_custody),
        circle_before - 5 * THOUSAND
    );
    let b = env.exit_batch(1, 7).expect("ExitBatch");
    assert_eq!(
        (
            b.denomination_index,
            b.denomination,
            b.exit_epoch_id,
            b.count,
            b.claimed_count
        ),
        (1, THOUSAND, 7, 5, 0)
    );
    assert_eq!(b.root, tree.root);
    assert_eq!(b.claimed, [0; 32]);
    assert_eq!(b.cctp_nonce, m.nonce);
    // CCTP marked the nonce used.
    assert!(env
        .svm
        .get_account(&mt_pda(&[b"used_nonce", &m.nonce]))
        .is_some_and(|a| !a.data.is_empty()));
    // The exit did not touch the deposit side.
    let c = env.config();
    assert_eq!(
        (
            c.net_deposits,
            env.escrow_balance(),
            env.fee_vault_balance()
        ),
        (0, 0, 0)
    );
}

/// With a 427-byte message and a two-signature attestation, receive_exit does not fit a legacy
/// transaction; it fits a v0 transaction whose lookup table holds the 18 static accounts.
#[test]
fn receive_exit_fits_a_v0_transaction_with_a_lookup_table() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(3, 2);
    let m = env.exit_msg(0, 0, &tree).bytes();
    let payer = env.stranger();
    let ixs = [
        compute_budget(400_000),
        env.ix_receive_exit(&payer.pubkey(), &m, &attest(&m)),
    ];
    assert_eq!(ixs[1].accounts.len(), 21);
    let legacy = VersionedTransaction::try_new(
        VersionedMessage::Legacy(Message::new(&ixs, Some(&payer.pubkey()))),
        &[&payer],
    )
    .unwrap();
    let alt = env.exit_lookup_table();
    let v0 = VersionedTransaction::try_new(
        VersionedMessage::V0(
            v0::Message::try_compile(&payer.pubkey(), &ixs, &[alt], env.svm.latest_blockhash())
                .unwrap(),
        ),
        &[&payer],
    )
    .unwrap();
    println!(
        "receive_exit transaction: legacy {} bytes ({} keys), v0 with lookup table {} bytes ({} static keys); limit {PACKET_DATA_SIZE}",
        wire_size(&legacy),
        legacy.message.static_account_keys().len(),
        wire_size(&v0),
        v0.message.static_account_keys().len(),
    );
    assert!(wire_size(&legacy) > PACKET_DATA_SIZE);
    assert!(wire_size(&v0) <= PACKET_DATA_SIZE);
    // payer, used_nonce, exit_batch, the gateway and the compute budget program stay static.
    assert_eq!(v0.message.static_account_keys().len(), 5);
    env.send_v0(&ixs, &payer).unwrap();
    assert_eq!(env.exit_custody_balance(), 3 * HUNDRED);
}

/// Each field the portal and Iris fix is checked before CCTP is called. The attestation is valid
/// for each altered message, so only the gateway's checks reject it.
#[test]
fn receive_exit_rejects_a_message_the_portal_did_not_send() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(4, 3);
    let stranger = Pubkey::new_unique().to_bytes();
    let (_, other_usdc) = env.user(0);
    let root_too_big = [0xffu8; 32];
    type Mutation = (&'static str, Box<dyn Fn(&mut ExitMsg)>, &'static str);
    let mutations: Vec<Mutation> = vec![
        (
            "another Ethereum sender",
            Box::new(move |m| m.sender = stranger),
            "ExitWrongOrigin",
        ),
        (
            "another source domain",
            Box::new(|m| m.source_domain = 6),
            "ExitWrongOrigin",
        ),
        (
            "another destination domain",
            Box::new(|m| m.destination_domain = 6),
            "ExitWrongOrigin",
        ),
        (
            "a generic message to MT",
            Box::new(|m| m.recipient = MT.to_bytes()),
            "ExitWrongOrigin",
        ),
        (
            "no destination caller",
            Box::new(|m| m.destination_caller = [0; 32]),
            "ExitWrongDestination",
        ),
        (
            "another destination caller",
            Box::new(move |m| m.destination_caller = stranger),
            "ExitWrongDestination",
        ),
        (
            "another mint recipient",
            Box::new(move |m| m.mint_recipient = other_usdc.to_bytes()),
            "ExitWrongDestination",
        ),
        (
            "not the portal",
            Box::new(move |m| m.message_sender = stranger),
            "ExitWrongPortal",
        ),
        (
            "one unit more",
            Box::new(|m| m.amount += 1),
            "ExitAmountMismatch",
        ),
        (
            "a fast transfer",
            Box::new(|m| m.finality_executed = 1000),
            "ExitNotStandard",
        ),
        (
            "a fee",
            Box::new(|m| {
                m.max_fee = 1;
                m.fee_executed = 1;
            }),
            "ExitNotStandard",
        ),
        (
            "a forward batch hook",
            Box::new(|m| m.hook[0] = 1),
            "ExitBadHook",
        ),
        (
            "an unknown denomination",
            Box::new(|m| {
                m.hook[1..9].copy_from_slice(&(5 * HUNDRED).to_be_bytes());
                m.amount = 4 * 5 * HUNDRED;
            }),
            "ExitBadHook",
        ),
        (
            "no exits",
            Box::new(|m| {
                m.hook[17..19].copy_from_slice(&0u16.to_be_bytes());
                m.amount = 0;
            }),
            "ExitBadHook",
        ),
        (
            "a root outside the field",
            Box::new(move |m| m.hook[19..].copy_from_slice(&root_too_big)),
            "ExitBadHook",
        ),
        (
            "body version 2",
            Box::new(|m| m.body_version = 2),
            "ExitMessageMalformed",
        ),
        (
            "a 50-byte hook",
            Box::new(|m| {
                m.hook.pop();
            }),
            "ExitMessageMalformed",
        ),
        (
            "a 52-byte hook",
            Box::new(|m| m.hook.push(0)),
            "ExitMessageMalformed",
        ),
    ];
    for (what, mutate, error) in mutations {
        let mut m = env.exit_msg(0, 1, &tree);
        mutate(&mut m);
        let r = env.receive_exit(&m.bytes());
        assert!(
            r.as_ref().is_err_and(|e| e.contains(error)),
            "{what}: expected {error}, got {r:?}"
        );
        no_batch_and_nothing_moved(&env, 0, 1);
    }
    // The real one still goes through.
    env.exit(0, 1, &tree).unwrap();
    assert_eq!(env.exit_custody_balance(), 4 * HUNDRED);
}

/// CCTP verifies the attestation over the exact bytes the gateway checked.
#[test]
fn receive_exit_rejects_a_forged_or_altered_attestation() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(4, 4);
    let m = env.exit_msg(0, 2, &tree).bytes();
    let payer = env.stranger();
    // Signed by keys CCTP does not know.
    assert_err(
        env.receive_exit_by(&payer, &m, &forged_attestation(&m)),
        "InvalidAttesterSignature",
    );
    // One signature where the threshold is two.
    let a = attest(&m);
    assert_err(
        env.receive_exit_by(&payer, &m, &a[..65]),
        "InvalidAttestationLength",
    );
    // The root swapped after attestation (to another valid batch's root): the signatures no
    // longer recover to the attesters.
    let mut altered = m.clone();
    altered[376 + 19..].copy_from_slice(&ExitTree::new(4, 5).root);
    assert_err(env.receive_exit_by(&payer, &altered, &a), "Signature");
    no_batch_and_nothing_moved(&env, 0, 2);
    env.receive_exit_by(&payer, &m, &a).unwrap();
}

/// A message is received once, and an exit epoch is received once whatever message carries it.
#[test]
fn receive_exit_is_once_per_message_and_per_exit_epoch() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(4, 6);
    let first = env.exit_msg(0, 3, &tree);
    env.receive_exit(&first.bytes()).unwrap();
    assert_eq!(env.exit_custody_balance(), 4 * HUNDRED);
    // The same message again.
    assert_err(env.receive_exit(&first.bytes()), "already in use");
    // Another CCTP message (new nonce) for the same denomination and exit epoch.
    let again = env.exit_msg(0, 3, &tree);
    assert_ne!(again.nonce, first.nonce);
    assert_err(env.receive_exit(&again.bytes()), "already in use");
    // A new exit epoch that reuses a received nonce: CCTP refuses it.
    let mut reused = env.exit_msg(0, 4, &tree);
    reused.nonce = first.nonce;
    assert_err(env.receive_exit(&reused.bytes()), "already in use");
    assert!(env.exit_batch(0, 4).is_none());
    assert_eq!(env.exit_custody_balance(), 4 * HUNDRED);
    // The same exit epoch id of the other denomination is another batch.
    env.exit(1, 3, &tree).unwrap();
    assert_eq!(env.exit_custody_balance(), 4 * HUNDRED + 4 * THOUSAND);
}

/// Exit epoch ids are predictable, so anyone can send lamports to a future ExitBatch address
/// first. That must not block the batch (CCTP would keep the USDC until an upgrade).
#[test]
fn a_prefunded_exit_batch_address_does_not_block_receive_exit() {
    let mut env = Env::new(default_params());
    let griefer = env.stranger();
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &griefer.pubkey(),
        &exit_batch_pda(0, 0),
        1_000_000,
    );
    env.send(&[ix], &griefer, &[]).unwrap();
    let tree = ExitTree::new(4, 14);
    env.exit(0, 0, &tree).unwrap();
    assert_eq!(env.exit_batch(0, 0).unwrap().root, tree.root);
    env.claim_exit(0, 0, &tree, 3).unwrap();
}

#[test]
fn a_full_256_exit_batch_is_received_and_claimed() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(256, 7);
    let meta = env.exit(0, 0, &tree).unwrap();
    println!(
        "receive_exit, 256 exits: {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(env.exit_custody_balance(), 256 * HUNDRED);
    for i in [0, 128, 255] {
        env.claim_exit(0, 0, &tree, i).unwrap();
        assert_eq!(env.usdc_of(&tree.destinations[i]), HUNDRED);
    }
    let b = env.exit_batch(0, 0).unwrap();
    assert_eq!(b.claimed_count, 3);
    assert!(b.is_claimed(0) && b.is_claimed(128) && b.is_claimed(255) && !b.is_claimed(1));
    assert_eq!(env.exit_custody_balance(), 253 * HUNDRED);
}

#[test]
fn cctp_receive_accounts_are_the_pinned_pdas() {
    use eclyps_gateway::{
        CCTP_MESSAGE_TRANSMITTER_STATE, CCTP_MT_AUTHORITY_TMM, CCTP_MT_EVENT_AUTHORITY,
        CCTP_REMOTE_TOKEN_MESSENGER_ETHEREUM, CCTP_TMM_EVENT_AUTHORITY, CCTP_TOKEN_MESSENGER,
        CCTP_TOKEN_MESSENGER_MINTER_V2, CCTP_TOKEN_MINTER,
    };
    assert_eq!(
        CCTP_MESSAGE_TRANSMITTER_STATE,
        mt_pda(&[b"message_transmitter"])
    );
    assert_eq!(
        CCTP_MT_AUTHORITY_TMM,
        mt_pda(&[
            b"message_transmitter_authority",
            CCTP_TOKEN_MESSENGER_MINTER_V2.as_ref()
        ])
    );
    assert_eq!(CCTP_MT_EVENT_AUTHORITY, mt_pda(&[b"__event_authority"]));
    assert_eq!(CCTP_TOKEN_MESSENGER, tmm_pda(&[b"token_messenger"]));
    assert_eq!(
        CCTP_REMOTE_TOKEN_MESSENGER_ETHEREUM,
        tmm_pda(&[b"remote_token_messenger", b"0"])
    );
    assert_eq!(CCTP_TOKEN_MINTER, tmm_pda(&[b"token_minter"]));
    assert_eq!(CCTP_TMM_EVENT_AUTHORITY, tmm_pda(&[b"__event_authority"]));
    // The devnet remote token messenger for Ethereum is TokenMessengerV2 on Sepolia.
    let env = Env::new(default_params());
    let rtm = env
        .svm
        .get_account(&CCTP_REMOTE_TOKEN_MESSENGER_ETHEREUM)
        .unwrap();
    assert_eq!(
        eclyps_gateway::exit_message::remote_token_messenger(&rtm.data).unwrap(),
        eth_token_messenger()
    );
}

// ---------- claim_exit ----------

#[test]
fn claim_exit_pays_the_destination_once() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(5, 8);
    env.exit(1, 9, &tree).unwrap();
    // A relayer, not the destination, sends it; the destination's USDC account is created.
    let relayer = env.stranger();
    let d = tree.destinations[3];
    assert!(env.svm.get_account(&ata(&d, &env.mint)).is_none());
    let ix = env.ix_claim_exit(&relayer.pubkey(), 1, 9, 3, tree.path(3), d, tree.secrets[3]);
    let size = wire_size(
        &VersionedTransaction::try_new(
            VersionedMessage::Legacy(Message::new(
                std::slice::from_ref(&ix),
                Some(&relayer.pubkey()),
            )),
            &[&relayer],
        )
        .unwrap(),
    );
    println!(
        "claim_exit transaction: {size} bytes (legacy, {} accounts)",
        ix.accounts.len()
    );
    assert!(size <= PACKET_DATA_SIZE);
    let meta = env.send(&[ix], &relayer, &[]).unwrap();
    println!(
        "claim_exit (creates the destination's USDC account): {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(env.usdc_of(&d), THOUSAND);
    assert_eq!(env.exit_custody_balance(), 4 * THOUSAND);
    let b = env.exit_batch(1, 9).unwrap();
    assert_eq!(b.claimed_count, 1);
    assert!(b.is_claimed(3));
    // Never twice, whoever sends it.
    assert_err(env.claim_exit(1, 9, &tree, 3), "ExitAlreadyClaimed");
    assert_eq!(env.usdc_of(&d), THOUSAND);
    // A destination that already has its USDC account.
    let e = tree.destinations[0];
    env.set_usdc_account(ata(&e, &env.mint), &e, 5, AccountState::Initialized);
    let payer = env.stranger();
    let ix = env.ix_claim_exit(&payer.pubkey(), 1, 9, 0, tree.path(0), e, tree.secrets[0]);
    let meta = env.send(&[ix], &payer, &[]).unwrap();
    println!(
        "claim_exit (destination's USDC account exists): {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(env.usdc_of(&e), THOUSAND + 5);
    for i in [1, 2, 4] {
        env.claim_exit(1, 9, &tree, i).unwrap();
    }
    assert_eq!(env.exit_custody_balance(), 0);
    assert_eq!(env.exit_batch(1, 9).unwrap().claimed_count, 5);
    for i in 0..5 {
        assert_err(env.claim_exit(1, 9, &tree, i), "ExitAlreadyClaimed");
    }
}

#[test]
fn claim_exit_rejects_a_wrong_secret_path_or_destination() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(6, 10);
    env.exit(0, 5, &tree).unwrap();
    let p = env.stranger();
    let pk = p.pubkey();
    let i = 2usize;
    let (d, s, path) = (tree.destinations[i], tree.secrets[i], tree.path(i));
    let mut bad_path = path;
    bad_path[3][31] ^= 1;
    let mut big = eclyps_merkle::BN254_MODULUS_BE;
    big[31] += 1;
    let thief = Pubkey::new_unique();
    let cases = vec![
        (
            "wrong secret",
            env.ix_claim_exit(&pk, 0, 5, 2, path, d, exit_secret(999)),
            "InvalidExitProof",
        ),
        (
            "another exit's secret",
            env.ix_claim_exit(&pk, 0, 5, 2, path, d, tree.secrets[3]),
            "InvalidExitProof",
        ),
        (
            "wrong path",
            env.ix_claim_exit(&pk, 0, 5, 2, bad_path, d, s),
            "InvalidExitProof",
        ),
        (
            "wrong index",
            env.ix_claim_exit(&pk, 0, 5, 3, path, d, s),
            "InvalidExitProof",
        ),
        (
            "index past the batch",
            env.ix_claim_exit(&pk, 0, 5, 6, tree.path(6), d, s),
            "InvalidExitProof",
        ),
        (
            "secret outside the field",
            env.ix_claim_exit(&pk, 0, 5, 2, path, d, big),
            "InvalidExitProof",
        ),
        // A front-runner who saw the secret cannot redirect the payout.
        (
            "another destination",
            env.ix_claim_exit(&pk, 0, 5, 2, path, thief, s),
            "InvalidExitProof",
        ),
        (
            "another exit epoch",
            env.ix_claim_exit(&pk, 0, 6, 2, path, d, s),
            "AccountNotInitialized",
        ),
        (
            "another denomination",
            env.ix_claim_exit(&pk, 1, 5, 2, path, d, s),
            "AccountNotInitialized",
        ),
    ];
    for (what, ix, error) in cases {
        let r = env.send(&[ix], &p, &[]);
        assert!(
            r.as_ref().is_err_and(|e| e.contains(error)),
            "{what}: expected {error}, got {r:?}"
        );
    }
    // The leaf names `d`, but the accounts pay someone else.
    let mut ix = env.ix_claim_exit(&pk, 0, 5, 2, path, d, s);
    ix.accounts[5].pubkey = thief;
    assert_err(env.send(&[ix], &p, &[]), "ExitDestinationMismatch");
    let (_, thief_usdc) = env.user(0);
    let mut ix = env.ix_claim_exit(&pk, 0, 5, 2, path, d, s);
    ix.accounts[6].pubkey = thief_usdc;
    assert_err(env.send(&[ix], &p, &[]), "ExitDestinationMismatch");
    // A USDC account `d` owns, but not its associated one.
    let other = Pubkey::new_unique();
    env.set_usdc_account(other, &d, 0, AccountState::Initialized);
    let mut ix = env.ix_claim_exit(&pk, 0, 5, 2, path, d, s);
    ix.accounts[6].pubkey = other;
    assert_err(env.send(&[ix], &p, &[]), "ExitDestinationMismatch");

    assert_eq!(env.exit_custody_balance(), 6 * HUNDRED);
    assert_eq!(env.exit_batch(0, 5).unwrap().claimed_count, 0);
    env.claim_exit(0, 5, &tree, i).unwrap();
    assert_eq!(env.usdc_of(&d), HUNDRED);
    assert_eq!(env.token_balance(&thief_usdc), 0);
}

/// The guardian's pause is for deposits only: exits keep arriving and paying out.
#[test]
fn exits_ignore_the_deposit_pause() {
    let mut env = Env::new(default_params());
    let (u, ta) = env.user(10 * HUNDRED_PAID);
    let g = env.guardian.insecure_clone();
    env.pause(&g, true).unwrap();
    assert_err(env.deposit(&u, &ta, 0, leaf(1)), "DepositsPaused");
    let tree = ExitTree::new(4, 11);
    env.exit(0, 0, &tree).unwrap();
    env.claim_exit(0, 0, &tree, 1).unwrap();
    assert_eq!(env.usdc_of(&tree.destinations[1]), HUNDRED);
    assert!(env.config().paused_deposits);
}

/// Exit custody is owned by the exit authority PDA: no key, the admin's or anyone's, can move it
/// or take it over; only claim_exit signs for it.
#[test]
fn nobody_can_move_exit_custody_directly() {
    let mut env = Env::new(default_params());
    let tree = ExitTree::new(4, 12);
    env.exit(0, 0, &tree).unwrap();
    let c = env.config();
    assert_eq!(c.exit_custody, env.exit_custody);
    let custody = spl_token_interface::state::Account::unpack_from_slice(
        &env.svm.get_account(&env.exit_custody).unwrap().data,
    )
    .unwrap();
    assert_eq!(custody.owner, env.exit_authority);
    assert_eq!(custody.mint, env.mint);
    let (u, ta) = env.user(0);
    for thief in [env.admin.insecure_clone(), env.guardian.insecure_clone(), u] {
        let transfer = spl_token_interface::instruction::transfer(
            &spl_token_interface::ID,
            &env.exit_custody,
            &ta,
            &thief.pubkey(),
            &[],
            1,
        )
        .unwrap();
        assert!(env.send(&[transfer], &thief, &[]).is_err());
        let take = spl_token_interface::instruction::set_authority(
            &spl_token_interface::ID,
            &env.exit_custody,
            Some(&thief.pubkey()),
            spl_token_interface::instruction::AuthorityType::AccountOwner,
            &thief.pubkey(),
            &[],
        )
        .unwrap();
        assert!(env.send(&[take], &thief, &[]).is_err());
    }
    assert_eq!(env.exit_custody_balance(), 4 * HUNDRED);
}

/// Deposits, batches, exits and claims side by side: neither side moves the other's funds, and
/// the exit charges no fee and does not count against the deposit cap.
#[test]
fn exits_leave_the_deposit_side_alone() {
    let p = eclyps_gateway::Params {
        min_batch_size: 4,
        per_epoch_cap: 4,
        ..default_params()
    };
    let mut env = Env::new(p);
    let (u, ta) = env.user(10 * HUNDRED_PAID);
    for i in 0..4 {
        env.deposit(&u, &ta, 0, leaf(i)).unwrap();
    }
    env.close_epoch(0).unwrap();
    let tree = ExitTree::new(4, 13);
    env.exit(0, 0, &tree).unwrap();
    assert_eq!(env.escrow_balance(), 4 * HUNDRED);
    assert_eq!(env.fee_vault_balance(), 4 * 500_000);
    assert_eq!(env.config().net_deposits, 4 * HUNDRED);
    env.claim_exit(0, 0, &tree, 0).unwrap();
    env.send_batch(0, 0).unwrap();
    assert_eq!((env.escrow_balance(), env.fee_vault_balance()), (0, 0));
    assert_eq!(env.exit_custody_balance(), 3 * HUNDRED);
    assert_eq!(env.config().net_deposits, 4 * HUNDRED);
    assert_eq!(env.usdc_of(&tree.destinations[0]), HUNDRED);
}

// ---------- client fixtures ----------

/// A received and partly claimed exit batch for the SDK (sdk/test/exit.test.ts): the exits'
/// destinations, secrets and leaves, the root, the path of the claimed leaf, the receive_exit and
/// claim_exit instructions that succeeded here (accounts and data), and the ExitBatch bytes.
/// Everything is deterministic, so the committed file must match exactly;
/// `ECLYPS_WRITE_FIXTURES=1 cargo test -p eclyps-gateway --test exit exit_fixture` rewrites it.
#[test]
fn exit_fixture_for_the_sdk() {
    use base64::Engine;
    let b64 = |d: &[u8]| base64::engine::general_purpose::STANDARD.encode(d);
    let hex = |d: &[u8]| d.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let hex32 = |d: &[u8; 32]| format!("0x{}", hex(d));
    let accounts = |ix: &Instruction| {
        ix.accounts
            .iter()
            .map(|a| {
                serde_json::json!({
                    "address": a.pubkey.to_string(),
                    "writable": a.is_writable,
                    "signer": a.is_signer,
                })
            })
            .collect::<Vec<_>>()
    };

    let mut env = Env::new(default_params());
    let payer = Keypair::new_from_array([0x42; 32]);
    env.svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let destinations: Vec<Pubkey> = (1..=3u8).map(|i| Pubkey::new_from_array([i; 32])).collect();
    let tree = ExitTree::to(destinations, 77);
    let (idx, exit_epoch_id, leaf_index) = (1u8, 7u64, 1usize);
    let message = env.exit_msg(idx, exit_epoch_id, &tree).bytes();
    let attestation = attest(&message);
    let receive = env.ix_receive_exit(&payer.pubkey(), &message, &attestation);
    env.send_v0(&[compute_budget(400_000), receive.clone()], &payer)
        .unwrap();
    let claim = env.ix_claim_exit(
        &payer.pubkey(),
        idx,
        exit_epoch_id,
        leaf_index as u16,
        tree.path(leaf_index),
        tree.destinations[leaf_index],
        tree.secrets[leaf_index],
    );
    env.send(std::slice::from_ref(&claim), &payer, &[]).unwrap();
    let batch = env.exit_batch(idx, exit_epoch_id).unwrap();
    let batch_bytes = env
        .svm
        .get_account(&exit_batch_pda(idx, exit_epoch_id))
        .unwrap()
        .data;
    assert_eq!(
        batch_bytes.len(),
        8 + <ExitBatch as anchor_lang::Space>::INIT_SPACE
    );
    let fee_recipient = {
        let tm = env
            .svm
            .get_account(&eclyps_gateway::CCTP_TOKEN_MESSENGER)
            .unwrap();
        Pubkey::new_from_array(tm.data[109..141].try_into().unwrap())
    };

    let fixture = serde_json::json!({
        "programId": eclyps_gateway::ID.to_string(),
        "usdcMint": env.mint.to_string(),
        "payer": payer.pubkey().to_string(),
        "denominations": env.config().denominations.iter().map(|d| d.to_string()).collect::<Vec<_>>(),
        "denominationIndex": idx,
        "exitEpochId": exit_epoch_id.to_string(),
        "exits": tree.destinations.iter().zip(&tree.secrets).zip(&tree.leaves).map(|((d, s), l)| serde_json::json!({
            "destination": d.to_string(),
            "secret": hex32(s),
            "leaf": hex32(l),
        })).collect::<Vec<_>>(),
        "root": hex32(&tree.root),
        "exitAuthority": env.exit_authority.to_string(),
        "exitCustody": env.exit_custody.to_string(),
        "cctpFeeRecipient": fee_recipient.to_string(),
        "receive": {
            "message": hex(&message),
            "attestation": hex(&attestation),
            "accounts": accounts(&receive),
            "data": b64(&receive.data),
        },
        "claim": {
            "leafIndex": leaf_index,
            "path": tree.path(leaf_index).iter().map(hex32).collect::<Vec<_>>(),
            "accounts": accounts(&claim),
            "data": b64(&claim.data),
        },
        "exitBatch": {
            "address": exit_batch_pda(idx, exit_epoch_id).to_string(),
            "data": b64(&batch_bytes),
            "claimedCount": batch.claimed_count,
            "receivedSlot": batch.received_slot.to_string(),
            "cctpNonce": hex32(&batch.cctp_nonce),
        },
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../sdk/test/fixtures/exit-claim.json"
    );
    let text = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
    if std::env::var("ECLYPS_WRITE_FIXTURES").is_ok() {
        std::fs::write(path, &text).unwrap();
    }
    let committed =
        std::fs::read_to_string(path).expect("fixture: run with ECLYPS_WRITE_FIXTURES=1");
    assert_eq!(
        committed, text,
        "exit fixture changed: regenerate it with ECLYPS_WRITE_FIXTURES=1"
    );
}
