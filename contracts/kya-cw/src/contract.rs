#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, Addr, BankMsg, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Response, StdResult, Uint128,
};

use crate::did::{kyc_level_num, query_did, status_is_active};
use crate::error::ContractError;
use crate::msg::{AgentStatusResponse, ConfigResponse, ExecuteMsg, InstantiateMsg, MeIdView, QueryMsg};
use crate::state::{Config, Mandate, CONFIG, MANDATES};

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(deps: DepsMut, _env: Env, info: MessageInfo, msg: InstantiateMsg) -> Result<Response, ContractError> {
    if msg.denom.is_empty() {
        return Err(ContractError::Invalid { msg: "denom is empty".into() });
    }
    if msg.min_kyc_level > 2 {
        return Err(ContractError::Invalid { msg: "min_kyc_level must be 0..=2".into() });
    }
    CONFIG.save(deps.storage, &Config { owner: info.sender.clone(), denom: msg.denom, min_kyc_level: msg.min_kyc_level })?;
    Ok(Response::new().add_attribute("action", "instantiate").add_attribute("owner", info.sender))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Grant { agent, per_tx_limit, period_limit, period_seconds, expires_at, allowed_recipients } => {
            let cfg = only_owner(deps.as_ref(), &info)?;
            let agent = deps.api.addr_validate(&agent)?;
            if per_tx_limit.is_zero() || period_limit.is_zero() || per_tx_limit > period_limit {
                return Err(ContractError::Invalid { msg: "need 0 < per_tx_limit <= period_limit".into() });
            }
            if expires_at <= env.block.time.seconds() {
                return Err(ContractError::Invalid { msg: "expires_at must be in the future".into() });
            }
            let allowed = match allowed_recipients {
                None => None,
                Some(list) => Some(list.iter().map(|a| deps.api.addr_validate(a)).collect::<StdResult<Vec<Addr>>>()?),
            };
            let m = Mandate {
                per_tx_limit,
                period_limit,
                period_seconds,
                period_start: env.block.time.seconds(),
                spent_in_period: Uint128::zero(),
                expires_at,
                allowed_recipients: allowed,
                revoked: false,
                total_spent: Uint128::zero(),
            };
            MANDATES.save(deps.storage, &agent, &m)?;
            Ok(Response::new()
                .add_attribute("action", "grant")
                .add_attribute("owner", cfg.owner)
                .add_attribute("agent", agent)
                .add_attribute("per_tx_limit", per_tx_limit)
                .add_attribute("period_limit", period_limit)
                .add_attribute("expires_at", expires_at.to_string()))
        }
        ExecuteMsg::Revoke { agent } => {
            only_owner(deps.as_ref(), &info)?;
            let agent = deps.api.addr_validate(&agent)?;
            let mut m = MANDATES
                .may_load(deps.storage, &agent)?
                .ok_or(ContractError::NoMandate { agent: agent.to_string() })?;
            m.revoked = true;
            MANDATES.save(deps.storage, &agent, &m)?;
            Ok(Response::new().add_attribute("action", "revoke").add_attribute("agent", agent))
        }
        ExecuteMsg::Spend { to, amount, memo } => spend(deps, env, info, to, amount, memo),
        ExecuteMsg::Deposit {} => {
            only_owner(deps.as_ref(), &info)?;
            Ok(Response::new().add_attribute("action", "deposit"))
        }
        ExecuteMsg::Withdraw { amount } => {
            let cfg = only_owner(deps.as_ref(), &info)?;
            let bal = deps.querier.query_balance(&env.contract.address, &cfg.denom)?.amount;
            let amt = amount.unwrap_or(bal);
            if amt > bal {
                return Err(ContractError::InsufficientBudget { amount: amt, balance: bal });
            }
            let mut res = Response::new().add_attribute("action", "withdraw").add_attribute("amount", amt);
            if !amt.is_zero() {
                res = res.add_message(BankMsg::Send { to_address: cfg.owner.to_string(), amount: vec![Coin { denom: cfg.denom, amount: amt }] });
            }
            Ok(res)
        }
    }
}

fn only_owner(deps: Deps, info: &MessageInfo) -> Result<Config, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    if info.sender != cfg.owner {
        return Err(ContractError::Unauthorized {});
    }
    Ok(cfg)
}

/// 鏈上強制：店主要有 ACTIVE 的 ME ID，而且 KYC 等級夠
fn check_owner_me_id(deps: Deps, cfg: &Config) -> Result<(), ContractError> {
    let (info, err) = query_did(&deps.querier, cfg.owner.as_str())?;
    let info = info.ok_or(ContractError::OwnerNoMeId { reason: err.unwrap_or_default() })?;
    let lvl = kyc_level_num(&info.kyc_level);
    if !status_is_active(&info.status) || lvl < cfg.min_kyc_level {
        return Err(ContractError::OwnerNotEligible { status: info.status.clone(), kyc_level: lvl, min: cfg.min_kyc_level });
    }
    Ok(())
}

fn spend(deps: DepsMut, env: Env, info: MessageInfo, to: String, amount: Uint128, memo: Option<String>) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let agent = info.sender;
    let to = deps.api.addr_validate(&to)?;
    if amount.is_zero() {
        return Err(ContractError::Invalid { msg: "amount is zero".into() });
    }
    let mut m = MANDATES
        .may_load(deps.storage, &agent)?
        .ok_or(ContractError::NoMandate { agent: agent.to_string() })?;
    let now = env.block.time.seconds();
    if m.revoked {
        return Err(ContractError::Revoked {});
    }
    if now >= m.expires_at {
        return Err(ContractError::Expired {});
    }
    if let Some(list) = &m.allowed_recipients {
        if !list.contains(&to) {
            return Err(ContractError::RecipientNotAllowed { to: to.to_string() });
        }
    }
    if amount > m.per_tx_limit {
        return Err(ContractError::OverPerTxLimit { amount, limit: m.per_tx_limit });
    }
    m.roll(now);
    if amount > m.remaining() {
        return Err(ContractError::OverPeriodLimit { amount, remaining: m.remaining() });
    }
    let bal = deps.querier.query_balance(&env.contract.address, &cfg.denom)?.amount;
    if amount > bal {
        return Err(ContractError::InsufficientBudget { amount, balance: bal });
    }
    check_owner_me_id(deps.as_ref(), &cfg)?;

    m.spent_in_period += amount;
    m.total_spent += amount;
    MANDATES.save(deps.storage, &agent, &m)?;
    Ok(Response::new()
        .add_message(BankMsg::Send { to_address: to.to_string(), amount: vec![Coin { denom: cfg.denom, amount }] })
        .add_attribute("action", "spend")
        .add_attribute("agent", agent)
        .add_attribute("owner", cfg.owner)
        .add_attribute("to", to)
        .add_attribute("amount", amount)
        .add_attribute("remaining_in_period", m.remaining())
        .add_attribute("memo", memo.unwrap_or_default()))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    let cfg = CONFIG.load(deps.storage)?;
    let balance = deps.querier.query_balance(&env.contract.address, &cfg.denom)?;
    match msg {
        QueryMsg::Config {} => to_json_binary(&ConfigResponse { owner: cfg.owner.to_string(), denom: cfg.denom, min_kyc_level: cfg.min_kyc_level, balance }),
        QueryMsg::AgentStatus { agent } => {
            let agent = deps.api.addr_validate(&agent)?;
            let now = env.block.time.seconds();
            let (did, err) = query_did(&deps.querier, cfg.owner.as_str())?;
            let owner_me_id = match &did {
                Some(i) => MeIdView { found: true, did: Some(i.did.clone()), status: Some(i.status.clone()), kyc_level: Some(kyc_level_num(&i.kyc_level)), error: None },
                None => MeIdView { found: false, did: None, status: None, kyc_level: None, error: err },
            };
            let eligible = did.as_ref().map(|i| status_is_active(&i.status) && kyc_level_num(&i.kyc_level) >= cfg.min_kyc_level).unwrap_or(false);
            let resp = match MANDATES.may_load(deps.storage, &agent)? {
                None => AgentStatusResponse {
                    agent: agent.to_string(), owner: cfg.owner.to_string(), has_mandate: false, revoked: false, expired: false,
                    per_tx_limit: Uint128::zero(), period_limit: Uint128::zero(), remaining_in_period: Uint128::zero(), expires_at: 0,
                    allowed_recipients: None, total_spent: Uint128::zero(), owner_me_id, can_spend_now: false, contract_balance: balance,
                },
                Some(mut m) => {
                    m.roll(now);
                    let expired = now >= m.expires_at;
                    AgentStatusResponse {
                        agent: agent.to_string(), owner: cfg.owner.to_string(), has_mandate: true, revoked: m.revoked, expired,
                        per_tx_limit: m.per_tx_limit, period_limit: m.period_limit, remaining_in_period: m.remaining(), expires_at: m.expires_at,
                        allowed_recipients: m.allowed_recipients.as_ref().map(|l| l.iter().map(|a| a.to_string()).collect()),
                        total_spent: m.total_spent, owner_me_id,
                        can_spend_now: eligible && !m.revoked && !expired && !m.remaining().is_zero() && !balance.amount.is_zero(),
                        contract_balance: balance,
                    }
                }
            };
            to_json_binary(&resp)
        }
    }
}
