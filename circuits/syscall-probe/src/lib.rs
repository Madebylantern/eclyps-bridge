//! Minimal SBF program used by S3 to check that the on-chain `sol_poseidon`
//! syscall reproduces `circuits/vectors/merkle.json` and to measure its cost.
//!
//! Instruction data:
//! - `[0, depth, leaf_0 .. leaf_n]`: return data = batch root over the leaves.
//! - `[1, n, a, b]`: hashes `(a, b)` n times (cost per hash); return data = last hash.

use eclyps_merkle::{hash_pair, root_in_place, Hash};
use solana_account_info::AccountInfo;
use solana_cpi::set_return_data;
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;

#[cfg(not(feature = "no-entrypoint"))]
solana_program_entrypoint::entrypoint!(process_instruction);

fn read_leaves(data: &[u8]) -> Result<Vec<Hash>, ProgramError> {
    if !data.len().is_multiple_of(32) {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(data
        .chunks_exact(32)
        .map(|c| c.try_into().expect("chunk is 32 bytes"))
        .collect())
}

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (&mode, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    let (&arg, rest) = rest
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    let mut leaves = read_leaves(rest)?;
    let out = match mode {
        0 => root_in_place(&mut leaves, arg as usize)
            .map_err(|_| ProgramError::InvalidInstructionData)?,
        1 if leaves.len() == 2 => {
            let mut h = [0u8; 32];
            for _ in 0..arg {
                h = hash_pair(&leaves[0], &leaves[1])
                    .map_err(|_| ProgramError::InvalidInstructionData)?;
            }
            h
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    set_return_data(&out);
    Ok(())
}
