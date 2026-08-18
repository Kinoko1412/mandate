# Cloudflare Workers 部署

Mandate 可用 **Cloudflare Workers + Static Assets** 一鍵部署（前端 `public/` + API `/api/*` 同一網域）。

## 前置

1. [Cloudflare 帳號](https://dash.cloudflare.com/)
2. Node.js 18+

## 第一次部署

在 `mandate/` 目錄：

```powershell
npm install
npx wrangler login
```

（選填）設定 OpenAI Key，主控版 AI 三幕 Demo 才會跑 Agent：

```powershell
npx wrangler secret put OPENAI_API_KEY
```

（選填）把稽核紀錄／核准紀錄／AI 對話雙寫進 Supabase（見 `supabase/schema.sql`）：

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
```

部署：

```powershell
npm run deploy:cf
```

成功後終端機會顯示網址，例如：

`https://mandate.<你的子網域>.workers.dev`

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
| 狀態 | Demo 資料在單一 Durable Object 實例的**記憶體**（見下方「狀態一致性」），閒置太久被回收或重新部署後會重置 |
| AI | 未設 `OPENAI_API_KEY` 時仍可用按鈕備援三幕 |
| 機密 | **勿**把 API Key 寫進 `wrangler.toml`；用 `wrangler secret` |
| Supabase | 選填、雙寫、失敗不影響 Demo；未設 `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` 時完全不啟用 |

## 狀態一致性（Durable Object，2026-08-18 新增）

`worker/index.js` 的 `/api/*` 路由全部經由一個固定名稱（`"global"`）的 Durable Object 實例（`MandateState` class）處理，`server/store.js`／`server/agentSession.js` 的模組層級記憶體狀態因此只會存在**單一** JS 執行環境裡。

**背景**：純用 `export default { fetch(request, env, ctx) {...} }` 的 Workers 沒有「同一瀏覽器分頁的連續請求會落在同一個 isolate」這種保證——2026-08-18 實測發現：即使是正常人類操作速度（點擊間隔幾秒），也會出現「剛撤銷的供應商憑證，另一個請求卻還看到撤銷前的狀態」這種真實案例，不只是理論上的邊界情況。Durable Object 是 Cloudflare 官方針對這類「需要單一一致記憶體狀態，但不想接外部資料庫」情境的建議做法：`wrangler.toml` 加 `[[durable_objects.bindings]]` + `new_sqlite_classes` migration（**Workers Free 方案已支援**，SQLite 儲存後端不額外收費，見 [2025-04-07 changelog](https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/)），純粹拿來當「保證單一執行環境」的容器，**沒有使用** `ctx.storage`，不算違反「V1 刻意零持久化」原則——`state` 該重置的時候（Durable Object 被回收、重新部署）還是會重置，行為跟 `npm start` 的單一 Node process 一致，只是把這個一致性也帶到 Cloudflare Workers 上。

**驗證方式**：連續多輪、每步間隔 2 秒的獨立 curl 呼叫（`request→fetch→revoke→ingest`），修復前偶發不一致，修復後 8/8 輪皆正確。

## 與本地 `npm start` 差異

| | `npm start` | Cloudflare |
|--|-------------|------------|
| 埠 | `127.0.0.1:3847` | HTTPS 443 |
| API | `/api` | 同左（同源） |
| 環境變數 | `.env` | `wrangler secret` / Dashboard |

## 更新部署

改完程式後：

```powershell
npm run smoke
npm run deploy:cf
```
