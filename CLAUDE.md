# Mandate — 給 Claude Code 的專案指引

碳數據信任閘門 Agent（CBAM／嵌入排放），可信 AI 黑客松 2026 PoC。

## 先讀這些，不要重複問

範圍、產品名、Demo 三幕劇情已經**定案鎖死**（2026-07-20）：`DECISIONS.md`。
評審敘事、評分對齊、六要點話術：`docs/STRATEGY.md`。
六信任要點的完整規格：`docs/trust/*.md`（`POLICY_SPEC.md`、`PERMISSION_MATRIX.md`、`DATA_MODEL.md`、`GOVERNANCE_GAP_MEMO.md`、`TRUST_ARCHITECTURE.md`、`THREAT_AND_GAPS.md`）。

**不要在未看過 `DECISIONS.md` 第 7 節「V1 刻意不做」之前，建議恢復那些排除項目**（真 CBAM registry、碳權避險、儀表板、多 Agent、讓 LLM 自判權限）——這些是團隊評估過的主動排除，不是遺漏。修改範圍需要「主辦規則衝突」或「隊長明確宣告改題」，且要在 `DECISIONS.md` 留下日期與原因。

## 不可違反的架構原則

- **`server/policy.js` 是唯一放行點**。任何新工具、新規則，一律先改 `docs/trust/POLICY_SPEC.md`、程式碼分支加 `// POL-xxx` 註解對應規格，再改 `server/policy.js`。不要讓 LLM 自己判斷權限。
- **`commit_cbam_draft`（真正寫入 CBAM 草稿）永遠不能被 Agent 呼叫**，只能是人類/後端觸發。這是整個 Demo 論證的核心——一旦讓 Agent 直接呼叫它，HITL（人審）敘事就整個垮了。改動 `server/agent.js`、`server/toolRuntime.js` 時特別注意這條線沒被打破。
- **V1 刻意零持久化（核心閘門邏輯）**：`server/store.js` 的 `state` 是記憶體變數，資料全來自 `server/fixtures/`，重啟就重置（有 `/api/reset`）。這是刻意設計，不要主動建議加資料庫接管核心邏輯。
  - 例外（2026-07-27 使用者主動要求，非 AI 建議）：`server/supabaseSync.js` 把稽核紀錄／核准紀錄／AI 對話**額外雙寫**進 Supabase（PostgREST fetch，無 SDK），純附加、失敗不影響閘門邏輯，未設 `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` 時完全不啟用。這不算恢復被排除的功能，是強化 Audit Log 這個既有信任要點——但正式上場前建議在 `DECISIONS.md` 補一筆日期與原因，避免評審對照文件時出現矛盾。

## 有兩個執行入口，改動時兩邊都要顧到

`server/index.js`（本機 `npm start`，Node 原生 `http`）和 `worker/index.js`（Cloudflare Workers，`wrangler deploy`）**共用同一套邏輯**，都是透過 `server/apiFetch.js` 進去。改 API 行為時，本機測完不代表 Workers 版本沒問題，兩邊入口都要留意。

## 部署預設一律推正式 Cloudflare 環境

使用者 2026-08-26 明確要求：**只要是「部署」，一律要跑真的 `wrangler deploy` 到線上環境，
不能只在本機 `npm start`／`localhost` 測完就當作做完**，除非使用者明確說要留在本機。
背景：一整晚做完 Vault WebAuthn PRF 功能、本機瀏覽器測得很徹底，但因為沒有真的部署，
使用者要親自問「你有推到 cloudflare 正式網域嗎」才發現根本沒推——這造成了「以為完成了、
其實只在本機」的誤解，這條規則就是要避免這件事重演。

兩個 Cloudflare 帳號要分清楚：使用者自己的（`david460525@gmail.com`，部署到自己帳號下的
`mandate.<subdomain>.workers.dev`）跟隊友 A 的正式帳號（`mandate.1qaz0726.workers.dev`，
GitHub `1qaz0726-star`）。**預設部署到使用者自己的帳號，除非明確被要求才碰 A 的正式網域**
（那是團隊共用的正式展示網址）。

## 已知歷史問題

`server/agent.js` 第 45-46 行曾經有一個逗號打成分號的語法錯誤，導致 `npm start` 直接 crash（`npm run smoke` 測不到這個路徑，會誤以為沒事）。如果又遇到啟動就 crash，先檢查這類低級語法錯誤，而不是假設是邏輯問題。

**Cloudflare Workers 禁止執行期動態產生程式碼（`new Function`/`eval`），且沒有任何
compatibility flag 能開放**——這是這個專案第二次踩到同一類問題（第一次是 ZK 電路的
`WebAssembly.compile` 動態編譯被擋，見 `services/proof/workersWasmCompat.js`；第二次是
2026-08-26 部署時發現 `packages/contracts/validator.js` 用 ajv 在執行期呼叫
`ajv.compile()`，內部用 `new Function()` 產生驗證函式，直接讓部署報
`EvalError: Code generation from strings disallowed for this context`）。**這兩次的解法
是同一個模式：不要在執行期做動態編譯，改成 build time 離線預先產生靜態產物、直接
`require()`**（ZK 電路是預編譯 wasm bytes 靜態 import；ajv 是用官方支援的 "standalone
code" 模式產生純 JS 檔案，見 `packages/contracts/buildValidators.js` +
`packages/contracts/compiledValidators.js`，改了 `schema-v1.json` 要記得重跑這支 build
腳本）。**下次任何新依賴出現「Code generation from strings disallowed」或類似錯誤，
第一個該查的方向就是這個模式，不要浪費時間找 compatibility flag——這個平台真的沒有。**

**「AI 自動演三幕」曾經很容易卡住（2026-07-28 發現並修好）**：`runAgentTurn` 每一步都靠 LLM 自己判斷「這樣算不算做完」再決定要不要繼續呼叫下一個工具——gpt-4o-mini 常常索取/取回完資料就提早回文字總結，不會繼續往下呼叫 `ingest_pcf_payload`／`submit_cbam_draft`，導致單一 Agent 對話卡在第一兩步。實測 4 次一鍵演示只有 1 次完整跑完。已加兩層修正（都在 `runAgentTurn` 內、`policy.js` 完全沒動）：①LLM 過早回 `tool=null` 時，最多給 2 次「繼續完成」的強制提醒才真的收手；②偵測到 LLM 想跳過 `ingest_pcf_payload` 直接呼叫 `submit_cbam_draft`（且該供應商尚未入庫、分享也還沒撤銷）時，攔下來改提醒先做品質檢查。**這只是讓 Demo 順序更穩定的提示工程，不是新的權限判斷**——不管 LLM 提議什麼順序，最終 ALLOW/DENY/PENDING_HUMAN 永遠由 `policy.js` 决定；已用 18 次 API 層級重跑（含撤銷後再申請）驗證過三幕最終判定 100% 正確。

## Demo 三幕的 policyId 是穩定契約

`POL-CARB-001`（拒收缺欄位）、`POL-HITL-010`（送審）、`POL-REV-010`（撤銷後拒用）這幾個 ID 會被 Demo 逐字稿、簡報、Governance Gap Memo 交叉引用。改規則邏輯可以，但**不要隨意改這些 ID 字串**，否則文件跟畫面會對不上。

## 团队协作

這是共用 repo，不要直接 push 到 `main`。改完先跑 `npm run smoke`（16 項 policy 決策測試，秒級）確認沒把閘門邏輯改壞，再開 PR。
