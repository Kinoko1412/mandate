# services/identity

Day 5 背景待辦 1：把 vLEI 身份驗證邏輯接進新的 canonical `IdentityContext` schema。

## 這是全新實作，不是復原

舊 fork（`_reference/vlei-old-fork/`，青禾零件情境）有一套完整的 vLEI 撤銷連鎖判斷邏輯，
但資料模型（記憶體 session store）跟現在的 canonical schema 完全不同，**沒有整份複製**。
這裡只參考舊邏輯的判斷精神（法人憑證＋角色憑證、I2I 指標檢查、撤銷連鎖），用跟
`services/factor-registry`／`services/policy-gate` 已經確立的同一套模式重新實作：

- `checks`/`reasonCodes` 陣列 + `makeCheck(name,status,detail)`
- 寫死的 Demo registry（不是真資料庫），`demoOnly: true` 標記
- **兩層防偽精神跟 factor-registry 一致**：呼叫端宣稱的 `IdentityContext.revocationStatus`／
  `credentialRefs` 只當「宣稱值」拿來比對，真正的憑證狀態一律從 registry 重新查。測試裡
  故意讓呼叫端宣稱 `revocationStatus: 'ACTIVE'`，但 registry 記錄實際上已撤銷，驗證仍然正確
  判定 `BLOCKED`——不會因為呼叫端自己說沒事就相信。

## API

```js
const { verifyIdentityContext, GATE_DECISION } = require('services/identity');

const result = verifyIdentityContext(identityContext, { now: new Date() });
// { decision: 'GATE_OK' | 'BLOCKED', reasonCodes: string[], checks: object[], evaluatedAt, inputHash }
```

沿用 Day 3 已確立的 GateResult 慣例（`decision`／`reasonCodes`／`checks`／`evaluatedAt`／
`inputHash`），跟 `services/policy-gate`、`services/proof` 的呼叫端習慣一致，方便之後要接進
既有 Gate 判斷鏈時介面不用另外轉換。

## 檢查順序

1. `IdentityContext` 形狀（`actorId` 必填）
2. actorId 是否在 Registry 內（`AUTHORIZATION_INVALID`）
3. `orgId` 是否跟 Registry 記錄一致（防冒用他人身份綁自己組織）
4. 法人憑證：撤銷（`AUTHORIZATION_REVOKED`）／過期（`IDENTITY_CREDENTIAL_EXPIRED`）
5. 角色憑證：I2I 指標檢查（`issuerCredentialId` 必須指向法人憑證本身）、撤銷、過期
6. `credentialRefs`（如果呼叫端有帶）逐項比對 Registry 的真實憑證 ID，抓偽造

## 已知限制

- Registry 是寫死的 Demo 清單，只收錄測試需要的三種情境（正常／已撤銷／已過期），不是真的
  QVI／GLEIF 發證流程或外部驗證服務。
- 目前**還沒接進** `services/policy-gate` 的判斷鏈——這個模組獨立可用、獨立測試過，要不要
  讓身份驗證結果影響 Gate 判斷（例如身份不合格時案件狀態要不要連動）是需要 A/B 一起決定的
  範圍問題，跟 `circuits/README.md` 裡 ZK 電路的「架構決策」一節是同一種性質的待辦。
- 沒有實作憑證的**發行**流程（怎麼從 GLEIF/QVI 拿到一張新憑證），只做**驗證**已存在憑證鏈
  的有效性——這跟舊 fork 的範圍一致，不是這次新增的限制。

## 測試

`tests/identity/smoke.js`（`npm run smoke:identity`），8 項：正常鏈、未知 actor、撤銷連鎖
（含「呼叫端謊稱沒事」的防偽測試）、過期、偽造 credentialRefs、orgId 冒用、格式錯誤、
決定性（inputHash 可重現）。
