# Mandate — 給 Claude Code 的專案指引

碳數據信任閘門 Agent（CBAM／嵌入排放），可信 AI 黑客松 2026 PoC。

## 先讀這些，不要重複問

範圍、產品名、Demo 三幕劇情已經**定案鎖死**（2026-07-20）：`DECISIONS.md`。
評審敘事、評分對齊、六要點話術：`docs/STRATEGY.md`。
六信任要點的完整規格：`docs/trust/*.md`（`POLICY_SPEC.md`、`PERMISSION_MATRIX.md`、`DATA_MODEL.md`、`GOVERNANCE_GAP_MEMO.md`、`TRUST_ARCHITECTURE.md`、`THREAT_AND_GAPS.md`）。

**不要在未看過 `DECISIONS.md` 第 7 節「V1 刻意不做」之前，建議恢復那些排除項目**（真 CBAM registry、碳權避險、儀表板、多 Agent、讓 LLM 自判權限）——這些是團隊評估過的主動排除，不是遺漏。修改範圍需要「主辦規則衝突」或「隊長明確宣告改題」，且要在 `DECISIONS.md` 留下日期與原因。（本分支對「多 Agent」這條有一個已留痕的例外，見下方「本分支對 `DECISIONS.md` §7 的偏離」一節——不是遺漏，是已記錄的個人 fork 實驗。）

## 不可違反的架構原則

- **`server/policy.js` 是唯一放行點**。任何新工具、新規則，一律先改 `docs/trust/POLICY_SPEC.md`、程式碼分支加 `// POL-xxx` 註解對應規格，再改 `server/policy.js`。不要讓 LLM 自己判斷權限。
- **`commit_cbam_draft`（真正寫入 CBAM 草稿）永遠不能被 Agent 呼叫**，只能是人類/後端觸發。這是整個 Demo 論證的核心——一旦讓 Agent 直接呼叫它，HITL（人審）敘事就整個垮了。改動 `server/agent.js`、`server/toolRuntime.js` 時特別注意這條線沒被打破。
- **V1 刻意零持久化（核心閘門邏輯）**：`server/store.js` 的 `state` 是記憶體變數，資料全來自 `server/fixtures/`，重啟就重置（有 `/api/reset`）。這是刻意設計，不要主動建議加資料庫接管核心邏輯。
  - 例外（2026-07-27 使用者主動要求，非 AI 建議）：`server/supabaseSync.js` 把稽核紀錄／核准紀錄／AI 對話**額外雙寫**進 Supabase（PostgREST fetch，無 SDK），純附加、失敗不影響閘門邏輯，未設 `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` 時完全不啟用。這不算恢復被排除的功能，是強化 Audit Log 這個既有信任要點——但正式上場前建議在 `DECISIONS.md` 補一筆日期與原因，避免評審對照文件時出現矛盾。
- **信心分數（`server/confidenceScore.js`，2026-08-17 新增）僅供排序／提示 UI 使用，絕不能用於略過 `POL-HITL-010` 或任何 `policy.js` 判斷**。這是純確定性加權的展示層 metadata（`staging`／`GET /api/cases`／pending approval 都會帶這個欄位），`policy.js` 完全不讀它、也不應該讀它。送審與否永遠由 `policy.js` 決定，改動這塊時特別注意不要讓分數影響任何一個 `stepN_*` 函式的判斷。

## 有兩個執行入口，改動時兩邊都要顧到

`server/index.js`（本機 `npm start`，Node 原生 `http`）和 `worker/index.js`（Cloudflare Workers，`wrangler deploy`）**共用同一套邏輯**，都是透過 `server/apiFetch.js` 進去。改 API 行為時，本機測完不代表 Workers 版本沒問題，兩邊入口都要留意。

**Cloudflare 端額外多一層**（2026-08-18 新增）：`worker/index.js` 把全部 `/api/*` 流量轉發進一個固定名稱（`"global"`）的 Durable Object（`MandateState` class），`server/store.js`／`server/agentSession.js` 的模組層級記憶體狀態因此保證落在單一 JS 執行環境。**改 `worker/index.js` 時不要繞過這個轉發**——直接在 `export default { fetch }` 裡呼叫 `handleFetchRequest`（跳過 DO）會讓 isolate 不一致的舊 bug 復發（見下方「已知歷史問題」）。細節與驗證方式見 `docs/DEPLOY_CLOUDFLARE.md`「狀態一致性」一節。

## 已知歷史問題

`server/agent.js` 第 45-46 行曾經有一個逗號打成分號的語法錯誤，導致 `npm start` 直接 crash（`npm run smoke` 測不到這個路徑，會誤以為沒事）。如果又遇到啟動就 crash，先檢查這類低級語法錯誤，而不是假設是邏輯問題。

**Cloudflare Workers 的 isolate 不一致曾經讓 Policy Engine 判斷本身出錯，不只是展示層（2026-08-18 發現並修好）**：純 stateless `fetch(request, env, ctx)` handler 沒有「同一瀏覽器分頁的連續請求會落在同一個 isolate」的保證——實測發現即使是正常人類操作速度（點擊間隔幾秒），也會出現「剛撤銷的供應商憑證，另一個請求卻還看到撤銷前的狀態」這種真實案例（不只是理論邊界情況）。已用 Durable Object 修好（見上方「有兩個執行入口」段落），8 輪、每步間隔 2 秒的重測全部一致。**如果之後又在 Cloudflare 上看到「明明剛做過的動作，後續請求卻好像沒發生」，先檢查是不是又繞過了 `MandateState` DO 轉發**，而不是假設是新的邏輯 bug。

**「AI 自動演三幕」曾經很容易卡住（2026-07-28 發現並修好）**：`runAgentTurn` 每一步都靠 LLM 自己判斷「這樣算不算做完」再決定要不要繼續呼叫下一個工具——gpt-4o-mini 常常索取/取回完資料就提早回文字總結，不會繼續往下呼叫 `ingest_pcf_payload`／`submit_cbam_draft`，導致單一 Agent 對話卡在第一兩步。實測 4 次一鍵演示只有 1 次完整跑完。已加兩層修正（都在 `runAgentTurn` 內、`policy.js` 完全沒動）：①LLM 過早回 `tool=null` 時，最多給 2 次「繼續完成」的強制提醒才真的收手；②偵測到 LLM 想跳過 `ingest_pcf_payload` 直接呼叫 `submit_cbam_draft`（且該供應商尚未入庫、分享也還沒撤銷）時，攔下來改提醒先做品質檢查。**這只是讓 Demo 順序更穩定的提示工程，不是新的權限判斷**——不管 LLM 提議什麼順序，最終 ALLOW/DENY/PENDING_HUMAN 永遠由 `policy.js` 决定；已用 18 次 API 層級重跑（含撤銷後再申請）驗證過三幕最終判定 100% 正確。

## Demo 三幕的 policyId 是穩定契約

`POL-CARB-001`（拒收缺欄位）、`POL-HITL-010`（送審）、`POL-REV-010`（撤銷後拒用）這幾個 ID 會被 Demo 逐字稿、簡報、Governance Gap Memo 交叉引用。改規則邏輯可以，但**不要隨意改這些 ID 字串**，否則文件跟畫面會對不上。

## 本分支對 `DECISIONS.md` §7 的偏離（2026-08-17，僅限本分支）

`feature/trust-enhancements` 分支的「資訊分層」功能（`server/llm.js` 的 `proposeCarbon`／`proposeAuth`）刻意採用**真正的多 Agent**（固定分工、並行發言、同一個 `policy.js` 關卡），偏離 `DECISIONS.md` §7「V1 不做：多 Agent 編排」。

- **決策者**：使用者本人在個人 fork 上的實驗性探索，**不是**隊長對 `1qaz0726-star/mandate:main` 的正式宣告。正式併回 `main` 前，需要跟隊友討論並視結果走 `DECISIONS.md` §9 的正式修訂流程（或維持只留在個人 fork）。
- **範圍**：**只**偏離「多 Agent 編排」這一條。§7 另一條「讓 LLM 自行決定權限」**完全沒動、仍全面禁止**，且有結構性保證（不是靠 prompt 拜託）：`AuthAgent` 的允許工具集合（`llm.js` 的 `AUTH_ALLOWED_TOOLS`）是空集合，**結構上**不可能提議任何可執行的工具；`CarbonDataAgent` 沿用今天既有的 4 個工具白名單。兩個 Agent 提議的每一個工具呼叫，仍然 100% 經過 `server/policy.js` 唯一放行點才會執行——沒有新的放行路徑，沒有任何一個 Agent 能自己判斷權限。
- **理由**：使用者認為之後若要降低資訊暴露風險，把不同資訊固定分派給不同 Agent（而非單一 Agent 分次呼叫）架構上更乾淨。
- **技術細節**：見 `docs/trust/TRUST_ARCHITECTURE.md`「為何這不是多 Agent 編排」一節。

## 团队协作

這是共用 repo，不要直接 push 到 `main`。改完先跑 `npm run smoke`（16 項 policy 決策測試，秒級）確認沒把閘門邏輯改壞，再開 PR。
