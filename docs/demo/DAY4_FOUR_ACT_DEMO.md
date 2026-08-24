# Day 4 四幕 Demo 腳本（約 4 分鐘）

> **入口**：`npm start` → [http://127.0.0.1:3847/](http://127.0.0.1:3847/)，或已部署 [https://mandate.1qaz0726.workers.dev](https://mandate.1qaz0726.workers.dev)（**僅 synthetic data**）。  
> **GIF**（幕 1／3／4 動態）：[`docs/handoff/screenshots/day4/day4-four-act-demo.gif`](../handoff/screenshots/day4/day4-four-act-demo.gif)  
> **幕 2 靜態截圖**：[`act2-importer-summary.png`](../handoff/screenshots/day4/act2-importer-summary.png)、[`act2-verifier-vault.png`](../handoff/screenshots/day4/act2-verifier-vault.png)

**誠實底線（開場必講）**：這是 Hackathon Demo Prototype；Proof 是 **demo commitment**（`demoOnly:sha256:`），**不是** zk-SNARK；Evidence Agent 是 **rule engine、無 LLM**；`x-demo-role` **不是**真實 auth；`READY_FOR_VERIFIER` **不是**官方核准；Importer default **2.5** 是 Demo estimate。

---

## 時間分配（合計約 4:00）

| 幕 | 時間 | 形式 |
|----|------|------|
| 幕 1｜正常案件 | ~1:30 | **GIF** + 現場一鍵 |
| 幕 2｜最小揭露 | ~1:00 | **截圖** + 現場切角色 |
| 幕 3｜攻擊攔截 | ~0:45 | **GIF** 片段 + 現場三按鈕 |
| 幕 4｜誠實邊界 | ~0:45 | **GIF** 片段 + 現場一鍵 |

---

## 幕 1｜正常案件 → READY_FOR_VERIFIER（~1:30）

**說什麼**  
「供應商上傳四份 synthetic 佐證、人工確認後提交；Evidence Agent 做**衍生**風險預審，但不決定 readiness；Trust Engine 重驗 proof／gate 後，案件才到 `READY_FOR_VERIFIER`——這只代表**送查準備**，不是查驗完成。」

**點哪裡**

1. 確認 header 角色為 **Supplier**（預設）。
2. 四幕控制台 → **「一鍵執行正常案件」**（`#run-act-1`）。

**預期看到**

- 四份 evidence 上傳並確認 → submit 成功。
- 依賴服務：Agent `executed` / `not_verified`；Proof、Gate `verified`。
- 案件狀態 **`READY_FOR_VERIFIER`**；banner 仍標「不代表正式查驗完成」。
- 成功通知：「幕 1 完成…Agent 預審不參與 readiness。」

**對照 GIF／截圖**：[act1-ready.png](../handoff/screenshots/day4/act1-ready.png)

**Fallback**

- 若一鍵失敗：手動「載入四份 synthetic Demo evidence」→「**人工確認全部**」→「**提交年度資料**」→「執行 Evidence Agent 預審」→「**重驗 Proof / Gate**」。
- 部署冷啟動後 state 清空：先 **重置 Demo** 再跑幕 1。

---

## 幕 2｜最小揭露（Importer 摘要 vs Verifier Vault）（~1:00）

**說什麼**  
「RiskReport 是衍生分析，**不是**底稿。Importer 只看 server 安全摘要；Verifier 必須一次性短效 token 才能開指定底稿——Grant 用完即失效。」

**點哪裡**

1. 先完成幕 1（需有 evidence）。
2. 四幕控制台 → **「建立 Grant 並看 Importer 摘要」**（`#run-act-2`）→ 自動切 **Importer**。
3. 看 Importer 區塊：`agentSummary` 只有 counts／reasonCodes，**無** entries／citations 全文。
4. 四幕控制台 → **「切 Verifier 並開底稿一次」**（`#open-act-2-verifier`）→ 底稿開啟後 token 清除。

**預期看到**

- Supplier 建立 Grant；token **只顯示一次**。
- Importer：actual **1.8** vs default **2.5**（Demo estimate）；無 `contentBase64`、無 vault 全文。
- Verifier：Evidence Index 有 metadata；open 後顯示底稿一次；Audit 有 `VAULT_OPEN`，**無** token 明文。

**對照截圖（本幕不用 GIF）**

- Importer：[act2-importer-summary.png](../handoff/screenshots/day4/act2-importer-summary.png)
- Verifier Vault：[act2-verifier-vault.png](../handoff/screenshots/day4/act2-verifier-vault.png)

**Fallback**

- 無 token：手動 Supplier 建 Grant → 複製 token → 切 Verifier → 選 evidence → 貼 `x-vault-token` →「開啟底稿一次」。
- Grant 已消耗：重新建 Grant（需 Supplier）。

---

## 幕 3｜攻擊攔截（~0:45）

**說什麼**  
「三個按鈕都走 **server-side Trust Engine** 真實 evaluate；結果 `BLOCKED` 且 **不修改** 正常案件 store。」

**點哪裡**（角色須 **Supplier**；四幕控制台「幕 3｜攻擊攔截」）

| 按鈕 | scenario | 預期 reason code |
|------|----------|------------------|
| 竄改 quantity | `tampered_quantity` | `PUBLIC_INPUT_MISMATCH` |
| 錯誤 factor | `wrong_factor` | `FACTOR_NOT_ALLOWED` |
| SHIP-A Proof 套 SHIP-B | `proof_context_swap` | `PROOF_CONTEXT_MISMATCH` |

**預期看到**

- `#attack-result` 顯示 `BLOCKED` 與 reason code。
- 幕 1 的 `READY_FOR_VERIFIER` **維持不變**（`storeModified: false`）。

**對照 GIF／截圖**：[act3-blocked.png](../handoff/screenshots/day4/act3-blocked.png)；GIF 含 attack 段落。

**Fallback**

- API：`POST /api/demo/attack` + `x-demo-role: Supplier` + `{ "scenario": "tampered_quantity" }`（見 [`DAY4_API_EXAMPLES.json`](../handoff/DAY4_API_EXAMPLES.json)）。

---

## 幕 4｜物理真實邊界（~0:45）

**說什麼**  
「文件數字一致 ≠ 現場儀表已校正。Commitment／Gate 只驗**資料一致性**，不證明物理真實；下一步是實地查驗。」

**點哪裡**

- 四幕控制台 → **「展示物理真實邊界」**（`#run-act-4`）。

**預期看到**

- `#physical-result`：`physicalRealityVerified: false`；`gateScope: DATA_CONSISTENCY_ONLY`；`recommendedAction: ONSITE_VERIFICATION`。
- 案件 status／Gate **不變**。

**對照 GIF／截圖**：[act4-physical-boundary.png](../handoff/screenshots/day4/act4-physical-boundary.png)

**Fallback**

- `GET` 或 `POST /api/demo/physical-reality`（任意 Demo role 皆可）。

---

## 收尾話術（30 秒）

- 我們**不是** CBAM Registry、**不是**法定查驗機構、**不是**正式 ZKP 商用產品。
- Workers 上 nonce 重放僅 **單 isolate** 有效，**不得**宣稱跨部署 replay protection。
- Factor／Policy Registry 為 **Demo 寫死清單**；workflow **全記憶體**，重啟即清空。

---

## 黑箱驗收（隊友 B）

```bash
npm run smoke:carbon-core      # 36
npm run smoke:evidence-agent # 20
npm run smoke:workflow       # 47 + 19 UI = 66
npm run smoke:trust          # 43
# 合計 165
```

部署 smoke：開啟部署 URL → 跑幕 1 一鍵 → 確認 `READY_FOR_VERIFIER`（見 [`DEPLOY_CLOUDFLARE.md`](../DEPLOY_CLOUDFLARE.md) 與 [`DAY4_TEST_CASES.md`](../handoff/DAY4_TEST_CASES.md) §8）。

黑箱四命令詳見 [`DAY4_TEST_CASES.md`](../handoff/DAY4_TEST_CASES.md) **§1**。
