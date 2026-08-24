# Day 4 測試案例

對照 `tests/agent/smoke.js`、`tests/carbon-core/smoke.js`、`tests/workflow/smoke.js`、`tests/ui/static-contract.js`、`tests/trust/smoke.js` 與 [`DAY4_WORK_SUMMARY_20260827.md`](DAY4_WORK_SUMMARY_20260827.md)。

**環境**：Node.js 18+；在 `mandate/` 目錄執行。  
**合計**：**165** 項（agent **20** + carbon **36** + workflow **47** + UI **19** + trust **43**）。

---

## 1. 一鍵回歸

| 命令 | 項數 | 預期 |
|------|------|------|
| `npm run smoke:carbon-core` | **36** | `RESULT: all PASS` |
| `npm run smoke:evidence-agent` | **20** | `20 passed, 0 failed` |
| `npm run smoke:workflow` | workflow **47** + UI **19** = **66** | 兩段各 `RESULT: all PASS` |
| `npm run smoke:trust` | **43** | `RESULT: all PASS` |

**建議黑箱驗收順序**：

```bash
npm run smoke:carbon-core
npm run smoke:evidence-agent
npm run smoke:workflow
npm run smoke:trust
```

---

## 2. Evidence Agent（`tests/agent/smoke.js`，20 項）

| # | 標籤 | 預期 |
|---|------|------|
| 1 | normal: 抽取值含來源頁、信心與人工確認 | entries ≥6；每筆有 sourcePage/confidence/humanConfirmed |
| 2 | contract: RiskReport canonical validation 通過 | `validateCanonical('RiskReport')` 無 errors |
| 3 | deterministic: 相同 snapshot 產生完全相同報告與 reportId | 兩次 deepEqual |
| 4 | missing period: 電費半年只產生缺期風險與補件建議 | missingEvidence / findings 含缺期 |
| 5 | missing type: 缺 precursor_list 只產生缺件風險與建議 | 缺類型風險 |
| 6 | coverage: 多份文件外框涵蓋全年仍會找出中間缺口 | 缺口 finding |
| 7 | cross-table: 極端用電、燃料、precursor 比率只標 Demo 風險 | Demo heuristics reason codes |
| 8 | confidence: 低信心與未確認高影響值不進計算候選 | eligible=false |
| 9 | sandbox: prompt injection 只記安全 finding/citation 且不回顯全文 | 無 attacker 原文 |
| 10 | sandbox: field、unit、filename/source injection 命中整份 drop | 安全 drop |
| 11 | whitelist: 過長或非法欄位字串 drop 且不回顯 | drop + 無 echo |
| 12 | unit: 不允許單位產生 UNIT_AMBIGUOUS 且不得 eligible | UNIT_AMBIGUOUS |
| 13 | unknown numeric: 未知數值欄位預設 high-impact，未確認不得 eligible | 未確認 → 非 eligible |
| 14 | DoS caps: 每份/全案 entries 與 citations 有上限並標截斷 | 截斷標記 |
| 15 | period: Agent 對無效日期產生安全 finding | 無 throw |
| 16 | contract enums: PASS、CBAM Certified 與未知 reviewStatus 均被拒 | validation fail |
| 17 | citations: 去重且 summary 不再引用全部抽取 citation | 去重 |
| 18 | text: 固定分號格式可離線抽取，不需 OCR 或外部模型 | 離線抽取 |
| 19 | governance: 固定模型/提示版本、時間與人工審查狀態 | modelVersion/promptVersion |
| 20 | failure: adapter 錯誤形狀穩定且不包含證據內容 | stable error；無 content |

---

## 3. Carbon Core（`tests/carbon-core/smoke.js`，36 項）

與 Day 2 相同基準線；carbon-core 完整 36 項見 [`DAY2_TEST_CASES.md`](DAY2_TEST_CASES.md) **§5**。Day 4 **不得**回歸。

| 命令 | 預期 |
|------|------|
| `npm run smoke:carbon-core` | **36/36 PASS** |

---

## 4. Workflow API（`tests/workflow/smoke.js`，47 項）

含 Day 2 基礎（34）+ Day 4 Agent／攻擊／物理邊界（13）。

| # | 標籤 | 預期 |
|---|------|------|
| 1–34 | Day 2 基礎（reset、evidence、vault、revalidate mock 等） | 同 [`DAY2_TEST_CASES.md`](DAY2_TEST_CASES.md) §2 |
| 35 | agent auth: 僅 Supplier 可觸發案件分析 | Importer/Verifier → `403 ROLE_FORBIDDEN` |
| 36 | agent E2E: injection finding 不改 proof、gate 或 READY | READY 維持；services 不變 |
| 37 | agent mask: Supplier/Verifier 看完整報告，Importer 僅安全摘要 | Importer 無 entries 全文 |
| 38 | agent audit: 僅保存報告識別、版本、計數與 reason codes | audit 無 evidence 全文 |
| 39 | agent alias: `/api/agent/analyze` 接受 body.caseId 且仍限 Supplier | Supplier `200`；Importer `403` |
| 40 | store: setRiskReport 會再次執行 canonical validation | invalid → throw |
| 41 | evidence period: 上傳端拒絕無效 ISO date 與反向期間 | `422` 穩定 error |
| 42 | evidence DoS: 單案份數達上限後回穩定錯碼 | 上限 error |
| 43 | agent failure audit: 分析失敗記 ERROR 且不洩漏內容 | `EVIDENCE_JSON_INVALID`；audit ERROR |
| 44 | demo attack: 三個 allowlist 情境由 server Trust Engine 真實攔截 | 各 `BLOCKED`；store 不變 |
| 45 | demo attack: 僅 Supplier 可執行且不接受任意 scenario | `403` / `400 DEMO_SCENARIO_INVALID` |
| 46 | demo attack audit: 只記 scenario 與 reasonCodes | 無 proof/token/content |
| 47 | physical boundary: GET/POST 固定誠實回應且不改 Gate/status/services | `physicalRealityVerified: false` |

---

## 5. UI 靜態契約（`tests/ui/static-contract.js`，19 項）

| # | 標籤 | 預期 |
|---|------|------|
| 1 | root: 三角色與固定案件 hooks 存在 | Supplier/Importer/Verifier；CASE-2026-001 |
| 2 | root: 信任邊界與 unavailable 文案存在 | Demo role 免責；無 CBAM Certified |
| 3 | Day4: 四幕控制台、Agent/Trust 按鈕與誠實文案存在 | run-act-1/2/4；attack 三 scenario；commitment 免責 |
| 4 | root: favicon 內嵌 | 不請求 `/favicon.ico` |
| 5 | root: 無 CDN | 無外部 http(s) 資源 |
| 6 | Importer: 靜態區塊沒有敏感欄位 hooks | 無 contentBase64 hooks |
| 7 | RiskReport: Supplier/Verifier 完整 vs Importer 安全摘要 hooks 分離 | agentSummary vs riskReport |
| 8 | client: 安全 DOM API，不用 innerHTML | 無 innerHTML 注入 |
| 9 | client: API 帶角色 header；token 不進 URL | x-demo-role；x-vault-token header |
| 10 | client: Importer 呈現 server allocationStatus | 不 client 覆寫 |
| 11 | client: submit 後重新載入 server state | finally loadRole |
| 12 | client: reset 依角色隱藏 | Supplier only |
| 13 | client: Grant 終態清除 session token | clearVaultSession |
| 14 | styles: 狀態 badge／loading／focus／窄版 hooks | CSS hooks 存在 |
| 15 | client: quantityUnit fallback tonne | 非 undefined |
| 16 | legacy: 舊 UI 可載入 | legacy.html |
| 17 | assets: CSS/JS 存在 | case-workflow.* |
| 18 | static server: 阻擋 public 備份 | 不依賴 `_backups/`（`b4a8bef` 可攜） |
| 19 | client: JavaScript 語法 node --check | 通過 |

---

## 6. Trust Engine（`tests/trust/smoke.js`，43 項）

| # | 區塊 | 標籤（摘要） | 預期 |
|---|------|--------------|------|
| 1–6 | factor-registry | active／not allowed／unknown／tamper／revoked／expired | 穩定 reason codes |
| 7–10 | policy-registry | 權威／unknown／inactive／CN+年度／snapshot 比對 | `POLICY_NOT_APPLICABLE` 等 |
| 11–18 | proof + nonce | 合法／偽造／竄改 inputs／context mismatch／TTL／atomic consume／adapter hook | `PROOF_INVALID` 等 |
| 19–22 | policy-gate | 證據涵蓋／缺件／硬失敗優先／NEEDS_EVIDENCE | p.13 mapping |
| 23–37 | attack matrix | normal、inputHash、tampered 100→120、偽造、SHIP swap、換年度等 | `BLOCKED` + reason |
| 38–43 | E2E HTTP | revalidate READY、重複 revalidate、缺半年、補齊、Agent unavailable 不阻擋 | READY／NEEDS_EVIDENCE |

完整標籤見 `tests/trust/smoke.js` 輸出；Day 3 P1 修正已 commit `635baf7`。

---

## 7. 瀏覽器／Playwright（本機，非 CI）

| 項目 | 路徑 | 用途 |
|------|------|------|
| 四幕 GIF | [`screenshots/day4/day4-four-act-demo.gif`](screenshots/day4/day4-four-act-demo.gif) | 幕 1 normal + 幕 3 attack + 幕 4 boundary |
| 幕 1 | [`act1-ready.png`](screenshots/day4/act1-ready.png) | READY_FOR_VERIFIER |
| 幕 2 Importer | [`act2-importer-summary.png`](screenshots/day4/act2-importer-summary.png) | 安全摘要 |
| 幕 2 Verifier | [`act2-verifier-vault.png`](screenshots/day4/act2-verifier-vault.png) | 一次性 Vault |
| 幕 3 | [`act3-blocked.png`](screenshots/day4/act3-blocked.png) | BLOCKED |
| 幕 4 | [`act4-physical-boundary.png`](screenshots/day4/act4-physical-boundary.png) | 物理邊界 |
| 窄版 | [`verifier-mobile.png`](screenshots/day4/verifier-mobile.png) | 選用 |

腳本：`artifacts/playwright/record-day4-demo.js`（本機 gitignore，不提交）。

---

## 8. Deployed smoke（https://mandate.1qaz0726.workers.dev）

| # | 步驟 | 預期 |
|---|------|------|
| 1 | 開啟 Root UI `/` | 200；四幕控制台可見 |
| 2 | Supplier →「一鍵執行正常案件」 | `READY_FOR_VERIFIER`（冷啟動可先 reset） |
| 3 | 幕 3 任一攻擊按鈕 | `BLOCKED`；案件狀態不變 |
| 4 | 幕 4「展示物理真實邊界」 | `physicalRealityVerified: false` |
| 5 | 切 Importer 看摘要 | 無底稿全文；default 2.5 標 Demo estimate |

**限制**：僅 synthetic data；`x-demo-role` 無 auth；state **in-memory**（冷啟動可能重置）；nonce **跨 isolate 不保證**。

Cloudflare Version ID：`6178232c-8ebf-4d0a-ab0f-814af9719ee0`（見 [`DEPLOY_CLOUDFLARE.md`](../DEPLOY_CLOUDFLARE.md)）。

---

## 9. 刻意不測（誠實邊界）

- 真 zk-SNARK proving／verifying
- LLM／OCR Evidence Agent
- 跨 Worker isolate nonce 持久化
- 正式 CBAM Registry／海關通道
- Legacy `npm run smoke:agent`（需 OPENAI_API_KEY，Day 4 主線不用）
