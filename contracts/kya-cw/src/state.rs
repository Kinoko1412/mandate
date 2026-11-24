use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub owner: Addr,
    pub denom: String,
    pub min_kyc_level: u8,
}

#[cw_serde]
pub struct Mandate {
    pub per_tx_limit: Uint128,
    pub period_limit: Uint128,
    pub period_seconds: u64,
    pub period_start: u64,
    pub spent_in_period: Uint128,
    pub expires_at: u64,
    pub allowed_recipients: Option<Vec<Addr>>,
    pub revoked: bool,
    pub total_spent: Uint128,
}

impl Mandate {
    /// 滾動期間：目前這一期已經結束就從 now 開新的一期
    pub fn roll(&mut self, now: u64) {
        if self.period_seconds > 0 && now >= self.period_start.saturating_add(self.period_seconds) {
            self.period_start = now;
            self.spent_in_period = Uint128::zero();
        }
    }
    pub fn remaining(&self) -> Uint128 {
        self.period_limit.saturating_sub(self.spent_in_period)
    }
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const MANDATES: Map<&Addr, Mandate> = Map::new("mandates");
