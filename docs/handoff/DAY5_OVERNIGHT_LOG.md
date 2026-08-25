# Day 5 Overnight Session Log

**分支**：`feature/day5-extensions`（從合併 PR #6 後的新 `main` @ `eaa59b2` 開出）
**執行者**：Claude Code（無人看管,使用者睡眠中）
**開始時間**：2026-08-25（見下方各節時間戳）

## 執行規則（使用者本人明確要求）

1. 遇到問題不能輕易放棄——要主動搜尋解法、換方法反覆嘗試，真的窮盡合理嘗試才能記錄「做不到」。
2. ZK 電路目標是做出完整可運作的電路，不是做完 spike 就決定要不要繼續。
3. 每項做完都要跑既有測試驗證，不弱化斷言、不改 fixture 讓造假情境測不出來。
4. 不碰隊友 A 的範圍（前端/Demo 腳本/案件工作流整合）。
5. 不 push 團隊 repo `main`、不開新 PR，只在個人 fork 上開分支備份。
6. 全部做完（或某項窮盡嘗試仍不通、有具體證據）才產出 PDF 向使用者說明。

## 執行順序

1. ZK 電路主線（步驟 0-5，Circom + snarkjs）
2. 全面 LLM Evidence Agent 測試前置工作（OCR fixture、新測試方式、跨文件檢查搬程式碼、`OPENAI_MODEL_EVIDENCE`）
3. 全面 LLM Evidence Agent 測試本體（gpt-5-mini，含 OCR）
4. 背景待辦 1——vLEI 身份驗證接進新 schema
5. 背景待辦 2——GS1/DPP 分層揭露最小示意
6. `schema-v1.json` 接 ajv 驗證器
7. 全部驗證通過後產出工作小結 PDF

---

## 進度紀錄

（逐項在下面追加，crash 後可從這裡接續）

### 1. ZK 電路主線 — ✅ 完成（真的做出完整可運作的電路，不是只做 spike）

- `circuits/carbon_proof.circom`：Circom 2.0，命題不變（各製程階段私密分量 × 公開係數
  加總，證明 total 與合規判斷）。N=4、INPUT_BITS=64、SUM_BITS=132，含防 field wraparound
  的 range check + 除法的見證賦值/範圍檢查/乘回驗證標準模式。
- 真實編譯（circom 2.2.3，官方 Windows binary）+ 真實 trusted setup（公開 Hermez ptau
  ceremony，非自建）+ 真實 groth16 prove/verify，全部端到端跑通。
- **Cloudflare Workers 相容性 spike 真的做通了**（不是「可能不行」就停）：依序解決三個真實
  問題（`URL.createObjectURL` 未實作、`WebAssembly.compile` 執行期動態編譯被 workerd 禁止、
  raw bytes vs 靜態 Module 落差），最終在真正的 `wrangler dev --local`（workerd 引擎）裡完整
  跑通 `fullProve()` + `verify()`，竄改測試正確被拒絕。詳細技術過程見 `circuits/README.md`。
- `services/proof/workersWasmCompat.js`（環境自適應 WebAssembly.compile patch）+
  `services/proof/zk.js`（production 介面：`generateRealZkProof`/`verifyRealZkProof`，
  Node 用 fs 自動載入、Workers 用 `configureZkAssets()` 注入）。
- `worker/index.js` 已接上靜態 wasm import + `configureZkAssets()`（真實部署路徑已就緒）。
- `tests/trust/zk.smoke.js`（`npm run smoke:zk`）：6 項測試全過，含 2 個攻擊測試
  （field wraparound range check 攻擊、proof 套用到不同 publicSignals）。
- **既有 165 項測試（carbon-core/evidence-agent/workflow+UI/trust）重跑確認零回歸**。
- **架構決策，誠實記錄，沒有自己拍板**：這一層目前是**疊加**在 `services/proof/index.js`
  既有 context-binding 之上的**額外、可選**能力，**還沒接進 `trustAdapter.js` 的即時
  shipment 驗證流程**——因為現有資料模型（case-level 單一 intensity×quantity）沒有電路
  命題假設的多階段分解，且即時接入有真實密碼學運算延遲，這是需要 A/B 一起決定的產品/
  架構問題，不是我能自己拍板的事，已完整寫在 `circuits/README.md`「架構決策」一節並附上
  建議的最小接線路徑（技術上可行，已被測試間接證明）。

### 2. 全面 LLM Evidence Agent 測試（gpt-5-mini，含 OCR）— ✅ 完成

- 模型：`openai/gpt-5-mini`（查證過即時報價後建議，已跟你確認）。**真實踩到的相容性坑**：
  GPT-5 系列是推理模型，`max_tokens` 太小時全部被內部 reasoning token 吃光，`content`
  會是空字串（`finish_reason: length`）——要嘛拉高 `max_tokens`、要嘛用
  `reasoning:{effort:'minimal'}` 關掉大部分推理，兩者我都用了（`max_tokens:2000` +
  `reasoning.effort:'minimal'`），已在 `services/agent/llmExtract.js` 裡固定下來。
- **架構**：LLM 只取代「怎麼從文件文字抽出候選欄位」這一步（`services/agent/llmExtract.js`），
  安全過濾／單位驗證／跨文件 heuristic／缺件偵測全部**沿用**規則引擎既有的確定性函式
  （`services/agent/index.js` 新增匯出，供 `services/agent/analyzeLlm.js` 重用，規則引擎
  本身完全沒被改動）。
- **證據分段**：照你的裁示，每份文件各自獨立呼叫一次 LLM，不共用 context/歷史。
- **OCR**：用本機已安裝的 Tesseract 5.5.0（CLI）處理圖片證據，OCR 出來的雜訊文字再交給
  LLM 結構化抽取（兩階段，不依賴 gpt-5-mini 是否支援 vision，沒有用猜的）。合成測試圖檔用
  headless Chrome 截圖產生（`tests/agent/fixtures/electricity_bill_scan.png`），真實 OCR
  出來的文字有雜訊（`unit=>MWh`、`humanConfirmed` 被截斷成 `hum`），LLM 正確還原出
  `electricityMWh=850, unit=MWh`，且沒有因為看不到完整 `humanConfirmed=true` 就亂猜成 true
  （保守、正確的行為）。
- **低信心值一律人工確認**：沿用既有 `eligibleForCalculation` 邏輯，沒有另外處理，因為
  下游本來就是這樣做的。
- **失敗定義**：呼叫失敗／逾時／HTTP 非 2xx／JSON 格式錯誤／canonical RiskReport 驗證不過，
  一律視為失敗，整案（不是部分文件）退回規則引擎——`server/agentAdapter.js` 新增
  `analyzeCaseWithLlm()`，回傳 `{report, usedFallback, fallbackReason}`；**既有的
  `analyzeCase()`（純規則引擎）完全沒被改動**，這是額外新增的並行路徑，還沒有接進
  `/api/cases/:id/agent/analyze` 這個既有 API（刻意，理由跟 ZK 電路一樣：這是先測試，
  要不要正式換掉現有端點是需要 A 一起決定的產品範圍問題）。
- **Prompt/response 記錄**：`server/supabaseSync.js` 新增 `syncEvidenceLlmPrompt()`，沿用
  既有 fire-and-forget 模式；本機沒設定 `SUPABASE_URL` 所以目前不會真的寫入，需要的表格
  schema 已寫在程式碼註解裡（`evidence_llm_prompts`），要用的話你要自己在 Supabase SQL
  editor 建表。
- **Gate 不受影響**：這個模組跟規則引擎一樣只產生 RiskReport，不呼叫任何 Gate/Policy
  函式，`DECISIONS.md`「不讓 LLM 自判權限」的紅線沒有被碰。
- **測試**（`tests/agent/llm.smoke.js`，`npm run smoke:evidence-agent-llm`，都是真實打
  OpenRouter API，不是 mock）：5 項全過——正常抽取、OCR 抽取正確性、prompt injection
  抵抗力（LLM 沒有被文件內嵌的「SYSTEM OVERRIDE」指令誘導捏造欄位）、跨文件 heuristic
  確實是確定性程式碼在判斷（不是 LLM 自己講的）、API key 清空時正確自動退回規則引擎。
- **既有 165+6 項測試重跑確認零回歸**。

### 3. 背景待辦 1——vLEI 身份驗證接進新 canonical schema — ✅ 完成

- `services/identity/index.js`：全新實作（不是舊 fork 復原），參考 `_reference/vlei-old-fork/
  vleiCheck.js` 的判斷精神（法人憑證＋角色憑證、I2I 指標檢查、撤銷連鎖），用跟
  `services/factor-registry`／`services/policy-gate` 一致的模式（checks/reasonCodes、demo
  registry、期望值由系統重建不信任呼叫端宣稱）重寫。
- 對齊 Day 3 GateResult 慣例：`{decision, reasonCodes, checks, evaluatedAt, inputHash}`。
- 新增一個 REASON_CODE（`IDENTITY_CREDENTIAL_EXPIRED`），其餘沿用既有的
  `AUTHORIZATION_REVOKED`/`AUTHORIZATION_INVALID`。
- `tests/identity/smoke.js`（`npm run smoke:identity`）：8/8 全過，含正常鏈、未知 actor、
  撤銷連鎖（且驗證「呼叫端謊稱沒被撤銷」也會被正確擋下，不信任宣稱值）、過期、偽造
  credentialRefs、orgId 冒用、格式錯誤、決定性。
- **還沒接進 `services/policy-gate` 判斷鏈**——獨立可用、獨立測試過，要不要讓身份驗證結果
  影響 Gate 是需要 A/B 一起決定的範圍問題，`services/identity/README.md` 有記錄。

### 4. 背景待辦 2——GS1/DPP 分層揭露最小示意 — ✅ 完成

- `services/dpp/index.js`：純函式，`GET /api/dpp/cases/:id?role=public|customer|customs`。
- **關鍵設計決定**：這個端點刻意不用既有 `x-demo-role` 認證（`handleWorkflowApi()` 會強制
  要求），因為 public/customer/customs 是「產品護照外部查詢者」這條軸線，跟案件參與者角色
  是不同概念——`server/apiFetch.js` 新增 `handleDppApi()` 呼叫，排在 `handleWorkflowApi()`
  之前，繞開它的認證閘門（原本想直接塞進 `handleWorkflowApi()` 裡，發現它的
  `isWorkflowRoute`/`requireActor` 兩道閘門會擋掉沒有 `x-demo-role` 的請求，這樣就沒辦法做
  出真正的「public 層免認證」，所以改成獨立函式）。
- 三層揭露：`public`(狀態+合規布林值,不露數字) → `customer`(+碳足跡強度) →
  `customs`(+實際vs預設係數比較,等同既有 Importer 摘要深度)。
- `tests/dpp/smoke.js`（`npm run smoke:dpp`）：7/7 全過，含「不帶任何角色/認證資訊也能查」
  「三層資料一致不矛盾」「無效角色拒絕」「案件不存在 404」「不影響既有 API 仍要求
  x-demo-role」。
- **既有全部測試（165+6+5+8+7=191 項）重跑確認零回歸**。

### 2.5　追加（使用者醒來後即時討論）：OCR+LLM 兩階段改成直接讀圖 — ✅ 完成

使用者看完 PDF 後問「為什麼不直接用支援圖像辨識的模型（如 Gemini），而是先研究 OCR」。
誠實回答原因（沒查證過 `gpt-5-mini` 支不支援圖片輸入、Tesseract 剛好已裝、統一文字管線）
後，使用者要求「還是我們測試看看」。**實測結果推翻了原本的保守假設**：

- `openai/gpt-5-mini` 經 OpenRouter **確實支援** `image_url` 直接讀圖，第一次呼叫就成功，
  而且比 Tesseract OCR 讀得更乾淨（沒有 OCR 那次的 `unit=>MWh` 雜訊）。
- 直接讀圖做結構化抽取，單次呼叫成本 $0.000554，跟兩階段管線同量級，不算貴。
- **更關鍵的問題（我原本沒想清楚）**：`services/agent/ocr.js` 用
  `child_process.spawnSync('tesseract', ...)` 呼叫本機 CLI，**這條路徑只能在 Node 跑，
  Cloudflare Workers 沒有 child process 能力，圖片證據部署到 Workers 後會直接失敗**——
  這是真實的架構缺口，不是使用者吹毛求疵。
- 圖片版 prompt injection 抵抗力也另外用合成測試圖驗證過（圖片裡明顯嵌入「SYSTEM
  OVERRIDE」指令文字，模型仍只抽出真實存在的欄位）。

**執行的改動**：
- `services/agent/llmExtract.js`：`extractEntriesWithLlm()` 改成同時支援
  `documentText`（文字模式）跟 `imageBase64`/`imageMediaType`（圖片模式，`image_url`
  content block），同一套 system prompt、同一套下游流程。
- `services/agent/analyzeLlm.js`：`decodeEvidenceForLlm()` 圖片證據直接回傳
  base64+mediaType，不再呼叫 OCR；文件層級 injection 關鍵字掃描維持只對文字模式做（圖片
  沒有解碼出來的文字可掃），下游 `normalizeEntry()` 白名單過濾對兩種模式一視同仁，是不受
  輸入模態影響的第二道防線。
- **`services/agent/ocr.js` 已刪除**（不再被任何地方引用）。
- 測試新增一項圖片版 injection 測試（`tests/agent/fixtures/production_injected_scan.png`），
  原本的「OCR」測試改名成「直接讀圖」測試。`smoke:evidence-agent-llm` 6/6 全過（比原本多
  一項）。
- 既有全部測試重跑確認零回歸。

### 5. `schema-v1.json` 接上 ajv — ✅ 完成（低優先項目，順手做掉）

- `packages/contracts/validator.js` 原本是手寫的最小 JSON Schema 子集驗證器（只認得
  type/enum/exclusiveMinimum/required/properties/items/$ref，完全不檢查
  additionalProperties／pattern／format／minLength 這類關鍵字），Day 1 就記錄成已知限制。
- 換成真的用 `ajv`（+`ajv-formats` 處理 date/date-time 格式）編譯 `schema-v1.json` 本身，
  對外介面（`validateCanonical(entityName, value) -> {valid, errors}`）完全不變，呼叫端
  一行都不用改。
- **驗證結果：全部 191 項既有測試換成 ajv 後原封不動全過**，證實 Day 1 當時的判斷是對的
  （手寫檢查邏輯確實功能等價涵蓋了測試案例需要的驗證），現在這件事有真正的 JSON Schema
  驗證器背書，不再只是手寫邏輯的近似值。
