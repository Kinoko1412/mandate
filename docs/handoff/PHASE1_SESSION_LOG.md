# Session Log — Phase 1 Canonical Contracts + Carbon Core

給接手的人（隊友黃昱羲，或之後的我自己）看的：這份文件記錄 2026-08-23 這次跟 Claude 一起把 carbon-core 重做成符合《可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊》的過程——遇到了什麼問題、怎麼判斷的、哪些地方還需要你確認。不是逐字對話紀錄，是整理過的決策摘要。

---

## 1. 時間軸

1. **兩份新規劃 PDF 出爐**：`可信碳排證據Agent_8月24日至28日雙人落地分工計畫.pdf`（五天分工時程）+ `可信碳排證據Agent_落地風險審查與修正版方案.pdf`（25 頁，法規/風險審查）。兩人討論後決定：Demo 情境從既有的「青禾零件」換成鋼鐵單一情境（`TW-STEEL-01`），沿用團隊 repo（`1qaz0726-star/mandate`）但內容不受限制。
2. **角色定案**：B（葉士愷）負責碳排資料模型、計算核心、ZKP、Factor/Policy Registry、Policy Gate；A（黃昱羲）負責產品流程、前端、Evidence Agent、整合。B 先接手 8/24 的工作提前開跑（沒等到 8/24 09:00 才開始）。
3. **隊友回饋範圍優先序**：現階段卡點是「引擎」（carbon-core/Policy Gate/ZKP/Factor Registry），UI 不重要、直接重來即可；只有引擎能用的部分值得參考舊 fork（`Kinoko1412/mandate`）。
4. **第一版 carbon-core 完成**（依 25 頁修正版的鬆散描述自行設計 schema）：`calculateAnnualEmissions`/`calculateIntensity`/`allocateShipment` 三個函式 + 4 個 fixture，12 項測試全過。
5. **收到第三份、優先權最高的文件**：`可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊.pdf`（28 頁）。這份文件明講自己是「優先權第 1」，且有精確的 Canonical Data Model（p.7，逐欄位必填清單）、狀態機（p.4，7 態）、GateResult 形狀（p.7）、固定 Demo Fixture 的字面 ID 值（p.8）、6 個具名函式（p.10）。
6. **稽核**：對照這份新規格逐項檢查第一版 carbon-core，發現大量欄位命名/形狀/狀態機不符（詳見下方第 2 節）。
7. **隊長（葉士愷）確認身分並正式宣告改題**：解決了「誰有權改 `DECISIONS.md`」這個治理問題（主 repo `DECISIONS.md` 明文要求「隊長明確宣告改題」才能修訂鎖死的範圍）——已在主 repo `mandate/DECISIONS.md` §9 補一筆正式修訂記錄。
8. **依稽核報告動手修正**：欄位改名、狀態機改成 7 態、GateResult 改成 `decision`+`reasonCodes`（陣列）形狀、補三個缺的函式（`validateInstallationYear`/`reconcileAllocationLedger`/`buildCalculationReceipt`）、改用定點整數 scale（`10^6`）取代浮點捨入、fixture 改用規格書 p.8 寫死的字面 ID、`tampered_shipment.json` 改名 `tampered_quantity.json` 並補上詮釋落差說明。21 項測試全過。
9. **本資料夾**：把修正後的成果從主 repo 的 working tree 複製出來，跟主 repo 分開存放，方便你（隊友）先審閱。

---

## 2. Repo Audit 發現的落差（第一版 vs Vibe Coding AI 工程規格）

| 項目 | 第一版做法 | 規格要求（page） | 已修正 |
|---|---|---|---|
| Case 狀態機 | 5 態，自創 `VERIFIER_REQUIRED` | 7 態：`DRAFT`/`NEEDS_EVIDENCE`/`METHOD_REVIEW`/`READY_FOR_VERIFIER`/`VERIFIER_REVIEW`/`BLOCKED`/`ARCHIVED`（p.4） | ✅ 移除 `VERIFIER_REQUIRED`，補齊 7 態 |
| GateResult 形狀 | `{shipmentId, status, reasonCode(單數), reasonMessage, evaluatedAt}` | `{decision, reasonCodes(陣列), checks, policyProfileId, evaluatedAt, inputHash}`（p.7） | ✅ |
| InstallationYear 欄位名 | `annualProductionQuantity`/`specificEmbeddedEmissionIntensity`/`status` | `productionTonnes`/`verifiedIntensity`/`verificationStatus`，加 `operatorOrgId`/`systemBoundaryVersion`（p.7） | ✅ |
| Shipment 欄位名 | `quantity`+`quantityUnit`，無 `caseId`/`allocationStatus` | `quantityTonnes`，需要 `caseId`/`allocationStatus`（p.7） | ✅ |
| 數值運算 | 浮點數 + `toFixed`/捨入到 3 位小數 | 定點整數，後端/前端/Circom 共用同一 scale 例如 `10^6`（p.10） | ✅ 新增 `packages/contracts/fixedPoint.js` |
| 缺的函式 | 只有 3 個 | 規格要求 6 個：`validateInstallationYear`/`calculateAnnualEmissions`/`calculateIntensity`/`allocateShipment`/`reconcileAllocationLedger`/`buildCalculationReceipt`（p.10） | ✅ 補齊 |
| Fixture ID | 自訂（`CASE-TW-STEEL-01-2026` 等） | 規格 p.8 寫死字面值：`CASE-2026-001`/`CBAM-STEEL-2026-v1`/`CBAM-DEMO-2026-v1` | ✅ |
| Fixture 檔名 | `tampered_shipment.json` | `tampered_quantity.json`（p.8/p.19） | ✅ 改名，但內容有詮釋落差，見第 3 節 |
| Demo 數值標記 | 無 | 規格要求標 `demoOnly: true`（p.10） | ✅ |

---

## 3. ⚠️ 最需要你（隊友）知道的一件事：`tampered_quantity` 的詮釋落差

規格書 p.19（COPY PROMPT 1）把 `tampered_quantity` 列進 **Phase 1**（現在）要做的 4 個 fixture 之一。但規格書 p.8「必備異常 Fixture」表對它的**完整定義**是：

> Proof 為 100 噸但 payload 改 120 → `BLOCKED`／`PUBLIC_INPUT_MISMATCH`

這是需要 **ZKP Proof**（有一份「Proof 聲稱的值」可以跟「payload 實際送出的值」比對）才有意義的情境，而規格書 p.19 同一頁明講 Phase 1「不要做 UI、Agent 或 ZKP」。

**目前的處理方式**（B 的判斷，隊長裁示「先照這個推測去做」，但這件事你本人還沒實際確認過）：Phase 1 版本的 `tampered_quantity.json` 改測 `reconcileAllocationLedger` 明確列出的拒絕條件——把 SHIP-A 的數量從 100 噸竄改成 150 噸，加上 SHIP-B 60 噸，合計 210 噸超過年度可用產量 200 噸，驗證帳本層級的「數量竄改」會被擋下。**這不是規格書原文定義的攻擊情境**，只是同一個檔名下、Phase 1 能力範圍內能測的最接近版本。

8/26（Phase 3，ZKP + Policy Gate）接上 ZKP 之後，這個檔名底下的情境需要**擴充**成規格書原文定義的「Proof 跟 payload 不一致」測試，屆時 `reconcileAllocationLedger` 那個版本可以保留當作額外的帳本檢查，不用整個換掉。

**需要你做的事**：看完這份說明後，跟葉士愷確認這個判斷是否合理，如果你有不同想法（例如覺得應該現在就想辦法先做一個簡化版 Proof 概念來測完整情境），提出來討論。

---

## 4. 其他規格沒有明確定義、carbon-core 自行判斷的地方

規格書本身在幾處只給了欄位名稱或函式行為描述，沒給精確的值域/字串。以下判斷都標在程式碼註解跟 `packages/contracts/enums.js` 裡（搜尋 `NOT IN SPEC`），這裡列一次方便你集中審閱：

1. **`InstallationYear.verificationStatus` 值域**：定義成 `'draft' | 'confirmed'`（供應商是否已自行確認年度資料），刻意跟「合格 CBAM 查驗員正式查驗完成」分開（那件事發生在 Case 狀態機的 `VERIFIER_REVIEW` 階段）。
2. **`Shipment.allocationStatus` 值域**：沿用 `CaseStatus` 裡 Gate 直接可達的子集（`NEEDS_EVIDENCE`/`METHOD_REVIEW`/`READY_FOR_VERIFIER`/`BLOCKED`）。
3. **`reconcileAllocationLedger` 兩個拒絕條件的 reason code 字串**：規格 p.11 Gate Check 表沒有列出，補了 `ALLOCATION_EXCEEDS_PRODUCTION`／`DUPLICATE_SHIPMENT_ID`。
4. **年度總產量 200 噸**：兩份出貨量固定是 100+60=160 噸，規格沒給整年總產量，抓了一個比出貨量略大的整數方便測試「超額分配」，不是真實或官方數字。
5. **`calculateAnnualEmissions` 的「sum(activity*factor)」怎麼對應到單一 `verifiedIntensity` 欄位**：判斷成單一製程情境下 activity=productionTonnes、factor=verifiedIntensity，是加總只有一項的特例；多製程/多 precursor 分項加總留給以後有真實 BOM 資料時再擴充。

---

## 5. 過程中抓到的技術問題（給以後除錯參考）

- **日期邊界誤判**：純日期字串（如 `"2026-12-31"`）被 `Date.parse` 當成當天 `00:00:00Z`，導致「涵蓋到 12/31」被誤判成沒涵蓋到年底。已用 `normalizeDateBoundary()` 補上邊界時間（`periodEnd` 補 `T23:59:59Z`）修正，這個坑任何用純日期字串做期間比對的地方都可能踩到。
- **定點數溢位防護**：`mulScaled()` 相乘前會檢查中間值是否超過 `Number.MAX_SAFE_INTEGER`，超過就丟 `RangeError`——目前用一般 JS number，資料量真的變大（例如接上真實大型 ERP 數字）時可能要改成 `BigInt`。
- **`inputHash` 用穩定序列化**：`stableStringify()` 會先把物件 key 排序再 `JSON.stringify`，確保同樣內容不管欄位寫入順序都算出同一個 Hash——如果 hash 對不上，先檢查是不是有巢狀物件的 key 順序不同。

---

## 6. 治理事項：`DECISIONS.md` 已補一筆正式修訂

主 repo（`1qaz0726-star/mandate`）的 `DECISIONS.md` 原本在 2026-07-20 把舊題目（PCF 單筆申報敘事、Demo 三幕、`POL-CARB-001` 等 policyId 契約）「定案鎖死」，明文規定改題需要「隊長明確宣告」並留痕。這次的改題（換成鋼鐵情境 + 全新資料模型）已經由隊長（葉士愷）正式宣告，在 `mandate/DECISIONS.md` §9 補了一筆修訂記錄（2026-08-23），不是偷偷改的。你可以直接去主 repo 那份文件看完整內容。

---

## 7. 下一步

1. 你（隊友）看過本資料夾，特別是第 3、4 節的判斷，回饋意見。
2. 對過之後，這批檔案會搬回主 repo（`mandate/`）的 `feature/carbon-core` 分支，正式 commit、開 PR。
3. `packages/contracts/`、`services/carbon-core/` 這兩個資料夾之後應該是你做前端（Phase 2）時會直接 `require` 的東西——欄位名稱、狀態值都已經照 Vibe Coding AI 規格對齊，UI 端不用再自己發明欄位。

---

## 8. 完成摘要（規格書 p.28 要求的回報格式）

- **本次任務**：Phase 1（Canonical Contracts + Carbon Core），依《可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊》p.19 COPY PROMPT 1 執行；**未做項目**：UI、Agent、ZKP（Phase 1 範圍外，明講不做）、`schema-v1.json` 尚未接上實際的 JSON Schema 驗證器（例如 ajv）——目前欄位/型別檢查是手寫在 `validateInstallationYear`/`allocateShipment` 裡，`schema-v1.json` 本身還只是文件用途，沒有被程式碼實際載入執行驗證。
- **新增／修改檔案**：`packages/contracts/{enums.js, fixedPoint.js, schema-v1.json}`、`services/carbon-core/{index.js, README.md, API_EXAMPLES.json, TEST_CASES.md, .env.example}`、`fixtures/{normal, missing_period, wrong_factor, tampered_quantity}.json`（含 `evidenceItems` 完整記錄）、`tests/carbon-core/smoke.js`、`package.json`（加 `smoke:carbon-core` script）、主 repo 的 `DECISIONS.md`（補一筆正式修訂記錄）。
- **Schema／API 影響**：這是全新模組，不影響 `server/`、`worker/`、`public/` 既有程式碼；沒有動到既有的 `POL-CARB-001` 等 policyId 契約（那些留在 `server/policy.js` 當參考，沒被刪除）。HTTP API 層（規格 p.9 的 `/api/carbon/calculate` 等路由）**還沒做**，Phase 1 只做到可被直接 `require()` 呼叫的純函式。
- **測試命令與結果**：`npm run smoke`（本資料夾）或 `npm run smoke:carbon-core`（主 repo）→ 21 項全 PASS。
- **正常／攻擊 Fixture 結果**：`normal`→兩批 `GATE_OK`（180/108 tCO2e）；`missing_period`→`NEEDS_EVIDENCE`/`EVIDENCE_PERIOD_INCOMPLETE`；`wrong_factor`→`BLOCKED`/`FACTOR_NOT_ALLOWED`；`tampered_quantity`（Phase 1 詮釋版，見第 3 節）→ SHIP-A 通過、SHIP-B `BLOCKED`/`ALLOCATION_EXCEEDS_PRODUCTION`。
- **安全／法規邊界**：沒有任何地方宣稱「CBAM Certified」「官方核准」；`READY_FOR_VERIFIER` 只代表「具備送查驗準備條件」，不是正式查驗完成（跟規格 p.3 文案限制一致，目前這句話還只活在程式邏輯層，UI 還沒做，Phase 2 要記得把這句話實際顯示出來）；Demo 係數/數值都標了 `demoOnly: true`。
- **已知限制與 fallback**：不驗證 factorSet 本身的官方權威性（只查允許清單）；不驗 ZKP；`schema-v1.json` 未接執行期驗證（見上）；年度總產量 200 噸是假設值非官方數字。
- **啟動／驗收步驟**：`npm install`（無外部依賴，這步其實可跳過）→ `npm run smoke` → 看到 `RESULT: all PASS`。
- **Commit／PR／release tag**：**尚未 commit、尚未開 PR、沒有 tag**——刻意保留，等隊友審閱過本資料夾（尤其第 3、4 節）後，才回到主 repo `feature/carbon-core` 分支正式提交。
- **回退方式**：本資料夾是複製品，刪除或忽略不影響主 repo 任何分支；主 repo 的 `feature/carbon-core` 分支也還沒 commit，`git checkout` 到其他分支即可讓 working tree 恢復原狀（新增的檔案在切分支後仍會留在 working tree，因為是 untracked files，需要的話用 `git clean` 或手動刪除 `packages/`、`services/`、`fixtures/`、`tests/` 這幾個新目錄）。
