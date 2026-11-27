//! cw-multi-test 整合測試：授權 → 額度內付款 → 超額被擋 → 撤銷後被擋，加上店主 ME ID 檢查。
//! Stargate `/metaearth.did.Query/Did` 用 mock，回應格式照 2026-11-24 測試網實際 JSON。

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use anyhow::bail;
use cosmwasm_std::{coins, Addr, Api, Binary, BlockInfo, CustomQuery, Querier, Storage, Uint128};
use cw_multi_test::error::AnyResult;
use cw_multi_test::{App, AppBuilder, AppResponse, ContractWrapper, CosmosRouter, Executor, Stargate};
use kya_cw::contract::{execute, instantiate, query};
use kya_cw::did::DID_QUERY_PATH;
use kya_cw::msg::{AgentStatusResponse, ExecuteMsg, InstantiateMsg, QueryMsg};
use kya_cw::ContractError;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use std::fmt::Debug;

const DENOM: &str = "umec";

/// address -> (status, kycLevel)；沒有的地址回 "did not found"
type DidTable = Rc<RefCell<HashMap<String, (&'static str, &'static str)>>>;

struct MockMeDid(DidTable);

impl Stargate for MockMeDid {
    fn execute<ExecC, QueryC>(
        &self,
        _api: &dyn Api,
        _storage: &mut dyn Storage,
        _router: &dyn CosmosRouter<ExecC = ExecC, QueryC = QueryC>,
        _block: &BlockInfo,
        _sender: Addr,
        type_url: String,
        _value: Binary,
    ) -> AnyResult<AppResponse>
    where
        ExecC: Debug + Clone + PartialEq + JsonSchema + DeserializeOwned + 'static,
        QueryC: CustomQuery + DeserializeOwned + 'static,
    {
        bail!("unexpected stargate msg {type_url}")
    }

    fn query(&self, _api: &dyn Api, _storage: &dyn Storage, _querier: &dyn Querier, _block: &BlockInfo, path: String, data: Binary) -> AnyResult<Binary> {
        if path != DID_QUERY_PATH {
            bail!("'{path}' path is not allowed from the contract");
        }
        // 解 protobuf QueryDid { string address = 1 }（測試用地址長度 < 128，長度是單一 byte）
        let d = data.as_slice();
        assert_eq!(d[0], 0x0a, "field 1 / wire type 2");
        assert_eq!(d[1] as usize, d.len() - 2, "length prefix");
        let addr = String::from_utf8(d[2..].to_vec())?;
        match self.0.borrow().get(&addr) {
            None => bail!("codespace: did, code: 2: DID not found"),
            Some((status, kyc)) => {
                let json = format!(
                    r#"{{"info":{{"did":"2605105872869","address":"{addr}","pubkey":"","status":"{status}","regionId":"me_earth","kycLevel":"{kyc}","sub_account":""}}}}"#
                );
                Ok(Binary::from(json.into_bytes()))
            }
        }
    }
}

type MeApp = App<
    cw_multi_test::BankKeeper,
    cosmwasm_std::testing::MockApi,
    cosmwasm_std::testing::MockStorage,
    cw_multi_test::FailingModule<cosmwasm_std::Empty, cosmwasm_std::Empty, cosmwasm_std::Empty>,
    cw_multi_test::WasmKeeper<cosmwasm_std::Empty, cosmwasm_std::Empty>,
    cw_multi_test::StakeKeeper,
    cw_multi_test::DistributionKeeper,
    cw_multi_test::IbcFailingModule,
    cw_multi_test::GovFailingModule,
    MockMeDid,
>;

struct Env {
    app: MeApp,
    dids: DidTable,
    contract: Addr,
    owner: Addr,
    agent: Addr,
    seller: Addr,
    stranger: Addr,
}

fn setup(min_kyc_level: u8, owner_did: Option<(&'static str, &'static str)>) -> Env {
    setup_inner(min_kyc_level, owner_did, None)
}

fn setup_inner(min_kyc_level: u8, owner_did: Option<(&'static str, &'static str)>, subject: Option<(&'static str, &'static str, &'static str)>) -> Env {
    let owner = Addr::unchecked("owner");
    let agent = Addr::unchecked("agent");
    let seller = Addr::unchecked("seller");
    let stranger = Addr::unchecked("stranger");
    let dids: DidTable = Rc::new(RefCell::new(HashMap::new()));
    if let Some(d) = owner_did {
        dids.borrow_mut().insert(owner.to_string(), d);
    }
    if let Some((addr, st, kyc)) = subject {
        dids.borrow_mut().insert(addr.to_string(), (st, kyc));
    }
    let o = owner.clone();
    let mut app = AppBuilder::default().with_stargate(MockMeDid(dids.clone())).build(|router, _api, storage| {
        router.bank.init_balance(storage, &o, coins(1_000_000_000, DENOM)).unwrap();
    });
    let code_id = app.store_code(Box::new(ContractWrapper::new(execute, instantiate, query)));
    let contract = app
        .instantiate_contract(code_id, owner.clone(), &inst_msg(min_kyc_level, subject.map(|s| s.0)), &coins(50_000_000, DENOM), "kya", None)
        .unwrap();
    Env { app, dids, contract, owner, agent, seller, stranger }
}

fn grant(e: &mut Env, allowed: Option<Vec<String>>, ttl: u64) -> AnyResult<AppResponse> {
    let expires_at = e.app.block_info().time.seconds() + ttl;
    e.app.execute_contract(
        e.owner.clone(),
        e.contract.clone(),
        &ExecuteMsg::Grant {
            agent: e.agent.to_string(),
            per_tx_limit: Uint128::new(10_000_000),
            period_limit: Uint128::new(15_000_000),
            period_seconds: 86_400,
            expires_at,
            allowed_recipients: allowed,
        },
        &[],
    )
}

fn spend(e: &mut Env, to: &Addr, amount: u128) -> AnyResult<AppResponse> {
    e.app.execute_contract(e.agent.clone(), e.contract.clone(), &ExecuteMsg::Spend { to: to.to_string(), amount: Uint128::new(amount), memo: Some("t".into()) }, &[])
}

fn err_of(r: AnyResult<AppResponse>) -> ContractError {
    r.unwrap_err().downcast::<ContractError>().expect("ContractError")
}

fn bal(e: &Env, a: &Addr) -> u128 {
    e.app.wrap().query_balance(a, DENOM).unwrap().amount.u128()
}

#[test]
fn full_flow_grant_spend_overlimit_revoke() {
    let mut e = setup(1, Some(("DID_STATUS_ACTIVE", "KYC_LEVEL_TWO")));
    let allowed = vec![e.seller.to_string()];
    grant(&mut e, Some(allowed), 7 * 86_400).unwrap();

    // 額度內付款
    let seller = e.seller.clone();
    spend(&mut e, &seller, 5_000_000).unwrap();
    assert_eq!(bal(&e, &seller), 5_000_000);

    // 超過單筆上限
    assert_eq!(err_of(spend(&mut e, &seller, 20_000_000)), ContractError::OverPerTxLimit { amount: Uint128::new(20_000_000), limit: Uint128::new(10_000_000) });
    // 超過每期剩餘額度（15 - 5 = 10）
    assert_eq!(err_of(spend(&mut e, &seller, 10_000_001)), ContractError::OverPerTxLimit { amount: Uint128::new(10_000_001), limit: Uint128::new(10_000_000) });
    spend(&mut e, &seller, 10_000_000).unwrap();
    assert_eq!(err_of(spend(&mut e, &seller, 1)), ContractError::OverPeriodLimit { amount: Uint128::new(1), remaining: Uint128::zero() });

    // 不在 allowed_recipients
    let stranger = e.stranger.clone();
    assert!(matches!(err_of(spend(&mut e, &stranger, 1)), ContractError::RecipientNotAllowed { .. }));

    // 下一期額度重置
    e.app.update_block(|b| b.time = b.time.plus_seconds(86_400));
    spend(&mut e, &seller, 1_000_000).unwrap();

    // 撤銷後被擋
    e.app.execute_contract(e.owner.clone(), e.contract.clone(), &ExecuteMsg::Revoke { agent: e.agent.to_string() }, &[]).unwrap();
    assert_eq!(err_of(spend(&mut e, &seller, 1)), ContractError::Revoked {});

    let s: AgentStatusResponse = e.app.wrap().query_wasm_smart(&e.contract, &QueryMsg::AgentStatus { agent: e.agent.to_string() }).unwrap();
    assert!(s.revoked && !s.can_spend_now && s.owner_me_id.found);
    assert_eq!(s.owner_me_id.kyc_level, Some(2));
    assert_eq!(s.total_spent, Uint128::new(16_000_000));
}

#[test]
fn owner_without_me_id_is_blocked_on_chain() {
    let mut e = setup(1, None);
    grant(&mut e, None, 3600).unwrap();
    let seller = e.seller.clone();
    assert!(matches!(err_of(spend(&mut e, &seller, 1)), ContractError::OwnerNoMeId { .. }));
    let s: AgentStatusResponse = e.app.wrap().query_wasm_smart(&e.contract, &QueryMsg::AgentStatus { agent: e.agent.to_string() }).unwrap();
    assert!(!s.owner_me_id.found && !s.can_spend_now);
}

#[test]
fn inactive_or_low_kyc_owner_is_blocked() {
    let mut e = setup(2, Some(("DID_STATUS_ACTIVE", "KYC_LEVEL_ONE")));
    grant(&mut e, None, 3600).unwrap();
    let seller = e.seller.clone();
    assert!(matches!(err_of(spend(&mut e, &seller, 1)), ContractError::OwnerNotEligible { kyc_level: 1, min: 2, .. }));

    // ME ID 被停用（例如 KYC 撤銷）→ 下一筆立即被擋
    let owner = e.owner.to_string();
    e.dids.borrow_mut().insert(owner.clone(), ("DID_STATUS_INACTIVE", "KYC_LEVEL_TWO"));
    assert!(matches!(err_of(spend(&mut e, &seller, 1)), ContractError::OwnerNotEligible { .. }));
    e.dids.borrow_mut().insert(owner, ("DID_STATUS_ACTIVE", "KYC_LEVEL_TWO"));
    spend(&mut e, &seller, 1).unwrap();
}

#[test]
fn expiry_and_owner_only() {
    let mut e = setup(0, Some(("DID_STATUS_ACTIVE", "KYC_LEVEL_NONE")));
    grant(&mut e, None, 3600).unwrap();
    // 代理不能自己授權、撤銷、提款
    let agent = e.agent.clone();
    let c = e.contract.clone();
    assert_eq!(
        e.app.execute_contract(agent.clone(), c.clone(), &ExecuteMsg::Withdraw { amount: None }, &[]).unwrap_err().downcast::<ContractError>().unwrap(),
        ContractError::Unauthorized {}
    );
    e.app.update_block(|b| b.time = b.time.plus_seconds(3600));
    let seller = e.seller.clone();
    assert_eq!(err_of(spend(&mut e, &seller, 1)), ContractError::Expired {});
    // 店主取回全部預算
    let before = bal(&e, &e.owner.clone());
    e.app.execute_contract(e.owner.clone(), c, &ExecuteMsg::Withdraw { amount: None }, &[]).unwrap();
    assert_eq!(bal(&e, &e.owner.clone()) - before, 50_000_000);
}

#[allow(unused_variables)]
fn inst_msg(min_kyc_level: u8, subject: Option<&str>) -> InstantiateMsg {
    #[allow(unused_mut)]
    let mut m = InstantiateMsg { min_kyc_level, denom: DENOM.into(), ..Default::default() };
    #[cfg(feature = "test-did-subject")]
    {
        m.did_subject = subject.map(|s| s.to_string());
    }
    m
}

#[test]
fn production_build_checks_owner_and_is_not_test_only() {
    let e = setup(1, Some(("DID_STATUS_ACTIVE", "KYC_LEVEL_ONE")));
    let c: kya_cw::msg::ConfigResponse = e.app.wrap().query_wasm_smart(&e.contract, &QueryMsg::Config {}).unwrap();
    assert_eq!(c.did_subject, None);
    assert!(!c.test_only);
    let s: AgentStatusResponse = e.app.wrap().query_wasm_smart(&e.contract, &QueryMsg::AgentStatus { agent: e.agent.to_string() }).unwrap();
    assert_eq!(s.me_id_subject, e.owner.to_string());
}

#[cfg(feature = "test-did-subject")]
mod test_did_subject {
    use super::*;

    #[test]
    fn borrowed_subject_full_flow_owner_has_no_did() {
        // 店主沒有 DID，借用 subject（ACTIVE / TWO）
        let mut e = setup_inner(1, None, Some(("subject", "DID_STATUS_ACTIVE", "KYC_LEVEL_TWO")));
        let c: kya_cw::msg::ConfigResponse = e.app.wrap().query_wasm_smart(&e.contract, &QueryMsg::Config {}).unwrap();
        assert_eq!(c.did_subject.as_deref(), Some("subject"));
        assert!(c.test_only);
        let allowed = vec![e.seller.to_string()];
        grant(&mut e, Some(allowed), 7 * 86_400).unwrap();
        let seller = e.seller.clone();
        spend(&mut e, &seller, 5_000_000).unwrap();
        assert!(matches!(err_of(spend(&mut e, &seller, 20_000_000)), ContractError::OverPerTxLimit { .. }));
        spend(&mut e, &seller, 10_000_000).unwrap();
        assert!(matches!(err_of(spend(&mut e, &seller, 1)), ContractError::OverPeriodLimit { .. }));
        e.app.execute_contract(e.owner.clone(), e.contract.clone(), &ExecuteMsg::Revoke { agent: e.agent.to_string() }, &[]).unwrap();
        assert_eq!(err_of(spend(&mut e, &seller, 1)), ContractError::Revoked {});
        let s: AgentStatusResponse = e.app.wrap().query_wasm_smart(&e.contract, &QueryMsg::AgentStatus { agent: e.agent.to_string() }).unwrap();
        assert_eq!(s.me_id_subject, "subject");
    }

    #[test]
    fn borrowed_subject_below_threshold_is_blocked() {
        let mut e = setup_inner(2, Some(("DID_STATUS_ACTIVE", "KYC_LEVEL_TWO")), Some(("subject", "DID_STATUS_ACTIVE", "KYC_LEVEL_ONE")));
        grant(&mut e, None, 3600).unwrap();
        let seller = e.seller.clone();
        // 店主本人等級夠也沒用：被檢查的是 subject
        assert!(matches!(err_of(spend(&mut e, &seller, 1)), ContractError::OwnerNotEligible { kyc_level: 1, min: 2, .. }));
    }

    #[test]
    fn subject_cannot_control_funds() {
        let mut e = setup_inner(1, None, Some(("subject", "DID_STATUS_ACTIVE", "KYC_LEVEL_TWO")));
        let c = e.contract.clone();
        let r = e.app.execute_contract(Addr::unchecked("subject"), c.clone(), &ExecuteMsg::Withdraw { amount: None }, &[]);
        assert_eq!(err_of(r), ContractError::Unauthorized {});
        let agent = e.agent.to_string();
        let r = e.app.execute_contract(Addr::unchecked("subject"), c, &ExecuteMsg::Revoke { agent }, &[]);
        assert_eq!(err_of(r), ContractError::Unauthorized {});
    }
}
