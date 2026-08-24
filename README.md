# Mandate — 可信碳排證據 Agent（Hackathon Prototype）

**產品定位（2026-08-25）**：協助台灣鋼鐵供應商與歐盟進口商，在**正式 CBAM 查驗／申報前**，把工廠年度排放、批次分攤、佐證文件與限時授權整理成可追溯的**證據案件**（Demo Prototype，**非**官方 Registry、**非**法定查驗完成）。

- **我們是**：申報前證據準備與風險預審協作層、確定性 carbon-core 計算、Demo Vault 與三角色工作流、Trust adapter hook（接 Day 3 ZKP/Gate）。
- **我們不是**：政府／海關、CBAM Registry、法定第三方查驗機構、已由 ZKP／Agent／Gate **正式驗證**的商用產品。

工程規格優先權與 Day 2 交棒詳見 [`docs/handoff/DAY2_EXECUTION_PLAN.md`](docs/handoff/DAY2_EXECUTION_PLAN.md)。Day 2 決策摘要：[`docs/handoff/PHASE2_SESSION_LOG.md`](docs/handoff/PHASE2_SESSION_LOG.md)。Day 3 trust engine：[`docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md`](docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md)。

> **Git**：Day 2 程式與本 README 更新目前在 `feature/case-workflow-ui` **working tree，尚未 commit**。

---

## 快速啟動（Day 2 主線）

```bash
cd mandate
npm start
```

瀏覽器開啟 [http://127.0.0.1:3847/](http://127.0.0.1:3847/) — **Root UI**：三角色案件工作流（Supplier／Importer／Verifier）、Demo Vault、Audit Timeline。

**驗收（無需 API Key）**

```bash
npm run smoke:carbon-core   # 36 項
npm run smoke:workflow      # workflow 34 + UI 16 = 50 項
```

Playwright 驗收截圖：[`docs/handoff/screenshots/day2/`](docs/handoff/screenshots/day2/)（supplier / importer / verifier / vault-denied）。

**環境變數**：Day 2 workflow **無新增**環境變數；`.env.example` 僅供 legacy 三幕可選功能（見下）。

---

## Day 2 Root UI

| 項目 | 說明 |
|------|------|
| 入口 | `public/index.html` |
| 固定案件 | `CASE-2026-001`（TW-STEEL-01 / 2026） |
| 角色切換 | header `x-demo-role`（畫面按鈕切換） |
| Supplier | 上傳 synthetic evidence、人工確認、提交、建立 Verifier Grant |
| Importer | 摘要、證據完整度、actual vs default（Demo estimate） |
| Verifier | Evidence Index、一次性 token 開啟／**下載**底稿、findings |
| 信任文案 | `READY_FOR_VERIFIER` 只代表送查準備條件，**不代表**正式查驗或官方核准 |
| 依賴服務 | Agent／Proof／Gate 顯示「尚未驗證」；提交後 **METHOD_REVIEW**；`POST /api/workflow/revalidate` 接 trust hook（8/26 B 接真 ZKP/Gate 後才可 READY） |

`x-demo-role` 只是可切換的 **Demo 身分**，沒有真實 authentication／authorization，也沒有 tenant 隔離。Root UI 與 Worker 可部署版本只允許 synthetic data；公開部署時任何人都能切換角色、操作案件及以 Supplier 重置。正式環境必須停用此機制，或改接真實 auth 與 tenant-scoped store。

API 範例：[`docs/handoff/DAY2_API_EXAMPLES.json`](docs/handoff/DAY2_API_EXAMPLES.json)
測試清單：[`docs/handoff/DAY2_TEST_CASES.md`](docs/handoff/DAY2_TEST_CASES.md)

---

## Legacy 入口（舊版 PCF 三幕）

[http://127.0.0.1:3847/legacy.html](http://127.0.0.1:3847/legacy.html) — 2026-07 改題前的 **碳數據信任閘門 Agent V1**：Agent 索取 PCF → 品質閘 → 人類核准 CBAM 草稿；權限唯一放行點為 `PolicyEngine.evaluate`（見 `docs/trust/POLICY_SPEC.md`）。

Root UI header 亦有「舊版 PCF 介面參考」連結。Legacy 與 carbon-core **兩套資料模型並存**，互不呼叫。

### 可選：接語言模型（Legacy Demo 主線）

```bash
cd mandate
copy .env.example .env
# 編輯 .env，填入 OPENAI_API_KEY=sk-...
npm start
```

- 有 Key：legacy 介面「AI 自動演三幕」
- 無 Key：左欄手動備援三幕
- **勿把 `.env` 提交進 git**

### 可選：稽核紀錄雙寫 Supabase（Legacy）

見 `.env.example` 的 `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`；執行 `supabase/schema.sql` 後啟用。Workflow Audit 預設仍為記憶體。

---

## npm scripts

| Script | 用途 |
|--------|------|
| `npm start` | 啟動 `server/index.js`（port **3847**） |
| `npm run smoke:carbon-core` | Phase 1 計算核心 + schema validator（36 項） |
| `npm run smoke:workflow` | Day 2 workflow API + UI 靜態契約 |
| `npm run smoke:ui` | 僅 UI 靜態契約 |
| `npm run smoke` | Legacy policy（12 vectors + 4 trace） |
| `npm run smoke:agent` | Legacy agent（需 Key，無 Key 則 SKIP） |
| `npm run dev:cf` / `deploy:cf` | 可部署的 synthetic Hackathon Demo（含 Root UI；非正式環境） |

---

## 2026-08-23 改題後的 Carbon Core

最高工程規格：《Vibe Coding AI 完整工程規格與指令手冊》。Phase 1 核心位於 `packages/contracts/`、`services/carbon-core/`、`fixtures/`。

normal Demo 由明確標 `demoOnly` 的 activities/factors 計算 `360 tCO2e ÷ 200 tonnes = 1.80 tCO2e/tonne`，再分攤 SHIP-A 180、SHIP-B 108；**不代表**官方係數或真實鋼廠資料。

改題記錄：`DECISIONS.md` §9。Day 1 handoff：[`docs/handoff/PHASE1_SESSION_LOG.md`](docs/handoff/PHASE1_SESSION_LOG.md)。

---

## 目錄

| 路徑 | 說明 |
|------|------|
| `public/index.html` | **Day 2** 三角色 Root UI |
| `public/legacy.html` | Legacy PCF 三欄工作台 |
| `server/workflowApi.js` | Day 2 workflow + Vault API |
| `server/trustAdapter.js` | Trust evaluate hook（Day 3 接 ZKP/Gate） |
| `server/carbonAdapter.js` | carbon-core 整合與 service stubs |
| `packages/contracts/` | Canonical schema、enums、validator |
| `services/carbon-core/` | 年度／批次計算（唯一數字來源） |
| `tests/workflow/`、`tests/ui/` | Day 2 煙測 |
| `docs/handoff/` | Day 1 / Day 2 / Day 3 交棒文件 |
| `docs/trust/` | Legacy 六信任要點規格 |

---

## Day 2 Workflow API 摘要

需 header `x-demo-role: Supplier|Importer|Verifier`；Vault 另需 `x-vault-token`（**不得**放 query）。

- `GET /api/cases` · `GET /api/cases/:id` · `POST /api/cases/:id/submit` · `GET /api/cases/:id/audit`
- `POST /api/evidence` · `POST /api/evidence/:id/confirm`
- `GET /api/importer/cases/:id/summary`
- `GET /api/verifier/cases/:id/evidence` · `POST /api/verifier/cases/:id/findings`
- `POST /api/vault/grants` · `POST /api/vault/grants/:id/revoke`
- `GET /api/vault/items/:id` · `GET /api/vault/items/:id/download`
- `POST /api/workflow/carbon/preview`（回 `previewOnly:true`、`clientSuppliedInput:true`，不寫入案件） · `POST /api/workflow/revalidate`（Supplier，trust hook） · `POST /api/workflow/reset`（僅 Supplier）

Legacy API（`/api/tools/*`、`/api/agent/*` 等）見 legacy 段落與 `docs/trust/`。

---

## Legacy Demo 三幕（僅 `legacy.html`）

1. Agent 向無證零件行索取 → `DENY_CONSTRAINT` / `POL-CARB-001`
2. Agent 向青禾索取 → 入庫 → `PENDING_HUMAN` / `POL-HITL-010` → 人類核准
3. 撤銷分享 → `DENY_REVOKED` / `POL-REV-010`

話術：[`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)。

---

## 文件優先

| 交件／規格 | 路徑 |
|------------|------|
| Day 2 交棒 | [`docs/handoff/DAY2_EXECUTION_PLAN.md`](docs/handoff/DAY2_EXECUTION_PLAN.md) |
| Day 2 session log | [`docs/handoff/PHASE2_SESSION_LOG.md`](docs/handoff/PHASE2_SESSION_LOG.md) |
| Day 3 trust engine | [`docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md`](docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md) |
| Governance Gap Memo | [`docs/trust/GOVERNANCE_GAP_MEMO.md`](docs/trust/GOVERNANCE_GAP_MEMO.md) |
| 信任架構 | [`docs/trust/TRUST_ARCHITECTURE.md`](docs/trust/TRUST_ARCHITECTURE.md) |
| Policy 契約（Legacy） | [`docs/trust/POLICY_SPEC.md`](docs/trust/POLICY_SPEC.md) |

> Legacy 執行碼若與 docs 殘留採購付款工具名，以 **docs 為準**；Root UI 已對齊 carbon-core 主線。

---

## 刻意不做（Prototype）

正式 CBAM registry 提交、碳權避險、ZKP／Policy Gate／Evidence Agent **正式上線**（Day 2 僅 trust hook）、Factor Registry 正式治理、正式 KMS/HSM、讓 LLM 自判權限、宣稱官方查驗完成或海關核准。

已知限制：Evidence `version` 目前恆為 `1`，同名檔案直接拒絕，尚未實作 evidence 版本演進。Worker 路徑可部署 synthetic Demo，但正式環境必須關閉 `x-demo-role`／公開 reset，或換成真實 auth 與 tenant store。
