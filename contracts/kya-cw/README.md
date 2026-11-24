# kya-cw：KYA 額度合約（BEACON spike 路線 1）

店主把 MEC 預存進合約，替 AI 代理設定單筆上限、每期額度、到期時間和收款人白名單。代理呼叫 `spend` 時，合約會**在鏈上即時查店主的 ME ID**（Stargate `/metaearth.did.Query/Did`），通過才轉帳。

## 介面
- instantiate：`{ "min_kyc_level": 1, "denom": "umec" }`，附帶 funds 就是預算。instantiate 的人是店主
- execute
  - `grant { agent, per_tx_limit, period_limit, period_seconds, expires_at, allowed_recipients? }`：只有店主能呼叫
  - `revoke { agent }`：只有店主能呼叫
  - `spend { to, amount, memo? }`：代理呼叫
  - `deposit {}`、`withdraw { amount? }`：只有店主能呼叫
- query：`config {}`、`agent_status { agent }`（任何人都能查，會回店主 ME ID 的狀態和 `can_spend_now`）

## spend 的檢查順序
撤銷 → 到期 → 收款人白名單 → 單筆上限 → 每期剩餘額度（期滿自動重置）→ 合約餘額 → **店主 ME ID 必須是 `DID_STATUS_ACTIVE`，且 KYC 等級 ≥ `min_kyc_level`**

## 和鏈的相容性（已查原始碼）
- ME 測試網用 wasmd v0.43.0、wasmvm v1.4.1，所以用 cosmwasm-std 1.5，只開 `stargate` 這個 feature，沒有開 `cosmwasm_1_5`
- Stargate 白名單（`openmetaearth/me-hub` 的 `app/keepers/wasm_me_query.go`）有 `/metaearth.did.Query/Did`
- request 是 protobuf 編碼的 `QueryDid{address}`；response 由 wasmd 的 `ConvertProtoToJSONMarshal` 轉成 **JSON**，enum 是字串（例如 `"DID_STATUS_ACTIVE"`、`"KYC_LEVEL_TWO"`）

## 建置
- 單元測試：`cargo test`（需要 Rust；CI 會跑）
- 正式 wasm：GitHub Actions `.github/workflows/kya-cw.yml`，用 `cosmwasm/optimizer:0.15.1` 建置，再跑 `cosmwasm-check`，產物是 artifact `kya-cw-wasm`（含 sha256）。**部署只用這個檔**
- `.wasm` 不要 commit
