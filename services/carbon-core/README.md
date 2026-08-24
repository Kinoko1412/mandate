# carbon-core

年度強度 × 批次分攤的唯一計算來源。實作依據：**《可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊》**（本專案文件優先權第 1 名，見該文件 p.2 優先順序表）p.10 Carbon Core 實作規格。

這個模組**只做計算跟基本一致性檢查**，不查「係數是不是官方核准」的完整清單治理（那是 Phase 3 Policy Gate + Factor Registry 的責任）、不判斷「文件是不是真的」（那是 Phase 4 Evidence Agent + 查驗員的責任）、不驗 ZKP Proof（Phase 3）。

## 安裝與啟動

不需要額外安裝，跟 repo 其他部分共用 Node（無外部 npm 套件依賴，`buildCalculationReceipt` 的 Hash 用 Node 內建 `crypto`）：

```bash
node tests/carbon-core/smoke.js
# 或
npm run smoke:carbon-core
```

看到 `RESULT: all PASS` 代表契約與核心邏輯正常。

## 資料模型（Canonical Data Model，逐字對照規格 p.7）

- **InstallationYear**（法定基礎層）：`installationId`、`operatorOrgId`、`reportingYear`、`productionRoute`、`systemBoundaryVersion`、`productionTonnes`、`verifiedIntensity`、`verificationStatus`。
- **Shipment**（交易分攤層）：`shipmentId`、`caseId`、`installationId`、`reportingYear`、`quantityTonnes`、`allocatedEmissions`、`allocationStatus`。
- **GateResult**：`decision`、`reasonCodes`（**陣列**）、`checks`、`policyProfileId`、`evaluatedAt`、`inputHash`。

完整欄位定義見 `packages/contracts/schema-v1.json`；`packages/contracts/validator.js` 會在執行期實際載入該 schema，並驗證 required/type/enum/數值下界；狀態/reason code 常數見 `packages/contracts/enums.js`；定點數 scale 常數見 `packages/contracts/fixedPoint.js`。

**數值規則**：後端全程用定點整數（`SCALE = 10^6`）運算，不在中間步驟用浮點小數——這是為了跟未來 `circuits/`（Circom 電路內完全沒有浮點數）共用同一 scale，規格 p.10 明講「不可混用浮點」。`toScaled`/`fromScaled` 只在輸入/輸出邊界轉換一次。

## API

```js
const {
  validateInstallationYear,
  calculateAnnualEmissions,
  calculateIntensity,
  allocateShipment,
  reconcileAllocationLedger,
  allocateAllShipments,
  buildCalculationReceipt,
  CarbonCoreError,
} = require('../../services/carbon-core');
```

六個函式名稱逐字對照規格 p.10 表格：

| 函式 | 必要行為 | 拒絕條件 |
|---|---|---|
| `validateInstallationYear(input)` | 驗年度、產量、邊界、路線、單位 | 錯年度、未知單位、負數、零產量 |
| `calculateAnnualEmissions({ activities, factorSet, policyProfile })` | 依每筆 `factorRef` 計算並加總 `activity.quantity × factor.value`；保存定點 terms | factor 不允許、負數、未知單位、缺 factor、溢位 |
| `calculateIntensity({ annualEmissions, productionTonnes })` | `annual emissions ÷ production tonnes`，不讀既有 `verifiedIntensity` 回算 | 零產量、負數、溢位 |
| `allocateShipment({ installationYear, shipment, policyProfile })` | 單一批次自身合法性：case context、供應商已確認、證據涵蓋期間、數量/單位、係數允許清單 | 來源不一致（`CASE_CONTEXT_MISMATCH`）——**不檢查跨批次累計超額**，那是下一個函式的責任 |
| `reconcileAllocationLedger({ installationYear, allocations })` | 檢查累積數量與重複分配 | 超出年度產量（`ALLOCATION_EXCEEDS_PRODUCTION`）、重複 shipmentId（`DUPLICATE_SHIPMENT_ID`） |
| `buildCalculationReceipt({ installationYear, activities, factorSet, policyProfile })` | 輸入 Hash、factor version/sourceHash、policy version/profile、scale、捨入規則、方法版本、結果與時間 | 缺 policy／factor／context |

`allocateAllShipments({ installationYear, shipments, policyProfile })` 是便利函式：依序對每批出貨呼叫 `allocateShipment`，再統一送進 `reconcileAllocationLedger`，回傳 `[{ shipment, gateResult }, ...]`。

介面注意：舊版 `calculateAnnualEmissions(installationYear)`／`calculateIntensity(installationYear)` 會被拒絕，避免再以既有 `verifiedIntensity` 循環算回年度排放。呼叫端必須分別傳入 activities/factor refs，以及已計算的 annual emissions。

## ⚠️ 規格沒有明確定義、由 carbon-core 自行判斷的地方

這份工程規格文件本身在幾處只給了欄位名稱或函式名稱，沒有給精確的值域/字串——以下是我方（B，葉士愷）的判斷，**8/24 09:00 需要跟隊友（A，黃昱羲）當面對過**，目前只是先動工用的暫定版本：

1. **`tampered_quantity` fixture 的內容**：規格 p.19（COPY PROMPT 1）把它列進 Phase 1 要做的 fixture，但 p.8 對它的完整定義是 ZKP 相關的 `PUBLIC_INPUT_MISMATCH`（Proof 跟 payload 對不上），Phase 1 明講不做 ZKP。**目前的解讀**：Phase 1 版本改測 `reconcileAllocationLedger` 的「超額分配」情境（見 `fixtures/tampered_quantity.json` 的 `_interpretationNote`），8/26 接 ZKP 後同一個檔名底下的情境要擴充成真正的 Proof/payload 不一致測試。
2. **`InstallationYear.verificationStatus` 的值域**：規格只給欄位名稱，沒列舉值。目前用 `'draft' | 'confirmed'`（供應商自己是否已確認年度資料），刻意跟「合格 CBAM 查驗員正式查驗完成」（那件事發生在 Case 狀態機的 `VERIFIER_REVIEW` 階段，是完全不同的動作）分開，避免跟舊版本自創的 `VERIFIER_REQUIRED` 狀態一樣的問題再發生一次。
3. **`Shipment.allocationStatus` 的值域**：規格只給欄位名稱，目前用 `CaseStatus` 裡由 Gate 直接可達的子集（`NEEDS_EVIDENCE`／`METHOD_REVIEW`／`READY_FOR_VERIFIER`／`BLOCKED`）。
4. **`reconcileAllocationLedger` 兩個拒絕條件的 reason code 字串**：規格 p.11 的 Gate Check 表沒有列出對應字串，目前用 `ALLOCATION_EXCEEDS_PRODUCTION`／`DUPLICATE_SHIPMENT_ID`（在 `packages/contracts/enums.js` 裡明確標注「NOT IN SPEC」）。
5. **年度總產量 200 噸**：兩份出貨量固定是 100+60=160 噸，但規格沒給整年總產量，目前抓一個比出貨量略大的整數方便測試「超額分配」情境，不是真實或官方數字。

normal fixture 的活動量與係數是刻意設計的合成 Demo：`100 MWh × 2 + 80 GJ × 2 = 360 tCO2e`，每筆均有 `demoOnly: true`，不代表官方或真實鋼廠係數。由此再除以 200 tonnes 得 `1.80 tCO2e/tonne`；`verifiedIntensity` 僅作 canonical 記錄與分攤輸入，不再被年度計算拿來循環回算。

## 已知限制 / 尚未做的事

- 不驗證 `factorSetId` 對應的係數本身是否為官方文件（只查是否在 `policyProfile.allowedFactorSets` 清單裡）——完整 Factor Registry 驗證是 Phase 3 範圍。
- 不驗證 ZKP Proof——Phase 3 才接。
- `evidenceCoverage` 假設由呼叫方（Evidence Agent 或前端）先算好聯集期間再傳進來，這個模組不掃描逐筆 EvidenceItem。
- `Case`、`IdentityContext`、`ProofEnvelope`、`RiskReport` 目前只在 `schema-v1.json` 定義了型別，carbon-core 沒有實際操作這些實體（Phase 1 範圍不需要）。
