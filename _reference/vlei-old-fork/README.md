# 舊 fork 的 vLEI 邏輯（唯讀參考資料，不是要你原封不動搬）

這幾個檔案是用 `git show feature/trust-enhancements:<path>` 從舊分支匯出的唯讀快照（不是這次 agent 自己用 git 抓的，是負責人先手動匯出好放這裡，避免 agent 需要碰 git）。

- `vleiCheck.js`：完整的 vLEI 撤銷連鎖判斷邏輯（法人憑證 + 角色憑證，撤銷任一個都會連鎖失效）。
- `policy_js_vlei_excerpt.txt`：舊版 `policy.js` 裡跟 vLEI 有關的判斷片段（`POL-CRED-001` 這類 policyId）。
- `store_js_vlei_excerpt.txt`：舊版 `store.js` 裡跟 vLEI 狀態儲存有關的片段。

## 重要限制，動手前一定要理解

1. **這是舊架構（青禾零件情境）的程式碼，資料模型完全不同**——舊版用的是記憶體 session store（`store.js` 那套），現在的 canonical schema（`packages/contracts/schema-v1.json`）是完全不同的 `IdentityContext`/`GateResult`/`PolicyProfile` 形狀。**不要整份複製貼上**，這樣會跟現有的 Day 3 trust engine 架構衝突。
2. 正確做法是**參考它的判斷邏輯/精神**（撤銷連鎖如何判斷、法人憑證跟角色憑證的關係），用現在 `services/policy-gate`、`services/factor-registry` 已經確立的模式重新實作一個對齊新 schema 的版本——這跟 Day 1 carbon-core 當初處理 `policy.js` 六步驟框架的做法一樣：**參考精神，不是直接搬**（可以去讀 `services/carbon-core/README.md` 裡「跟 `server/policy.js` 的關係」那段，理解這個團隊一貫的做法）。
3. 這是**優先度較低的背景任務**，只有在 ZK 電路（`tasks/mandate-zk-circuit.md`）的步驟 0-5 都做完、測試都過了，還有餘裕（時間/預算）才碰這個。不要為了做這個而放掉 ZK 電路沒做完。
4. `IdentityContext` 目前在新 schema 裡只有欄位型別（沒有邏輯），所以這其實是**從零實作一個新模組**，只是設計時可以參考這份舊邏輯少走一些冤枉路，不是「復原」舊功能。
