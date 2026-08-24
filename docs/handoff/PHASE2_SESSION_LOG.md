# Session Log — Phase 2 Case Workflow UI + Demo Vault + Trust Adapter Hook

給接手的人（隊友葉士愷 Day 3 trust engine，或之後的我自己）看的：這份文件記錄 2026-08-24～08-25 A（黃昱羲）在 `feature/case-workflow-ui` 分支把 Day 2 工作流、三角色 UI、Demo Vault、瀏覽器除錯，以及 **Trust adapter hook（尚未接真 ZKP/Gate）** 落地的過程。不是逐字對話紀錄，是整理過的決策摘要。

**Git／stacked Draft PR 狀態（撰寫當下）**：PR #3 **尚未合併**；本分支 stacked 於 `b8a648c` + `401ae5d`，因此以 `main` 為 base 的 Draft PR 會同時包含 Day 1。`origin/pr-3` 只是本機 fetched ref／目前 upstream，可能 stale，不能視為已合併證據。上述 Day 2 變更仍在 **working tree，尚未 commit、未 push、未 tag `v0.2-workflow`**；分支／PR base 由主對話稍後處理。

---

## 1. 時間軸

1. **Day 1 stacked 脈絡**：`feature/carbon-core` @ `b8a648c`（PR #3，**尚未合併**）交付 `packages/contracts/`、`services/carbon-core/`、四份 fixture、36 項 smoke；本分支另含 `401ae5d`，對 `main` 的 Draft PR 會包含 Day 1；`docs/handoff/PHASE1_SESSION_LOG.md` 記錄 Phase 1 決策；`DECISIONS.md` §9 改題留痕。
2. **Day 2 規劃對齊**：依《Vibe Coding AI 完整工程規格與指令手冊》（優先權第 1）、《落地風險審查與修正版方案》、《8/24–8/28 雙人落地分工計畫》Day 2、《Day1工作小結_20260824.pdf》——A 負責三角色 UI、workflow API、Demo Vault；B 的 ZKP／Registry／Gate **留 8/26**。
3. **Phase 1 阻斷修正（同分支、同 working tree）**：補 `packages/contracts/validator.js` 執行期 schema 驗證；`calculateAnnualEmissions` 改為 `sum(activity×factor)` + scale `10^6`；normal 路徑 **360 tCO2e ÷ 200 t = 1.80**。
4. **Workflow 後端落地**：`server/workflowApi.js`、`server/workflowStore.js`、`server/carbonAdapter.js`；固定案件 `CASE-2026-001`；記憶體 evidence/grant/audit；server-side `maskCase()`。
5. **Root UI 落地**：`public/index.html`、`public/js/case-workflow.js`、`public/css/case-workflow.css`；Legacy 保留 `public/legacy.html`。
6. **瀏覽器除錯（Playwright MCP）**：實跑三角色流程；修正 favicon 404、Importer 自行覆寫狀態、submit 失敗不刷新、reset 權限、Grant 終態未清 session、download 缺 UI、`quantityUnit` 顯示 `undefined`、`.bak` 檔可從 public 讀取等問題（詳 §6）。
7. **Trust adapter hook（Day 2 末）**：新增 `server/trustAdapter.js`；`POST /api/workflow/revalidate`；`workflowStore.setTrustServices()`／`setServiceStatus()`；smoke 以 `setEvaluatorForTests` 驗 READY／BLOCKED 路徑——**預設 evaluator 仍回 unavailable，不代表 ZKP/Gate 已完成**。
8. **本文件 + Day 3 handoff**：供 8/26 B 直接開工，無需再問 A 路由形狀。

---

## 2. 文件權威順序與本 Phase 範圍

| 優先 | 文件 | 用途 |
|------|------|------|
| 1 | 《Vibe Coding AI 完整工程規格與指令手冊》 | 欄位、API、GateResult、fixture ID |
| 2 | 《落地風險審查與修正版方案》 | 法規邊界、Vault／ZKP 限制 |
| 3 | 《8/24–8/28 雙人落地分工計畫》 | Owner、Cut Plan |
| 4 | `docs/handoff/`、`DECISIONS.md` §9 | 團隊留痕 |

### 規格要求 vs 今日實況 vs 明日才做

| 項目 | 規格要求 | 今日實況（working tree） | 明日（8/26，B） |
|------|----------|--------------------------|-----------------|
| 三角色 UI | Supplier／Importer／Verifier | ✅ Root UI + server 遮罩 | 可選：revalidate 按鈕 |
| 案件工作流 | 上傳→確認→提交 | ✅ 固定 `CASE-2026-001` | — |
| 碳排數字 | 只走 carbon-core | ✅ `buildCaseCarbon()` | Gate 餵 receipt `inputHash` |
| Demo Vault | Hash、Grant、一次性 | ✅ + **download** 路由／UI | — |
| Proof／Gate | 硬規則 + ZKP | ⚠️ **hook only**（stub evaluator） | ZKP + Factor Registry + Policy Gate |
| Agent | RiskReport | stub `unavailable` | Day 4；**不阻擋** READY（見 §9） |
| 正式查驗／Registry | 不得宣稱 | ✅ 文案 + 測試約束 | 仍禁止 |

---

## 3. Day 1 輸入與本日修正

### 3.1 自 Day 1 沿用

- 固定 Demo ID：`CASE-2026-001`、`CBAM-STEEL-2026-v1`、`CBAM-DEMO-2026-v1`、`TW-STEEL-01`、`SHIP-A`／`SHIP-B`。
- `packages/contracts/` + `services/carbon-core/` + `fixtures/`（四份；`tampered_quantity` 仍為 Phase 1 帳本詮釋，見 Phase 1 log §3）。
- `npm run smoke:carbon-core` → **36/36 PASS**。

### 3.2 本日兩項核心修正（同分支）

1. **執行期 schema 驗證**：`validator.js` 零 npm 依賴 draft-07 子集；`carbonAdapter.assertCanonical()` 與 smoke 載入 `schema-v1.json`（11 entities）。
2. **年度排放**：`normal.json` 補 `activities`／`factorSet`；拒絕 installationYear-only 舊呼叫；分攤 **180／108**。

---

## 4. Day 2 實作（working tree）

| 模組 | 路徑 | 說明 |
|------|------|------|
| Workflow API | `server/workflowApi.js` | 路由、遮罩、Vault、Audit、`revalidateCase` |
| Workflow Store | `server/workflowStore.js` | 記憶體狀態；`setTrustServices`／`setServiceStatus` |
| Trust hook | `server/trustAdapter.js` | `evaluate()` + 測試用 `setEvaluatorForTests` |
| Carbon 整合 | `server/carbonAdapter.js` | `buildCaseCarbon()`、`unavailableAdapters()` |
| 路由掛載 | `server/apiFetch.js`、`server/index.js` | `x-demo-role`／`x-vault-token` |
| Root UI | `public/index.html`、`case-workflow.js`、`case-workflow.css` | 三角色 + download |
| Legacy | `public/legacy.html` | 舊 PCF 三幕 |
| 測試 | `tests/workflow/smoke.js`（**34**）、`tests/ui/static-contract.js`（**16**） | `npm run smoke:workflow` → **50/50 PASS** |
| 交棒 | `docs/handoff/DAY2_*`、`PHASE2_SESSION_LOG.md`（本檔） | — |

**新增路由（相對 Vibe p.9 簡化）**

- 已有：`GET/POST` workflow 路由（見 `DAY2_EXECUTION_PLAN.md` §8）。
- **本日新增**：`POST /api/workflow/revalidate`（Supplier only）— 呼叫 `trustAdapter.evaluate` → `setTrustServices` → `applyReadiness`。
- 仍**無**：`POST /api/cases` 建案、獨立 `/api/carbon/calculate`（改 `carbon/preview` + submit 內嵌）。

---

## 5. Playwright 發現與修正

Browser debug 使用 Playwright MCP 對 `http://127.0.0.1:3847/` 跑三角色腳本；`artifacts/`（含 `artifacts/playwright/` 的 YAML／console log、一次性 token 或底稿）**僅供本機使用且整目錄已 gitignore，永不提交**。只提交人工清洗後的 `docs/handoff/screenshots/day2/*.png`。

| 現象 | 根因 | 修正 |
|------|------|------|
| Console：`/favicon.ico` 404 | 無 favicon | `index.html` 內嵌 SVG `data:` favicon |
| Importer  shipment 狀態與 server 不一致 | client 用 trust 猜測覆寫 `allocationStatus` | 刪 client 覆寫；只顯示 server `outwardStatus` |
| submit 422 後 UI 仍顯示舊狀態 | 失敗路徑未 `loadRole` | `submitCase()` `finally { await loadRole() }` |
| 非 Supplier 可見「重置 Demo」 | 未依角色隱藏 | `reset-workflow.hidden = !supplier` + `aria-describedby` |
| Grant 過期／重用後 token 留 session | 終態未清 | `clearVaultSession()`；對 `GRANT_INVALID`／`EXPIRED`／`REVOKED` 自動清 |
| Verifier 只能 open、不能 download | UI 缺按鈕 | `#download-evidence` + `URL.createObjectURL` 下載 |
| Shipment 欄位顯示 `undefined` | fixture 缺 `quantityUnit` | `shipment.quantityUnit \|\| 'tonne'` |
| `.bak-*` 可從 public URL 讀取 | 備份留在 `public/` | 移至 `_backups/20260825/public/`；`server/index.js` 拒絕 `.bak-` |
| Console 403 on vault reuse | **預期行為**（一次性 Grant） | 無 bug；UI 顯示穩定 `GRANT_*` code 引導 |

**截圖**（相對本檔）：[`screenshots/day2/`](screenshots/day2/)

| 檔案 | 情境 |
|------|------|
| [supplier-initial.png](screenshots/day2/supplier-initial.png) | Supplier 初始 DRAFT |
| [supplier-complete.png](screenshots/day2/supplier-complete.png) | 四份 evidence + 提交後 METHOD_REVIEW |
| [importer-summary.png](screenshots/day2/importer-summary.png) | Importer 摘要（無底稿） |
| [verifier-vault.png](screenshots/day2/verifier-vault.png) | Verifier 開啟底稿 |
| [vault-denied.png](screenshots/day2/vault-denied.png) | Grant 拒絕／重用 |

---

## 6. 三角色流程（Demo 腳本）

1. `npm start` → [http://127.0.0.1:3847/](http://127.0.0.1:3847/)
2. **Supplier**：一鍵 seed → 人工確認全部 → 提交 → 強度 **1.80**、分攤 **180/108**、狀態 **METHOD_REVIEW**（Proof/Gate **尚未驗證**）
3. **Supplier**：建 Grant（≤5 分鐘）→ 複製 token（僅一次）
4. **Verifier**：貼 token → 開啟或 **下載一次** → Audit `VAULT_OPEN`／`VAULT_DOWNLOAD`
5. 重用 token 或 **Importer** 帶 token → `403` + `GRANT_INVALID`（或 `GRANT_EXPIRED`／`GRANT_REVOKED`）
6. **Importer**：摘要、完整度、actual **1.8** vs default **2.5**（Demo estimate）
7. Supplier「重置 Demo」→ `DRAFT`

Legacy：`legacy.html` 舊 PCF 三幕（可選 `OPENAI_API_KEY`）。

---

## 7. Vault／遮罩／安全

| 控制 | 規格 | 實況 |
|------|------|------|
| 完整性 | SHA-256 | ✅ 同名 `409 EVIDENCE_ALREADY_EXISTS` |
| 大小／類型 | 白名單 | ✅ 512 KiB；PDF/JSON/text/PNG/JPEG |
| 授權 | 短效、綁 Verifier、一次性 | ✅ ≤5 分鐘；`demo-verifier-001` |
| Token | 不進 URL／Audit | ✅ `x-vault-token` header |
| 遮罩 | server-side | ✅ Importer 無 vaultRef/content/檔名；Verifier receipt 僅 `inputHash`+`methodVersion` |
| 儲存 | Demo | ⚠️ 記憶體；重啟即失 |

**Vault 錯誤碼（server 實際）**：`GRANT_INVALID`、`GRANT_EXPIRED`、`GRANT_REVOKED`（**不是** `VAULT_ACCESS_DENIED`；該字串僅 client 在「未選 token」時的 UI 提示碼）。

---

## 8. Trust adapter 決策（hook only，非 ZKP 完成）

### 8.1 為何 Day 2 只做 hook

規格要求 Proof + Gate 才能 `READY_FOR_VERIFIER`，但 ZKP／Registry 屬 B Day 3。A 先固化 **接點**，避免 8/26 改 workflow 路由。

### 8.2 接點契約

**`trustAdapter.evaluate(input)` input**

```json
{
  "caseId": "CASE-2026-001",
  "policyProfileId": "CBAM-STEEL-2026-v1",
  "inputHash": "<calculationReceipt.inputHash 或省略>"
}
```

**output**（僅 `proof` + `gate`；`validateResult` 強制）

```json
{
  "proof": {
    "status": "available|unavailable|error",
    "verification": "verified|not_verified|failed",
    "checks": [{ "name": "...", "status": "pass|fail|skipped" }],
    "reasonCodes": ["STABLE_CODE"],
    "inputHash": "<verified 時必填>"
  },
  "gate": { "...同上..." }
}
```

**adapter/store 邊界**：`trustAdapter.validateServiceResult()` 與 `workflowStore.setTrustServices(result)` 均要求 `status=available` 時 `verification` 只能是 `verified|failed`；`verified` 必須搭配 `status=available`。Store 只接受 `agent|proof|gate` 名稱，reasonCodes 須匹配 `/^[A-Z][A-Z0-9_]*$/`。

**readiness 規則**（`calculateReadiness`）

1. proof/gate `error|failed` → `BLOCKED`／`readiness=failed`
2. 缺 evidence → `NEEDS_EVIDENCE`
3. proof **且** gate 皆 `available+verified` → `READY_FOR_VERIFIER`（**Agent 可仍 unavailable**）
4. 否則 → `METHOD_REVIEW`／`SERVICE_UNAVAILABLE`

**重驗**：`POST /api/workflow/revalidate`（Supplier）→ evaluate → setTrustServices → applyReadiness → Audit `WORKFLOW_REVALIDATE`。

**預設**：evaluator 回 `PROOF_SERVICE_UNAVAILABLE`／`GATE_SERVICE_UNAVAILABLE`；submit 後固定 **METHOD_REVIEW**。

詳細 Day 3 實作指引：[`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md)。

---

## 9. 測試命令與實際項數

```bash
npm run smoke:carbon-core   # 36/36 PASS
npm run smoke:workflow      # workflow 34 + UI 16 = 50/50 PASS
npm start                   # http://127.0.0.1:3847/
```

| 套件 | 檔案 | 項數 | 備註 |
|------|------|------|------|
| carbon-core | `tests/carbon-core/smoke.js` | **36** | 含 validator 11 entities |
| workflow API | `tests/workflow/smoke.js` | **34** | 含 adapter boundary、revalidate×4、store setter、submit 狀態同步 |
| UI 靜態 | `tests/ui/static-contract.js` | **16** | 含 favicon、download、reset、styles |
| Legacy | `npm run smoke` | 16 | 非 Day 2 主線 |

完整標籤清單：`docs/handoff/DAY2_TEST_CASES.md`。

---

## 10. 已知限制

- Workflow 全記憶體；重啟清空 evidence/grant（carbon fixture 可重建）。
- 單一固定案件；無多 tenant／正式 auth。
- `workflowStore` 的 `CASE_STATUSES` 仍含 legacy `VERIFIER_REQUIRED`（validator/enums 已移除）— 新 workflow 不會寫入此值。
- Importer default **2.5** 硬編碼 Demo estimate。
- UI **尚無** revalidate 按鈕（僅 API + smoke）；B 可接或 A Day 4 補。
- ZKP／Factor Registry／Policy Gate **未實作**；禁止宣稱「已正式驗證／CBAM Certified／官方查驗完成」。
- `tampered_quantity.json` 仍測帳本超額，非規格 p.8 的 `PUBLIC_INPUT_MISMATCH`（Day 3 擴充）。

---

## 11. 未完成（留 Day 3+）

| 項目 | Owner | 目標日 |
|------|-------|--------|
| ZKP Proof 產生／驗證 | B | 8/26 |
| Factor Registry + Policy Gate 服務 | B | 8/26 |
| 攻擊 fixture 全套（100→120、replayed、revoked…） | B | 8/26 |
| `PolicyProfile.circuitId` 填值 | B | 8/26 |
| Evidence Agent RiskReport | B/A | Day 4 |
| working tree **commit + PR** | A | 待隊友審閱後 |

---

## 12. 交付檔案

| 路徑 | 用途 |
|------|------|
| `server/workflowApi.js`、`workflowStore.js`、`trustAdapter.js`、`carbonAdapter.js` | Day 2 + trust hook |
| `public/index.html`、`js/case-workflow.js`、`css/case-workflow.css` | Root UI |
| `tests/workflow/smoke.js`、`tests/ui/static-contract.js` | 50 項 workflow 煙測 |
| `docs/handoff/DAY2_EXECUTION_PLAN.md` | Day 2 規格 vs 實況 |
| `docs/handoff/DAY2_API_EXAMPLES.json` | 可 parse 的 API 範例 |
| `docs/handoff/DAY2_TEST_CASES.md` | 測試矩陣 |
| `docs/handoff/PHASE2_SESSION_LOG.md` | 本檔 |
| `docs/handoff/DAY3_TRUST_ENGINE_HANDOFF.md` | B 開工手冊 |
| `docs/handoff/screenshots/day2/*.png` | Playwright 截圖 |

---

## 13. 啟動／回退

**啟動**

```bash
cd mandate
npm run smoke:carbon-core
npm run smoke:workflow
npm start
```

**回退**（未 commit 前）

- 保留 Day 1：`git checkout -- .` 會連 Phase 1 修正一起還原；**勿**盲目 `git clean -fd`。
- 安全做法：只刪 Day 2 untracked（`server/workflow*.js`、`trustAdapter.js`、`public/js/case-workflow.*` 等）或整支 checkout 到 `401ae5d` 前備份。
- Legacy 演示：保留 `public/legacy.html` + 舊 `server/*` 即可。

---

## 14. Git 狀態（撰寫當下）

- **分支**：`feature/case-workflow-ui`
- **HEAD**：`401ae5d`（Add Phase 1 session log）
- **狀態**：大量 modified + untracked（workflow、trust、UI、handoff、screenshots）；**尚未 commit**
- **主對話待辦**：審閱通過後 commit、push、`gh pr create` — **不在本 session 範圍**

---

## 15. 完成摘要（對照規格 p.28 回報格式）

- **本次任務**：Phase 2 Day 2 — 三角色 UI、workflow API、Demo Vault、browser debug、Trust adapter hook；**未做**：真 ZKP、Factor/Policy Registry、Policy Gate 評估、Evidence Agent、正式 auth。
- **測試**：`smoke:carbon-core` 36/36；`smoke:workflow` 50/50（2026-08-25 實跑）。
- **安全／法規**：無「CBAM Certified／官方核准／海關已核准」；`READY_FOR_VERIFIER` 僅送查準備條件。
- **Commit／PR**：**尚未** — 刻意保留至隊友審閱 handoff 後由主對話處理。
