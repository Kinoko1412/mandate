# CHANGELOG

## v0.1-core（2026-08-24，B 葉士愷，`feature/carbon-core` 分支）

依《可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊》p.19 COPY PROMPT 1 執行 Phase 1：Canonical Contracts + Carbon Core。

### 本階段完成

- `packages/contracts/`：`enums.js`（CaseStatus/GateDecision/ReasonCode/FactorPurpose/EvidenceType/VerificationStatus）、`fixedPoint.js`（定點整數 scale=10^6，供後端/前端/未來 circuits/ 共用）、`schema-v1.json`（10 個 canonical 實體的 JSON Schema 定義）。
- `services/carbon-core/`：`validateInstallationYear`、`calculateAnnualEmissions`、`calculateIntensity`、`allocateShipment`、`reconcileAllocationLedger`、`buildCalculationReceipt` 六個函式，逐字對照規格 p.10。
- `fixtures/`：`normal`、`missing_period`、`wrong_factor`、`tampered_quantity` 四組，含完整 `evidenceItems`，ID 值採規格 p.8 固定 Demo Fixture 表的字面值。
- `tests/carbon-core/smoke.js`：21 項測試全過（`npm run smoke:carbon-core`）。
- Handoff Package 四件套：`services/carbon-core/{README.md, API_EXAMPLES.json, TEST_CASES.md, .env.example}`。

### 本階段未完成（刻意排除，非遺漏）

- UI、Agent、ZKP——規格 p.19 明講 Phase 1 不做，留給 Phase 2–3。
- HTTP API 層（`/api/carbon/calculate` 等，規格 p.9）——Phase 1 只做可被直接 `require()` 呼叫的純函式，路由層留給接下來整合時再做。
- `schema-v1.json` 尚未接上執行期 JSON Schema 驗證器（例如 ajv）——目前型別/欄位檢查靠 `validateInstallationYear`/`allocateShipment` 內手寫邏輯，功能等價但不是「真的用 schema 驗」。

### 介面差異與風險（跟舊版/其他文件的落差，接手前必看）

- **資料模型完全改版**：跟主 repo `origin/main` 既有的 `server/policy.js`（PCF 單筆申報敘事、`POL-CARB-001` 等 policyId 契約）是兩套不同的資料模型，彼此不相容，也沒有互相呼叫。舊模組保留當參考，沒有刪除。改題理由與正式宣告記錄見 `DECISIONS.md` §9（2026-08-23 條目）。
- **`tampered_quantity` fixture 跟規格書 p.8 原文定義不同**：規格原文是 ZKP 相關的 `PUBLIC_INPUT_MISMATCH`，Phase 1 現況改測 `reconcileAllocationLedger` 的超額分配情境。詳細原因跟後續（Phase 3）擴充計畫見 `mandate-phase1-carbon-core/vault/SESSION_LOG.md` 第 3 節。
- **幾個欄位值域是 carbon-core 自行判斷、規格書沒有明講**（`verificationStatus`、`allocationStatus`、兩個 reconcileAllocationLedger 的 reason code 字串、年度總產量 200 噸）：完整清單見 `services/carbon-core/README.md`「⚠️ 規格沒有明確定義」一節，均標註 `NOT IN SPEC`，接手/審閱時請留意這些不是官方規格值。

### 尚未做的收尾

- 尚未 commit、尚未開 PR、沒有 `v0.1-core` git tag——本檔案先寫在 working tree，等隊友（A，黃昱羲）看過 `mandate-phase1-carbon-core/` 資料夾回饋確認後才正式提交。
