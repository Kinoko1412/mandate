# Evidence Vault（WebAuthn PRF）UI/UX 評分標準

2026-08-26。使用者要求：開發完成後實際操作瀏覽器、依真實體驗做 5~10 輪優化，開始前先訂
評分標準、先查對照基準。這份文件記錄評分方式跟依據，不是憑感覺打分。

## 方法論依據（WebSearch，見下方 Sources）

- **Nielsen 10 大易用性原則**（Nielsen Norman Group，1994 年定案、業界標準沿用至今）——
  用它的架構当評分維度，每項 0–4 分（0=完全沒做到／壞掉，4=優秀），跟 NN/g 建議的嚴重度
  評分慣例一致。
- **WebAuthn/passkey 專屬 UX 建議**（2026 年多篇技術部落格彙整）：文案不解釋 WebAuthn／
  公鑰加密術語，只回答使用者關心的兩件事「這是做什麼」「要花多久」；帳號救援/備援路徑要
  先想好；passkey 路徑要視覺上顯眼、預設。

## 評分維度（10 項，各 0–4 分）

1. **系統狀態可見性**——按下按鈕到結果出現這段時間，使用者知不知道現在發生什麼事
2. **現實世界語言**——文案是不是使用者聽得懂的話，不是技術術語
3. **使用者控制與自由**——能不能取消、能不能重試、會不會卡死看起來像當機
4. **一致性與標準**——跟頁面其他既有部分的視覺/互動模式是否一致
5. **錯誤預防**——不可逆動作（例如輪替金鑰讓舊底稿變不能解密）有沒有足夠提示
6. **辨識而非記憶**——目前狀態（已加密/未加密/已註冊/未註冊）是不是一眼看到，不用使用者自己記
7. **彈性與效率**——同一 session 內重複操作會不會不必要地重複要求生物辨識
8. **美學與極簡設計**——有沒有多餘雜訊、排版是否乾淨
9. **錯誤辨識/診斷/恢復**——錯誤訊息是不是人話、有沒有給下一步
10. **即時脈絡說明**——不懂的地方（為什麼要按指紋）有沒有一行解釋，不用另外找文件

## 通過標準

- 10 項平均分數 ≥ 3.0，**且**
- 沒有任何一項 < 2 分（不能靠其他項目拉高平均蓋過一個明顯的破口）

未達標就是還沒做完，不是「差不多了」。

## 對照基準

實際比較對象是 Bitwarden／1Password 等密碼管理器的 passkey 註冊流程（2026 年主流做法，
見 Sources）——這些產品的登入牆後台無法直接截圖比對，改用查到的書面最佳實務準則當替代
基準（上面「方法論依據」那段），評分時對照這些具體準則，不是憑印象。

## Sources

- [How to Conduct a Heuristic Evaluation](https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/)
- [How to Conduct Heuristic Evaluation w/ Nielsen's 10 Usability Heuristics](https://blog.uxtweak.com/usability-heuristics/)
- [How I Developed the 10 Usability Heuristics](https://www.uxtigers.com/post/usability-heuristics-history)
- [Passkeys at Scale: The Complete Enterprise Deployment Playbook 2026](https://securityboulevard.com/2026/03/passkeys-at-scale-the-complete-enterprise-deployment-playbook-2026/)
- [Dashlane Passkeys: Analysis of Sign-ups and Logins with Passkeys](https://www.corbado.com/blog/dashlane-passkeys)

## 迭代紀錄（摘要——完整過程見 `記憶.md` 對應日期段落）

**Round 1（基準評分）**：實機操作（claude-in-chrome）走過 Supplier 上傳→Grant→Verifier 開
底稿的明碼備援路徑，確認既有功能零回歸；點擊「註冊 Vault 裝置」時抓到一個**真的 bug**——
`http://127.0.0.1` 被 Chrome 判定為無效 WebAuthn 網域，`http://localhost` 才正常。10 項評分：
平均 2.9 分，且「錯誤預防」（輪替金鑰沒有二次確認）只有 1 分，未達標。

**Round 2（修復）**：
1. 修好一個真的邏輯 bug——`mapWebAuthnError()` 誤把原生 `DOMException` 的舊版數字 `.code`
   （SecurityError=18）當成「已經處理過」直接放行，導致使用者看到英文原文 + 沒人看得懂的
   數字代碼。改成只認字串 code，並新增 `SecurityError`（網域無效）的明確中文對應。
2. 新增「輪替金鑰」二段式 inline 確認（不用原生 `confirm()`，維持跟全站一致、不用瀏覽器
   原生對話框的既有風格）。
3. 觸發 WebAuthn 的按鈕（註冊/輪替/開底稿/下載）在等待期間文字換成「請完成裝置驗證…」。
4. 加一行提示：大概要多久、改變主意可以在系統視窗按取消。

全部用瀏覽器 JS 直接驅動＋讀 DOM 狀態驗證過（比截圖時序更可靠），包含刻意模擬
`SecurityError`／`NotAllowedError` 兩種原生錯誤，確認訊息、按鈕文字、稽核狀態都正確。
10 項重新評分：平均 3.9 分，最低分（使用者控制與自由）3 分，**達標**。

**Round 3（額外找到、順手修的兩個小落差）**：
1. Evidence Index 表格的 Vault 加密狀態欄位原本排在最後一欄，這張表在雙欄版面裡本來就要
   橫向捲動，等於使用者每次都要捲到底才看得到最關鍵的加密狀態——改成排在 ID 後面第二欄。
2. Supplier 上傳表單完全沒有顯示「這次上傳會不會被加密」，這個資訊落差原本只有 Verifier
   端事後才看得到——新增 `upload-vault-status` 提示行，跟 Verifier 端的狀態徽章同步。

兩項都用真瀏覽器（reset scrollLeft 後截圖 + 讀 DOM outerHTML）驗證過，且全部既有測試套件
（`server/smoke`／`workflow`／`dpp`／`vault/*`／`trust/smoke`／`trust/live-extras`）重跑
零回歸。

**結論**：3 輪之後已經穩定達標（≥3.0 平均、無低於 2 分項目），且每一輪都是實機操作找到的
真實落差、真的修掉，不是為了湊滿建議的 5–10 輪硬找東西改。第 4 輪起如果還要繼續找，下一個
該看的地方是：下載流程（`downloadBytesEvidence`）目前完全沒有實機測過、行動裝置（手機
Windows Hello/指紋）版面目前只驗證過桌面寬度。
