use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::GatewayError,
    events::{BatchFeesPaid, BatchSent},
    state::*,
};

/// Permissionless (finishers). Burns a closed batch's USDC from escrow through Circle CCTP V2
/// `deposit_for_burn_with_hook` with the config PDA as owner, carrying the 51-byte batch hook to
/// the Ethereum portal (ADR 0002), then pays the batch's fees out of the fee vault: the
/// finisher's share to the payer's USDC account, the rest to the treasury (ADR 0012). Not
/// affected by the deposit pause.
///
/// Safety: the CCTP program ids are pinned and the amount, destination domain, mint recipient,
/// destination caller, fee and finality all come from program state, so a finisher can only
/// choose *when* a batch is sent, never where or how much. The remaining CCTP state accounts are
/// validated by TokenMessengerMinterV2 itself (PDA seeds / has_one). The fee amounts come from
/// the epoch's snapshot; the finisher only chooses which of its own USDC accounts is paid.
#[derive(Accounts)]
#[instruction(denomination_index: u8, epoch_id: u64)]
pub struct SendBatch<'info> {
    /// Finisher; pays the CCTP MessageSent rent (~0.0042 SOL, reclaimable after 5 days) and
    /// receives the finisher share of the batch's fees.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, &[denomination_index], &epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,
    #[account(mut, address = config.escrow)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    /// The finisher's USDC account: the finisher share is paid here.
    #[account(mut, token::mint = usdc_mint, token::authority = payer)]
    pub finisher_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: pinned to `config.params.treasury`. Not deserialized by Anchor on purpose: if it
    /// cannot receive USDC (closed, frozen, another mint), its share goes to the finisher instead,
    /// so a treasury problem never blocks a batch (`treasury_can_receive`).
    #[account(mut, address = config.params.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// Fresh keypair; CCTP's MessageTransmitter creates the MessageSent account here.
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    /// CHECK: TokenMessengerMinterV2 PDA `["sender_authority"]`, verified by CCTP.
    pub cctp_sender_authority: UncheckedAccount<'info>,
    /// CHECK: TMM PDA `["denylist_account", config]`; must not exist (verified by CCTP).
    pub cctp_denylist: UncheckedAccount<'info>,
    /// CHECK: MessageTransmitterV2 PDA `["message_transmitter"]`, verified by CCTP.
    #[account(mut)]
    pub cctp_message_transmitter: UncheckedAccount<'info>,
    /// CHECK: TMM PDA `["token_messenger"]`, verified by CCTP.
    pub cctp_token_messenger: UncheckedAccount<'info>,
    /// CHECK: TMM PDA `["remote_token_messenger", "0"]`; CCTP checks its domain matches.
    pub cctp_remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: TMM PDA `["token_minter"]`, verified by CCTP.
    pub cctp_token_minter: UncheckedAccount<'info>,
    /// CHECK: TMM PDA `["local_token", usdc_mint]`, verified by CCTP.
    #[account(mut)]
    pub cctp_local_token: UncheckedAccount<'info>,
    /// CHECK: TMM PDA `["__event_authority"]` (Anchor event CPI), verified by CCTP.
    pub cctp_event_authority: UncheckedAccount<'info>,
    /// CHECK: pinned program id.
    #[account(address = CCTP_MESSAGE_TRANSMITTER_V2)]
    pub cctp_message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: pinned program id.
    #[account(address = CCTP_TOKEN_MESSENGER_MINTER_V2)]
    pub cctp_token_messenger_minter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_send_batch(
    ctx: Context<SendBatch>,
    _denomination_index: u8,
    _epoch_id: u64,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.epoch.status == EpochStatus::Closed,
        GatewayError::EpochNotClosed
    );
    let leaf_count = a.epoch.leaves.len() as u16;
    let total = a
        .epoch
        .denomination
        .checked_mul(leaf_count as u64)
        .ok_or(GatewayError::Overflow)?;
    let hook = batch_hook(
        a.epoch.denomination,
        a.epoch.epoch_id,
        leaf_count,
        &a.epoch.root,
    );
    burn_to_portal(
        &BurnAccounts {
            config: &a.config,
            payer: a.payer.to_account_info(),
            escrow: a.escrow.to_account_info(),
            usdc_mint: a.usdc_mint.to_account_info(),
            message_sent_event_data: a.message_sent_event_data.to_account_info(),
            cctp_sender_authority: a.cctp_sender_authority.to_account_info(),
            cctp_denylist: a.cctp_denylist.to_account_info(),
            cctp_message_transmitter: a.cctp_message_transmitter.to_account_info(),
            cctp_token_messenger: a.cctp_token_messenger.to_account_info(),
            cctp_remote_token_messenger: a.cctp_remote_token_messenger.to_account_info(),
            cctp_token_minter: a.cctp_token_minter.to_account_info(),
            cctp_local_token: a.cctp_local_token.to_account_info(),
            cctp_event_authority: a.cctp_event_authority.to_account_info(),
            cctp_message_transmitter_program: a.cctp_message_transmitter_program.to_account_info(),
            cctp_token_messenger_minter_program: a
                .cctp_token_messenger_minter_program
                .to_account_info(),
            token_program: a.token_program.to_account_info(),
            system_program: a.system_program.to_account_info(),
        },
        total,
        &hook,
    )?;

    // The batch's fees, at its epoch's snapshot. The treasury gets the rest of each note's fee,
    // rounding included, so the two shares add up to exactly what the deposits paid.
    let n = leaf_count as u64;
    let fees = a
        .epoch
        .fee_per_note()
        .checked_mul(n)
        .ok_or(GatewayError::Overflow)?;
    let finisher_amount = a
        .epoch
        .finisher_fee_per_note()
        .checked_mul(n)
        .ok_or(GatewayError::Overflow)?;
    pay_batch_fees(
        &FeeAccounts {
            config: &a.config,
            fee_vault: a.fee_vault.to_account_info(),
            finisher_usdc: a.finisher_usdc.to_account_info(),
            treasury: a.treasury.to_account_info(),
            usdc_mint: &a.usdc_mint,
            token_program: a.token_program.to_account_info(),
        },
        a.epoch.denomination,
        a.epoch.epoch_id,
        fees,
        finisher_amount,
        0,
    )?;

    let epoch = &mut ctx.accounts.epoch;
    epoch.status = EpochStatus::Sent;
    emit!(BatchSent {
        denomination: epoch.denomination,
        epoch_id: epoch.epoch_id,
        leaf_count,
        total,
        root: epoch.root,
        hook,
    });
    Ok(())
}

/// The accounts a CCTP V2 burn of escrowed USDC to the portal reads (`send_batch`,
/// `send_express_batch`).
pub(crate) struct BurnAccounts<'a, 'info> {
    pub config: &'a Account<'info, Config>,
    pub payer: AccountInfo<'info>,
    pub escrow: AccountInfo<'info>,
    pub usdc_mint: AccountInfo<'info>,
    pub message_sent_event_data: AccountInfo<'info>,
    pub cctp_sender_authority: AccountInfo<'info>,
    pub cctp_denylist: AccountInfo<'info>,
    pub cctp_message_transmitter: AccountInfo<'info>,
    pub cctp_token_messenger: AccountInfo<'info>,
    pub cctp_remote_token_messenger: AccountInfo<'info>,
    pub cctp_token_minter: AccountInfo<'info>,
    pub cctp_local_token: AccountInfo<'info>,
    pub cctp_event_authority: AccountInfo<'info>,
    pub cctp_message_transmitter_program: AccountInfo<'info>,
    pub cctp_token_messenger_minter_program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
}

/// Burns `amount` from escrow through CCTP V2 `deposit_for_burn_with_hook`, signed by the config
/// PDA, to the configured portal (mint recipient and destination caller), standard finality, no
/// fee, carrying `hook` (ADR 0002).
pub(crate) fn burn_to_portal(b: &BurnAccounts, amount: u64, hook: &[u8; 51]) -> Result<()> {
    let mut data = Vec::with_capacity(100 + hook.len());
    data.extend_from_slice(&CCTP_DEPOSIT_FOR_BURN_WITH_HOOK);
    data.extend_from_slice(&amount.to_le_bytes()); // amount
    data.extend_from_slice(&CCTP_DOMAIN_ETHEREUM.to_le_bytes()); // destination_domain
    data.extend_from_slice(&b.config.portal); // mint_recipient
    data.extend_from_slice(&b.config.portal); // destination_caller
    data.extend_from_slice(&0u64.to_le_bytes()); // max_fee
    data.extend_from_slice(&CCTP_FINALITY_STANDARD.to_le_bytes()); // min_finality_threshold
    data.extend_from_slice(&(hook.len() as u32).to_le_bytes()); // hook_data: Vec<u8>
    data.extend_from_slice(hook);

    let tmm = b.cctp_token_messenger_minter_program.key();
    let ix = Instruction {
        program_id: tmm,
        accounts: vec![
            AccountMeta::new_readonly(b.config.key(), true), // owner (PDA signer)
            AccountMeta::new(b.payer.key(), true),           // event_rent_payer
            AccountMeta::new_readonly(b.cctp_sender_authority.key(), false),
            AccountMeta::new(b.escrow.key(), false), // burn_token_account
            AccountMeta::new_readonly(b.cctp_denylist.key(), false),
            AccountMeta::new(b.cctp_message_transmitter.key(), false),
            AccountMeta::new_readonly(b.cctp_token_messenger.key(), false),
            AccountMeta::new_readonly(b.cctp_remote_token_messenger.key(), false),
            AccountMeta::new_readonly(b.cctp_token_minter.key(), false),
            AccountMeta::new(b.cctp_local_token.key(), false),
            AccountMeta::new(b.usdc_mint.key(), false), // burn_token_mint
            AccountMeta::new(b.message_sent_event_data.key(), true),
            AccountMeta::new_readonly(b.cctp_message_transmitter_program.key(), false),
            AccountMeta::new_readonly(tmm, false),
            AccountMeta::new_readonly(b.token_program.key(), false),
            AccountMeta::new_readonly(b.system_program.key(), false),
            AccountMeta::new_readonly(b.cctp_event_authority.key(), false),
            AccountMeta::new_readonly(tmm, false), // event_cpi `program`
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            b.config.to_account_info(),
            b.payer.clone(),
            b.cctp_sender_authority.clone(),
            b.escrow.clone(),
            b.cctp_denylist.clone(),
            b.cctp_message_transmitter.clone(),
            b.cctp_token_messenger.clone(),
            b.cctp_remote_token_messenger.clone(),
            b.cctp_token_minter.clone(),
            b.cctp_local_token.clone(),
            b.usdc_mint.clone(),
            b.message_sent_event_data.clone(),
            b.cctp_message_transmitter_program.clone(),
            b.cctp_token_messenger_minter_program.clone(),
            b.token_program.clone(),
            b.system_program.clone(),
            b.cctp_event_authority.clone(),
        ],
        &[&[CONFIG_SEED, &[b.config.bump]]],
    )?;
    Ok(())
}

/// The accounts a batch's fee payout reads.
pub(crate) struct FeeAccounts<'a, 'info> {
    pub config: &'a Account<'info, Config>,
    pub fee_vault: AccountInfo<'info>,
    pub finisher_usdc: AccountInfo<'info>,
    pub treasury: AccountInfo<'info>,
    pub usdc_mint: &'a Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
}

/// Pays a batch's fees out of the fee vault: `finisher_amount + extra_to_finisher` to the
/// finisher, the rest of `fees` to the treasury (all of `fees` to the finisher when the treasury
/// cannot receive). `extra_to_finisher` is the express fee (ADR 0015); 0 for a normal batch.
pub(crate) fn pay_batch_fees(
    f: &FeeAccounts,
    denomination: u64,
    epoch_id: u64,
    fees: u64,
    finisher_amount: u64,
    extra_to_finisher: u64,
) -> Result<()> {
    let treasury_skipped = !treasury_can_receive(&f.treasury, f.config);
    let finisher_share = if treasury_skipped {
        fees
    } else {
        finisher_amount
    };
    let treasury_amount = fees - finisher_share;
    let finisher_amount = finisher_share
        .checked_add(extra_to_finisher)
        .ok_or(GatewayError::Overflow)?;
    if finisher_amount > 0 {
        pay_fee(f, f.finisher_usdc.clone(), finisher_amount)?;
    }
    if treasury_amount > 0 {
        pay_fee(f, f.treasury.clone(), treasury_amount)?;
    }
    emit!(BatchFeesPaid {
        denomination,
        epoch_id,
        finisher: f.finisher_usdc.key(),
        finisher_amount,
        treasury: f.treasury.key(),
        treasury_amount,
        treasury_skipped,
    });
    Ok(())
}

/// `amount` of the batch's fees from the fee vault (signed by the config PDA) to `to`.
fn pay_fee<'info>(f: &FeeAccounts<'_, 'info>, to: AccountInfo<'info>, amount: u64) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            f.token_program.key(),
            TransferChecked {
                from: f.fee_vault.clone(),
                mint: f.usdc_mint.to_account_info(),
                to,
                authority: f.config.to_account_info(),
            },
            &[&[CONFIG_SEED, &[f.config.bump]]],
        ),
        amount,
        f.usdc_mint.decimals,
    )
}

/// Whether the treasury account can receive USDC now: an initialized, unfrozen USDC account of
/// the token program, other than the gateway's own vaults.
fn treasury_can_receive(t: &AccountInfo, config: &Config) -> bool {
    if *t.owner != token::ID
        || *t.key == config.escrow
        || *t.key == config.fee_vault
        || *t.key == config.exit_custody
    {
        return false;
    }
    let Ok(data) = t.try_borrow_data() else {
        return false;
    };
    match TokenAccount::try_deserialize_unchecked(&mut &data[..]) {
        Ok(acc) => acc.mint == config.usdc_mint && !acc.is_frozen(),
        Err(_) => false,
    }
}

/// The 51-byte batch hook (ADR 0002): version | denomination | epoch_id | leaf_count | root,
/// big-endian. Mirrors `BatchHook.sol` and `encodeBatchHook` in the SDK.
pub fn batch_hook(denomination: u64, epoch_id: u64, leaf_count: u16, root: &[u8; 32]) -> [u8; 51] {
    let mut h = [0u8; 51];
    h[0] = BATCH_HOOK_VERSION;
    h[1..9].copy_from_slice(&denomination.to_be_bytes());
    h[9..17].copy_from_slice(&epoch_id.to_be_bytes());
    h[17..19].copy_from_slice(&leaf_count.to_be_bytes());
    h[19..51].copy_from_slice(root);
    h
}
