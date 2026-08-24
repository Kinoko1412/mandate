# Day 2（8/25）工作小結

**A 分工範圍**：案件工作流 + 三角色 UI + Demo Vault + Trust adapter hook  
**負責人**：黃昱羲（A）｜**交付對象**：葉士愷（B）｜**日期**：2026-08-25

**對照文件**：《8/24–8/28 雙人落地分工計畫》Day 2、《落地風險審查與修正版方案》、《Vibe Coding AI 完整工程規格與指令手冊》、[`PHASE2_SESSION_LOG.md`](PHASE2_SESSION_LOG.md)

**Git 狀態（撰寫當下）**：PR #3（`feature/carbon-core`）**尚未合併**；PR #4（`feature/case-workflow-ui`）**stacked** 於 `b8a648c` + `401ae5d` 之上，對 `main` 的 Draft PR 同時包含 Day 1 與 Day 2。

---

## 1. 一句話總結

在 stacked Draft PR #4 完成三角色 Root UI、workflow API、Demo Vault、server-side 遮罩與 Audit，並同分支補 Phase 1 兩項阻斷修正（schema validator + 年度排放公式）；Trust adapter **僅 hook**（預設 unavailable，**不代表** ZKP／Gate 已完成），`smoke:carbon-core` 36／36、`smoke:workflow` 50／50、legacy smoke 16／16 全過，Worker `npm run dev:cf` dry-run 可載入 Root UI（`GET /` → 200）。

---

## 2. 驗收表（對照 Day 2 分工計畫）

| 驗收項目 | 完成內容 | 狀態 |
|----------|----------|------|
| 三角色 UI | Supplier／Importer／Verifier Root UI（`public/index.html` + `case-workflow.js`） | ✓ |
| 案件工作流 | 固定 `CASE-2026-001`：上傳 → 人工確認 → 提交 → 狀態推進 | ✓ |
| 碳排數字來源 | 只走 `carbonAdapter` → `services/carbon-core`，前端不算公式 | ✓ |
| Demo Vault | SHA-256、短效 Grant（≤5 分鐘）、一次性開啟／**download**、Audit 留痕 | ✓ |
| 角色遮罩 | server-side `maskCase()`；Importer 無 vaultRef／content／完整檔名 | ✓ |
| 未完成模組 stub | Agent／Proof／Gate 預設 unavailable；提交後 **METHOD_REVIEW** | ✓ |
| Trust hook | `trustAdapter.js` + `POST /api/workflow/revalidate`（**非** ZKP 完成） | ✓ |
| Phase 1 修正 | `validator.js` 11 entities；年度排放改 `sum(activity×factor)` → 1.80 | ✓ |
| 自動化測試 | carbon 36 + workflow/UI 50 + legacy 16 全 PASS | ✓ |
| 交棒文件 | `PHASE2_SESSION_LOG`、`DAY3_TRUST_ENGINE_HANDOFF`、本小結 | ✓ |

---

## 3. 為何同分支修正 Phase 1

Day 2 整合 carbon-core 時發現兩項**阻斷**落差，若不修 workflow 無法正確提交案件：

1. **執行期 schema 驗證**：規格要求 canonical 實體可驗 required／type／enum；新增零依賴 `packages/contracts/validator.js`，smoke 實際載入 `schema-v1.json` 驗 11 個 entities（含 `CalculationReceipt`）。
2. **年度排放公式**：規格要求 `sum(activity × factor)`、定點 scale `10^6`；`normal.json` 補 `activities`／`factorSet`，normal 路徑 **360 tCO2e ÷ 200 t = 1.80**，分攤 **180／108**；拒絕舊版 installationYear-only 呼叫。

兩項修正與 Day 2 程式同在 PR #4 commits `a41802a` 與後續 Day 2 commits，**不等** PR #3 merge。

---

## 4. Day 2 做法

### 4.1 三角色 UI

- 入口：`public/index.html`；固定案件 `CASE-2026-001`。
- 角色：`x-demo-role` header（畫面按鈕切換；**Demo 身分，非正式 auth**）。
- Supplier：seed 四份 synthetic evidence → 人工確認 → 提交 → 建 Grant。
- Importer：摘要、完整度、actual **1.8** vs default **2.5**（Demo estimate）。
- Verifier：Evidence Index、token 開啟／**下載**底稿、findings。
- Legacy 保留：`public/legacy.html` 舊 PCF 三幕。

### 4.2 Workflow API 與 Vault

| 模組 | 路徑 | 說明 |
|------|------|------|
| Workflow API | `server/workflowApi.js` | 路由、遮罩、Vault、Audit、`revalidateCase` |
| Workflow Store | `server/workflowStore.js` | 記憶體狀態；`setTrustServices`／`setServiceStatus` |
| Carbon 整合 | `server/carbonAdapter.js` | `buildCaseCarbon()`、`unavailableAdapters()` |
| Trust hook | `server/trustAdapter.js` | `evaluate()`；預設 unavailable |
| 路由掛載 | `server/apiFetch.js`、`server/index.js` | port **3847** |

Vault 控制：SHA-256 完整性、512 KiB／media 白名單、Grant ≤5 分鐘綁 `demo-verifier-001`、token 僅 `x-vault-token` header（不進 URL／Audit）。錯誤碼：`GRANT_INVALID`、`GRANT_EXPIRED`、`GRANT_REVOKED`。

### 4.3 Audit

- `GET /api/cases/:id/audit` 時間軸；含 evidence／submit／vault open／download／deny／revoke／finding／revalidate。
- Audit **不含** token 明文與 evidence 全文。

### 4.4 Trust adapter hook（非 ZKP 完成）

- `POST /api/workflow/revalidate`（Supplier only）→ `trustAdapter.evaluate` → `setTrustServices` → `applyReadiness`。
- READY 條件：**proof + gate** 皆 `available+verified`；**Agent 可不接**（smoke 已鎖）。
- 預設 evaluator 回 `PROOF_SERVICE_UNAVAILABLE`／`GATE_SERVICE_UNAVAILABLE` → submit／revalidate 後固定 **METHOD_REVIEW**。
- **禁止宣稱**：ZKP 已驗證、Policy Gate 正式評估、Evidence Agent 上線、CBAM Certified、官方核准、海關已核准。

---

## 5. Playwright 瀏覽器偵錯

實跑 `http://127.0.0.1:3847/` 三角色流程；`artifacts/playwright/` 僅本機 gitignore，**永不提交**。

| 現象 | 根因 | 修正 |
|------|------|------|
| `/favicon.ico` 404 | 無 favicon | 內嵌 SVG `data:` favicon |
| Importer 狀態與 server 不一致 | client 覆寫 `allocationStatus` | 刪 client 覆寫；只顯示 server 值 |
| submit 422 後 UI 舊狀態 | 失敗路徑未刷新 | `submitCase()` `finally { loadRole() }` |
| 非 Supplier 可見「重置 Demo」 | 未依角色隱藏 | `reset-workflow.hidden = !supplier` |
| Grant 終態 token 留 session | 未清 sessionStorage | `clearVaultSession()` on 終態 |
| Verifier 只能 open、不能 download | UI 缺按鈕 | `#download-evidence` + blob 下載 |
| Shipment 顯示 `undefined` | fixture 缺 `quantityUnit` | fallback `'tonne'` |
| public `.bak-*` 可讀 | 備份留在 public | 移至 `_backups/20260825/public/` |
| Console 403 on vault reuse | **預期**（一次性 Grant） | 無 bug |

截圖：[`docs/handoff/screenshots/day2/`](screenshots/day2/)（五張 PNG）。

---

## 6. 需要 B 注意的事

1. **PR #3 尚未合併**；你 checkout `feature/case-workflow-ui` 或看 PR #4 即可取得 Day 1+2 全部程式。
2. **不要改** `server/workflowApi.js` 路由表、`maskCase()`、`public/*` 三角色 UI／Vault 行為（除非與 A 同步 PR）。
3. Trust 接點已固化：`server/trustAdapter.js` 的 `evaluate()`；只需替換 evaluator，不改 workflow 形狀。
4. `READY_FOR_VERIFIER` = 具備送查準備條件，**不是**查驗員已簽核。
5. UI **尚無** revalidate 按鈕（僅 API + smoke）；DevTools POST `/api/workflow/revalidate` + `x-demo-role: Supplier`。

---

## 7. 明日（8/26）B 的唯一工作

**只讀 [`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md) 即可開工**——實作 `services/proof/`、`services/factor-registry/`、`services/policy-gate/`，替換 `trustAdapter` evaluator。

Day 3 必做攻擊矩陣（詳見 handoff §10）：

| 情境 | 預期 |
|------|------|
| normal | proof+gate verified → `READY_FOR_VERIFIER`；Gate `GATE_OK` |
| tampered **100→120** | Proof 聲稱 100 t、payload 120 t → `BLOCKED`／`PUBLIC_INPUT_MISMATCH` |
| replayed | 同 nonce 兩次 → `NONCE_REUSED` |
| revoked | factorSet 或 proof revoked → `FACTOR_NOT_ALLOWED` 或 `AUTHORIZATION_REVOKED` |
| expiry | Proof 過期 → `PROOF_EXPIRED` 或 `FACTOR_EXPIRED` |
| nonce | 缺 nonce／格式錯 → `PROOF_INVALID` |
| wrong_factor | factorSetId 不在 allowed → `FACTOR_NOT_ALLOWED` |
| circuitId | `PolicyProfile.circuitId` 填非 null 值；與 `ProofEnvelope` 一致 |

回歸：`npm run smoke:carbon-core` 仍 36／36；`npm run smoke:workflow` 仍 50／50。

---

## 8. tampered_quantity 詮釋（過渡說明）

| 層次 | 現況 | 負責日 |
|------|------|--------|
| Phase 1（現檔） | 測帳本超額：SHIP-A 150 t + SHIP-B 60 t > 200 t → `ALLOCATION_EXCEEDS_PRODUCTION` | 已保留 |
| 規格 p.8 原文 | Proof 聲稱 **100 t**、payload **120 t** → `PUBLIC_INPUT_MISMATCH` | **8/26 B** |

兩者**並存**：Phase 1 帳本測試保留；Day 3 **另外**實作 ZKP 版 100→120，不可刪除現有 carbon-core 測試。

---

## 9. 測試結果（2026-08-25 實跑）

```bash
npm run smoke:carbon-core   # 36/36 PASS
npm run smoke:workflow      # workflow 34 + UI 16 = 50/50 PASS
npm run smoke               # legacy 16/16 PASS
npm run dev:cf              # Worker dry-run Ready http://127.0.0.1:8787，GET / → 200
npm start                   # http://127.0.0.1:3847/
```

| 套件 | 檔案 | 項數 |
|------|------|------|
| carbon-core | `tests/carbon-core/smoke.js` | **36** |
| workflow API | `tests/workflow/smoke.js` | **34** |
| UI 靜態 | `tests/ui/static-contract.js` | **16** |
| Legacy policy | `server/smoke.js` | **16** |

完整標籤：[`DAY2_TEST_CASES.md`](DAY2_TEST_CASES.md)。

---

## 10. 交付物與 PR #4

| 項目 | 位置 |
|------|------|
| Draft PR #4（stacked，含 Day 1+2） | https://github.com/1qaz0726-star/mandate/pull/4 |
| PR #3（**未合併**，Day 1 原 PR） | https://github.com/1qaz0726-star/mandate/pull/3 |
| 分支 | `feature/case-workflow-ui` |
| Commits（PR #4 全歷程） | `b8a648c` Phase 1 → `401ae5d` session log → `a41802a` Phase 1 修正 → `43fb327` Day 2 workflow → `c8639d8` handoff 文件 |
| Day 2 程式 | `server/workflow*.js`、`trustAdapter.js`、`carbonAdapter.js`、`public/index.html` 等 |
| Day 3 開工手冊 | [`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md) |
| 決策摘要 | [`PHASE2_SESSION_LOG.md`](PHASE2_SESSION_LOG.md) |
| API 範例 | [`DAY2_API_EXAMPLES.json`](DAY2_API_EXAMPLES.json) |

---

## 11. 已知限制

- Workflow 全記憶體；重啟清空 evidence／grant。
- 單一固定案件；`x-demo-role` 無真實 auth／tenant 隔離。
- Importer default **2.5** 硬編碼 Demo estimate。
- UI 無 revalidate 按鈕。
- ZKP／Factor Registry／Policy Gate **未實作**；Agent stub `unavailable`。
- 與 Vibe p.9 簡化：無 `POST /api/cases` 建案、無獨立 `/api/carbon/calculate`。
- Day 2 **無新增**環境變數。

---

## 12. 8/26 下一步（摘要）

1. B 讀 [`DAY3_TRUST_ENGINE_HANDOFF.md`](DAY3_TRUST_ENGINE_HANDOFF.md)，實作 trust 引擎 + 替換 evaluator。
2. normal fixture → `POST /api/workflow/revalidate` → `READY_FOR_VERIFIER`。
3. 攻擊 fixture 全套（100→120、replayed、revoked、expiry、nonce、circuitId）+ `GATE_OK` on normal。
4. 回歸 36 + 50 smoke 不破；可選加 `smoke:trust`。
5. A 審閱 PR #4；PR #3 merge 順序由主對話決定。

---

*可信碳排證據 Agent · Day 2 工作小結 · 2026-08-25*
