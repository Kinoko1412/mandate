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
