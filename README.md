# Mandate — 可信碳排證據 Agent（Hackathon Prototype）

**產品定位（2026-08-27）**：協助台灣鋼鐵供應商與歐盟進口商，在**正式 CBAM 查驗／申報前**，把工廠年度排放、批次分攤、佐證文件與限時授權整理成可追溯的**證據案件**（Demo Prototype，**非**官方 Registry、**非**法定查驗完成）。

- **我們是**：申報前證據準備與風險預審協作層、確定性 carbon-core 計算、Demo Vault 與三角色工作流、Trust Engine（demo commitment + policy/factor gate）、**Evidence Agent 規則引擎預審**（無 LLM）、**四幕 Demo 控制台**。
- **我們不是**：政府／海關、CBAM Registry、法定第三方查驗機構、已由 ZKP／LLM Agent／Gate **正式驗證**的商用產品。

**Git（Day 4）**：分支 `feature/agent-demo-integration`；runtime commits `b4a8bef`、`635baf7`、`9b2e6ab`、`b712df2`；影像 `c1d4ec6`（git 記錄日 **2026-08-24～25**）。Draft PR [#6](https://github.com/1qaz0726-star/mandate/pull/6) 為對 **`main` 的累積型 Draft PR**，已含 Day 1–4 commits；PR #3／#4／#5 亦 target `main` 且內容已涵蓋（#4 `55ac373` ≈ PR6 `b4a8bef`），**均未 merge**——8/28 建議 review/merge **#6** 並關閉舊 PR。

**部署**：https://mandate.1qaz0726.workers.dev · Cloudflare Version ID `6178232c-8ebf-4d0a-ab0f-814af9719ee0`（部署日 git 記錄 **2026-08-24～25**；**僅 synthetic data**）。

Day 4 交棒：[`docs/handoff/DAY4_WORK_SUMMARY_20260827.md`](docs/handoff/DAY4_WORK_SUMMARY_20260827.md) · [`PHASE4_SESSION_LOG.md`](docs/handoff/PHASE4_SESSION_LOG.md) · 四幕腳本 [`docs/demo/DAY4_FOUR_ACT_DEMO.md`](docs/demo/DAY4_FOUR_ACT_DEMO.md)

---

## 快速啟動（Day 4 主線）

```bash
cd mandate
npm start
```

瀏覽器開啟 [http://127.0.0.1:3847/](http://127.0.0.1:3847/) — **Root UI**：三角色工作流 + **四幕 Demo 控制台** + Evidence Agent + Trust 重驗。

### 四幕操作（約 4 分鐘）

| 幕 | 操作 | 預期 |
|----|------|------|
| **1 正常** | Supplier →「一鍵執行正常案件」 | `READY_FOR_VERIFIER`（Agent 預審不參與 readiness） |
| **2 揭露** | Grant → Importer 摘要 → Verifier 開底稿一次 | Importer 無底稿全文；token 一次性 |
| **3 攻擊** | 三 attack 按鈕 | `BLOCKED` + reason code；正常案件不變 |
| **4 邊界** |「展示物理真實邊界」 | `physicalRealityVerified: false` |

逐步腳本：[`docs/demo/DAY4_FOUR_ACT_DEMO.md`](docs/demo/DAY4_FOUR_ACT_DEMO.md)

GIF／截圖：[`docs/handoff/screenshots/day4/`](docs/handoff/screenshots/day4/)

**驗收（無需 API Key）**

```bash
npm run smoke:carbon-core      # 36
npm run smoke:evidence-agent   # 20
npm run smoke:workflow         # workflow 47 + UI 19 = 66
npm run smoke:trust            # 43
# 合計 165
```

**環境變數**：Day 4 主線 **無新增**；`.env.example` 僅供 legacy 三幕可選功能。

---

## Day 4 Root UI

| 項目 | 說明 |
|------|------|
| 入口 | `public/index.html` |
| 固定案件 | `CASE-2026-001`（TW-STEEL-01 / 2026） |
| 角色切換 | header `x-demo-role`（**Demo 身分，非真實 auth**） |
| 四幕控制台 | `#run-act-1`／`#run-act-2`／attack 三按鈕／`#run-act-4` |
| Evidence Agent | `#run-agent-analysis` → `POST /api/cases/:id/agent/analyze`（**rule engine，無 LLM**） |
| Trust 重驗 | `#revalidate-trust` → `POST /api/workflow/revalidate` |
| Supplier | synthetic evidence、確認、提交、Agent 預審、Grant |
| Importer | 摘要、**agentSafeSummary**（非 RiskReport 全文）、actual vs default **2.5**（Demo estimate） |
| Verifier | Evidence Index、一次性 token 開啟／**download**、findings |
| 信任文案 | `READY_FOR_VERIFIER` = 送查準備，**≠** 正式查驗或官方核准 |

公開部署（含 Workers URL）**只允許 synthetic data**；任何人可切換角色／reset——正式環境須停用或接真實 auth。

API 範例：[`docs/handoff/DAY4_API_EXAMPLES.json`](docs/handoff/DAY4_API_EXAMPLES.json)

測試清單：[`docs/handoff/DAY4_TEST_CASES.md`](docs/handoff/DAY4_TEST_CASES.md)

---

## Evidence Agent（`services/agent/` + `server/agentAdapter.js`）

確定性 **rule engine**（`demo-rule-based-no-llm-v1`），**不是 LLM**：

- 證據解析：`application/json` 走 **JSON parser**（`JSON.parse` → `entries`／`pages[].entries`）；非 JSON 或 JSON 失敗時走固定 **`key=value;`** 分號行 **text parser**（`field=…;value=…;unit=…;page=…`）。無 OCR／外部模型。
- 輸出 canonical `RiskReport`：entries、findings、missingEvidence、heuristics。
- Injection sandbox、DoS caps；低信心高影響值不 eligible。
- Workflow 整合：`execution=executed`，`verification=not_verified`——**不修改** case status／proof／gate readiness。
- Importer 只看 `agentSafeSummary`；audit 僅 reportId／counts／reasonCodes。

測試：`npm run smoke:evidence-agent`（**20** 項）。

---

## Trust Engine（`services/proof` + `factor-registry` + `policy-registry` + `policy-gate`）

`server/trustAdapter.js` production evaluator：normal fixture 經 revalidate → `READY_FOR_VERIFIER`；攻擊 fixture → `BLOCKED`／`NEEDS_EVIDENCE`。

> **⚠️ 不是 zk-SNARK。** `ProofEnvelope.proof` = `demoOnly:sha256:` **hash commitment**（規格 cut plan fallback）。現場重算 + `crypto.timingSafeEqual`；`cryptographic_proof` check 永遠 `skipped`。
>
> **Nonce 邊界**：in-memory ledger；Cloudflare Workers **跨 isolate 不共享** → **不得**宣稱完整 replay protection。`setNonceLedger(adapter)` hook 供 Durable Object／KV／D1。
>
> **Registry**：Factor／Policy 為程式內 **寫死** Demo 清單，非官方治理。

Demo attack（server-side，不寫 store）：`POST /api/demo/attack` — `tampered_quantity`／`wrong_factor`／`proof_context_swap`。

測試：`npm run smoke:trust`（**43** 項）。

---

## Legacy 入口（舊版 PCF 三幕）

[http://127.0.0.1:3847/legacy.html](http://127.0.0.1:3847/legacy.html) — 2026-07 改題前 V1；需可選 `OPENAI_API_KEY` 才跑 LLM Agent 三幕。與 carbon-core 主線**並存、互不呼叫**。

---

## npm scripts

| Script | 用途 |
|--------|------|
| `npm start` | 啟動 `server/index.js`（port **3847**） |
| `npm run smoke:carbon-core` | Phase 1 計算核心 + schema validator（**36**） |
| `npm run smoke:evidence-agent` | Day 4 Evidence Agent（**20**） |
| `npm run smoke:workflow` | Workflow API（**47**）+ UI 靜態契約（**19**） |
| `npm run smoke:trust` | Trust engine（**43**） |
| `npm run smoke:ui` | 僅 UI 靜態契約 |
| `npm run smoke` | Legacy policy（12 vectors + 4 trace） |
| `npm run smoke:agent` | Legacy OpenAI agent（需 Key，無 Key 則 SKIP） |
| `npm run dev:cf` / `deploy:cf` | Cloudflare synthetic Demo（見 [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md)） |

---

## 2026-08-23 改題後的 Carbon Core

`packages/contracts/`、`services/carbon-core/`、`fixtures/` — normal Demo **360 tCO2e ÷ 200 t = 1.80**，分攤 **180／108**（`demoOnly` activities/factors）。

改題記錄：`DECISIONS.md` §9。

---

## 目錄

| 路徑 | 說明 |
|------|------|
| `public/index.html` | **Day 4** 三角色 + 四幕控制台 |
| `public/js/case-workflow.js` | 四幕一鍵、Agent、attack、Vault |
| `services/agent/` | Evidence Agent rule engine |
| `server/agentAdapter.js` | Agent ↔ workflow 接點 |
| `server/trustAdapter.js` | Trust evaluate + demo attack harness |
| `server/workflowApi.js` | Workflow + Agent + `/api/demo/*` |
| `docs/handoff/DAY4_*` | Day 4 交棒四件套 |
| `docs/demo/DAY4_FOUR_ACT_DEMO.md` | 四幕簡報腳本 |
| `docs/handoff/screenshots/day4/` | GIF + PNG |

---

## Workflow API 摘要（Day 4）

需 header `x-demo-role: Supplier|Importer|Verifier`；Vault 另需 `x-vault-token`（**不得**放 query）。

**新增／Day 4 重點**

- `POST /api/cases/:id/agent/analyze` · `POST /api/agent/analyze`（alias，`body.caseId`）
- `POST /api/workflow/revalidate`（Supplier，Trust hook）
- `POST /api/demo/attack`（Supplier，三固定 scenario）
- `GET|POST /api/demo/physical-reality`（誠實邊界，不改 case）

其餘 Day 2 路由：cases、evidence、vault、importer summary、verifier index/findings、carbon preview、reset — 見 [`DAY4_API_EXAMPLES.json`](docs/handoff/DAY4_API_EXAMPLES.json)。

---

## 文件優先

| 交件／規格 | 路徑 |
|------------|------|
| Day 4 小結 | [`docs/handoff/DAY4_WORK_SUMMARY_20260827.md`](docs/handoff/DAY4_WORK_SUMMARY_20260827.md) |
| Day 4 session log | [`docs/handoff/PHASE4_SESSION_LOG.md`](docs/handoff/PHASE4_SESSION_LOG.md) |
| 四幕 Demo | [`docs/demo/DAY4_FOUR_ACT_DEMO.md`](docs/demo/DAY4_FOUR_ACT_DEMO.md) |
| Day 3 trust | [`docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md`](docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md) |
| 部署 | [`docs/DEPLOY_CLOUDFLARE.md`](docs/DEPLOY_CLOUDFLARE.md) |
| Draft PR #6 | https://github.com/1qaz0726-star/mandate/pull/6（對 **main** 累積型 Draft PR，含 Day 1–4） |

---

## 刻意不做（Prototype）

正式 CBAM registry、碳權避險、**真正的 zk-SNARK**、**LLM Evidence Agent**、Factor/Policy **正式治理**（現為寫死 Demo）、正式 KMS/HSM、讓 LLM 自判權限、宣稱官方查驗完成或海關核准或 ZKP 已完成正式驗證。

**已知限制**：Workflow **in-memory**；`x-demo-role` **無 auth**；nonce **跨 isolate 不保證**；`READY_FOR_VERIFIER` **非核准**；Importer default **2.5** = Demo estimate；Evidence `version` 恆 `1`；部署 **僅 synthetic data**。
