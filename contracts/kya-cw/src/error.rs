use cosmwasm_std::{StdError, Uint128};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("unauthorized: only the owner can do this")]
    Unauthorized {},

    #[error("no mandate for agent {agent}")]
    NoMandate { agent: String },

    #[error("mandate revoked")]
    Revoked {},

    #[error("mandate expired")]
    Expired {},

    #[error("recipient {to} is not in allowed_recipients")]
    RecipientNotAllowed { to: String },

    #[error("amount {amount} exceeds per-tx limit {limit}")]
    OverPerTxLimit { amount: Uint128, limit: Uint128 },

    #[error("amount {amount} exceeds remaining period allowance {remaining}")]
    OverPeriodLimit { amount: Uint128, remaining: Uint128 },

    #[error("contract balance {balance} is less than {amount}")]
    InsufficientBudget { amount: Uint128, balance: Uint128 },

    #[error("owner has no ME ID on chain: {reason}")]
    OwnerNoMeId { reason: String },

    #[error("owner ME ID not eligible: status={status} kyc_level={kyc_level} (need ACTIVE and >= {min})")]
    OwnerNotEligible { status: String, kyc_level: u8, min: u8 },

    #[error("invalid: {msg}")]
    Invalid { msg: String },
}
