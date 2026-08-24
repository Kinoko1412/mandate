# Day 3 Session Log — Trust Engine（ZKP-lite Proof + Factor Registry + Policy Gate）

> 對應 `DAY3_TRUST_ENGINE_HANDOFF.md`。撰寫者：B（葉士愷）。**working tree 尚未 commit**——
> 這份記錄先寫給隊友 review，確認後才會正式 commit 進 `feature/trust-engine` 分支。

## 1. 一句話總結

`trustAdapter.evaluate()` 現在有真的（非 mock）production evaluator：串接 `services/proof`、
`services/factor-registry`、`services/policy-gate` 三個新模組。normal fixture 走完整 HTTP
流程（reset → 上傳 4 份證據 → 確認 → submit → `POST /api/workflow/revalidate`）會推到
`READY_FOR_VERIFIER`；§10 攻擊矩陣 8 列全部驗證通過並回穩定 `reasonCodes`。回歸：
`smoke:carbon-core` 36/36、`smoke:workflow`（`tests/workflow/smoke.js` 34/34 +
`tests/ui/static-contract.js` 15/16，那 1 個既有失敗跟 Day 3 無關，見 §5）、新增
`smoke:trust` 19/19。`npm run dev:cf` 下用 curl 走過同一條 normal 流程，Cloudflare Workers
runtime（`nodejs_compat`）也驗證通過。

## 2. ⚠️ 最重要的誠實揭露：這不是真的 zk-SNARK

`services/proof` 沒有跑 Circom/snarkjs，`ProofEnvelope.proof` 是一個 `demoOnly:` 前綴的
sha256 摘要字串，不是密碼學證明。這是刻意的決定，依 hand-off §13 Cut Plan 自己的
fallback 條款：「若 18:00 前 ZKP 來不及：保留 mock verifier 但 reasonCodes／checks／
inputHash 契約必須真」。實際做到的部分是**真的**：

- 公開輸入（`caseId`／`policyProfileId`／`inputHash`／`quantityTonnesScaled`）逐項跟系統
  當下重算的值比對，不一致就擋（`PUBLIC_INPUT_MISMATCH`）。
- nonce 重放偵測是真的（in-memory Set，process 存活期間有效）。
- `circuitId` 跟 `PolicyProfile.circuitId` 綁定檢查是真的。
- `expiresAt` 過期檢查是真的。
- Factor Registry 的 revoked／expired／不在允許清單判斷是真的。

**唯一沒做的是「這份 proof bytes 本身有沒有密碼學保證」**——目前任何格式正確的
demoOnly proof 都會通過這一項（`services/proof/index.js` 裡的 `cryptographic_proof`
check 標記 `status: 'skipped'`，不是 `pass`，刻意留痕）。正式版本要換掉的只有這一小塊
（`verifyProofEnvelope` 裡的 `cryptographic_proof` 那段），介面完全不用改。程式碼、
checks、這份文件都沒有任何地方宣稱「已完成正式 ZKP 驗證」。

## 3. 判斷落差：`tampered_quantity` 的 Day 3 版本跟 Phase 1 版本是兩個不同 fixture

Phase 1 的 `fixtures/tampered_quantity.json`（帳本超額版，`ALLOCATION_EXCEEDS_PRODUCTION`）
**完全沒有被修改或刪除**——carbon-core 的 36 項測試繼續吃這份檔案，不受影響。

Day 3 的「Proof 宣稱 100t、payload 120t → `PUBLIC_INPUT_MISMATCH`」版本**沒有**存成獨立
JSON fixture 檔，而是直接寫在 `tests/trust/smoke.js` 的攻擊矩陣測試裡（用
`trustAdapter.getDemoContext()` 取得 normal 案件的真實 `inputHash`，再組一個宣稱
「100 噸」的 `ProofEnvelope`，跟一個「實際 120 噸」的 `quantityTonnesScaled` 期望值比對）。
這是刻意的選擇：Day 3 的 trust 層測試不是透過 `buildCaseCarbon()`／`workflowStore`
（那條路徑目前只服務 normal fixture 這一個 Demo 案件），而是直接呼叫
`trustAdapter.evaluateTrustScenario()` 做組合層級的單元測試，用 JS 物件組攻擊情境比
額外開一份高度重複的 JSON fixture 更直接、也更容易看出每個攻擊到底改了哪個欄位。
如果之後想要一份獨立 JSON fixture（例如給前端 mock 資料用），可以再補，目前判斷不是
必要項目。

## 4. `trustAdapter.js` 的 evaluator 生命週期——跟 Day 2 既有語意刻意保持一致

`server/trustAdapter.js` 原本的 `resetEvaluatorForTests()` 語意是「重置回
unavailable stub」，Day 2 既有測試（`tests/workflow/smoke.js`「revalidate: default
adapter 回 unavailable 且不會 READY」）依賴這個行為。Day 3 **沒有改這個函式的行為**——
`resetEvaluatorForTests()` 呼叫後仍然是 unavailable，不是新的 production evaluator。

改的是模組**冷開機**（第一次被 `require`、還沒有任何測試呼叫過任何 setter）的初始值：
從原本的 `evaluateUnavailable` 換成 `productionEvaluator`。這代表：

- 真正的 server（`npm start`／`wrangler dev`，兩者都不會呼叫測試專用的
  `setEvaluatorForTests`/`resetEvaluatorForTests`）一啟動，`revalidate` 就是 Day 3
  真實信任引擎，不需要在 `server/index.js` 或 `worker/index.js` 另外接線（§2.3 提到
  「需知會 A」的 `worker/index.js` 改動，因為完全沒動這個檔案，不需要知會）。
- 每一個 Day 2 既有測試在呼叫 `trustAdapter` 之前，要嘛先 403 被擋（Importer 觸發
  revalidate）、要嘛已經明確呼叫過 `setEvaluatorForTests`/`resetEvaluatorForTests`——
  沒有任何既有測試依賴「冷開機時的預設值是 unavailable」這件事，所以這個改動不影響
  Day 2 的 34 項 workflow 測試（已重跑驗證，見 §6）。

## 5. 跟這個 PR 無關的既有失敗——`smoke:workflow` 不是真的 50/50

`tests/ui/static-contract.js` 有一項測試（驗證 `.bak` 備份檔案）依賴
`_backups/20260825/...bak-20260825` 這幾個本機檔案，但 A 同一個 PR 加的 `.gitignore`
把 `_backups/` 排除在外，導致這幾個檔案不存在於任何乾淨 checkout 裡。這件事已經在
另一個管道回報給 A（不是這次 Day 3 工作的一部分），Day 3 沒有嘗試修這個測試——它不在
`services/proof`／`services/factor-registry`／`services/policy-gate`／`trustAdapter.js`
這個 owner 範圍內，硬修可能跟 A 之後的修法打架。**回歸基準線本來就是「這一項失敗、
其餘全過」，不是真的 50/50**，Day 3 結束後維持同樣的基準線（沒有新增失敗）。

## 6. 測試結果（2026-08-24 實跑，乾淨 working tree）

```
npm run smoke:carbon-core   # 36/36 PASS
npm run smoke:workflow      # tests/workflow/smoke.js 34/34 PASS
                             # tests/ui/static-contract.js 15/16（既有失敗，見 §5）
npm run smoke:trust         # 19/19 PASS（新增）
npm run dev:cf               # Worker Ready，curl 走完整 normal 流程 revalidate → READY_FOR_VERIFIER
```

## 7. Definition of Done 對照（DAY3_TRUST_ENGINE_HANDOFF.md §11）

- [x] `services/proof`、`services/factor-registry`、`services/policy-gate` 存在且被
      `trustAdapter` 呼叫（不是 dead code——`productionEvaluator` 實際 require 並呼叫
      三者）。
- [x] `trustAdapter.evaluate` 在 normal fixture 上 proof+gate 皆 `available+verified`；
      `POST /api/workflow/revalidate` → `READY_FOR_VERIFIER`（真實 HTTP E2E 測試驗證，
      非 mock）。
- [x] §10 攻擊表 8 列全部有自動化測試（`tests/trust/smoke.js` 攻擊矩陣區塊）。
- [x] 定點 `10^6`（`quantityTonnesScaled` 全程用 `toScaled`/`addScaled`）與 `inputHash`
      跟 carbon-core `CalculationReceipt.inputHash` 一致（`getDemoContext()` 直接呼叫
      `buildCalculationReceipt` 現場重算，不是複製一份常數）。
- [x] 無正式查驗誤述——`tests/trust/smoke.js` E2E 測試明確斷言回應不含禁用詞彙清單。
- [x] `npm run smoke:carbon-core` 仍 36/36；`npm run smoke:workflow` 維持既有基準線
      （34/34 + 15/16，沒有新增失敗，不是真的 50/50，見 §5）。
- [x] `npm run dev:cf` 能跑 synthetic revalidate（見 §6，curl 實測）。

## 8. 尚未做/已知限制

- 真的 zk-SNARK 電路（Circom/snarkjs）完全沒做，見 §2——這是刻意依規格 cut plan 條款
  做的判斷，不是漏做。
- Factor Registry 是寫死在 `services/factor-registry/index.js` 的 3 筆 Demo 記錄
  （active／revoked／expired 各一），不是外部資料庫或可機讀清單——跟 carbon-core 對
  `allowedFactorSets` 的處理方式一致，都是 Demo 規模的簡化，非正式治理清單。
- `proof` nonce 重放記錄是 process 記憶體（`Set`），跟 `workflowStore` 一樣重啟即清空，
  單一 Demo process 內有效即可，沒有跨 process/跨部署的持久化。
- 沒有新增 UI「重驗」按鈕（hand-off §13 明講這是可砍範圍，Day 2 的 DevTools POST
  方式繼續可用）。
