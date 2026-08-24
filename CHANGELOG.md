# CHANGELOG

## Day 2 — 案件工作流 + 三角色 UI + Demo Vault + Trust hook（2026-08-24～25，working tree 未 commit）

分支 `feature/case-workflow-ui`；依《8/24–8/28 雙人落地分工計畫》Day 2 與 Vibe 規格 p.9／p.13 實作。**尚未 commit、未 tag `v0.2-workflow`、未 merge。**

### 本階段完成

- **Root UI**：`public/index.html` 三角色（Supplier／Importer／Verifier）、固定案件 `CASE-2026-001`、Audit Timeline、信任邊界 banner；`public/js/case-workflow.js`、`public/css/case-workflow.css`。
- **Playwright 瀏覽器除錯**：favicon、Importer 狀態同步、submit 刷新、reset 權限、Grant session 清除、Verifier **download** UI、`quantityUnit` fallback、public `.bak` 隔離；截圖 [`docs/handoff/screenshots/day2/`](docs/handoff/screenshots/day2/)。
- **Workflow API**：`server/workflowApi.js`、`server/workflowStore.js` — evidence 上傳（SHA-256、512KiB、media 白名單）、人工確認、案件提交、importer summary、verifier index/findings、Demo Vault Grant（≤5 分鐘、一次性、subject 綁 Verifier）、`x-vault-token` 開啟／**download**。
- **Trust adapter hook**：`server/trustAdapter.js`；`POST /api/workflow/revalidate`；`workflowStore.setTrustServices()`／`setServiceStatus()`；smoke 驗 mock READY／BLOCKED（**預設仍 unavailable，非 ZKP 完成**）。
- **Carbon 整合**：`server/carbonAdapter.js` 經 `buildCaseCarbon()` 呼叫 `services/carbon-core` + `packages/contracts/validator`；`POST /api/workflow/carbon/preview`。
- **Server-side 角色遮罩**：Importer 無 vaultRef／content／完整檔名；Verifier 僅 Grant 後見 content；Audit 不含 token／全文。
- **Service stubs**：`agent`／`proof`／`gate` 預設 `unavailable`；提交成功後案件 **METHOD_REVIEW**（proof+gate verified 後才可 READY；**Agent 可不接**）。
- **Legacy 保留**：`public/legacy.html` 舊 PCF 三幕仍可載入；Root header 連結 legacy。
- **測試**：`tests/workflow/smoke.js`（**34** 項）、`tests/ui/static-contract.js`（**16** 項）；`npm run smoke:workflow` → **50/50 PASS**。
- **交棒文件**：`docs/handoff/PHASE2_SESSION_LOG.md`、`DAY3_TRUST_ENGINE_HANDOFF.md`、更新 `DAY2_*`；README 本段。

### 本階段刻意不做

- ZKP、Policy Gate **正式實作**、Factor Registry、Evidence Agent（留 Day 3–4；Day 2 僅 hook）。
- 正式物件儲存／KMS／HSM；多案件建案 API。
- 登入、vLEI、CBAM Registry、官方查驗完成或海關核准宣告。
- Cloudflare Worker 已保留可部署 synthetic Demo（含 Root UI）；`x-demo-role` 無真實 auth／tenant 隔離。

### 已知限制

- Workflow 全記憶體，重啟清空 evidence／grant。
- UI 尚無 revalidate 按鈕（僅 API + smoke）。
- Evidence `version` 恆為 `1`，同名拒絕，尚無版本演進。
- 單一 Demo 案件；Importer default 2.5 為硬編碼 Demo estimate。
- 與 Vibe p.9 相比簡化：無 `POST /api/cases` 建案、無獨立 `/api/carbon/calculate`。
- **無新增環境變數**。

### 驗收命令

```bash
npm run smoke:carbon-core   # 36/36
npm run smoke:workflow      # 50/50
npm start                   # http://127.0.0.1:3847/
```

---

## Phase 1 核心阻斷修正（2026-08-25）

- 新增零依賴 schema draft-07 子集 validator，煙測會實際載入 `schema-v1.json` 驗證 11 個 canonical entities（含 `CalculationReceipt`）的 required/type/enum/數值下界；四份 fixture 的 Shipment 均補齊 `allocatedEmissions` 與 `allocationStatus`。
- 年度排放改為 `sum(activity × referenced factor)` 的 10^6 定點計算，拒絕不允許 factor、負數、未知單位、缺項與溢位；normal 的合成 Demo activities/factors 明確標 `demoOnly`，算得 360，再除以 200 得強度 1.80。
- CalculationReceipt 的 hash 與 metadata 納入 factor version/sourceHash、policy version/profile、scale、rounding rule、method version；`tampered_quantity` 仍只測 Phase 1 帳本超額，並保留 8/26 補真正 `PUBLIC_INPUT_MISMATCH` 的邊界說明。

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
