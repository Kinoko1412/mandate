# Day 4 Session Log — Evidence Agent + Four-act Demo + Trust Hardening

> **分支**：`feature/agent-demo-integration`  
> **Runtime commits**（git 記錄 **2026-08-24～25**）：`b4a8bef` → `635baf7` → `9b2e6ab` → `b712df2`（`c1d4ec6` 為瀏覽器驗收集）  
> **Draft PR**：[#6](https://github.com/1qaz0726-star/mandate/pull/6) 為對 **`main` 的累積型 Draft PR**（已含 Day 1–4）；PR #3／#4／#5 亦 target `main`、內容已涵蓋、均未 merge  
> **部署**：[https://mandate.1qaz0726.workers.dev](https://mandate.1qaz0726.workers.dev) · Version ID `6178232c-8ebf-4d0a-ab0f-814af9719ee0`

---

## 1. 時間線

| 時間（git 記錄） | 事件 |
|------------------|------|
| 2026-08-24 22:43 | `b4a8bef` 修正 UI 靜態契約對 `_backups/` 的不可攜依賴 → UI **19/19** |
| 2026-08-24 23:06 | `635baf7` Trust Engine P1 hardening → `smoke:trust` **43** |
| 2026-08-24 23:33 | `9b2e6ab` Evidence Agent rule engine → `smoke:evidence-agent` **20** |
| 2026-08-24 23:47 | `b712df2` 四幕 Demo UI／API |
| 2026-08-25 00:00 | `c1d4ec6` Playwright 截圖／GIF → `docs/handoff/screenshots/day4/` |
| **2026-08-27（計畫交棒日）** | Day 4 交接包文件定稿（本 log、`DAY4_*`、README／CHANGELOG／DEPLOY） |

---

## 2. 設計決策（定案，勿再改方向）

| 決策 | 理由 |
|------|------|
| Evidence Agent = **確定性 rule engine**（`demo-rule-based-no-llm-v1`） | 規格 Day 4 要可離線 smoke；禁止 LLM 自判權限 |
| Agent **`execution=executed` 但 `verification=not_verified`** | 預審是衍生分析，不參與 READY |
| READY 仍只由 **Trust revalidate**（proof+gate verified）決定 | Day 3 契約保留；Agent unavailable 不阻擋 READY |
| Proof 維持 **`demoOnly:sha256:` commitment** | 規格 ZKP cut plan fallback；**不是** zk-SNARK |
| Demo attack 只接受 **三個固定 scenario 名稱** | 防 attacker-controlled envelope；結果 **不寫 store** |
| 幕 2 Importer 只看 **`agentSafeSummary`** | 最小揭露；RiskReport 全文僅 Supplier／Verifier |
| 物理邊界獨立 endpoint | 明確區分資料一致性 vs 現場校正（`physicalRealityVerified: false`） |
| 四幕一鍵腳本在 **client**（`runActOne` 等） | Demo 可 repeat；server 路由形狀不變 |

---

## 3. PR #5 獨立 review → P1 修正（commit `635baf7`）

在 Day 3 trust engine（`8f10675`）上，review 發現下列 **P1**，已於 `635baf7` 修復：

| 問題 | 修法 |
|------|------|
| `getDemoContext()` 自簽自驗，expected context 可被呼叫端污染 | 新增 `buildCaseTrustContext()`：從 workflow store 快照 + Registry 權威記錄獨立重建 |
| 任意 `inputHash` 未比對宣稱值 | 呼叫端 `inputHash` 只作比對 → `PUBLIC_INPUT_MISMATCH` |
| Proof 僅 case-level 綁定，SHIP-A→SHIP-B 測不到 | **逐批** publicInputs + `PROOF_CONTEXT_MISMATCH` 測試 |
| 偽造 `proof` bytes 可過 | commitment 現場重算 + `crypto.timingSafeEqual` → `PROOF_INVALID` |
| `evidenceReady: true` 寫死 | `evaluateEvidenceCoverage()` 依 EvidenceItem metadata |
| 缺件被標成 BLOCKED | 純缺件 → `NEEDS_EVIDENCE`（p.13 mapping） |
| 無 policy-registry | 新增 `services/policy-registry/` immutable snapshot |
| nonce 失敗即占用 | TTL／容量上限；**驗證全過才原子 consume**；`setNonceLedger()` hook |
| `resetEvaluatorForTests()` 語意混亂 | 重置回 **production** evaluator；unavailable 測試明確注入 |

**仍誠實**：commitment 輸入全公開 → **非**密碼學證明；`cryptographic_proof` check 永遠 `skipped`。

---

## 4. Day 4 新增模組

| 路徑 | 說明 |
|------|------|
| `services/agent/index.js` | 離線 evidence 抽取、heuristics、injection sandbox、RiskReport |
| `server/agentAdapter.js` | case snapshot → analyze → canonical validate |
| `public/index.html` + `case-workflow.js` | 四幕控制台、Agent／Trust 按鈕、attack／boundary 結果面板 |
| `server/workflowApi.js` | `/api/cases/:id/agent/analyze`、`/api/agent/analyze`、`/api/demo/attack`、`/api/demo/physical-reality` |
| `tests/agent/smoke.js` | 20 項 agent 單元 |
| `tests/workflow/smoke.js` | +13 項 agent E2E／attack／boundary |
| `tests/ui/static-contract.js` | +3 項 Day4 UI 契約（共 19） |

---

## 5. Playwright 驗收

- 本機 `http://127.0.0.1:3847/` 跑四幕；產物在 `artifacts/playwright/`（gitignore）。
- 提交用靜態資源：`docs/handoff/screenshots/day4/`（7 檔，`c1d4ec6`）。
- **GIF** 錄 normal + attack + boundary；**幕 2** 僅 PNG（importer summary、verifier vault）。
- 腳本：`artifacts/playwright/record-day4-demo.js`。

---

## 6. 部署

| 項目 | 值 |
|------|-----|
| URL | https://mandate.1qaz0726.workers.dev |
| Version ID | `6178232c-8ebf-4d0a-ab0f-814af9719ee0` |
| 命令 | `npm run deploy:cf` |
| Smoke | 見 [`DAY4_TEST_CASES.md`](DAY4_TEST_CASES.md) §8 |

---

## 7. 測試基準線（本 session 實跑）

```bash
npm run smoke:carbon-core      # 36/36
npm run smoke:evidence-agent   # 20/20
npm run smoke:workflow         # 47/47 + 19/19 UI
npm run smoke:trust            # 43/43
# 合計 165
```

---

## 8. 已知限制（Demo 必講）

- **不是 zk-SNARK**；Proof = demo commitment。
- **Nonce ledger 跨 Cloudflare isolate 不共享** → 不得宣稱完整 replay protection。
- **Factor／Policy Registry 寫死** Demo 清單，非官方治理。
- **`x-demo-role` 無 authentication**；公開部署誰都能切角色／reset。
- **Workflow 全 in-memory**；冷啟動／閒置可能清空。
- **`READY_FOR_VERIFIER` ≠ 核准**；Importer default **2.5** = Demo estimate。
- Evidence Agent **無 LLM**；`verification=not_verified` 即使已 executed。
- 部署 **僅 synthetic data**。

---

## 9. Day 5（8/28）freeze 事項（交 B）

1. **不再加功能**——僅文案／截圖／PR 描述對齊 165 測試與四幕腳本。
2. **Review／merge PR #6** 至 `main`，關閉 #3／#4／#5；**勿 force push main**。
3. 簡報話術對照 [`docs/demo/DAY4_FOUR_ACT_DEMO.md`](../demo/DAY4_FOUR_ACT_DEMO.md) 誠實底線。
4. 若評審問 ZKP／AI／官方認證：指向 README「刻意不做」與本 log §8。
5. 可選：merge 後打 tag。

---

*Mandate · Day 4 Session Log · 計畫交棒日 2026-08-27*
