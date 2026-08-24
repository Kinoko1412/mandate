# Mandate｜已定案事項

> **效力**：下列事項已確認，隊內實作與簡報**勿再討論、勿改方向**。若與程式衝突，以本檔與 `docs/trust/*` 為準，改碼對齊文件。  
> **定案日**：2026-07-20  
> **題目修訂**：同日由「採購付款閘」改為「CBAM／嵌入排放 碳數據信任閘門」；舊採購敘事作廢。

---

## 1. 題目與產品名

| 項目 | 定案 |
|------|------|
| 題目 | **碳數據信任閘門 Agent**（CBAM／嵌入排放） |
| 副標 | **碳數據**：索取實際嵌入排放 → 品質閘 → 人類確認才寫入 CBAM 草稿 → audit；撤銷後不可用 |
| 定位 | 代表買方法人；可索取／入庫 PCF 碳數據；寫入 CBAM 申報草稿必須人類核准；資料分享可撤銷且撤銷後不得再用 |
| 產品名 | **Mandate**（繁中敘事為主，專有名詞英文並陳） |
| 官方參考方向 | 供應鏈與貿易金融（ESG／碳資料可信度；Agent 授權邊界） |

**一句話**：Mandate 向供應商索取實際嵌入排放，經品質閘後，由人類確認才寫入 CBAM 草稿並留下 audit；分享一旦撤銷，既有數據不可再用於申報。

---

## 2. 技術棧與權限邊界

| 項目 | 定案 |
|------|------|
| 前端 | **純 HTML + CSS + JS**（`public/`） |
| 後端 | 輕量 **Node.js** |
| LLM | **可選**：`OPENAI_API_KEY`（見 `.env.example`）；僅能**提議** tool，放行仍只經 Policy Engine |
| 權限決策 | **只在程式 Policy Engine**（`server/policy.js`）；不信任 LLM 自判 |
| 契約 | 每筆決策／audit 必帶 **`policyId`**，對應 `docs/trust/POLICY_SPEC.md` 條文 |

---

## 3. Agent 工具（V1）

| toolId | 誰可呼叫 | 語意 |
|--------|----------|------|
| `request_emissions` | Agent | 向供應商索取嵌入排放／PCF 資料 |
| `fetch_supplier_response` | Agent | 取回供應商回覆（須先 request） |
| `ingest_pcf_payload` | Agent | 入庫前跑品質閘；不合格拒收 |
| `submit_cbam_draft` | Agent | 提議寫入 CBAM 申報草稿 → **必 PENDING_HUMAN** |
| `commit_cbam_draft` | **僅 Human／後端** | 人類核准後才真正寫入草稿；**Agent 永不暴露** |
| `revoke_data_share` | Human（預設） | 撤銷資料分享；之後不得再用該批數據 |

---

## 4. 碳為主角（範圍鎖）

| 做 | 不做 |
|----|------|
| 嵌入排放／PCF 品質閘、CBAM **草稿**申報 HITL、audit、分享撤銷 | 真 CBAM registry／官方申報 API |
| 缺 method／boundary／period／unit／tCO2e／supplierId → 拒收 | 碳權避險、碳費套利、儀表板產品 |
| 漂亮但缺欄位的「噸數」一樣拒 | 完整 PCF 核算引擎、多市場碳交易 |

碳是產品主線，**不是**採購付款的附屬憑證。

---

## 5. 文件與實作優先序

| 項目 | 定案 |
|------|------|
| 優先序 | **文件優先**：六信任要點先有嚴謹架構 MD，程式是規格的可執行子集 |
| 規則變更 | 新增／修改規則：**先改 MD，再改碼**；碼內分支註解 `// POL-xxx` |
| 必備 trust 文件 | `TRUST_ARCHITECTURE`、`PERMISSION_MATRIX`、`POLICY_SPEC`、`DATA_MODEL`、`GOVERNANCE_GAP_MEMO`、`THREAT_AND_GAPS` |

---

## 6. Demo 三幕（不可改情節）

| 幕 | 動作 | 預期決策（示意） |
|----|------|------------------|
| **一** | 入庫「漂亮噸數」但缺品質欄位 | `DENY_CONSTRAINT`／`POL-CARB-001`（拒收） |
| **二** | 合格 PCF 入庫 → `submit_cbam_draft` | `PENDING_HUMAN`／`POL-HITL-010` → 人類核准 → `commit_cbam_draft`（Human） |
| **三** | `revoke_data_share` 後再試用該數據 | `DENY_REVOKED`／`POL-REV-010`（撤銷後不能用） |

畫面／audit 必須同時可見 **`decision` + `policyId`**。

---

## 7. V1 刻意不做（範圍鎖）

- 真 CBAM 官方 registry／真實海關申報通道  
- 碳權避險、碳費套利、儀表板／可視化產品主軸  
- 完整第三方 PCF 核算或多市場碳權 API  
- 多 Agent 編排  
- 讓 LLM 自行決定權限  
- 撤銷後「自行恢復」同一資料分享（需重新授權／新 share；規格寫明）  
- Agent 可呼叫 `commit_cbam_draft`（V1 **永不暴露**給 Agent）

---

## 8. 企業串接表述（誠實上限）

- V1：**全 fixture**（合成供應商／PCF payload／CBAM draft store）  
- 可接路徑：Mandate／Approval／Audit／PcfPayload 的 **schema** 預留接供應商 API、簽核 webhook、內部 CBAM 草稿庫  
- 勿對外宣稱「已接歐盟 CBAM registry」或「已驗證真實第三方 PCF」
- 稽核紀錄／核准紀錄／AI 對話：可選填 Supabase 雙寫持久化（見 `supabase/schema.sql`、README「可選：稽核紀錄雙寫進 Supabase」段落）；未設定 `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` 時維持 V1 原本的全記憶體行為，核心 Policy Engine 判斷邏輯與 fixture 架構不受影響

---

## 9. 變更本檔的條件

僅當主辦規則衝突、或隊長明確宣告改題時，才可修訂本檔；修訂須留日期與原因一行。

**修訂記錄**：

- 2026-07-27：新增稽核紀錄／核准紀錄／AI 對話的 Supabase 選填雙寫持久化（`server/supabaseSync.js`、`supabase/schema.sql`）。原因：官方六信任要點之一的 Audit Log 屬實際評分項目，V1 全記憶體儲存重啟即消失，無法對評審展示「可追蹤」的持久性與防竄改（雜湊鏈）。此為**附加雙寫**，不改動核心 Policy Engine 判斷邏輯、不觸碰第 7 節任何排除項目、未設金鑰時完全不啟用；為使用者主動要求，非 AI 建議。
- **2026-08-23（已由隊長葉士愷正式宣告，滿足本文件第 9 節「隊長明確宣告改題」的程序要求；與隊友黃昱羲討論並確認一致）**：改題範圍大幅調整——兩人（葉士愷 + 黃昱羲）討論後決定改採兩份新規劃文件實作：`可信碳排證據Agent_8月24日至28日雙人落地分工計畫.pdf`（五天四次交棒時程）+ `可信碳排證據Agent_落地風險審查與修正版方案.pdf`（25 頁，法定資料模型改為「工廠年度層＋批次交易層」）。**這使本文件第 1、3、4、6 節（PCF 單筆申報敘事、Demo 三幕、`POL-CARB-001`／`POL-HITL-010`／`POL-REV-010` policyId 契約、青禾零件情境）不再是本週的實作依據**，改用新的 `GateStatus`（`READY_FOR_VERIFIER`／`NEEDS_EVIDENCE`／`METHOD_REVIEW`／`VERIFIER_REQUIRED`／`BLOCKED`）與新的 `ReasonCode` 體系（見 `packages/contracts/enums.js`），Demo 情境換成鋼鐵單一案例（`TW-STEEL-01`）。原因：兩份新文件是賽前工作坊後對法規／風險落地面的深入審查結果，原版單筆 PCF 申報敘事不符合 CBAM 實際法定計算底層（工廠安裝／製程／曆年）。舊的 `server/policy.js`／`docs/trust/*.md` 架構暫不刪除，留作參考（見 `services/carbon-core/README.md` 的「已知限制」與同資料夾外的 fork 現況盤點文件）。
