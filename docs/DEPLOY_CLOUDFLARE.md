# Cloudflare Workers 部署

Mandate 可用 **Cloudflare Workers + Static Assets** 一鍵部署（前端 `public/` + API `/api/*` 同一網域）。

## 固定 Demo 部署（Day 4）

| 項目 | 值 |
|------|-----|
| URL | **https://mandate.1qaz0726.workers.dev** |
| Cloudflare Version ID | `6178232c-8ebf-4d0a-ab0f-814af9719ee0` |
| 分支 | `feature/agent-demo-integration`（Draft PR [#6](https://github.com/1qaz0726-star/mandate/pull/6)，對 **main** 累積型） |
| 資料 | **僅 synthetic Demo data**——勿上傳真實證據、token 或機密 |

## 前置

1. [Cloudflare 帳號](https://dash.cloudflare.com/)
2. Node.js 18+

## 第一次部署

在 `mandate/` 目錄：

```powershell
npm install
npx wrangler login
```

（選填）設定 OpenAI Key，**Legacy** `legacy.html` AI 三幕才需要：

```powershell
npx wrangler secret put OPENAI_API_KEY
```

（選填）Supabase 雙寫（Legacy audit）：

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
```

部署：

```powershell
npm run deploy:cf
```

## Day 4 部署 smoke（黑箱）

1. 開啟 https://mandate.1qaz0726.workers.dev/
2. 角色 **Supplier** → 四幕控制台 **「一鍵執行正常案件」** → 狀態 **`READY_FOR_VERIFIER`**
3. 幕 3 任一**攻擊按鈕** → `BLOCKED`；正常案件不變
4. 幕 4 **「展示物理真實邊界」** → `physicalRealityVerified: false`
5. 切 **Importer** → 摘要無底稿全文；default **2.5** 標 Demo estimate

詳見 [`docs/handoff/DAY4_TEST_CASES.md`](handoff/DAY4_TEST_CASES.md) §8。

**本地先驗**（交付前）：

```powershell
npm run smoke:carbon-core
npm run smoke:evidence-agent
npm run smoke:workflow
npm run smoke:trust
```

合計 **165** 項（20 + 36 + 47 + 19 + 43）。

## 本機預覽 Cloudflare 版

```powershell
npm run dev:cf
```

本地 `.dev.vars`（勿 commit）可放：

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

## 自訂網域（選填）

Cloudflare Dashboard → Workers & Pages → mandate → Settings → Domains → Add custom domain。

## 限制（Demo 須知）

| 項目 | 說明 |
|------|------|
| 狀態 | Workflow／Vault／nonce ledger 在 Worker **記憶體**；冷啟動或閒置後可能重置 |
| synthetic-only | 公開部署**只允許** synthetic Demo data；勿當正式環境 |
| `x-demo-role` | 可切換的 Demo 身分，**不是**真實 authentication／authorization／tenant 隔離 |
| 任何人可操作 | 未設 auth 時，訪客可切角色、reset、跑四幕——正式環境須停用或接真實 auth |
| Proof | **demo commitment**（`demoOnly:sha256:`），**不是** zk-SNARK |
| Nonce | **跨 Cloudflare isolate 不共享** in-memory ledger → **不得**宣稱完整 replay protection |
| Registry | Factor／Policy 為程式內 **寫死** Demo 清單，非官方治理 |
| Agent | Rule engine（`demo-rule-based-no-llm-v1`），**無 LLM**；不參與 READY |
| READY | `READY_FOR_VERIFIER` = 送查準備條件，**非**官方核准或查驗完成 |
| Importer default | **2.5** tCO2e/t 為硬編碼 **Demo estimate** |
| Legacy AI | 未設 `OPENAI_API_KEY` 時 Legacy 三幕仍可用按鈕備援 |
| 機密 | **勿**把 API Key 寫進 `wrangler.toml`；用 `wrangler secret` |

## 與本地 `npm start` 差異

| | `npm start` | Cloudflare |
|--|-------------|------------|
| 埠 | `127.0.0.1:3847` | HTTPS 443 |
| API | `/api` | 同左（同源） |
| 環境變數 | `.env` | `wrangler secret` / Dashboard |
| Nonce 語意 | 單 process 內有效 | 單 **isolate** 內有效；跨 isolate **不保證** |

## 更新部署

改完程式後：

```powershell
npm run smoke:carbon-core
npm run smoke:evidence-agent
npm run smoke:workflow
npm run smoke:trust
npm run deploy:cf
```

記錄新 Version ID 於 [`PHASE4_SESSION_LOG.md`](handoff/PHASE4_SESSION_LOG.md) 或 PR 描述。
