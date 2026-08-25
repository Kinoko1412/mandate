# services/dpp

Day 5 背景待辦 2：GS1／DPP（Digital Product Passport）分層揭露的最小示意。

## 範圍（刻意縮小）

- **沒有**接真正的 GS1 GTIN 查詢服務或 Digital Link 標準解析器。
- 純函式、只讀，不影響 Gate/Policy、不產生稽核事件。
- 示範的是「同一筆 Case 依查詢者角色回傳不同欄位子集」這個概念本身，不是要重做一套認證機制。

## API

`GET /api/dpp/cases/:caseId?role=public|customer|customs`（預設 `public`）

**故意不需要 `x-demo-role`**——這是這個端點存在的意義：public/customer/customs 是「產品護照
的外部查詢者」這條軸線（掃 QR code 的人是誰），跟既有 `x-demo-role`（案件參與者：Supplier/
Importer/Verifier）是不同概念，兩者刻意分開成不同的 query 參數（`role` vs `demoRole`），互不
影響——`server/apiFetch.js` 裡 `handleDppApi()` 特別排在 `handleWorkflowApi()`（會強制要求
`x-demo-role`）之前處理。

## 三層揭露（Day 5 追加②：規則驅動，不是寫死的 if/else）

| 層級 | 看得到 |
|---|---|
| `public` | caseId／CN code／對外狀態／是否合規（布林值）——不揭露實際排放數字 |
| `customer` | 以上 + 總碳足跡強度（下游客戶採購/自身碳盤查需要） |
| `customs` | 以上 + 批次數、policyProfileId，**加上有條件的比較數字**（見下） |

三層揭露規則定義在 `DPP_DISCLOSURE_POLICIES`（keyed by `policyProfileId`，目前只有
`default` 一份），對應工作坊投影片 Layer 2「合約邏輯層：存取條件可程式化」的精神——欄位
子集跟「哪個角色看到什麼」不是散落的 if/else，是一份可以查、可以延伸的政策定義。

**customs 層的 `comparison`（實際 vs 預設係數比較）是有條件的**：案件要推進到
`READY_FOR_VERIFIER` 之後才給真數字；之前查詢會拿到明確的占位訊息
（`{withheld: true, reason: "..."}`），不是提前洩漏一個還沒經過信任閘門檢查的數字，也不是
整層都看不到（`shipmentCount`/`policyProfileId` 不受這個條件影響）。這是「存取條件可程式化」
真正的意思：條件本身可以掛判斷式，不是單純的角色對欄位靜態表格。

## 已知限制

- 三層欄位子集是為了示範概念挑的，不是任何正式 GS1/DPP 標準的逐字對應。
- 沒有實作 GTIN／Digital Link URI 結構，`caseId` 直接當路徑參數用，不是真的產品識別碼系統。
- `public` 層目前完全不需要認證——正式產品化的話，即使是「公開層」通常也會有速率限制／
  來源驗證，這裡沒有做（Demo 用途）。

## 尚未接線的下一步

`services/credential`（Day 5 追加①，JWT 碳足跡憑證）目前是獨立模組，customs 層還沒有把
已簽發的憑證（或憑證參照）一起回傳。自然的下一步是：案件 `READY_FOR_VERIFIER` 後，customs
層查詢時順便回傳對應的 JWT（或至少一個 `jti`／下載連結），把①②兩個追加功能真正串成一個
完整故事——目前故意先讓兩個模組各自獨立、各自測試扎實，再決定要不要接（同一種「先求穩、
再求整合」的紀律，跟 ZK 電路還沒接進 trustAdapter 即時流程是同一個判斷）。

## 測試

`tests/dpp/smoke.js`（`npm run smoke:dpp`），8 項：三層揭露內容正確、customs 層有條件
comparison 的兩個分支（條件不成立的占位訊息、條件成立後的真數字，各自走真實 HTTP 流程把
案件推到對應狀態）、三層資料一致（不會互相矛盾）、無效角色拒絕、案件不存在回 404、不需要
x-demo-role 且不影響既有 API 仍然要求它。
