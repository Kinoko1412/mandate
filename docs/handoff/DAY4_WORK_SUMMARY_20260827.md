# Day 4（8/27）工作小結

**A 分工範圍**：Evidence Agent + Trust P1 覆驗 + 四幕 Demo UI/API + 部署 smoke + 交接包  
**負責人**：黃昱羲（A）｜**交付對象**：葉士愷（B）｜**日期**：2026-08-27

**對照文件**：《8/24–8/28 雙人落地分工計畫》Day 4、《落地風險審查與修正版方案》、[`PHASE3_SESSION_LOG.md`](PHASE3_SESSION_LOG.md)、[`PHASE4_SESSION_LOG.md`](PHASE4_SESSION_LOG.md)

**Git 狀態（撰寫當下）**：分支 `feature/agent-demo-integration`；runtime commits `b4a8bef`、`635baf7`、`9b2e6ab`、`b712df2`；影像 `c1d4ec6`（git 記錄 **2026-08-24～25**）。Draft PR [#6](https://github.com/1qaz0726-star/mandate/pull/6) 為對 **`main` 的累積型 Draft PR**（已含 Day 1–4）；PR #3／#4／#5 亦 target `main`、內容已涵蓋、均未 merge（#4 `55ac373` ≈ `b4a8bef`）。

---

## 1. 一句話總結

在 PR #6 累積分支完成確定性 Evidence Agent（rule engine、無 LLM）、Trust Engine P1 覆驗修正、四幕 Demo 控制台（正常／最小揭露／攻擊／物理邊界），並部署至 Workers；本 session 實跑 `smoke:evidence-agent` **20** + `smoke:carbon-core` **36** + `smoke:workflow` **47** + UI **19** + `smoke:trust` **43** = **165** 全 PASS。Proof 仍為 **demo commitment**，**不是** zk-SNARK；Agent **不參與** READY。

---

## 2. 驗收表（對照 Day 4 分工計畫）

| 驗收項目 | 完成內容 | 狀態 |
|----------|----------|------|
| Evidence Agent | `services/agent/` 離線抽取 + RiskReport；`server/agentAdapter.js` | ✓ |
| Agent 整合 API | `POST /api/cases/:id/agent/analyze`、`POST /api/agent/analyze` alias | ✓ |
| Agent 不阻擋 READY | revalidate 契約保留；E2E 斷言 Agent unavailable 亦可 READY | ✓ |
| Trust P1 覆驗 | `635baf7`：buildCaseTrustContext、逐批 proof、policy-registry | ✓ |
| 四幕 UI | 一鍵 normal、Grant+Importer、三 attack、physical boundary | ✓ |
| Trust 重驗按鈕 | `#revalidate-trust` + 幕 1 內建 revalidate | ✓ |
| Demo attack harness | `POST /api/demo/attack` 三 scenario；store 不變 | ✓ |
| 角色遮罩 | Importer `agentSummary`；audit 無 evidence 全文 | ✓ |
| 自動化測試 | 165 項全 PASS（見 §7） | ✓ |
| 部署 | https://mandate.1qaz0726.workers.dev · Version `6178232c-…` | ✓ |
| 交棒文件 | `DAY4_*`、`PHASE4_SESSION_LOG`、四幕腳本、本小結 | ✓ |

---

## 3. Trust P1 覆驗（PR #5 review → `635baf7`）

獨立 review 在 Day 3 交付上找到自簽自驗、case-level proof、寫死 evidenceReady 等 **P1**；已全部修復並將 `smoke:trust` 從 19 擴至 **43**。詳細對照表見 [`PHASE4_SESSION_LOG.md`](PHASE4_SESSION_LOG.md) §3。

**禁止宣稱**：ZKP 已完成、官方查驗完成、CBAM Certified、Agent 已正式驗證。

---

## 4. Day 4 做法

### 4.1 Evidence Agent（rule engine，無 LLM）

- 模型版本：`demo-rule-based-no-llm-v1`；固定 prompt contract。
- 輸出 canonical `RiskReport`；injection／DoS caps；低信心高影響值不 eligible。
- Workflow：`analyzeCase()` 寫入 store + audit（僅 reportId／counts／reasonCodes）。
- **不修改** case status／proof／gate readiness。

### 4.2 四幕 Demo 控制台

| 幕 | UI | Server |
|----|-----|--------|
| 1 正常 | `#run-act-1` 一鍵 | submit → analyze → revalidate |
| 2 揭露 | Grant + Importer + Verifier open | Vault + `agentSafeSummary` |
| 3 攻擊 | 三 `data-scenario` 按鈕 | `POST /api/demo/attack` |
| 4 邊界 | `#run-act-4` | `GET/POST /api/demo/physical-reality` |

操作腳本：[`docs/demo/DAY4_FOUR_ACT_DEMO.md`](../demo/DAY4_FOUR_ACT_DEMO.md)  
GIF／截圖：[`screenshots/day4/`](screenshots/day4/)

### 4.3 部署

- URL：https://mandate.1qaz0726.workers.dev  
- Version ID：`6178232c-8ebf-4d0a-ab0f-814af9719ee0`  
- **僅 synthetic data**；in-memory state；`x-demo-role` 無 auth。

---

## 5. 需要 B 注意的事

1. Checkout `feature/agent-demo-integration` 或 PR #6 即可取得 Day 1–4 累積 commits。
2. **8/28 只做 freeze**——不加功能；對齊 165 smoke + 四幕話術。
3. Agent 是 **衍生預審**；Importer default **2.5** 是 Demo estimate。
4. Nonce **跨 isolate 不保證**；Registry **寫死**；workflow **記憶體**。
5. 勿把真實 evidence／token 提交進 git 或公開部署操作。

---

## 6. 明日（8/28）B 的唯一工作

1. 黑箱跑 [`DAY4_TEST_CASES.md`](DAY4_TEST_CASES.md) **§1** 四條 smoke + **§8** 部署五項。
2. 照 [`DAY4_FOUR_ACT_DEMO.md`](../demo/DAY4_FOUR_ACT_DEMO.md) 練四幕（約 4 分鐘）。
3. **Review／merge PR #6** 至 `main`，關閉 #3／#4／#5；**不新開大功能**。
4. 簡報只講 Demo Prototype 邊界（見 README「刻意不做」）。

---

## 7. 測試結果（本 session 實跑；commits／部署 git 記錄 2026-08-24～25）

```bash
npm run smoke:carbon-core      # 36/36 PASS
npm run smoke:evidence-agent   # 20/20 PASS
npm run smoke:workflow         # 47/47 + 19/19 UI PASS
npm run smoke:trust            # 43/43 PASS
npm start                      # http://127.0.0.1:3847/
```

| 套件 | 檔案 | 項數 |
|------|------|------|
| carbon-core | `tests/carbon-core/smoke.js` | **36** |
| evidence-agent | `tests/agent/smoke.js` | **20** |
| workflow API | `tests/workflow/smoke.js` | **47** |
| UI 靜態 | `tests/ui/static-contract.js` | **19** |
| trust | `tests/trust/smoke.js` | **43** |
| **合計** | | **165** |

完整標籤：[`DAY4_TEST_CASES.md`](DAY4_TEST_CASES.md)。

---

## 8. 交付物與 PR #6

| 項目 | 位置 |
|------|------|
| Draft PR #6（對 main 累積型，含 Day 1–4） | https://github.com/1qaz0726-star/mandate/pull/6 |
| PR #3／#4／#5 | target `main`；內容已涵蓋；**未 merge**（#4 `55ac373` ≈ `b4a8bef`） |
| 分支 | `feature/agent-demo-integration` |
| Commits | `b4a8bef` UI 可攜 → `635baf7` Trust P1 → `9b2e6ab` Agent → `b712df2` 四幕 → `c1d4ec6` 截圖 |
| API 範例 | [`DAY4_API_EXAMPLES.json`](DAY4_API_EXAMPLES.json) |
| 四幕腳本 | [`docs/demo/DAY4_FOUR_ACT_DEMO.md`](../demo/DAY4_FOUR_ACT_DEMO.md) |
| Session log | [`PHASE4_SESSION_LOG.md`](PHASE4_SESSION_LOG.md) |
| 部署 | [`DEPLOY_CLOUDFLARE.md`](../DEPLOY_CLOUDFLARE.md) |

---

## 9. 已知限制

- Proof = **demo commitment**，非 zk-SNARK；`cryptographic_proof` skipped。
- Evidence Agent = rule engine；**無 LLM**；`verification=not_verified`。
- `x-demo-role` 無真實 auth／tenant；公開 URL 誰都能操作。
- Workflow／nonce ledger **in-memory**；Workers **跨 isolate 不共享** nonce。
- Factor／Policy Registry **寫死** Demo 記錄。
- `READY_FOR_VERIFIER` = 送查準備，**非**官方核准。
- Importer default **2.5** 硬編碼 Demo estimate。
- 部署與 demo **僅 synthetic data**。

---

## 10. 8/28 freeze（摘要）

1. 165 smoke 全綠 + 部署四幕 smoke 通過。  
2. 話術誠實（無 ZKP／無官方認證／無 LLM Agent 誤稱）。  
3. **Review／merge PR #6** 至 `main`，關閉 #3／#4／#5；B 不擅自改路由或 trust 契約。

---

*可信碳排證據 Agent · Day 4 工作小結 · 2026-08-27*
