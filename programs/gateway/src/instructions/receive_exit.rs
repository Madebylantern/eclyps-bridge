use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::GatewayError,
    events::ExitReceived,
    exit_message::{self, ExitExpected},
    state::*,
};

/// Permissionless (finishers). Receives one exit batch from Ethereum (ADR 0009): CPIs into
/// CCTP MessageTransmitterV2 `receive_message`, signing as the exit authority (the message's
/// destinationCaller), so TokenMessengerMinterV2 pays `count x denomination` into exit custody;
/// then stores the batch root in a new `ExitBatch`. Not affected by the deposit pause.
///
/// Before the CPI the message is checked as the portal checks a batch (`exit_message::parse`):
/// source domain 0, sender Ethereum's TokenMessengerV2, recipient TMM, destinationCaller the exit
/// authority, mintRecipient exit custody, messageSender the portal, finalized and fee-free, hook
/// version 2 with a known denomination, 1..=256 exits, a canonical root and amount = count x
/// denomination. CCTP then verifies the attestation over the same bytes, and the custody must
/// grow by exactly that amount. A message is received once: CCTP's used-nonce PDA and the
/// `ExitBatch` PDA (one per denomination and exit epoch) both refuse a second time.
///
/// The CCTP program ids and the mint-independent CCTP accounts are pinned; `local_token`,
/// `token_pair`, `custody`, the fee recipient's account and `used_nonce` are checked by CCTP
/// (PDA seeds, mint equality). The relayer only chooses *when*.
///
/// Transaction size: with its 21 accounts, a 427-byte message and a 130-byte attestation the
/// instruction does not fit a legacy transaction (1,232 bytes); clients send it as a v0
/// transaction with an address lookup table holding the static accounts (ADR 0009).
#[derive(Accounts)]
#[instruction(message: Vec<u8>)]
pub struct ReceiveExit<'info> {
    /// Relayer: pays the `ExitBatch` rent and CCTP's used-nonce rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: PDA ["exit_authority"]. Signs only the receive_message CPI here (as `caller`).
    #[account(seeds = [EXIT_AUTHORITY_SEED], bump = config.exit_authority_bump)]
    pub exit_authority: UncheckedAccount<'info>,
    #[account(mut, address = config.exit_custody)]
    pub exit_custody: Box<Account<'info, TokenAccount>>,
    /// Created here; its seeds come from the message's hook (`exit_message::batch_seed_*`).
    #[account(
        init,
        payer = payer,
        space = 8 + ExitBatch::INIT_SPACE,
        seeds = [
            EXIT_BATCH_SEED,
            &exit_message::batch_seed_index(&message, &config.denominations),
            &exit_message::batch_seed_epoch(&message),
        ],
        bump,
    )]
    pub exit_batch: Box<Account<'info, ExitBatch>>,
    /// CHECK: pinned. MessageTransmitterV2 state; MT verifies the attestation against its
    /// enabled attesters and threshold.
    #[account(address = CCTP_MESSAGE_TRANSMITTER_STATE)]
    pub cctp_message_transmitter: UncheckedAccount<'info>,
    /// CHECK: MT PDA ["used_nonce", nonce], created by MT (seeds verified by MT).
    #[account(mut)]
    pub cctp_used_nonce: UncheckedAccount<'info>,
    /// CHECK: pinned. MT PDA ["message_transmitter_authority", TMM].
    #[account(address = CCTP_MT_AUTHORITY_TMM)]
    pub cctp_authority_pda: UncheckedAccount<'info>,
    /// CHECK: pinned. MT PDA ["__event_authority"].
    #[account(address = CCTP_MT_EVENT_AUTHORITY)]
    pub cctp_mt_event_authority: UncheckedAccount<'info>,
    /// CHECK: pinned. TMM PDA ["token_messenger"].
    #[account(address = CCTP_TOKEN_MESSENGER)]
    pub cctp_token_messenger: UncheckedAccount<'info>,
    /// CHECK: pinned, owned by TMM. TMM PDA ["remote_token_messenger", "0"]: its token messenger is
    /// the only accepted sender.
    #[account(
        address = CCTP_REMOTE_TOKEN_MESSENGER_ETHEREUM,
        owner = CCTP_TOKEN_MESSENGER_MINTER_V2,
    )]
    pub cctp_remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: pinned. TMM PDA ["token_minter"].
    #[account(address = CCTP_TOKEN_MINTER)]
    pub cctp_token_minter: UncheckedAccount<'info>,
    /// CHECK: TMM PDA ["local_token", usdc_mint], verified by TMM.
    #[account(mut)]
    pub cctp_local_token: UncheckedAccount<'info>,
    /// CHECK: TMM PDA ["token_pair", "0", burn_token], verified by TMM.
    pub cctp_token_pair: UncheckedAccount<'info>,
    /// CHECK: USDC ATA of `token_messenger.fee_recipient`, verified by TMM (no fee is paid).
    #[account(mut)]
    pub cctp_fee_recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: TMM PDA ["custody", usdc_mint]: Circle's USDC, paid out by TMM; verified by TMM.
    #[account(mut)]
    pub cctp_custody: UncheckedAccount<'info>,
    /// CHECK: pinned. TMM PDA ["__event_authority"].
    #[account(address = CCTP_TMM_EVENT_AUTHORITY)]
    pub cctp_tmm_event_authority: UncheckedAccount<'info>,
    /// CHECK: pinned program id.
    #[account(address = CCTP_MESSAGE_TRANSMITTER_V2)]
    pub cctp_message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: pinned program id.
    #[account(address = CCTP_TOKEN_MESSENGER_MINTER_V2)]
    pub cctp_token_messenger_minter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_receive_exit(
    ctx: Context<ReceiveExit>,
    message: Vec<u8>,
    attestation: Vec<u8>,
) -> Result<()> {
    let a = &ctx.accounts;
    let eth_token_messenger = exit_message::remote_token_messenger(
        &a.cctp_remote_token_messenger.try_borrow_data()?[..],
    )?;
    let exit = exit_message::parse(
        &message,
        &ExitExpected {
            eth_token_messenger,
            exit_authority: a.exit_authority.key(),
            exit_custody: a.exit_custody.key(),
            portal: a.config.portal,
            denominations: a.config.denominations,
        },
    )?;
    let before = a.exit_custody.amount;

    // MessageTransmitterV2::receive_message(ReceiveMessageParams { message, attestation }).
    let mut data = Vec::with_capacity(16 + message.len() + attestation.len());
    data.extend_from_slice(&CCTP_RECEIVE_MESSAGE);
    data.extend_from_slice(&(message.len() as u32).to_le_bytes());
    data.extend_from_slice(&message);
    data.extend_from_slice(&(attestation.len() as u32).to_le_bytes());
    data.extend_from_slice(&attestation);
    let tmm = a.cctp_token_messenger_minter_program.key();
    let ix = Instruction {
        program_id: a.cctp_message_transmitter_program.key(),
        accounts: vec![
            AccountMeta::new(a.payer.key(), true),
            AccountMeta::new_readonly(a.exit_authority.key(), true), // caller = destinationCaller
            AccountMeta::new_readonly(a.cctp_authority_pda.key(), false),
            AccountMeta::new_readonly(a.cctp_message_transmitter.key(), false),
            AccountMeta::new(a.cctp_used_nonce.key(), false),
            AccountMeta::new_readonly(tmm, false), // receiver
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(a.cctp_mt_event_authority.key(), false),
            AccountMeta::new_readonly(a.cctp_message_transmitter_program.key(), false),
            // Remaining accounts: TMM handle_receive_finalized_message, after MT's authority.
            AccountMeta::new_readonly(a.cctp_token_messenger.key(), false),
            AccountMeta::new_readonly(a.cctp_remote_token_messenger.key(), false),
            AccountMeta::new_readonly(a.cctp_token_minter.key(), false),
            AccountMeta::new(a.cctp_local_token.key(), false),
            AccountMeta::new_readonly(a.cctp_token_pair.key(), false),
            AccountMeta::new(a.cctp_fee_recipient_token_account.key(), false),
            AccountMeta::new(a.exit_custody.key(), false), // recipient_token_account
            AccountMeta::new(a.cctp_custody.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.cctp_tmm_event_authority.key(), false),
            AccountMeta::new_readonly(tmm, false), // event_cpi `program`
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.payer.to_account_info(),
            a.exit_authority.to_account_info(),
            a.cctp_authority_pda.to_account_info(),
            a.cctp_message_transmitter.to_account_info(),
            a.cctp_used_nonce.to_account_info(),
            a.cctp_token_messenger_minter_program.to_account_info(),
            a.system_program.to_account_info(),
            a.cctp_mt_event_authority.to_account_info(),
            a.cctp_message_transmitter_program.to_account_info(),
            a.cctp_token_messenger.to_account_info(),
            a.cctp_remote_token_messenger.to_account_info(),
            a.cctp_token_minter.to_account_info(),
            a.cctp_local_token.to_account_info(),
            a.cctp_token_pair.to_account_info(),
            a.cctp_fee_recipient_token_account.to_account_info(),
            a.exit_custody.to_account_info(),
            a.cctp_custody.to_account_info(),
            a.token_program.to_account_info(),
            a.cctp_tmm_event_authority.to_account_info(),
        ],
        &[&[EXIT_AUTHORITY_SEED, &[a.config.exit_authority_bump]]],
    )?;

    // Exactly the batch arrived, as the portal checks for a forward batch.
    ctx.accounts.exit_custody.reload()?;
    let received = ctx
        .accounts
        .exit_custody
        .amount
        .checked_sub(before)
        .ok_or(GatewayError::ExitAmountMismatch)?;
    require!(received == exit.amount, GatewayError::ExitAmountMismatch);

    let slot = Clock::get()?.slot;
    let bump = ctx.bumps.exit_batch;
    ctx.accounts.exit_batch.set_inner(ExitBatch {
        denomination_index: exit.denomination_index,
        denomination: exit.hook.denomination,
        exit_epoch_id: exit.hook.exit_epoch_id,
        root: exit.hook.root,
        count: exit.hook.count,
        claimed_count: 0,
        claimed: [0; 32],
        cctp_nonce: exit.nonce,
        received_slot: slot,
        bump,
    });
    emit!(ExitReceived {
        denomination: exit.hook.denomination,
        exit_epoch_id: exit.hook.exit_epoch_id,
        count: exit.hook.count,
        root: exit.hook.root,
        amount: exit.amount,
        cctp_nonce: exit.nonce,
    });
    Ok(())
}
