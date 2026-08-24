# Day 3 Trust Engine Handoff — ZKP + Factor/Policy Registry + Policy Gate

> **讀者**：隊友 B（葉士愷），2026-08-26 09:00 開工。  
> **前提**：Day 2 workflow／UI／Vault／**trust hook** 已在 A 的 working tree（`feature/case-workflow-ui`，**尚未 commit**）。你**不應**改 workflow 路由形狀或 `maskCase` 契約；只實作 trust 引擎並接上既有 adapter。

> **Stacked Draft PR 事實**：PR #3 **尚未合併**；本分支 stacked 於 `b8a648c` + `401ae5d`，對 `main` 的 Draft PR 會同時包含 Day 1。`origin/pr-3` 是本機 fetched ref／目前 upstream，可能 stale，不能當作已合併證據；分支／PR base 由主對話處理。

**一句話目標**：讓 `trustAdapter.evaluate()` 在 normal fixture 上回 `proof+gate` 皆 `available+verified`，使 `POST /api/workflow/revalidate`（或 submit 後自動重驗）能把案件推到 **`READY_FOR_VERIFIER`**；攻擊 fixture 回穩定 `reasonCodes` 且 **`BLOCKED`**。**Agent 未接妥不得阻擋 Day 3 READY**（規格與 Day 2 smoke 已鎖定）。

---

## 1. 文件權威與禁止誤述

| 優先 | 文件 |
|------|------|
| 1 | 《Vibe Coding AI 完整工程規格與指令手冊》 |
| 2 | 《落地風險審查與修正版方案》 |
| 3 | 《8/24–8/28 雙人落地分工計畫》Day 3 |
| 4 | `docs/handoff/PHASE2_SESSION_LOG.md`、`PHASE1_SESSION_LOG.md` |

**禁止文案／commit message**：CBAM Certified、Officially Approved、海關已核准、官方查驗完成、Registry 已提交。  
`READY_FOR_VERIFIER` = **具備送交查驗準備條件**，不是查驗員已簽核。

---

## 2. Owner 與路徑邊界

### 2.1 你是 Owner（可改）

| 區域 | 路徑 | 任務 |
|------|------|------|
| ZKP | `services/proof/`（新建） | Proof 產生／驗證、`ProofEnvelope` |
| Factor Registry | `services/factor-registry/`（新建） | `FactorSet` 查詢、版本／有效期 |
| Policy Gate | `services/policy-gate/`（新建） | `GateResult`、reasonCodes |
| Trust 整合 | `server/trustAdapter.js` | 替換預設 unavailable evaluator |
| Fixtures | `fixtures/*.json` | 擴充攻擊情境；**保留** Phase 1 四份 |
| 測試 | `tests/trust/` 或擴充 `tests/carbon-core/` | 攻擊矩陣 + adapter 契約 |
| Schema | `packages/contracts/schema-v1.json`、`enums.js` | 若需新 reasonCode，同步兩檔 |

### 2.2 禁改（除非與 A 同步 PR）

| 路徑 | 原因 |
|------|------|
| `server/workflowApi.js` 路由表、`maskCase()` 欄位 | Day 2 契約已 smoke |
| `public/*` 三角色 UI | A Day 2 交付；最多加「重驗」按鈕需另開 |
| `services/carbon-core/index.js` 計算公式 | 唯一數字來源已驗 36 項 |
| `docs/DEPLOY_CLOUDFLARE.md` | 除非 route 真不一致 |
| Legacy `server/policy.js` | PCF 舊線 |

### 2.3 可改但需知會 A

- `server/workflowStore.js`：若需存 `ProofEnvelope` 引用（建議先不存底稿，只存 evaluate 結果）
- `worker/index.js`：確認 trust 模組在 Workers 可跑（見 §12）

---

## 3. 固定 Demo IDs（勿自創）

| 實體 | 值 |
|------|-----|
| caseId | `CASE-2026-001` |
| policyProfileId | `CBAM-STEEL-2026-v1` |
| factorSetId | `CBAM-DEMO-2026-v1` |
| installationId | `TW-STEEL-01` |
| shipmentId | `SHIP-A`、`SHIP-B` |
| Demo actors | `demo-supplier-001`、`demo-importer-001`、`demo-verifier-001` |

---

## 4. 定點 scale `10^6`

- 常數：`packages/contracts/fixedPoint.js` → `SCALE = 1_000_000`
- **carbon-core、Gate、未來 Circom** 共用；禁止中間步驟浮點捨入。
- `CalculationReceipt` / `GateResult.inputHash` 用 `stableStringify` + hash（見 carbon-core `buildCalculationReceipt`）。

---

## 5. Canonical 契約（必須對齊 schema-v1.json）

### 5.1 FactorSet（p.7）

Required：`factorSetId`, `issuer`, `purpose`, `version`, `effectiveFrom`, `effectiveTo`, `sourceHash`, `status`  
Enum `status`：`active` | `expired` | `revoked`  
Enum `purpose`：見 `enums.js` `FACTOR_PURPOSE`（Demo 用 `CBAM_ACTUAL`）

### 5.2 PolicyProfile（p.7）

Required：`policyProfileId`, `cnCodes`, `reportingYear`, `allowedFactorSets`, `requiredEvidence`, `circuitId`, `status`  
- Day 3 填 **`circuitId`**（例：`cbam-steel-qty-v1-demo`，你定但寫進 fixture）  
- `allowedFactorSets` 必含 `CBAM-DEMO-2026-v1`

### 5.3 ProofEnvelope（p.7，Day 3 起實用）

Required：`proofId`, `circuitId`, `publicInputs`, `proof`, `nonce`, `expiresAt`, `verificationKeyId`

**publicInputs（建議最小集，對齊 tampered 100→120 規格）**

| 欄位 | 說明 |
|------|------|
| `quantityTonnesScaled` | 公開輸入（Proof 聲稱的噸數 × 10^6） |
| `inputHash` | 綁 `CalculationReceipt.inputHash` |
| `policyProfileId` | 綁政策 |
| `caseId` | 綁案件 |

**privateInputs（不進 API 回應／不進 Audit）**：原始 activity 明細、未公開係數等（依你的 circuit 設計）。

### 5.4 GateResult（p.7）

Required：`decision`, `reasonCodes[]`, `checks[]`, `policyProfileId`, `evaluatedAt`, `inputHash`  
Optional 擴充：`shipmentId`（carbon-core 逐批需要）

`decision` enum：`GATE_OK` | `NEEDS_EVIDENCE` | `METHOD_REVIEW` | `BLOCKED`

### 5.5 trustAdapter service 形狀（Day 2 已鎖）

與 `GateResult` **不同層**：這是 workflow UI 的 **service readiness**，不是 shipment 級 Gate。

```typescript
// 每個 service: proof | gate（evaluate 只回這兩個）
{
  status: 'available' | 'unavailable' | 'error',
  verification: 'verified' | 'not_verified' | 'failed',
  checks: Array<{ name: string, status: 'pass'|'fail'|'skipped', detail?: string }>,
  reasonCodes: string[],  // /^[A-Z][A-Z0-9_]*$/
  inputHash?: string      // verification==='verified' 時必填
}
```

---

## 6. trustAdapter 接點（已存在，你來填實作）

### 6.1 evaluate input（`workflowApi.revalidateCase` 傳入）

```javascript
{
  caseId: 'CASE-2026-001',
  policyProfileId: 'CBAM-STEEL-2026-v1',
  inputHash: '<carbon.annual.calculationReceipt.inputHash>' // 可能 undefined 若尚未 submit
}
```

### 6.2 evaluate output

```javascript
{
  proof: { status, verification, checks, reasonCodes, inputHash? },
  gate:  { status, verification, checks, reasonCodes, inputHash? }
}
```

通過 `validateResult()`；throw 時 workflow 設 `TRUST_ADAPTER_FAILURE` + `BLOCKED`。

### 6.3 寫入 store

```javascript
workflowStore.setTrustServices(result);
// 或單項：workflowStore.setServiceStatus('proof', patch);
```

**驗證規則**（`trustAdapter.validateServiceResult` 與 `workflowStore.validateServicePatch` 一致）：  
- 不認 `registry` 等未知名  
- `verified` ⇒ `status==='available'`  
- `available` 時 `verification` 只能是 `verified|failed`，不可 `not_verified`

### 6.4 readiness（勿改語意）

`workflowApi.trustServicesVerified()`：**只檢查 proof + gate**。  
Agent 保持 `unavailable` 仍可 READY（smoke：`revalidate: Agent unavailable 但 mock Proof+Gate verified 可 READY`）。

### 6.5 建議 evaluate 流程

```
1. 讀 workflowStore.getCarbon(caseId) + getCase(caseId)
2. factor-registry.resolve(factorSetId) → 驗 active / 未 expired / 未 revoked
3. proof.verify(ProofEnvelope, { inputHash, publicInputs }) → checks + reasonCodes
4. policy-gate.evaluate({ case, carbon, proofResult, policyProfile }) → GateResult
5. 映射為 proof/gate service 物件；兩者皆 verified 才 READY
```

**接線範例**（替換 `trustAdapter.js` 預設 evaluator）：

```javascript
const { verifyProof } = require('../services/proof');
const { evaluateGate } = require('../services/policy-gate');

async function productionEvaluator(input) {
  // ... load context, run verify + gate ...
  return { proof: {...}, gate: {...} };
}
// 在 server 啟動或 trustAdapter 模組底層 setEvaluatorForTests(productionEvaluator) 的正式版
```

測試繼續用 `setEvaluatorForTests` / `resetEvaluatorForTests`。

---

## 7. Public / private signals

| 訊號 | 可公開（API/UI/Audit） | 必須私有 |
|------|------------------------|----------|
| `GateResult.decision` / `reasonCodes` | ✅ | |
| `inputHash` | ✅（Verifier 摘要級） | |
| `ProofEnvelope.publicInputs` | ✅ 摘要 | |
| `ProofEnvelope.proof` bytes | ⚠️ 僅 trust 層；勿進 Audit | |
| Grant token / `contentBase64` | | ✅ Vault 控制 |
| `CalculationReceipt` 完整 terms | Supplier 明細 | Importer 遮罩 |
| privateInputs | | ✅ 永不回 HTTP |

---

## 8. circuitId

- 存在 `PolicyProfile.circuitId`（schema required，Phase 1 允許 `null`）。
- Day 3 normal fixture 改為非 null，例如 `cbam-demo-qty-v1`。
- `ProofEnvelope.circuitId` 必與 PolicyProfile 一致，否則 `PROOF_CONTEXT_MISMATCH`。

---

## 9. Proof / Gate readiness（Agent 不阻擋）

| 模組 | Day 3 目標 | 阻擋 READY? |
|------|------------|-------------|
| proof | `available+verified` on normal | **是** |
| gate | `available+verified` on normal | **是** |
| agent | 可維持 `unavailable` | **否** |

UI `renderServices()` 已讀 `services.*`；接妥後 chip 顯示「已驗證」。

---

## 10. 攻擊 fixtures（完整矩陣）

現有 Phase 1 四份保留。Day 3 **新增或擴充**（可獨立 JSON 或 parametrize smoke）：

| ID | 情境 | 預期 decision | 預期 reasonCodes（至少包含） |
|----|------|---------------|------------------------------|
| `normal` | 完整資料 + 有效 Proof | `GATE_OK` / service verified | `GATE_OK` 或 `[]` |
| `tampered_quantity` | **規格 p.8**：Proof 聲稱 100 t，payload **120 t** | `BLOCKED` | `PUBLIC_INPUT_MISMATCH` |
| `replayed` | 同一 nonce 用兩次 | `BLOCKED` | `NONCE_REUSED` |
| `revoked` | factorSet 或 proof `revoked` | `BLOCKED` | `FACTOR_NOT_ALLOWED` 或 `AUTHORIZATION_REVOKED` |
| `expiry` | Proof `expiresAt` 已過 | `BLOCKED` | `PROOF_EXPIRED` 或 `FACTOR_EXPIRED` |
| `nonce` | 缺 nonce／格式錯 | `BLOCKED` | `PROOF_INVALID` |
| `wrong_factor` | factorSetId 不在 allowed | `BLOCKED` | `FACTOR_NOT_ALLOWED` |
| `missing_period` | evidence 期間缺 | `NEEDS_EVIDENCE` | `EVIDENCE_PERIOD_INCOMPLETE` |

**tampered 過渡**：現檔測帳本超額（`ALLOCATION_EXCEEDS_PRODUCTION`）— **保留** 為額外測試，但 Day 3 必須**另外**實作 100→120 + ZKP 版（見 Phase 1 log §3）。

完整 reasonCode 表：`packages/contracts/enums.js` `REASON_CODE` + 規格 p.11。

---

## 11. Definition of Done（8/26 EOD）

- [ ] `services/proof`、`services/factor-registry`、`services/policy-gate` 存在且被 `trustAdapter` 呼叫
- [ ] `trustAdapter.evaluate` normal → proof+gate verified；`POST /api/workflow/revalidate` → `READY_FOR_VERIFIER`
- [ ] 攻擊表 §10 每列有自動化測試或 fixture + smoke 標籤
- [ ] 定點 `10^6` 與 `inputHash` 與 carbon-core receipt 一致
- [ ] 無正式查驗誤述；README/CHANGELOG 若更新仍寫 **working tree 未 commit**（除非 A 已 commit）
- [ ] `npm run smoke:carbon-core` 仍 36/36；`npm run smoke:workflow` 仍 50/50（可加 `smoke:trust` 但勿破壞既有）
- [ ] Worker：`npm run dev:cf` 至少能跑 synthetic revalidate（記憶體 store 限制同 Day 2）

---

## 12. 測試命令

```bash
# 回歸（必跑）
npm run smoke:carbon-core      # 36
npm run smoke:workflow         # 50（含 trust hook mock + adapter boundary）

# 建議新增
npm run smoke:trust            # 你實作：fixtures × evaluate + gate unit

# 手動
npm start
# Supplier: submit → POST /api/workflow/revalidate → 看 status READY_FOR_VERIFIER
```

**Node**：`tests/workflow/smoke.js` 用 `handleFetchRequest`，無需 HTTP。  
**Browser**：Root UI 目前無 revalidate 鈕；DevTools 對 `/api/workflow/revalidate` POST + `x-demo-role: Supplier`。  
**Worker fallback**：`npm run dev:cf` → 同一 `apiFetch`；若 isolate 限制 crypto/ZKP，文件註明「Demo 用 Node 跑 proof，Worker 只轉發結果」— **不可** 靜默假 PASS。

---

## 13. Cut Plan（8/26）

| 時間 | 目標 | 可砍範圍 |
|------|------|----------|
| **14:00** | factor-registry 查表 + `wrong_factor`/`revoked` smoke；policy-gate 回 `GateResult` 形狀 | Circom 可先用 **mock proof bytes** + 真 verify 介面 |
| **18:00** | `trustAdapter` 接線 + normal READY + `tampered 100→120` PUBLIC_INPUT_MISMATCH + revalidate E2E | Agent、完整 Circom production proving、UI revalidate 鈕 |

若 18:00 前 ZKP 來不及：保留 mock verifier **但** reasonCodes／checks／inputHash 契約必須真；標 Demo `demoOnly: true`，**不得** 宣稱 cryptographic proof 已 production-grade。

---

## 14. 快速參考：現有 API（勿新增路由）

| Method | Path | 角色 |
|--------|------|------|
| POST | `/api/workflow/revalidate` | Supplier |
| POST | `/api/cases/:id/submit` | Supplier |
| GET | `/api/cases/:id` | 任一（遮罩） |

錯誤形狀：`{ code, message, retryable, details }`  
Vault：`GRANT_INVALID` | `GRANT_EXPIRED` | `GRANT_REVOKED`

範例 JSON：`docs/handoff/DAY2_API_EXAMPLES.json`（含 revalidate）。

---

## 15. 相關檔案

| 檔案 | 用途 |
|------|------|
| [`PHASE2_SESSION_LOG.md`](PHASE2_SESSION_LOG.md) | Day 2 實況 + trust hook 決策 |
| [`PHASE1_SESSION_LOG.md`](PHASE1_SESSION_LOG.md) | tampered 詮釋、NOT IN SPEC |
| [`DAY2_TEST_CASES.md`](DAY2_TEST_CASES.md) | 50 項 workflow 測試標籤 |
| `packages/contracts/schema-v1.json` | ProofEnvelope / GateResult |
| `server/trustAdapter.js` | **你的主接點** |
| `fixtures/normal.json` | 基準資料 |

---

## 16. 聯絡邊界

- 路由／UI 歧義 → 查 Phase 2 log + smoke，仍不明再問 A。
- reasonCode 命名新增 → 更新 `enums.js` + schema + 本檔 §10 表。
- **不要** 為了 READY 把 Agent 改成必須 verified — smoke 會紅。

Good luck — 接好 evaluator 後第一個驗收就是既有 `revalidate: mock Proof+Gate verified 可 READY` 從 mock 換成你的真實實作。
