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

## 三層揭露

| 層級 | 看得到 |
|---|---|
| `public` | caseId／CN code／對外狀態／是否合規（布林值）——不揭露實際排放數字 |
| `customer` | 以上 + 總碳足跡強度（下游客戶採購/自身碳盤查需要） |
| `customs` | 以上 + 實際 vs 預設係數比較、批次數、policyProfileId（等同既有 Importer 摘要深度） |

## 已知限制

- 三層欄位子集是為了示範概念挑的，不是任何正式 GS1/DPP 標準的逐字對應。
- 沒有實作 GTIN／Digital Link URI 結構，`caseId` 直接當路徑參數用，不是真的產品識別碼系統。
- `public` 層目前完全不需要認證——正式產品化的話，即使是「公開層」通常也會有速率限制／
  來源驗證，這裡沒有做（Demo 用途）。

## 測試

`tests/dpp/smoke.js`（`npm run smoke:dpp`），7 項：三層揭露內容正確、三層資料一致（不會
互相矛盾）、無效角色拒絕、案件不存在回 404、不需要 x-demo-role 且不影響既有 API 仍然要求它。
