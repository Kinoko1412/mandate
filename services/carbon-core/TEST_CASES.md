# carbon-core 測試案例對照表

對照《可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊》p.16「測試與 Definition of Done」Contract／Carbon 兩層，以及 p.19 COPY PROMPT 1 的完成定義。跑 `npm run smoke:carbon-core` 逐項驗證（目前 21 項全過）。

## Contract 層

| 驗收項目 | 對應測試 | 通過標準 | 狀態 |
|---|---|---|---|
| normal 通過 | 全部 4 個 fixture 端到端測試 | ✅ |
| 缺欄、錯型別 | `validateInstallationYear` 拋 `CarbonCoreError` | ✅ |
| 負數 | 負數強度／負數出貨量測試 | ✅ |
| 未知 enum | `verificationStatus` 只接受 `draft`/`confirmed`（enums.js 限制） | ✅（隱含於型別檢查） |

## Carbon 層

| 驗收項目 | 對應測試 | 通過標準 | 狀態 |
|---|---|---|---|
| 固定答案 | normal fixture SHIP-A/SHIP-B | 100×1.80=180、60×1.80=108 | ✅ |
| 零產量 | `validateInstallationYear` 零產量測試 | 拋出 `ZERO_OR_NEGATIVE_QUANTITY` | ✅ |
| 單位 | 未知單位測試（installationYear + shipment 兩處） | 拋出/回傳 `UNKNOWN_UNIT` | ✅ |
| scale | `fixedPoint` 定點數測試 | `SCALE=10^6`，`mulScaled` 正確 | ✅ |
| 捨入 | `toScaled`/`fromScaled` 往返測試 | 不失真 | ✅ |
| 超額分配 | `tampered_quantity` fixture + `reconcileAllocationLedger` 重複 shipmentId 測試 | `ALLOCATION_EXCEEDS_PRODUCTION`／`DUPLICATE_SHIPMENT_ID` | ✅ |

## 必備異常 Fixture 對照表（規格 p.8，Phase 1 範圍內的 4 個）

| 檔名 | 規格定義 | Phase 1 實際測試內容 | 預期 |
|---|---|---|---|
| `normal.json` | 固定 Demo 情境 | 完全依規格 p.8 固定值 | `GATE_OK` |
| `missing_period.json` | 電費只涵蓋 1–6 月 | 逐字照規格 | `NEEDS_EVIDENCE`／`EVIDENCE_PERIOD_INCOMPLETE` |
| `wrong_factor.json` | factorSetId 不在允許清單 | 逐字照規格 | `BLOCKED`／`FACTOR_NOT_ALLOWED` |
| `tampered_quantity.json` | **規格原文是「Proof 為 100 噸但 payload 改 120」→ `PUBLIC_INPUT_MISMATCH`，屬於 ZKP（Phase 3）情境** | **本階段改測 `reconcileAllocationLedger` 的超額分配（150+60=210>200）**，見下方「⚠️ 規格詮釋落差」 | `GATE_OK`（SHIP-A 單獨）→ `BLOCKED`／`ALLOCATION_EXCEEDS_PRODUCTION`（SHIP-B 疊加後） |

## ⚠️ 規格詮釋落差——工作小結時務必讓隊友（黃昱羲）知道

**`tampered_quantity` 這個 fixture 名稱，Phase 1 目前的內容跟規格書 p.8 對它的完整定義不一樣。**

- 規格 p.19（COPY PROMPT 1）把 `tampered_quantity` 列進 **Phase 1**（現在，資料契約與碳排核心）要建立的 4 個 fixture 之一。
- 但規格 p.8「必備異常 Fixture」表對 `tampered_quantity` 的完整定義是：「Proof 為 100 噸但 payload 改 120」→ `BLOCKED`／`PUBLIC_INPUT_MISMATCH`——這需要 ZKP Proof 才有意義（要有一份「Proof 聲稱的值」跟「payload 實際送出的值」兩者對比）。
- Phase 1 明講「不要做 UI、Agent 或 ZKP」（p.19），現階段完全沒有 Proof 概念，沒辦法測 `PUBLIC_INPUT_MISMATCH`。
- **B（葉士愷）的判斷**：Phase 1 版本的 `tampered_quantity.json` 改測 `reconcileAllocationLedger` 明確列出的拒絕條件「超出年度產量」——同一個檔名先驗證「帳本層級的數量竄改被擋下」這個較弱但當下就能測的版本，8/26 接 ZKP（Phase 3）後，同一個檔名底下的情境要**擴充**成規格原文定義的完整 Proof/payload 不一致測試。
- 這個判斷是隊長（使用者本人）裁示「先照這個推測去做」，**但尚未實際跟隊友核對過**，是本次工作小結最需要明確提出來讓隊友知情的一項技術決策——避免對方看到 `tampered_quantity` 這個檔名時，誤以為 Phase 1 已經涵蓋了規格書原文定義的 ZKP 攻擊情境。

## `.env.example` 說明

carbon-core 是純計算函式，不呼叫外部 API，`buildCalculationReceipt` 的 Hash 用 Node 內建 `crypto`，不需要任何環境變數。

## 未涵蓋、留給後續階段的案例

- `replayed_proof`、`revoked_mandate`、`prompt_injection_doc`（規格 p.8）→ Phase 3／Phase 4
- `tampered_quantity` 的完整 ZKP 版本（`PUBLIC_INPUT_MISMATCH`）→ Phase 3
- CN code／50 噸門檻／授權申報人（Scope Router）→ 規格架構圖列在 p.5，尚未排入哪一天，待與隊友確認
