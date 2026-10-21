use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::GatewayError,
    events::{BatchSent, ExpressDeposited},
    instructions::send_batch::{
        batch_hook, burn_to_portal, pay_batch_fees, BurnAccounts, FeeAccounts,
    },
    state::*,
};

/// Cross now (ADR 0015): one note in its own express epoch, closed here with a single leaf and
/// ready for `send_express_batch` at once. Normal epochs are untouched: an express crossing never
/// closes or shrinks anyone else's batch.
///
/// The note pays its denomination into the escrow and the ADR 0012 fee into the fee vault, as a
/// deposit does. The express fee (`lanes.params.express_fee`, paid to the finisher at send) comes
/// from the crossing pool while the pool holds at least that much ("on us"); otherwise from the
/// user, and only up to `max_express_fee`, so a pool that ran dry since the app showed "on us"
/// cannot charge anyone by surprise. Same deposit pause, deposit cap and screening (ADR 0019) as
/// `deposit`.
#[derive(Accounts)]
#[instruction(denomination_index: u8)]
pub struct DepositExpress<'info> {
    /// Pays the express epoch's rent (about 0.002 SOL).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns `source`; recorded as the depositor.
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LANES_SEED], bump = lanes.bump)]
    pub lanes: Box<Account<'info, Lanes>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ExpressEpoch::INIT_SPACE,
        seeds = [EXPRESS_SEED, &[denomination_index], &lanes.express_id(denomination_index).to_le_bytes()],
        bump,
    )]
    pub express: Box<Account<'info, ExpressEpoch>>,
    #[account(mut, token::mint = usdc_mint, token::authority = authority)]
    pub source: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.escrow)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = lanes.crossing_pool)]
    pub crossing_pool: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: the screening record of `authority` (ADR 0019), PDA ["blocked", authority]. Empty
    /// unless the guardian listed that address; the deposit is refused when it holds a record.
    /// Last, so clients that pass it also work with a gateway built before it (extra accounts are
    /// ignored there).
    #[account(seeds = [BLOCKED_SEED, authority.key().as_ref()], bump)]
    pub blocked: UncheckedAccount<'info>,
}

pub fn handle_deposit_express(
    ctx: Context<DepositExpress>,
    denomination_index: u8,
    secret_hash: [u8; 32],
    max_express_fee: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let denomination = config.denomination(denomination_index)?;
    let now = Clock::get()?.unix_timestamp;
    require!(!config.deposits_paused(now), GatewayError::DepositsPaused);
    require!(
        !is_blocked(&ctx.accounts.blocked),
        GatewayError::DepositorBlocked
    );
    let net_deposits = config
        .net_deposits
        .checked_add(denomination)
        .ok_or(GatewayError::Overflow)?;
    require!(
        net_deposits <= config.params.deposit_cap,
        GatewayError::DepositCapReached
    );
    require!(
        eclyps_merkle::is_canonical(&secret_hash) && secret_hash != eclyps_merkle::ZERO_LEAF,
        GatewayError::InvalidLeaf
    );
    let fee = bps_of(denomination, config.params.fee_bps);
    let finisher_fee = bps_of(denomination, config.params.finisher_bps);
    let express_fee = ctx.accounts.lanes.params.express_fee;
    let paid_by_pool = express_fee > 0 && ctx.accounts.crossing_pool.amount >= express_fee;
    if !paid_by_pool {
        require!(
            express_fee <= max_express_fee,
            GatewayError::ExpressFeeTooHigh
        );
    }

    let a = &ctx.accounts;
    user_pays(a, a.escrow.to_account_info(), denomination)?;
    let from_user = if paid_by_pool { fee } else { fee + express_fee };
    if from_user > 0 {
        user_pays(a, a.fee_vault.to_account_info(), from_user)?;
    }
    if paid_by_pool {
        token::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.crossing_pool.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.fee_vault.to_account_info(),
                    authority: a.config.to_account_info(),
                },
                &[&[CONFIG_SEED, &[a.config.bump]]],
            ),
            express_fee,
            a.usdc_mint.decimals,
        )?;
    }

    let root = eclyps_merkle::root_streaming(&[secret_hash], eclyps_merkle::BATCH_TREE_DEPTH)
        .map_err(|_| GatewayError::MerkleFailed)?;
    let lanes = &mut ctx.accounts.lanes;
    let express_id = lanes.express_id(denomination_index);
    let idx = denomination_index as usize;
    lanes.express_next[idx] = lanes.express_next[idx]
        .checked_add(1)
        .ok_or(GatewayError::Overflow)?;
    if paid_by_pool {
        lanes.pool_paid = lanes.pool_paid.saturating_add(express_fee);
    }
    ctx.accounts.config.net_deposits = net_deposits;
    let bump = ctx.bumps.express;
    let depositor = ctx.accounts.authority.key();
    ctx.accounts.express.set_inner(ExpressEpoch {
        version: LANES_VERSION,
        bump,
        denomination_index,
        denomination,
        express_id,
        opened_slot: Clock::get()?.slot,
        status: EpochStatus::Closed,
        root,
        leaf: secret_hash,
        depositor,
        fee,
        finisher_fee,
        express_fee,
        paid_by_pool,
        reserved: [0; 16],
    });
    emit!(ExpressDeposited {
        denomination,
        express_id,
        leaf: secret_hash,
        root,
        fee,
        express_fee,
        paid_by_pool,
    });
    Ok(())
}

/// `amount` from the depositor's `source` to one of the gateway's vaults.
fn user_pays<'info>(a: &DepositExpress<'info>, to: AccountInfo<'info>, amount: u64) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.source.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to,
                authority: a.authority.to_account_info(),
            },
        ),
        amount,
        a.usdc_mint.decimals,
    )
}

/// Permissionless (finishers): `send_batch` for an express epoch. Burns its one denomination
/// through CCTP with the batch hook (epoch id = express id, EXPRESS_EPOCH_BIT set), then pays the
/// finisher its share of the note's fee plus the express fee, and the treasury the rest.
#[derive(Accounts)]
#[instruction(denomination_index: u8, express_id: u64)]
pub struct SendExpressBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [EXPRESS_SEED, &[denomination_index], &express_id.to_le_bytes()],
        bump = express.bump,
    )]
    pub express: Box<Account<'info, ExpressEpoch>>,
    #[account(mut, address = config.escrow)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = payer)]
    pub finisher_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: pinned to `config.params.treasury`; see `SendBatch::treasury`.
    #[account(mut, address = config.params.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    /// CHECK: verified by CCTP, as in `SendBatch`.
    pub cctp_sender_authority: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
    pub cctp_denylist: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
    #[account(mut)]
    pub cctp_message_transmitter: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
    pub cctp_token_messenger: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
    pub cctp_remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
    pub cctp_token_minter: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
    #[account(mut)]
    pub cctp_local_token: UncheckedAccount<'info>,
    /// CHECK: verified by CCTP.
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

pub fn handle_send_express_batch(
    ctx: Context<SendExpressBatch>,
    _denomination_index: u8,
    _express_id: u64,
) -> Result<()> {
    let a = &ctx.accounts;
    let x = &a.express;
    require!(
        x.status == EpochStatus::Closed,
        GatewayError::ExpressNotClosed
    );
    let hook = batch_hook(x.denomination, x.express_id, 1, &x.root);
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
        x.denomination,
        &hook,
    )?;
    pay_batch_fees(
        &FeeAccounts {
            config: &a.config,
            fee_vault: a.fee_vault.to_account_info(),
            finisher_usdc: a.finisher_usdc.to_account_info(),
            treasury: a.treasury.to_account_info(),
            usdc_mint: &a.usdc_mint,
            token_program: a.token_program.to_account_info(),
        },
        x.denomination,
        x.express_id,
        x.fee,
        x.finisher_fee,
        x.express_fee,
    )?;
    let x = &mut ctx.accounts.express;
    x.status = EpochStatus::Sent;
    emit!(BatchSent {
        denomination: x.denomination,
        epoch_id: x.express_id,
        leaf_count: 1,
        total: x.denomination,
        root: x.root,
        hook,
    });
    Ok(())
}
