# Mandate — Policy Specification

**文件狀態**：V1 程式契約  
**唯一放行點**：`PolicyEngine.evaluate`  
**決策碼**：`DENY_REVOKED` \| `DENY_EXPIRED` \| `DENY_POLICY` \| `DENY_CONSTRAINT` \| `PENDING_HUMAN` \| `ALLOW`

---

## 1. 評估順序（必須嚴格遵守）

引擎對每一次 `evaluate` **由上而下**執行；**先命中先終止**（short-circuit）。deny 類永遠在 allow 之前。

| 步驟 | 名稱 | 說明 | 典型 decision |
|------|------|------|---------------|
| **1** | status | Mandate 狀態與時間有效性 | `DENY_REVOKED` / `DENY_EXPIRED` |
| **2** | deny list | 工具、供應商、動作在拒絕清單 | `DENY_POLICY` |
| **3** | allow | 工具是否在允許清單；Actor 是否準入 | `DENY_POLICY` |
| **4** | constraints | 品質欄位、分享撤銷、輸入邊界 | `DENY_CONSTRAINT` / `DENY_REVOKED` |
| **5** | L3+ PENDING | 高風險／HITL 規則（含 CBAM 草稿提交） | `PENDING_HUMAN` |
| **6** | ALLOW | 以上皆通過 | `ALLOW` |

```text
evaluate(ctx):
  step1_status(ctx)        -> if deny return
  step2_deny_list(ctx)     -> if deny return
  step3_allow(ctx)         -> if deny return
  step4_constraints(ctx)   -> if deny return
  step5_l3_pending(ctx)    -> if pending return
  step6_allow(ctx)         -> ALLOW
  write AuditEvent(policyId=終止決策之 id, decision=...)
```

**Audit 規則**：終止決策的那一條 `policyId` 必須寫入 `AuditEvent.policyId`。

---

## 2. Decision Code 語意

| Code | HTTP/UI 建議 | 可重試？ | 說明 |
|------|--------------|----------|------|
| `DENY_REVOKED` | 403 | 否* | Mandate 已撤銷，或資料分享已撤銷且不可再用 |
| `DENY_EXPIRED` | 403 | 否* | 已過 `expiresAt` |
| `DENY_POLICY` | 403 | 視情況 | 不在 allow／命中 deny list／Actor 不准／禁工具 |
| `DENY_CONSTRAINT` | 422 | 改參數後可 | 缺品質欄位、輸入非法 |
| `PENDING_HUMAN` | 202 | 等待核准 | 已建或應建 Approval |
| `ALLOW` | 200 | — | 可執行 tool |

\* V1：**不做**對 REVOKED／EXPIRED Mandate 或已撤銷 share 的自行恢復。

---

## 3. Policy 目錄（穩定 ID）

| policyId | 步驟 | 標題 |
|----------|------|------|
| POL-AUTH-001 | 1 | Mandate 已撤銷拒絕 |
| POL-AUTH-002 | 1 | Mandate 已過期拒絕 |
| POL-AUTH-003 | 1／3 | 無有效 Mandate／主體不一致 |
| POL-GATE-000 | 3 | 工具未註冊或 Agent 呼叫禁工具（含 commit） |
| POL-GATE-001 | 2 | Deny list（供應商／工具） |
| POL-GATE-002 | 3 | Allow list（工具準入） |
| POL-GATE-003 | 2／5 | 敏感匯出閘門 |
| POL-CARB-001 | 4 | PCF 品質最低欄位（缺則拒收） |
| POL-CARB-002 | 4 | PCF 進階欄位／查驗一致性（缺可警告；假查驗拒收） |
| POL-REQ-001 | 4 | fetch 供應商回覆須先有索取紀錄 |
| POL-CRED-001 | 4 | 供應商 vLEI 憑證鏈無效（法人／角色憑證撤銷、過期、I2I 檢查失敗） |
| POL-EXP-001 | 3／5 | 客戶回覆草稿／稽核匯出 |
| POL-HITL-010 | 5 | submit_cbam_draft 必須人類確認 |
| POL-REV-010 | 4／副作用 | 資料分享撤銷後不得再用 |
| POL-REV-002 | 3／4 | 禁止復活已撤銷 Mandate |

> 實作可增補，但**不可改已公布 ID 的語意**。舊採購相關 ID（如 POL-HITL-001 付款）本 V1 **不再使用**。

---

## 4. 逐條 IF / THEN

### POL-AUTH-001 — Mandate 已撤銷拒絕

```text
IF mandate.status == "REVOKED"
THEN decision = DENY_REVOKED
     policyId = "POL-AUTH-001"
     reason = "Mandate has been revoked; issue a new mandate to continue."
```

### POL-AUTH-002 — Mandate 已過期拒絕

```text
IF mandate.status != "REVOKED"
   AND now >= mandate.expiresAt
THEN decision = DENY_EXPIRED
     policyId = "POL-AUTH-002"
     reason = "Mandate expired at expiresAt."
```

### POL-AUTH-003 — 無有效 Mandate／主體不一致

```text
IF mandate == null
   OR mandate.principalId 與 ctx.principal 不一致（含 org 隔離失敗）
   OR mandate.status 不屬於 {"ACTIVE"} 且非由 001/002 處理之狀態
THEN decision = DENY_POLICY
     policyId = "POL-AUTH-003"
     reason = "No valid mandate bound to principal."
```

### POL-GATE-000 — 禁工具／未註冊

```text
IF toolName == "commit_cbam_draft" AND actor.actorType == "AGENT"
THEN decision = DENY_POLICY
     policyId = "POL-GATE-000"
     reason = "commit_cbam_draft is never exposed to Agent."

IF toolName not in registry
THEN decision = DENY_POLICY
     policyId = "POL-GATE-000"
```

### POL-GATE-001 — Deny list 優先

```text
IF toolName in mandate.deniedTools
   OR (input.supplierId != null AND input.supplierId in mandate.deniedSuppliers)
THEN decision = DENY_POLICY
     policyId = "POL-GATE-001"
     reason = "Matched deny list (tool or supplier)."
```

### POL-GATE-002 — Allow list

```text
IF toolName not in mandate.allowedTools
THEN decision = DENY_POLICY
     policyId = "POL-GATE-002"
     reason = "Tool not in mandate allow list."

IF actor.actorType == "AGENT"
   AND toolName not in agent.allowedTools
THEN decision = DENY_POLICY
     policyId = "POL-GATE-002"
```

### POL-GATE-003 — 敏感匯出

```text
IF toolName == "export_sensitive" AND actor.actorType == "AGENT"
THEN decision = DENY_POLICY
     policyId = "POL-GATE-003"

IF toolName == "export_sensitive" AND actor.actorType == "HUMAN"
THEN decision = PENDING_HUMAN
     policyId = "POL-GATE-003"
```

### POL-CARB-001 — PCF 品質最低欄位

適用：`ingest_pcf_payload`（以及任何將 PCF 當可信輸入寫入 Staging／提交的路徑）。

**品質最低欄位（皆必填且非空）**：

| 欄位 | 說明 |
|------|------|
| `method` | 核算／計算方法（如 ISO／PEF／supplier method id） |
| `boundary` | 系統邊界（如 cradle-to-gate） |
| `period` | 報告期間（起迄或同等結構） |
| `unit` | 功能單位／產品單位 |
| `tCO2e` | 嵌入排放數值（number，且有限） |
| `supplierId` | 供應商穩定 ID |

```text
IF toolName == "ingest_pcf_payload"
   AND (
        input.method 缺失或空白
     OR input.boundary 缺失或空白
     OR input.period 缺失或無效
     OR input.unit 缺失或空白
     OR input.tCO2e 缺失或非有限數字
     OR input.supplierId 缺失或空白
   )
THEN decision = DENY_CONSTRAINT
     policyId = "POL-CARB-001"
     reason = "PCF payload missing required quality fields (method/boundary/period/unit/tCO2e/supplierId)."
```

> 「漂亮噸數」＝僅有 `tCO2e`（或數字很大）但缺其他欄位 → **同樣拒收**。

### POL-CARB-002 — PCF 進階欄位與查驗一致性

**Level 2 建議欄位**（缺仍可入 staging，但標 `qualityTier: PARTIAL` 與 `warnings[]`）：

| 欄位 | 說明 |
|------|------|
| `cnCode` | 產品 CN 碼或產業模板 |
| `emissionPerUnit` | 單位產品排放 |
| `verificationStatus` | `verified` \| `unverified` \| `in_progress` |

```text
IF toolName == "ingest_pcf_payload"
   AND input.verificationStatus == "verified"
   AND input.verificationReportId 缺失或空白
THEN decision = DENY_CONSTRAINT
     policyId = "POL-CARB-002"
     reason = "Cannot claim verified without verificationReportId."
```

### POL-REQ-001 — 須先索取才能 fetch 回覆

適用：`fetch_supplier_response`。

```text
IF toolName == "fetch_supplier_response"
   AND input.supplierId 不在 emissionsRequests（已成功 request_emissions）
THEN decision = DENY_CONSTRAINT
     policyId = "POL-REQ-001"
     reason = "Must request emissions from supplier before fetching response."
```

### POL-CRED-001 — 供應商 vLEI 憑證鏈無效

適用：`fetch_supplier_response`、`ingest_pcf_payload`。自建 vLEI mock（`server/vleiCheck.js`），仿造 GLEIF→QVI→法人憑證→角色憑證(ECR/OOR) 信任鏈；沒有 `vlei` 欄位的供應商一律視為有效（向下相容，不影響 Demo 三幕）。

```text
IF toolName in {"fetch_supplier_response", "ingest_pcf_payload"}
   AND supplier.vlei 存在
   AND (legalEntityCredential.status == "REVOKED"
        OR legalEntityCredential 已過期
        OR 任一 roleCredential.status == "REVOKED"
        OR 任一 roleCredential 已過期
        OR 任一 roleCredential.issuerCredentialId != legalEntityCredential.credentialId  // I2I 檢查
        OR 法人底下無任何角色憑證)
THEN decision = DENY_CONSTRAINT
     policyId = "POL-CRED-001"
```

撤銷動作：`revoke_supplier_credential`（Human-only，比照 `revoke_data_share` 走 `step3_allow` 的 humanSystemExtra 清單）撤銷指定供應商的 `legalEntityCredential`，並連鎖撤銷該供應商自己底下所有 `roleCredentials`（範圍僅限該供應商自己的憑證階層，不影響其他供應商）。

### POL-EXP-001 — 匯出客戶草稿／稽核

```text
IF toolName in {"export_client_draft", "export_audit"}
   AND actor.actorType == "AGENT"
THEN decision = DENY_POLICY
     policyId = "POL-EXP-001"

IF toolName == "export_client_draft"
   AND actor.actorType == "HUMAN"
   AND 無對應 staging 或 draft
THEN decision = DENY_CONSTRAINT
     policyId = "POL-EXP-001"
```

### POL-HITL-010 — submit_cbam_draft 一律 HITL

```text
IF toolName == "submit_cbam_draft"
THEN decision = PENDING_HUMAN
     policyId = "POL-HITL-010"
     reason = "CBAM draft submission always requires human approval."
     // 並建立 Approval{ type: "CBAM_DRAFT", status: "PENDING", mandateId, ... }
```

**即使** Staging 合格且未撤銷，本條仍在 step 5 強制 PENDING（不得直接 step 6 ALLOW）。

Human 核准與 commit 綁定：

```text
IF toolName == "commit_cbam_draft"
THEN
  IF actor.actorType == "AGENT"
  THEN DENY_POLICY / POL-GATE-000

  IF approval == null
     OR approval.status != "APPROVED"
     OR approval.consumedAt != null
     OR approval.mandateId != mandate.mandateId
  THEN decision = DENY_POLICY
       policyId = "POL-HITL-010"
       reason = "Valid unused approval required for commit_cbam_draft."

  ELSE on successful commit:
       set approval.consumedAt = now
```

```text
IF action == "approve_approval"
   AND approval.status == "PENDING"
   AND mandate.status == "ACTIVE"
   AND now < mandate.expiresAt
   AND 對應 staging/payload 未 shareRevoked
THEN approval.status = "APPROVED"
     audit policyId = "POL-HITL-010"
```

### POL-REV-010 — 撤銷後不得再用

```text
IF toolName in {"ingest_pcf_payload", "submit_cbam_draft", "commit_cbam_draft", "fetch_supplier_response"}
   AND target_payload_or_share.shareRevoked == true
THEN decision = DENY_REVOKED
     policyId = "POL-REV-010"
     reason = "Data share has been revoked; payload must not be reused."
```

撤銷副作用：

```text
IF toolName == "revoke_data_share" AND decision will be ALLOW for Human
THEN
  set share.shareRevoked = true
  set staging usable = false（若綁定）
  FOR EACH approval WHERE approval 綁定該 share/staging
                        AND approval.status == "PENDING"
  DO set approval.status = "CANCELLED"
     audit policyId = "POL-REV-010"
```

### POL-REV-002 — 禁止復活 Mandate

```text
IF 試圖將 REVOKED／EXPIRED mandate 改回 ACTIVE
THEN decision = DENY_POLICY
     policyId = "POL-REV-002"
     reason = "Revoked/expired mandate cannot be restored; issue a new mandate."
```

---

## 5. 步驟與 policy 對照（實作檢查表）

| 步驟 | 必須實作的 policyId |
|------|---------------------|
| 1 status | POL-AUTH-001, POL-AUTH-002, POL-AUTH-003 |
| 2 deny list | POL-GATE-001 |
| 3 allow | POL-GATE-000, POL-GATE-002, POL-REV-002 |
| 4 constraints | POL-CARB-001, POL-CARB-002, POL-REQ-001, POL-REV-010, POL-CRED-001 |
| 5 L3+ PENDING | POL-HITL-010, POL-GATE-003（Human 匯出） |
| 6 ALLOW | （選配 `POL-ALLOW-000`） |
| 副作用 | POL-REV-010（撤銷作廢 pending） |

選配：

```text
POL-ALLOW-000:
IF all previous steps passed AND tool risk <= L2
THEN ALLOW
```

若引入 `POL-ALLOW-000`，仍屬步驟 6；**不得**用來覆寫 HITL。

---

## 6. 測試向量（契約級）

| # | 情境 | 期望 decision | policyId |
|---|------|---------------|----------|
| T1 | mandate.status=REVOKED，任意 tool | DENY_REVOKED | POL-AUTH-001 |
| T2 | now > expiresAt | DENY_EXPIRED | POL-AUTH-002 |
| T3 | supplier in deniedSuppliers | DENY_POLICY | POL-GATE-001 |
| T4 | tool 不在 allowedTools | DENY_POLICY | POL-GATE-002 |
| T5 | 漂亮噸數缺 method／boundary 等 | DENY_CONSTRAINT | POL-CARB-001 |
| T6 | 合格 ingest | ALLOW | POL-ALLOW-000 或隱式 |
| T7 | submit_cbam_draft（合格 staging） | PENDING_HUMAN | POL-HITL-010 |
| T8 | Agent 呼叫 commit_cbam_draft | DENY_POLICY | POL-GATE-000 |
| T9 | revoke_data_share 後再 submit | DENY_REVOKED | POL-REV-010 |
| T10 | commit 使用已 consumed approval | DENY_POLICY | POL-HITL-010 |
| T11 | 對 REVOKED mandate 復活 | DENY_POLICY | POL-REV-002 |
| T12 | fetch 無先 request | DENY_CONSTRAINT | POL-REQ-001 |
| T13 | verified 無 reportId | DENY_CONSTRAINT | POL-CARB-002 |
| T14 | 供應商法人憑證已撤銷後 ingest/fetch | DENY_CONSTRAINT | POL-CRED-001 |

---

## 7. Audit 必填欄位（與 policy 相關）

| 欄位 | 規則 |
|------|------|
| `policyId` | 終止決策 ID，必填 |
| `decision` | 上表六碼之一 |
| `mandateId` | 若可知 |
| `toolName` | 提議工具 |
| `actorId` / `principalId` | 必填 |

完整 schema：[DATA_MODEL.md](./DATA_MODEL.md)

---

## 8. 版本

| 版本 | 日期 | 說明 |
|------|------|------|
| V1 | 2026-07-20 | 碳主線；POL-CARB-001／HITL-010／REV-010；保留 AUTH 狀態條 |
| V1.1 | 2026-08-17 | 新增 POL-CRED-001（供應商 vLEI 憑證鏈），使用者個人 fork 準備期強化，尚未併回 `1qaz0726-star/mandate:main` |
