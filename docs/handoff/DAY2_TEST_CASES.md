# Day 2 測試案例

對照 `tests/workflow/smoke.js`、`tests/ui/static-contract.js`、`tests/carbon-core/smoke.js` 與 `docs/handoff/DAY2_EXECUTION_PLAN.md`。

**環境**：Node.js（repo 零 workflow 額外依賴）；在 `mandate/` 目錄執行。

---

## 1. 一鍵回歸

| 命令 | 涵蓋 | 預期 |
|------|------|------|
| `npm run smoke:workflow` | workflow API **34** 項 + UI 靜態契約 **16** 項 | 終端兩段各輸出 `RESULT: all PASS`（合計 **50**） |
| `npm run smoke:ui` | 僅 UI 靜態契約 | `RESULT: all PASS`（16 項） |
| `npm run smoke:carbon-core` | carbon-core + validator | `RESULT: all PASS`（**36** 項） |

**建議交付前順序**：

```bash
npm run smoke:carbon-core
npm run smoke:workflow
```

---

## 2. Workflow API（`tests/workflow/smoke.js`，34 項）

透過 `server/apiFetch.handleFetchRequest` 直接呼叫路由，無需啟動 HTTP server。

| # | 標籤 | 預期 |
|---|------|------|
| 1 | reset: Demo workflow 可重跑且初始不是 READY | `200`；`status=DRAFT`；`readiness=not_verified` |
| 2 | reset: 僅 Supplier 可重置 Demo workflow | Importer → `403 ROLE_FORBIDDEN` |
| 3 | submit: 缺件失敗後 server 案件狀態同步為 NEEDS_EVIDENCE | submit `422`；GET detail → `NEEDS_EVIDENCE` |
| 4 | store: service setter 驗證名稱、狀態與 verification 且不暴露 root state | 非法名稱/狀態 throw；無 `getState` |
| 5 | trust adapter: available 拒絕 not_verified | adapter boundary 拋 `TypeError`，與 workflowStore 契約一致 |
| 6 | auth: 未指定 Demo role | `401`；`DEMO_ROLE_REQUIRED`；`details.demoOnly=true` |
| 7 | apiFetch: demoRole query whitelist | `GET /api/cases?demoRole=Supplier` → `200` |
| 8 | apiFetch: 無效 JSON | `400`；`INVALID_JSON`；body 不含使用者輸入 |
| 9 | evidence: 上傳 4 份 SHA-256 | 各 `201`；`fileHash=sha256:<hex>`；無 `contentBase64` |
| 10 | evidence: 同名不可覆寫 | `409`；`EVIDENCE_ALREADY_EXISTS` |
| 11 | evidence: 類型與大小限制 | 錯誤 media → `MEDIA_TYPE_NOT_ALLOWED`；>512KiB → `EVIDENCE_TOO_LARGE` |
| 12 | mask: Importer detail 不洩漏 | JSON 不含 `vaultRef`、`contentBase64`、完整檔名、`"token"` |
| 13 | auth: Importer 不可 confirm | `404`；`EVIDENCE_NOT_FOUND` |
| 14 | supplier: 確認後提交 | submit `200`；emissions=360；分攤 `[180,108]`；allocationStatus `METHOD_REVIEW` |
| 15 | fallback: 依賴 unavailable | `status=METHOD_REVIEW`；**非** `READY_FOR_VERIFIER`；services 全 `unavailable` |
| 16 | revalidate: 僅 Supplier 可觸發 | Importer → `403 ROLE_FORBIDDEN` |
| 17 | revalidate: mock Proof+Gate verified 可 READY | `200`；`READY_FOR_VERIFIER`；agent 仍 unavailable |
| 18 | revalidate: adapter hard failure → BLOCKED | `200`；`BLOCKED`；`TRUST_ADAPTER_FAILURE`；無 stack 洩漏 |
| 19 | revalidate: default adapter unavailable | `200`；`METHOD_REVIEW`；`SERVICE_UNAVAILABLE` |
| 20 | carbon preview: UNKNOWN_UNIT | `422`；穩定 error shape |
| 21 | carbon preview: metadata | `previewOnly=true`、`clientSuppliedInput=true` |
| 22 | carbon preview: INTENSITY_MISMATCH | `422` |
| 23 | carbon preview: 超額分攤 | `422`；`ALLOCATION_EXCEEDS_PRODUCTION` |
| 24 | importer summary | `actualIntensity=1.8`；`demoOnly=true`；無底稿欄位 |
| 25 | verifier receipt mask | 僅 `inputHash`、`methodVersion` |
| 26 | verifier evidence index | 有 `filename`；無 `contentBase64` |
| 27 | vault: Grant 建立 | `201`；`oneTime=true`；grant 無 tokenHash |
| 28 | vault: Importer + token 被拒 | `403`；`GRANT_INVALID` |
| 29 | vault: Verifier 開啟一次 | 第一次 `200` 含 content；第二次 download `403 GRANT_INVALID` |
| 30 | vault: 撤銷 Grant | revoke 後 open `403`；`GRANT_REVOKED` |
| 31 | vault: download 消耗 Grant | download `200`；`access.mode=download` |
| 32 | vault: 過期 Grant | 40ms 有效期後 open `403`；`GRANT_EXPIRED` |
| 33 | verifier: finding | `201`；`severity=warning` |
| 34 | audit: 留痕且無 secret | 含 `VAULT_OPEN/DOWNLOAD`、`GRANT_REVOKE`、`FINDING`；無 token/content |

**穩定錯誤契約**（所有 workflow 4xx/422）：`code`、`message`（string）、`retryable`（boolean）、`details` 必存在；JSON 不含 `stack`。

**Vault 錯誤碼（server）**：`GRANT_INVALID`、`GRANT_EXPIRED`、`GRANT_REVOKED`（UI 另用 `VAULT_ACCESS_DENIED` 表示「未選 token」）。

---

## 3. UI 靜態契約（`tests/ui/static-contract.js`，16 項）

| # | 標籤 | 預期 |
|---|------|------|
| 1 | root: 三角色 hooks | Supplier/Importer/Verifier、`CASE-2026-001`、seed/confirm/submit/grant/open/download/finding；Grant label/control 各包在 `.field` |
| 2 | root: 信任邊界文案 | 含「Demo role，不是真實認證」；含 READY 免責；無 CBAM Certified 等字眼 |
| 3 | root: favicon 內嵌 | `data:image/svg+xml`；不請求 `/favicon.ico` |
| 4 | root: 無 CDN | `index.html` 無 `http(s)://` 外部資源 |
| 5 | Importer: 無敏感 hooks | importer section 無 vault/token/filename/opened-content |
| 6 | client: header 與 token | 使用 `x-demo-role`、`x-vault-token`；token 不進 URL |
| 7 | client: Importer 用 server allocationStatus | 不自行覆寫 trust 狀態 |
| 8 | client: submit 後 always loadRole | `finally { await loadRole() }` |
| 9 | client: reset 依角色隱藏 | 僅 Supplier 可見 reset + 說明 |
| 10 | client: open/download 終態清 session | `clearVaultSession`；`GRANT_*` 時清除 |
| 11 | styles: 狀態/loading/focus/窄版 | DRAFT/VERIFIER_REVIEW/ARCHIVED 等 hooks |
| 12 | client: quantityUnit fallback | 缺值顯示 `tonne` |
| 13 | legacy: 資源可載 | `legacy.html` 引用之 css/js 皆存在 |
| 14 | assets: 新版檔案 | `case-workflow.css`、`case-workflow.js` 存在 |
| 15 | static server: 備份隔離 | 遞迴掃描 `public/` 不得有任何 `.bak-`；五個備份保留於 `_backups/` |
| 16 | client: 語法 | `node --check public/js/case-workflow.js` 通過 |

---

## 4. Security / Role-mask 手動抽查（可選）

在 `npm start` 運行時，瀏覽器 DevTools → Network：

1. 切 **Importer** → 檢查 `/api/importer/cases/CASE-2026-001/summary` 回應無 `vaultRef`、`contentBase64`。
2. **Supplier** 建 Grant 後 → 確認 Audit API 回應無 plaintext token。
3. **Verifier** 開啟或下載底稿 → header 有 `x-vault-token`，URL 無 query token。
4. Grant 用過後再開 → UI 顯示 `GRANT_INVALID` 引導；console 403 為預期。

Playwright 截圖：[`screenshots/day2/`](screenshots/day2/)。

---

## 5. Carbon-core regression（Day 2 依賴）

Workflow submit 與 `carbon/preview` 依賴下列測試仍 PASS（節錄）：

| 標籤 | 預期 |
|------|------|
| contract: validator 載入 schema | 11 entities；四 fixtures 六類核心 entity 全過 |
| normal fixture 分攤 | 180 / 108 |
| normal 年度排放 | 360（activity×factor Demo） |
| calculateAnnualEmissions: 舊版循環拒絕 | 拋錯 |
| tampered_quantity（Phase 1 詮釋） | 帳本超額 BLOCKED |

完整清單：`npm run smoke:carbon-core`（**36** 項）。

---

## 6. Legacy 煙測（非 Day 2 主線，可選）

| 命令 | 預期 |
|------|------|
| `npm run smoke` | 12 vectors + 4 trace PASS |
| `npm run smoke:agent` | 有 `OPENAI_API_KEY` 才跑；否則 SKIP |

Legacy UI：`http://127.0.0.1:3847/legacy.html`

---

## 7. 失敗時排查

| 現象 | 檢查 |
|------|------|
| workflow 全 FAIL | 是否在 `mandate/` 根目錄；Node 是否支援 `globalThis.crypto.subtle` |
| 僅 vault 過期 FAIL | 系統時鐘；smoke 內建 70ms sleep |
| revalidate FAIL | `server/trustAdapter.js` 是否存在；mock 後是否 `resetEvaluatorForTests` |
| carbon-core FAIL | `packages/contracts/validator.js`；`fixtures/normal.json` activities |
| UI static FAIL | `public/index.html` 是否為 Day 2 版 |
