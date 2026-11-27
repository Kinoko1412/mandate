use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Coin, Uint128};

#[cw_serde]
#[derive(Default)]
pub struct InstantiateMsg {
    /// 店主 ME ID 的最低 KYC 等級（0=NONE、1=ONE、2=TWO）
    pub min_kyc_level: u8,
    /// 預算幣別，ME 是 "umec"
    pub denom: String,
    /// TEST ONLY：只有 feature test-did-subject 的建置才有這個欄位（正式版因 deny_unknown_fields 會拒收）
    #[cfg(feature = "test-did-subject")]
    #[serde(default)]
    pub did_subject: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// 店主授權（或覆寫）一個代理的額度
    Grant {
        agent: String,
        per_tx_limit: Uint128,
        period_limit: Uint128,
        period_seconds: u64,
        /// unix 秒
        expires_at: u64,
        /// None = 任何收款人；Some = 只能付給清單裡的地址
        allowed_recipients: Option<Vec<String>>,
    },
    /// 店主撤銷代理
    Revoke { agent: String },
    /// 代理在額度內付款
    Spend { to: String, amount: Uint128, memo: Option<String> },
    /// 店主追加預算（附帶 funds）
    Deposit {},
    /// 店主取回預算；None = 全部
    Withdraw { amount: Option<Uint128> },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    #[returns(AgentStatusResponse)]
    AgentStatus { agent: String },
}

#[cw_serde]
pub struct ConfigResponse {
    pub owner: String,
    pub denom: String,
    pub min_kyc_level: u8,
    pub balance: Coin,
    /// TEST ONLY：借用來檢查 ME ID 的地址；正式版永遠是 None
    pub did_subject: Option<String>,
    /// true = 這份合約是測試用變體，ME ID 不是店主本人的，不能當 Demo
    pub test_only: bool,
}

#[cw_serde]
pub struct MeIdView {
    pub found: bool,
    pub did: Option<String>,
    pub status: Option<String>,
    pub kyc_level: Option<u8>,
    pub error: Option<String>,
}

#[cw_serde]
pub struct AgentStatusResponse {
    pub agent: String,
    pub owner: String,
    /// 實際被檢查 ME ID 的地址（正式版 = owner）
    pub me_id_subject: String,
    pub has_mandate: bool,
    pub revoked: bool,
    pub expired: bool,
    pub per_tx_limit: Uint128,
    pub period_limit: Uint128,
    pub remaining_in_period: Uint128,
    pub expires_at: u64,
    pub allowed_recipients: Option<Vec<String>>,
    pub total_spent: Uint128,
    pub owner_me_id: MeIdView,
    /// 現在呼叫 spend（金額 > 0、收款人允許）在「身分、撤銷、到期」三項上會不會被擋
    pub can_spend_now: bool,
    pub contract_balance: Coin,
}
