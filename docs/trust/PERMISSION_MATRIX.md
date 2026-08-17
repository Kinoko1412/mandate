# Mandate — Permission Matrix

**文件狀態**：V1 規格（程式契約）  
**原則**：deny 清單優先於 allow；Agent 工具表不含 `commit_cbam_draft`；`submit_cbam_draft` 對 Agent 永遠走 HITL。

---

## 1. 身份欄位定義

### 1.1 Principal（授權主體／被代表的一方）

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `principalId` | string | Y | 穩定 ID，如 `user_buyer_01` |
| `principalType` | enum | Y | `USER` \| `ORG` \| `SERVICE` |
| `orgId` | string | Y | 所屬組織，如 `org_acme` |
| `displayName` | string | N | 顯示名 |
| `roles` | string[] | Y | 如 `buyer`、`compliance`、`approver`、`admin` |
| `authSource` | string | Y | V1：`fixture`；上線：`idp` |

**語意**：Mandate 代表此 Principal（或其 org）行事；稽核「代表誰」以此為準。

### 1.2 Actor（實際發起 evaluate／動作的一方）

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `actorId` | string | Y | 如 `agent_mandate_v1`、`user_buyer_01` |
| `actorType` | enum | Y | `HUMAN` \| `AGENT` \| `SYSTEM` |
| `onBehalfOf` | string | Y | 必須等於或隸屬 Mandate 的 `principalId`／`orgId` |
| `sessionId` | string | N | 人類會話或 agent run id |

### 1.3 Agent（執行平面）

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `agentId` | string | Y | V1 固定 `agent_mandate_v1` |
| `agentVersion` | string | Y | 如 `1.0.0` |
| `allowedTools` | string[] | Y | **靜態白名單**；不得含 `commit_cbam_draft` |
| `llmRole` | string | Y | `propose_only`（硬編碼） |
| `mandateId` | string | Y | 目前綁定的 Mandate |

**V1 `allowedTools`（Agent）**

```text
request_emissions
fetch_supplier_response
ingest_pcf_payload
submit_cbam_draft
```

**永不在 Agent `allowedTools`**

```text
commit_cbam_draft
```

Human 側另有：`revoke_data_share`、（可選）Mandate `revoke`／狀態管理。

---

## 2. 風險級定義

| 級別 | 名稱 | 定義 | 預設閘門 |
|------|------|------|----------|
| L1 | Request / Read | 索取排放資料、讀取 staging 狀態 | 可 ALLOW（受 deny／分享狀態約束） |
| L2 | Ingest / Stage | 品質閘後寫入 Staging（草案庫），未對外申報 | 可 ALLOW（通過 POL-CARB-001） |
| L3 | External commit intent | 提議寫入 CBAM 草稿、撤銷分享、敏感匯出 | **PENDING_HUMAN** 或嚴格 DENY |
| L4 | Irreversible execution | 真正寫入 CBAM 草稿（commit） | **僅 Human／System 通道**；Agent 不可見 |

---

## 3. 完整工具權限表

圖例：

- **Agent**：`actorType=AGENT`
- **Human**：`actorType=HUMAN` 且角色足夠
- **V1**：黑客松 PoC 是否實作該 tool adapter

| toolName | 風險 | Agent | Human | 輸入邊界（摘要） | 主要 policy | V1 |
|----------|------|-------|-------|------------------|-------------|-----|
| `request_emissions` | L1 | allow* | allow* | `supplierId` 必填；period 可選 | POL-GATE-002, POL-AUTH-* | Yes |
| `fetch_supplier_response` | L1 | allow* | allow* | `supplierId` 必填；須先有 request | POL-REQ-001, POL-REV-010, POL-CRED-001 | Yes |
| `ingest_pcf_payload` | L2 | allow* | allow* | 完整 `PcfPayload`；品質最低欄位 | POL-CARB-001, POL-CARB-002, POL-REV-010, POL-CRED-001 | Yes |
| `export_client_draft` | L2 | deny | allow* | `supplierId`；須有 staging | POL-EXP-001 | Yes |
| `export_audit` | L2 | deny | allow* | 可選 `format` | POL-EXP-001 | Yes |
| `submit_cbam_draft` | L3 | **PENDING_HUMAN** | PENDING_HUMAN | `stagingId`／payload 未撤銷；**一律 HITL** | POL-HITL-010, POL-REV-010 | Yes |
| `commit_cbam_draft` | L4 | **deny（工具未暴露）** | allow（需有效 Approval） | `approvalId` 必填且未消耗 | POL-HITL-010, POL-GATE-000 | Human-only stub |
| `revoke_data_share` | L3 | deny（預設） | allow（owner／admin／compliance） | `shareId` 或 `stagingId`；`reason` 必填 | POL-REV-010 | Yes |
| `revoke_supplier_credential` | L3 | deny（預設） | allow（owner／admin／compliance） | `supplierId` 必填；撤銷該供應商法人憑證，連鎖撤銷其下角色憑證 | POL-CRED-001 | Yes（個人 fork 準備期強化，2026-08-17） |
| `export_sensitive` | L3 | deny | PENDING_HUMAN | `scope` ∈ {audit, staging} | POL-GATE-003 | Optional |

\* `allow*` = 仍須通過 PolicyEngine；不是無條件放行。

---

## 4. 各工具詳細契約

### 4.1 `request_emissions`

| 項目 | 內容 |
|------|------|
| 目的 | 向供應商索取嵌入排放／PCF（V1：回 fixture 或觸發後續 ingest） |
| Agent | 可提議並在 ALLOW 後執行 |
| deny 條件 | 供應商在 deny list；Mandate 非 ACTIVE；分享已全局撤銷（若適用） |
| 輸入邊界 | `supplierId: string`；`period?: { start, end }`；禁止任意 URL fetch（V1 僅 fixture） |
| 輸出 | `{ requestId, status, supplierId }` |
| 副作用 | 寫 audit；可標記「待回傳」 |

### 4.2 `ingest_pcf_payload`

| 項目 | 內容 |
|------|------|
| 目的 | 將供應商 PCF 經品質閘寫入 Staging |
| Agent | 可執行（ALLOW 後） |
| deny 條件 | 缺品質最低欄位（`POL-CARB-001`）；`shareRevoked`（`POL-REV-010`）；Mandate 非 ACTIVE |
| 輸入邊界 | 見 DATA_MODEL `PcfPayload`：method、boundary、period、unit、tCO2e、supplierId **皆必填** |
| 輸出 | `{ stagingId, status: "STAGED" \| "REJECTED" }` |
| 副作用 | 僅 STAGED 可供後續 submit |

### 4.3 `submit_cbam_draft`

| 項目 | 內容 |
|------|------|
| 目的 | 提議將 Staging 數據寫入 CBAM 申報草稿 |
| Agent | **永遠 PENDING_HUMAN**（`POL-HITL-010`） |
| Human | 同樣建立 Approval；不可被 Agent 繞過 |
| 輸入邊界 | `stagingId` 存在且 STAGED；對應 payload **未** `shareRevoked` |
| 輸出 | `{ approvalId, status: "PENDING" }` |
| 副作用 | 建立 `Approval`；**不**寫入 CbamDraft |

### 4.4 `commit_cbam_draft`

| 項目 | 內容 |
|------|------|
| 目的 | 真正寫入 CBAM 草稿（V1 stub store，非官方 registry） |
| Agent | **永不暴露**；Runtime 若收到此 toolName → 硬 DENY + audit |
| Human | 僅在 `Approval.status=APPROVED` 且未消耗時可呼叫 |
| 輸入邊界 | `approvalId`；`idempotencyKey`；staging 仍未撤銷 |
| 輸出 | `{ draftId, status: "DRAFT" }` |
| 副作用 | 寫入 `CbamDraft`；消耗 Approval（`consumedAt`） |

### 4.5 `revoke_data_share`

| 項目 | 內容 |
|------|------|
| 目的 | 撤銷某次／某批資料分享；立即不可再用 |
| Agent | V1 預設 **deny** |
| Human | owner／admin／compliance allow |
| 輸入邊界 | `shareId` 或 `stagingId`；`reason` minLength 3 |
| 輸出 | `{ shareId, shareRevoked: true }` |
| 副作用 | 標記 payload／staging；作廢相關 PENDING Approval（`POL-REV-010`） |

### 4.6 `export_sensitive`（選配）

| 項目 | 內容 |
|------|------|
| 目的 | 匯出 audit／staging 供合規 |
| Agent | deny |
| Human | PENDING_HUMAN |
| V1 | Optional（Demo 可用「查看 audit UI」代替） |

---

## 5. Actor × Tool 決策速查

| toolName | AGENT | HUMAN buyer/compliance | HUMAN approver/admin |
|----------|-------|------------------------|----------------------|
| request_emissions | evaluate → allow/deny | same | same |
| ingest_pcf_payload | evaluate → allow/deny | same | same |
| submit_cbam_draft | **PENDING_HUMAN** | PENDING_HUMAN | 可 approve 既有請求 |
| commit_cbam_draft | **硬拒絕／未註冊** | 需 APPROVED approval | 可執行 |
| revoke_data_share | DENY_POLICY | 若角色足夠：ALLOW | ALLOW |
| export_sensitive | DENY_POLICY | PENDING/DENY | PENDING/ALLOW |

---

## 6. 與 PolicyEngine 的銜接

1. Runtime 先查「工具是否在該 Actor 的靜態表」。不在表 → 仍建議寫 audit（`POL-GATE-000`）。  
2. 在表內 → **必須** `PolicyEngine.evaluate`。  
3. 矩陣中的 allow 僅表示「有資格進入評估」，不是最終放行。

---

## 7. V1 Fixture 對照（摘要）

詳見 [DATA_MODEL.md](./DATA_MODEL.md)。

| 識別子 | 值 |
|--------|-----|
| org | `org_acme` |
| principal | `user_buyer_01` |
| agent | `agent_mandate_v1` |
| good supplier | `supplier_steel_01` |
| pretty-but-bad payload | 有 tCO2e、缺 method／boundary 等 |

---

## 8. 版本

| 版本 | 日期 | 說明 |
|------|------|------|
| V1 | 2026-07-20 | 碳數據工具表；commit 對 Agent 隱藏 |
