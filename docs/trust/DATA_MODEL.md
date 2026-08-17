# Mandate — Data Model

**文件狀態**：V1 程式契約（JSON Schema 風格說明）  
**原則**：每個 `AuditEvent` 必含 `policyId`；`shareRevoked` 後 payload 不可再用；Agent 工具表不含 `commit_cbam_draft`。

---

## 1. 共用型別

| 型別 | 說明 |
|------|------|
| `ISO8601` | 字串時間 |
| `DecisionCode` | `ALLOW` \| `DENY_REVOKED` \| `DENY_EXPIRED` \| `DENY_POLICY` \| `DENY_CONSTRAINT` \| `PENDING_HUMAN` |
| `MandateStatus` | `ACTIVE` \| `REVOKED` \| `EXPIRED` |
| `ApprovalStatus` | `PENDING` \| `APPROVED` \| `REJECTED` \| `CANCELLED` |
| `ActorType` | `HUMAN` \| `AGENT` \| `SYSTEM` |
| `StagingStatus` | `STAGED` \| `REJECTED` \| `REVOKED_UNUSABLE` |
| `DraftStatus` | `DRAFT` \| `CANCELLED` |

---

## 2. Principal

```json
{
  "$id": "mandate.Principal",
  "type": "object",
  "required": ["principalId", "principalType", "orgId", "roles", "authSource"],
  "properties": {
    "principalId": { "type": "string" },
    "principalType": { "enum": ["USER", "ORG", "SERVICE"] },
    "orgId": { "type": "string" },
    "displayName": { "type": "string" },
    "roles": {
      "type": "array",
      "items": { "type": "string" },
      "description": "buyer | compliance | approver | admin"
    },
    "authSource": { "type": "string", "description": "fixture | idp" }
  }
}
```

### V1 Fixture — Principal

```json
{
  "principalId": "user_buyer_01",
  "principalType": "USER",
  "orgId": "org_acme",
  "displayName": "Buyer One",
  "roles": ["buyer", "compliance"],
  "authSource": "fixture"
}
```

Approver：

```json
{
  "principalId": "user_approver_01",
  "principalType": "USER",
  "orgId": "org_acme",
  "displayName": "Approver One",
  "roles": ["approver", "admin"],
  "authSource": "fixture"
}
```

---

## 3. Mandate

```json
{
  "$id": "mandate.Mandate",
  "type": "object",
  "required": [
    "mandateId",
    "orgId",
    "principalId",
    "agentId",
    "status",
    "issuedAt",
    "expiresAt",
    "allowedTools",
    "deniedTools",
    "deniedSuppliers",
    "constraints"
  ],
  "properties": {
    "mandateId": { "type": "string" },
    "orgId": { "type": "string" },
    "principalId": { "type": "string" },
    "agentId": { "type": "string", "const": "agent_mandate_v1" },
    "status": { "enum": ["ACTIVE", "REVOKED", "EXPIRED"] },
    "issuedAt": { "type": "string", "format": "date-time" },
    "expiresAt": { "type": "string", "format": "date-time" },
    "revokedAt": { "type": ["string", "null"] },
    "revokeReason": { "type": ["string", "null"] },
    "allowedTools": {
      "type": "array",
      "items": { "type": "string" },
      "description": "不得包含 commit_cbam_draft"
    },
    "deniedTools": { "type": "array", "items": { "type": "string" } },
    "deniedSuppliers": { "type": "array", "items": { "type": "string" } },
    "constraints": {
      "type": "object",
      "required": ["requirePcfQualityFields"],
      "properties": {
        "requirePcfQualityFields": { "type": "boolean", "const": true },
        "allowedBoundaries": {
          "type": "array",
          "items": { "type": "string" },
          "description": "選配：允許的系統邊界"
        }
      }
    },
    "version": { "type": "integer", "minimum": 1 }
  }
}
```

### 不變式

1. `allowedTools` ∩ {`commit_cbam_draft`} = ∅  
2. `status=REVOKED` 後不可再變 `ACTIVE`（須新 `mandateId`）  
3. `deniedTools` 優先於 `allowedTools`  
4. `orgId` 必須與 Principal.orgId 一致  

### V1 Fixture — Mandate

```json
{
  "mandateId": "mandate_acme_carbon_01_v1",
  "orgId": "org_acme",
  "principalId": "user_buyer_01",
  "agentId": "agent_mandate_v1",
  "status": "ACTIVE",
  "issuedAt": "2026-07-20T00:00:00+08:00",
  "expiresAt": "2026-12-31T23:59:59+08:00",
  "revokedAt": null,
  "revokeReason": null,
  "allowedTools": [
    "request_emissions",
    "fetch_supplier_response",
    "ingest_pcf_payload",
    "submit_cbam_draft"
  ],
  "deniedTools": ["export_sensitive"],
  "deniedSuppliers": ["supplier_blocked_99"],
  "constraints": {
    "requirePcfQualityFields": true,
    "allowedBoundaries": ["cradle-to-gate", "cradle-to-grave"]
  },
  "version": 1
}
```

---

## 4. PcfPayload（品質最低欄位）

供應商回傳／Agent 入庫的嵌入排放載體。**缺任一最低欄位 → POL-CARB-001 拒收。**

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `method` | string | Y | 核算方法 |
| `boundary` | string | Y | 系統邊界 |
| `period` | object | Y | `{ "start": ISO8601, "end": ISO8601 }` |
| `unit` | string | Y | 功能單位（如 `t product`） |
| `tCO2e` | number | Y | 嵌入排放（有限數字） |
| `supplierId` | string | Y | 供應商 ID |
| `productId` | string | N | 產品／CN 碼等 |
| `cnCode` | string | N | Level 2：CN 碼或產業模板 |
| `emissionPerUnit` | number | N | Level 2：單位產品排放 |
| `verificationStatus` | enum | N | `verified` \| `unverified` \| `in_progress` |
| `verificationReportId` | string | N | 查驗報告 ID；`verified` 時必填 |
| `qualityTier` | enum | N | `COMPLETE` \| `PARTIAL`（系統寫入） |
| `warnings` | string[] | N | Level 2 缺欄警告（系統寫入） |
| `shareId` | string | N | 資料分享識別；撤銷時標記 |
| `shareRevoked` | boolean | Y | 預設 `false`；撤銷後 `true` |
| `receivedAt` | ISO8601 | N | 收到時間 |

```json
{
  "$id": "mandate.PcfPayload",
  "type": "object",
  "required": [
    "method",
    "boundary",
    "period",
    "unit",
    "tCO2e",
    "supplierId",
    "shareRevoked"
  ],
  "properties": {
    "method": { "type": "string", "minLength": 1 },
    "boundary": { "type": "string", "minLength": 1 },
    "period": {
      "type": "object",
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "format": "date-time" },
        "end": { "type": "string", "format": "date-time" }
      }
    },
    "unit": { "type": "string", "minLength": 1 },
    "tCO2e": { "type": "number" },
    "supplierId": { "type": "string", "minLength": 1 },
    "productId": { "type": "string" },
    "shareId": { "type": "string" },
    "shareRevoked": { "type": "boolean" },
    "receivedAt": { "type": "string", "format": "date-time" }
  }
}
```

### Fixture — 合格

```json
{
  "method": "ISO-14067",
  "boundary": "cradle-to-gate",
  "period": {
    "start": "2025-01-01T00:00:00+08:00",
    "end": "2025-12-31T23:59:59+08:00"
  },
  "unit": "t steel",
  "tCO2e": 1.82,
  "supplierId": "supplier_steel_01",
  "productId": "CN_7208",
  "shareId": "share_steel_01_2025",
  "shareRevoked": false
}
```

### Fixture — 漂亮噸數（缺欄，應拒）

```json
{
  "tCO2e": 9999.9,
  "supplierId": "supplier_pretty_tons",
  "shareRevoked": false
}
```

（缺 `method`／`boundary`／`period`／`unit` → `POL-CARB-001`。）

---

## 5. StagingRecord

品質閘通過後的暫存；**未**等於已寫入 CBAM 草稿。

```json
{
  "$id": "mandate.StagingRecord",
  "type": "object",
  "required": [
    "stagingId",
    "mandateId",
    "payload",
    "status",
    "createdAt",
    "createdBy"
  ],
  "properties": {
    "stagingId": { "type": "string" },
    "mandateId": { "type": "string" },
    "payload": { "$ref": "mandate.PcfPayload" },
    "status": { "enum": ["STAGED", "REJECTED", "REVOKED_UNUSABLE"] },
    "createdAt": { "type": "string", "format": "date-time" },
    "createdBy": { "type": "string" },
    "rejectReason": { "type": ["string", "null"] },
    "policyId": { "type": ["string", "null"] }
  }
}
```

不變式：`payload.shareRevoked == true` ⇒ `status` 必須為 `REVOKED_UNUSABLE`（或同等不可用）。

---

## 6. CbamDraft

人類核准並 `commit_cbam_draft` 後寫入；**非**官方 registry 物件。

```json
{
  "$id": "mandate.CbamDraft",
  "type": "object",
  "required": [
    "draftId",
    "mandateId",
    "stagingId",
    "status",
    "committedAt",
    "committedBy",
    "approvalId",
    "snapshot"
  ],
  "properties": {
    "draftId": { "type": "string" },
    "mandateId": { "type": "string" },
    "stagingId": { "type": "string" },
    "status": { "enum": ["DRAFT", "CANCELLED"] },
    "committedAt": { "type": "string", "format": "date-time" },
    "committedBy": { "type": "string", "description": "Human actorId" },
    "approvalId": { "type": "string" },
    "snapshot": { "$ref": "mandate.PcfPayload" },
    "registryHint": {
      "type": "string",
      "description": "V1 固定 mock_cbam_draft_store"
    }
  }
}
```

---

## 7. Approval

```json
{
  "$id": "mandate.Approval",
  "type": "object",
  "required": [
    "approvalId",
    "mandateId",
    "type",
    "status",
    "requestedBy",
    "createdAt",
    "payload"
  ],
  "properties": {
    "approvalId": { "type": "string" },
    "mandateId": { "type": "string" },
    "type": { "enum": ["CBAM_DRAFT", "EXPORT", "DATA_SHARE_REVOKE"] },
    "status": { "enum": ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] },
    "requestedBy": { "type": "string" },
    "approverId": { "type": ["string", "null"] },
    "createdAt": { "type": "string", "format": "date-time" },
    "decidedAt": { "type": ["string", "null"] },
    "consumedAt": {
      "type": ["string", "null"],
      "description": "commit_cbam_draft 成功後寫入"
    },
    "policyId": { "type": "string", "description": "如 POL-HITL-010" },
    "payload": {
      "type": "object",
      "properties": {
        "toolName": { "type": "string" },
        "stagingId": { "type": "string" },
        "shareId": { "type": "string" },
        "supplierId": { "type": "string" }
      }
    }
  }
}
```

### Fixture — PENDING CBAM 草稿

```json
{
  "approvalId": "appr_cbam_0001",
  "mandateId": "mandate_acme_carbon_01_v1",
  "type": "CBAM_DRAFT",
  "status": "PENDING",
  "requestedBy": "agent_mandate_v1",
  "approverId": null,
  "createdAt": "2026-07-20T10:00:00+08:00",
  "decidedAt": null,
  "consumedAt": null,
  "policyId": "POL-HITL-010",
  "payload": {
    "toolName": "submit_cbam_draft",
    "stagingId": "stg_0001",
    "shareId": "share_steel_01_2025",
    "supplierId": "supplier_steel_01"
  }
}
```

---

## 8. AuditEvent

```json
{
  "$id": "mandate.AuditEvent",
  "type": "object",
  "required": [
    "auditEventId",
    "ts",
    "principalId",
    "actorId",
    "actorType",
    "toolName",
    "decision",
    "policyId"
  ],
  "properties": {
    "auditEventId": { "type": "string" },
    "ts": { "type": "string", "format": "date-time" },
    "orgId": { "type": "string" },
    "principalId": { "type": "string" },
    "actorId": { "type": "string" },
    "actorType": { "enum": ["HUMAN", "AGENT", "SYSTEM"] },
    "mandateId": { "type": ["string", "null"] },
    "toolName": { "type": "string" },
    "decision": {
      "enum": [
        "ALLOW",
        "DENY_REVOKED",
        "DENY_EXPIRED",
        "DENY_POLICY",
        "DENY_CONSTRAINT",
        "PENDING_HUMAN"
      ]
    },
    "policyId": { "type": "string" },
    "reason": { "type": "string" },
    "correlationId": { "type": "string" },
    "approvalId": { "type": ["string", "null"] },
    "stagingId": { "type": ["string", "null"] },
    "inputRedacted": { "type": "object" }
  }
}
```

---

## 9. EvaluateContext / Agent

```json
{
  "agentId": "agent_mandate_v1",
  "agentVersion": "1.0.0",
  "llmRole": "propose_only",
  "allowedTools": [
    "request_emissions",
    "ingest_pcf_payload",
    "submit_cbam_draft"
  ]
}
```

---

## 10. 識別子一覽（V1 Demo）

| 名稱 | Fixture 值 |
|------|------------|
| org | `org_acme` |
| buyer／compliance | `user_buyer_01` |
| approver | `user_approver_01` |
| agent | `agent_mandate_v1` |
| mandate | `mandate_acme_carbon_01_v1` |
| good supplier | `supplier_steel_01` |
| pretty-tons supplier | `supplier_pretty_tons` |
| good share | `share_steel_01_2025` |

---

## 11. 儲存與關聯（V1）

| 實體 | V1 儲存 | 備註 |
|------|---------|------|
| Mandate / Approval / Audit | 本地 JSON store | 可竄改；見缺口文件 |
| PcfPayload / Staging / CbamDraft | 同 store | 非真 CBAM registry |
| Principal | fixture | 非真 IdP |

```text
Principal 1---* Mandate
Mandate 1---* StagingRecord
StagingRecord 1---0..1 CbamDraft（經 Approval）
Mandate 1---* Approval
Mandate 1---* AuditEvent
PcfPayload.shareRevoked → Staging 不可用 → 擋 submit/commit
```

---

## 12. PACT V3 對齊（PCF 格式）

`server/pactMapping.js` 把 `PcfPayload`（見第 4 節欄位定義）轉成 [PACT Technical Specifications V3](https://github.com/wbcsd/data-exchange-protocol)（WBCSD Pathfinder Framework）的 `ProductFootprint` 物件，供 `GET /api/pcf/:supplierId/pact` 讀取、「詳細控制」面板「查看 PACT V3 格式預覽」按鈕開新分頁展示。**純附加、唯讀**：不改動 `pcfCheck.js` 的必填欄位（`tCO2e`／`unit`／`method`／`boundary`／`period`／`supplierId`）或任何政策判斷邏輯。

### 欄位對照

| Mandate 欄位 | PACT V3 欄位 | 備註 |
|------|------|------|
| `supplierId` + supplier `orgName` | `companyName`／`companyIds` | 有 `vlei.lei`（見第 13 節）的供應商用真實形狀的 `urn:lei:<20碼>`；沒有的仍用 `urn:mandate:supplier:<id>` 佔位，誠實標示非真實可解析的公司識別碼 |
| `product` | `productDescription`／`productNameCompany` | — |
| `cnCode` | `productClassifications` | 用 `urn:pact:productclassification:cncode:<碼>`，非 PACT 官方列舉的分類法 |
| `period`（`YYYY-MM-DD/YYYY-MM-DD`） | `pcf.referencePeriodStart`／`referencePeriodEnd` | 直接切開轉 ISO 8601 |
| `tCO2e` | `pcf.pcfExcludingBiogenicUptake`／`pcfIncludingBiogenicUptake`／`fossilGhgEmissions` | 同一數字填三個欄位，見下方缺口 |
| `method`（如 `"ISO14067"`） | `pcf.crossSectoralStandards` | 剛好跟 PACT 列舉值字串相同，直接對應 |
| `boundary`、`verificationStatus`、`verificationReportId` | `comment`（自由文字） | PACT 沒有對應的結構化欄位，放進官方允許的 `comment` 欄位並標明來源 |
| `qualityTier`、`emissionPerUnit` | `mandateExtension`（非官方 `DataModelExtension` 包裝） | Mandate 內部品質閘資料，明確標示非 PACT 標準格式 |

### 已知缺口（`pactGaps`，隨每次回應一起吐出，不藏起來）

PACT V3 的 `CarbonFootprint` 有 11 個必填欄位；Mandate 目前的資料模型能誠實對應到其中約一半，以下是做不到、直接承認的部分：

| PACT 必填欄位 | 缺口原因 |
|------|------|
| `declaredUnitOfMeasurement`／`declaredUnitAmount`／`productMassPerDeclaredUnit` | Mandate 只記「這批貨總共排多少 tCO2e」，沒有另外要求供應商回報「每宣告單位的產品數量」——PACT 要求兩者分開申報 |
| `pcfExcludingBiogenicUptake` vs. `pcfIncludingBiogenicUptake` | Mandate 的 `tCO2e` 是單一總數，沒有拆分生質碳吸收前後差異 |
| `fossilCarbonContent` | PACT 要求申報化石碳含量（質量），Mandate 不收集 |
| `ipccCharacterizationFactors` | PACT 要求標明採用的 IPCC 評估報告版本，Mandate 不記錄 |
| `exemptedEmissionsPercent` | PACT 要求申報排除在 PCF 外的排放百分比，Mandate 不要求供應商揭露 |

**刻意選擇誠實列缺口，而不是編造看起來合理的數字填滿這些欄位**——這跟 Mandate 產品本身「拒收看起來完整但實際不合格的數據」的立場一致；用假數字填 PACT 格式會是同一種問題的另一種形式。

---

## 13. Supplier vLEI 身分（自建 mock）

`server/fixtures/suppliers.json` 每個供應商可選填 `vlei` 物件，仿造 ISO 17442-3 vLEI 信任鏈（GLEIF → QVI → 法人憑證 → 角色憑證）。沒有 `vlei` 欄位的供應商（如「無證零件行」）維持原本行為，不受影響。

```json
{
  "supplierId": "supplier_green_01",
  "vlei": {
    "lei": "5299000QINGH0PARTS56",
    "legalEntityCredential": {
      "credentialId": "vc_le_green01",
      "issuer": "qvi_mock_tabei",
      "status": "ACTIVE",
      "issuedAt": "2025-01-01T00:00:00+08:00",
      "expiresAt": "2027-01-01T00:00:00+08:00"
    },
    "roleCredentials": [
      {
        "credentialId": "vc_ecr_green01_carbon",
        "type": "ECR",
        "role": "碳排放申報專員",
        "issuerCredentialId": "vc_le_green01",
        "status": "ACTIVE",
        "issuedAt": "2025-01-01T00:00:00+08:00",
        "expiresAt": "2027-01-01T00:00:00+08:00"
      }
    ]
  }
}
```

- `lei`：20 碼、含正確 ISO 17442-1 MOD 97-10 檢核碼（非隨機字串）。
- `roleCredentials[].issuerCredentialId` 必須等於 `legalEntityCredential.credentialId`（I2I：Issuer-to-Issuee 指標檢查，`server/vleiCheck.js` 會驗）。
- 撤銷 `legalEntityCredential` 會連鎖撤銷該供應商自己底下所有 `roleCredentials`（範圍僅限這家供應商的憑證階層，不影響其他供應商）——見 `docs/trust/POLICY_SPEC.md` 的 `POL-CRED-001`。
- **誠實揭露**：這是自建 mock，仿真 0815 工作坊講者展示的 vLEI 信任鏈行為（見 `記憶.md` 2026-08-17 條目），不接真實 GLEIF／QVI，不能對外宣稱「已串接真實 vLEI 發證機構」。

**回頭修正第 12 節的 `companyIds` 誠實揭露**：有 `vlei.lei` 的供應商，`GET /api/pcf/:supplierId/pact` 現在用真實形狀的 `urn:lei:<20碼>` 取代原本的純佔位字串；沒有 `vlei` 的供應商仍誠實標示 `urn:mandate:supplier:<id>` 佔位字串，不假裝有 LEI。

---

## 14. 案件交接摘要（`GET /api/cases`）

`server/caseSummary.js` 對每個供應商彙整既有的 `session.supplierPipeline`（第 11 節既有欄位）與該供應商的 `AuditEvent.reasoningSummary` 時間軸，組成一份「接手審核前先看這頁」的摘要。**唯讀彙整，不是新實體**：不寫 audit、不呼叫 `policy.evaluate()`、不新增任何 `policyId`，資料來源與 `GET /api/session`／`GET /api/audit` 完全相同，只是換一種排列方式。

```json
{
  "supplierId": "supplier_green_01",
  "orgName": "青禾零件股份有限公司",
  "status": "PENDING_REVIEW",
  "timeline": [
    { "ts": "...", "actorType": "AGENT", "toolName": "ingest_pcf_payload", "decision": "ALLOW", "policyId": "POL-ALLOW-000", "reasoningSummary": "品質欄位齊全，已進入暫存區..." }
  ]
}
```

`status` 是純推導欄位（`NEEDS_ATTENTION`／`PENDING_REVIEW`／`REVOKED`／`CLEAR`／`UNTOUCHED`），依既有的 `shareRevoked`／`pendingApproval`／`ingestRejected`／`staged` 訊號決定，不引入新判斷邏輯。

---

## 15. 版本

| 版本 | 日期 | 說明 |
|------|------|------|
| V1 | 2026-07-20 | PcfPayload／Staging／CbamDraft／shareRevoked |
| V1.1 | 2026-07-27 | 新增 PACT V3 格式對齊（`pactMapping.js`），詳見第 12 節 |
| V1.2 | 2026-08-17 | 新增 Supplier vLEI 身分（第 13 節）與案件交接摘要唯讀彙整（第 14 節），使用者個人 fork 上的準備期強化，尚未併回 `1qaz0726-star/mandate:main` |
