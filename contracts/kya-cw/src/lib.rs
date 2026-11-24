//! KYA（Know-Your-Agent）額度合約。
//!
//! 店主（instantiate 的人）把 MEC 預存進合約，替代理設定單筆上限、每期額度、到期時間、允許的收款人。
//! 代理呼叫 `spend` 時，合約即時用 Stargate 查店主的 ME ID（`/metaearth.did.Query/Did`），
//! 必須是 `DID_STATUS_ACTIVE` 且 KYC 等級 >= `min_kyc_level`，再檢查撤銷、到期、收款人、額度，通過才轉帳。
//! 店主可以 `revoke`；任何人可以查 `agent_status`。

pub mod contract;
pub mod did;
pub mod error;
pub mod msg;
pub mod state;

pub use crate::error::ContractError;
