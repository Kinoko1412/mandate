# Day 2 交棒文件 — 案件工作流、三角色 UI、Demo Vault

> **性質**：本檔雖名「plan」，內容同時記錄**規格要求**與**working tree 實況**（分支 `feature/case-workflow-ui`，截至 2026-08-25 **尚未 commit**）。接手者請以程式碼與 `npm run smoke:workflow` 為準，規格段落僅供對照。Day 2 完整決策摘要見 [`PHASE2_SESSION_LOG.md`](PHASE2_SESSION_LOG.md)；Day 3 trust engine 見 [`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md)。

**Stacked Draft PR 事實**：PR #3 **尚未合併**；本分支 stacked 於 `b8a648c` + `401ae5d`，所以以 `main` 為 base 的 Draft PR 會同時包含 Day 1。`origin/pr-3` 是本機 fetched ref／目前 upstream，可能 stale，不能視為 merge 狀態；分支／PR base 留待主對話處理。

**對照來源**：《Vibe Coding AI 完整工程規格與指令手冊》（優先權第 1）、《落地風險審查與修正版方案》、《8/24–8/28 雙人落地分工計畫》Day 2、《Day1工作小結_20260824.pdf》、尚未合併的 PR #3（`feature/carbon-core` @ `b8a648c`）。

---

## 1. 文件權威順序

| 優先 | 文件 | 用途 | 衝突時 |
|------|------|------|--------|
| 1 | 《Vibe Coding AI 完整工程規格與指令手冊》 | 欄位、API、測試、狀態文案 | **實作依此** |
| 2 | 《落地風險審查與修正版方案》 | 法規邊界、資料模型、Vault／Agent／ZKP 限制 | 推翻過度樂觀敘事 |
| 3 | 《8/24–8/28 雙人落地分工計畫》 | Owner、交棒時段、Cut Plan | 決定誰在何時改哪個模組 |
| 4 | 20 頁產業計畫書 | 產品故事（未被修正版否定部分） | 僅敘事參考 |
| 5 | 本 repo `docs/handoff/`、`DECISIONS.md` §9 | 團隊留痕與改題宣告 | 解釋為何保留 legacy `server/` |

**實況**：Day 2 workflow 路由命名與 Vibe 規格 p.9 **部分對齊、部分簡化**（例如無 `POST /api/cases` 建案、固定單一 Demo 案件；詳見 §8）。

---

## 2. 產品目標與非目標

### 2.1 目標（Day 2 / v0.2-workflow 範圍）

| 項目 | 規格要求 | 實況（working tree） |
|------|----------|----------------------|
| 三角色 UI | Supplier／Importer／Verifier 各一工作區 | ✅ `public/index.html` + `case-workflow.js` |
| 案件工作流 | 上傳 → 人工確認 → 提交 → 狀態推進 | ✅ 固定 `CASE-2026-001` |
| 碳排數字來源 | 只呼叫 carbon-core，不在前端算公式 | ✅ `server/carbonAdapter.js` → `services/carbon-core` |
| Demo Vault | Hash、短效 Grant、一次性開啟、Audit | ✅ 記憶體 Vault + `x-vault-token` header |
| 角色遮罩 | server-side 執行 | ✅ `workflowApi.js` 的 `maskCase()` |
| 未完成模組 stub | Agent／Proof／Gate 顯示 unavailable | ✅ `unavailableAdapters()`；提交後 **METHOD_REVIEW**，非 READY |
| Trust hook | Proof/Gate 可重驗、接 Day 3 | ✅ `server/trustAdapter.js` + `POST /api/workflow/revalidate`（預設仍 unavailable） |
| Verifier download | 一次性下載底稿 | ✅ `GET .../download` + UI `#download-evidence` |
| Legacy 保留 | 不刪舊 PCF 三幕 | ✅ `public/legacy.html` 仍可用 |

### 2.2 非目標（規格與實況一致：刻意不做）

- 正式 CBAM Registry 介接、海關核准、官方查驗完成宣告
- ZKP 產生／驗證、Policy Gate 正式評估、Evidence Agent 抽取
- 正式 KMS／HSM、ABE、多 tenant 物件儲存
- vLEI／EORI 真實身分、登入系統
- 第二案件、動態建案 API、正式 production auth／tenant store（Node `server/index.js` 仍為本機主路徑）

Cloudflare Worker 已可部署 synthetic Hackathon Demo（含 Root UI），不是「Workers 未做」。`x-demo-role` 是可任意切換的 Demo 身分，沒有真實 auth 或 tenant 隔離；只可放 synthetic data。公開部署時任何人皆可切換角色、操作案件，並以 Supplier reset。正式環境必須關閉此機制，或換成真實 auth 與 tenant-scoped store。

**文案硬限制**（UI 與文件均須遵守）：不得出現「CBAM Certified」「Officially Approved」「海關已核准」；`READY_FOR_VERIFIER` 僅表示「具備送交查驗準備條件」，**不代表**正式查驗完成。

---

## 3. 架構與資料流

```
Browser (public/index.html, case-workflow.js)
    │  x-demo-role: Supplier | Importer | Verifier
    │  x-vault-token: (Verifier 開 Vault 時)
    ▼
server/index.js :3847
    ▼
server/apiFetch.js → handleWorkflowApi()
    ├── server/workflowStore.js   (in-memory cases/evidence/grants/audit)
    └── server/carbonAdapter.js   → packages/contracts/validator
                                  → services/carbon-core/*
```

**提交案件資料流（Supplier）**

1. `POST /api/evidence` — Base64 上傳 → SHA-256 → 記憶體 Vault（含 `contentBase64`，不進 Audit）
2. `POST /api/evidence/:id/confirm` — `humanConfirmed: true`
3. `POST /api/cases/:id/submit` — 檢查四種 evidence 齊全且已確認 → `buildCaseCarbon()` → 更新 `carbonByCase`
4. 若 `services.proof|gate` 任一未達 `available+verified` → `status: METHOD_REVIEW`，`readiness: not_verified`
5. Proof + Gate 皆達 `available+verified` 才可 `READY_FOR_VERIFIER`；Agent 不參與 readiness

**Vault 資料流**

1. Supplier `POST /api/vault/grants` → 回傳 **plaintext token 一次**（僅 HTTP body，不寫 Audit）
2. Verifier `GET /api/vault/items/:evidenceId` + header `x-vault-token` → 驗 hash／subject／expiry／one-time → 回傳 `contentBase64`
3. 同一 Grant 第二次 open/download → `GRANT_INVALID`；過期 → `GRANT_EXPIRED`；撤銷 → `GRANT_REVOKED`

**Legacy 路徑（未改主線）**

- `public/legacy.html` → 舊 PCF 三幕、`server/policy.js`、`POST /api/tools/*` 等（Day 1 前既有）。

---

## 4. Day 1 實況與兩項核心修正

### 4.1 Day 1 交付（stacked／PR #3 尚未合併）

| 項目 | 狀態 |
|------|------|
| `packages/contracts/`、`services/carbon-core/`、`fixtures/` | 尚未合併的 PR #3（`feature/carbon-core` @ `b8a648c`）；本分支 stacked 其上 |
| `npm run smoke:carbon-core` | 21→**36** 項（見 §4.2 修正後） |
| Handoff | `docs/handoff/PHASE1_SESSION_LOG.md` |
| 改題留痕 | `DECISIONS.md` §9 |

### 4.2 兩項核心修正（在 Day 2 分支 working tree，**同 PR 尚未 commit**）

依 `CHANGELOG.md`「Phase 1 核心阻斷修正（2026-08-25）」：

1. **執行期 schema 驗證**  
   - **規格**：canonical 實體不得私自改名；應可驗證 required/type/enum。  
   - **修正**：新增 `packages/contracts/validator.js`（零 npm 依賴 draft-07 子集），`carbonAdapter.assertCanonical()` 與 smoke 實際載入 `schema-v1.json`。  
   - **實況**：11 個 canonical entities（含 `CalculationReceipt`）驗證測試 PASS。

2. **年度排放改為 sum(activity × factor)**  
   - **規格**：`calculateAnnualEmissions` 應加總 activity×factor，定點 scale=10^6；Demo 標 `demoOnly`。  
   - **修正**：`normal.json` 補 `activities`／`factorSet`；normal 路徑 **360 tCO2e ÷ 200 t = 1.80**；Shipment 補 `allocatedEmissions`／`allocationStatus`。  
   - **實況**：拒絕舊版「只用 installationYear 循環算」呼叫；`tampered_quantity` 仍為 Phase 1 帳本超額詮釋（非 ZKP `PUBLIC_INPUT_MISMATCH`，留 8/26）。

---

## 5. Day 2 實際完成（working tree）

| 模組 | 路徑 | 說明 |
|------|------|------|
| Workflow API | `server/workflowApi.js` | 路由、遮罩、Vault、Audit、`revalidateCase` |
| Workflow Store | `server/workflowStore.js` | 記憶體狀態；`setTrustServices`／`setServiceStatus` |
| Trust hook | `server/trustAdapter.js` | `evaluate()`；預設 unavailable |
| Carbon 整合 | `server/carbonAdapter.js` | `buildCaseCarbon()`、service stubs |
| 路由掛載 | `server/apiFetch.js`、`server/index.js` | workflow 優先；`x-demo-role`／`x-vault-token` |
| Root UI | `public/index.html`、`public/css/case-workflow.css` | Day 2 主入口 |
| Client | `public/js/case-workflow.js` | 三角色、download、錯誤引導、sessionStorage |
| Legacy | `public/legacy.html` | 舊 PCF 介面 |
| 測試 | `tests/workflow/smoke.js`、`tests/ui/static-contract.js` | **34 + 16 = 50** 項 |
| 截圖 | `docs/handoff/screenshots/day2/` | Playwright 五張 PNG |
| Scripts | `package.json` | `smoke:workflow`、`smoke:ui` |

**環境變數**：Day 2 workflow **無新增**環境變數；仍只需既有 `.env.example`（OpenAI／Supabase 為 legacy 三幕可選，與 workflow 無關）。

**驗收命令（2026-08-25 實跑）**

```bash
npm run smoke:carbon-core   # 36/36 PASS
npm run smoke:workflow      # workflow 34 + UI 16 = 50/50 PASS
npm start                   # http://127.0.0.1:3847/
```

---

## 5.1 Playwright 瀏覽器除錯（2026-08-24）

實跑 Root UI 三角色；修正 favicon 404、Importer 自行覆寫 `allocationStatus`、submit 失敗不刷新、reset 權限、Grant 終態清 session、download UI、`quantityUnit` undefined、public `.bak` 洩漏。Console 403 on vault reuse 為**預期**。截圖：[`screenshots/day2/`](screenshots/day2/)（五張 PNG）。

---

## 5.2 Trust adapter hook（非 ZKP 完成）

| 項目 | 實況 |
|------|------|
| 模組 | `server/trustAdapter.js` — `evaluate(input)`、`unavailableResult()` |
| 寫入 | `workflowStore.setTrustServices()`／`setServiceStatus()` |
| 重驗路由 | `POST /api/workflow/revalidate`（Supplier only） |
| READY 條件 | **proof + gate** 皆 `available+verified`（**Agent 可不接**） |
| 預設 | evaluator 回 unavailable → submit/revalidate 後 **METHOD_REVIEW** |
| Day 3 | B 替換 evaluator；見 [`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md) |

---

## 6. 三角色資料遮罩

| 欄位／能力 | Supplier | Importer | Verifier |
|------------|----------|----------|----------|
| `installationYear` 完整 | ✅ | ❌ | ✅ |
| `carbon` 明細／receipt | ✅ | ❌（僅 `annualSummary`） | ❌（摘要級） |
| `evidence[].filename` | ✅ | ❌ | ✅（index） |
| `evidence[].vaultRef` | ✅ | ❌ | ❌ |
| `contentBase64` | ❌（列表） | ❌ | 僅 Grant 開啟後 |
| `shipments` 明細 | ✅ | ✅（無底稿） | ✅ |
| `findings` | ❌ | ❌ | ✅ |
| Vault Grant 建立 | ✅ | ❌ | ❌ |
| Vault 開啟 | ❌ | ❌（即使有 token） | ✅ |

實作：`maskCase()`、`supplierEvidence()`、`importerEvidence()`、`evidenceMetadata()`（`workflowApi.js`）。

---

## 7. Vault 安全（Demo 級，非正式儲存）

| 控制 | 規格 | 實況 |
|------|------|------|
| 完整性 | SHA-256，不靜默覆寫 | ✅ 同名檔 `409 EVIDENCE_ALREADY_EXISTS` |
| 大小／類型 | 允許清單 | ✅ max 512 KiB；PDF/JSON/text/PNG/JPEG |
| 授權 | 短效、subject 綁定、一次性 | ✅ max 5 分鐘；綁 `demo-verifier-001`；consume 後失效 |
| Token 傳遞 | 不得進 URL／Audit | ✅ header `x-vault-token`；Audit 無 token／content |
| 記憶體 | Demo storage | ⚠️ 重啟即失；**非** R2/KMS/WORM |

---

## 8. API 與狀態（實際路由）

### 8.1 共通

- **Base URL**：`http://127.0.0.1:3847`
- **Demo 角色**：header `x-demo-role: Supplier|Importer|Verifier` 或 query `?demoRole=Supplier`（測試用）
- **錯誤形狀**：`{ code, message, retryable, details }`

### 8.2 Workflow 路由一覽

| Method | Path | 角色 | 說明 |
|--------|------|------|------|
| GET | `/api/cases` | 任一 | 列表（遮罩） |
| GET | `/api/cases/:caseId` | 任一 | 詳情（遮罩） |
| POST | `/api/cases/:caseId/submit` | Supplier | 提交年度資料 |
| GET | `/api/cases/:caseId/audit` | 任一（case scope） | Audit 時間軸 |
| POST | `/api/evidence` | Supplier | 上傳 evidence |
| POST | `/api/evidence/:evidenceId/confirm` | Supplier | 人工確認 |
| GET | `/api/importer/cases/:caseId/summary` | Importer | 摘要 + actual/default 比較 |
| GET | `/api/verifier/cases/:caseId/evidence` | Verifier | Evidence index |
| POST | `/api/verifier/cases/:caseId/findings` | Verifier | 新增 finding |
| POST | `/api/vault/grants` | Supplier | 建立 Grant |
| POST | `/api/vault/grants/:grantId/revoke` | Supplier | 撤銷 Grant |
| GET | `/api/vault/items/:evidenceId` | Verifier | 開啟底稿（消耗 Grant） |
| GET | `/api/vault/items/:evidenceId/download` | Verifier | 下載模式（同樣消耗 Grant） |
| POST | `/api/workflow/carbon/preview` | Supplier | 碳排預覽；回 `previewOnly:true`、`clientSuppliedInput:true`，不寫入案件 |
| POST | `/api/workflow/revalidate` | Supplier | 呼叫 trustAdapter → 更新 services + readiness |
| POST | `/api/workflow/reset` | Supplier | 重置 Demo |

**與 Vibe 規格 p.9 差異（刻意簡化）**：無 `POST /api/cases` 建案、無 `/api/carbon/calculate` 獨立路由（改 `carbon/preview` + submit 內嵌）、無 Proof/Gate/Agent 路由。

### 8.3 Case 狀態（Demo 固定案件）

| 狀態 | 意義 | 目前如何進入 |
|------|------|----------------|
| `DRAFT` | 初始／reset 後 | 預設 |
| `NEEDS_EVIDENCE` | 缺件或未確認 | submit 缺 evidence |
| `METHOD_REVIEW` | Proof/Gate 未 verified | **目前 submit/revalidate（預設 adapter）固定進此狀態** |
| `READY_FOR_VERIFIER` | proof+gate 皆 verified | mock/real adapter verified 後；Agent 可不接 |
| `BLOCKED` | trust adapter failed | revalidate throw → `TRUST_ADAPTER_FAILURE` |
| 其餘 | 規格有定義 | Day 2 UI 未演示推進 |

`readyDisclaimer`（固定文案）：「具備送交查驗準備條件，不代表正式查驗完成。」

---

## 9. 操作步驟（Demo 腳本）

1. `npm start` → 開啟 `http://127.0.0.1:3847/`
2. **Supplier**：「一鍵載入四份 synthetic Demo evidence」→「人工確認全部」→「提交年度資料」  
   - 預期：強度 1.80、分攤 180/108；狀態 **METHOD_REVIEW**；Agent/Proof/Gate **尚未驗證**
3. **Supplier**：選 evidence → 建立 Grant（120s）→ 複製 token（僅顯示一次）
4. **Verifier**：貼 token →「開啟底稿一次」或「下載一次」→ synthetic 內容；Audit 有 `VAULT_OPEN:ALLOW`／`VAULT_DOWNLOAD:ALLOW`
5. 再次開啟或 **Importer** 帶 token → `403` + `GRANT_INVALID`（或 `GRANT_EXPIRED`／`GRANT_REVOKED`）
6. **Importer**：只看摘要、完整度、actual vs default（2.5 為 **Demo estimate**）
7. 「重置 Demo」→ 回 `DRAFT`

Legacy：header 連結 `legacy.html` → 舊 PCF 三幕（需可選 `OPENAI_API_KEY`）。

---

## 10. 驗收清單（對照分工計畫 Day 2）

| 情境 | 預期 | 自動化 |
|------|------|--------|
| 供應商上傳 4 份 | Index 有 Hash／期間／來源 | `smoke:workflow` evidence 段 |
| 買方查看 | 無 vaultRef／content／完整檔名 | mask + importer summary 測試 |
| 查驗員授權開啟 | 成功一次 + Audit | vault open 測試 |
| 權限失敗 | 穩定 reason code，不洩漏 | Importer+token、過期、revoke |
| 核心錯誤 | UNKNOWN_UNIT、ALLOCATION_EXCEEDS_PRODUCTION | carbon/preview 測試 |
| 未完成模組 | 不誤標 READY | fallback 測試 |
| UI 契約 | 三角色 hooks、無 CDN、legacy 可載 | `smoke:ui` |

---

## 11. 已知限制

- Workflow 全記憶體；`npm start` 重啟即清空 evidence/grant（carbon fixture 可重建）
- 單一固定案件 `CASE-2026-001`；無多 tenant
- Findings 僅結構化表單，無協作／通知
- Evidence `version` 恆為 `1`；同名檔案拒絕，尚無版本演進
- Importer 的 default 2.5 為硬編碼 Demo，**非**官方預設值
- `POST /api/workflow/reset` 不清理 browser `sessionStorage` token（需手動或刷新）
- Legacy `server/` PCF 模型與 carbon-core **兩套並存**，互不呼叫
- ZKP／Gate／Agent service adapters：**未實作**，禁止宣稱已正式驗證；但 synthetic Worker Demo 本身可部署

---

## 12. 8/26（Day 3）交棒接口

**完整手冊**：[`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md)（Owner、契約、fixtures、DoD、Cut Plan）。

摘要：B 只改 trust 引擎 + `trustAdapter` evaluator，**不改** workflow 路由／`maskCase`：

| 接口 | 位置 | 8/26 預期 |
|------|------|-----------|
| Evaluator | `server/trustAdapter.js` | 接 `services/proof`、`services/policy-gate`、`services/factor-registry` |
| 重驗 | `POST /api/workflow/revalidate` | normal → `READY_FOR_VERIFIER` |
| Store | `workflowStore.setTrustServices()` | 已存在；勿暴露 root state |
| Agent | `services.agent` stub | **不阻擋** READY（Day 4 RiskReport） |
| Fixtures | `fixtures/*` | 新增 100→120 `PUBLIC_INPUT_MISMATCH` 等攻擊集 |
| 前端 | `renderServices()` | 接妥即顯示；revalidate 按鈕可選 |

**不需改**：`maskCase`、`x-demo-role`／`x-vault-token`、Audit 形狀、Vault download 路由。

---

## 13. Fallback 與 Rollback

### 13.1 Demo 現場 fallback

| 狀況 | 作法 |
|------|------|
| UI 異常 | 改跑 `npm run smoke:workflow` 證明 API；或操作 `legacy.html` |
| Vault token 遺失 | Supplier 重建 Grant |
| 狀態混亂 | UI「重置 Demo」或 `POST /api/workflow/reset` |
| 8/26 前誤期待 READY | 說明 **METHOD_REVIEW** = 依賴服務未驗證，非案件資料錯 |

### 13.2 Git rollback

- Day 2 全在 **uncommitted** working tree：  
  `git checkout -- .` 並刪除 untracked workflow 檔可回到 `401ae5d`（含 Phase1 session log）狀態。  
- **勿**在未確認前 `git clean -fd`（會刪 `packages/validator.js` 等 Day1 修正）。  
- Legacy 路徑：保留 `public/legacy.html` 與舊 `server/*` 即可獨立演示 PCF 三幕。

---

## 14. 相關文件

| 文件 | 用途 |
|------|------|
| `docs/handoff/DAY2_API_EXAMPLES.json` | 可機器讀的 request/response 範例 |
| `docs/handoff/DAY2_TEST_CASES.md` | 測試命令與預期 |
| `docs/handoff/PHASE1_SESSION_LOG.md` | Day 1 決策脈絡 |
| `docs/handoff/PHASE2_SESSION_LOG.md` | Day 2 決策 + Playwright + trust hook |
| `docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md` | Day 3 B 開工手冊 |
| `docs/handoff/screenshots/day2/` | 瀏覽器驗收截圖 |
| `services/carbon-core/README.md` | 計算核心與 NOT IN SPEC 清單 |
