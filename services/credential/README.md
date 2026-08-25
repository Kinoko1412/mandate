# services/credential

Day 5 追加功能①：把 ZK 電路（`services/proof/zk`）+ vLEI 身份驗證（`services/identity`）的
輸出，包裝成一張可攜帶、外部工具能獨立驗證的「碳足跡憑證」（Carbon Footprint Verifiable
Credential）。

## 格式：JWT-VC，不是完整 JSON-LD VC

跟使用者討論過的取捨（見 `docs/handoff/DAY5_OVERNIGHT_LOG.md` 決策記錄）：JWT 序列化是
W3C VC 規格正式支援的方式，不是變通做法。放棄完整 JSON-LD + Linked Data Proof 是因為那條路
需要 RDF canonicalization（URDNA2015 這類演算法）才能簽出穩定結果，實作複雜、有微妙的安全
風險，且需要連網解析 `@context`——demo 現場網路不穩會直接讓驗證失敗。JWT 直接對固定位元組
簽章，`services/credential/jwt.js` 用 Node 內建 `crypto` 手寫，二十幾行講得完，沒有這些風險。

## 這張憑證有多「真」——誠實分層說明

| 層 | 有多真 |
|---|---|
| JWT 簽章 | **真的**。任何人拿到 JWT + 對應公鑰，用任何語言的通用 JWT 工具都能獨立驗證簽章沒被竄改，不需要打這個專案的 API。 |
| ZK proof | **真的**。憑證內嵌完整 groth16 proof + publicSignals，`circuits/build/verification_key.json` 是公開檔案，任何人都能自己重新驗證，不用相信這個系統的說法。 |
| 身份根（誰簽的） | **demo 等級**。簽章金鑰對應的 vLEI 身份來自 `services/identity` 的寫死 demo registry，不是真的 GLEIF 網路。這把金鑰真的屬於哪家公司，這個系統以外的人沒辦法獨立驗證。 |

## 電路輸入映射（沿用 `circuits/README.md` 先前寫好、當時沒接線的建議）

```
quantityScaled = [verifiedIntensity, 0, 0, 0]   // 私密：唯一真正該隱藏的數字（製程效率）
factorScaled   = [productionTonnes, 0, 0, 0]    // 公開：出貨量本來就不是機密
```
電路算出的 `totalScaled` 因此等於 `intensity × production`，跟 carbon-core 既有算法一致，
可以互相核對，沒有杜撰電路命題假設之外的東西。

## 三層獨立驗證（`verifyCarbonFootprintVC`）

1. **JWT 簽章**——內容沒被竄改，真的是宣稱簽發者簽的
2. **未過期**
3. **ZK proof 重新驗證** + **交叉比對**：不是只驗證 proof 本身合法，還要比對憑證外層寫的
   `totalScaled`/`compliant`/`complianceThresholdScaled` 是不是真的等於 proof 的
   `publicSignals` 裡編碼的數字——沒有這一步，proof 驗證會過，但憑證外層可以講假話（這是
   實作過程中發現並補上的真實漏洞，不是預先設計好的，見 commit 說明）
4. **簽發者身份現在還有效**——不是「簽發當下有效」，是**現在**重查一次；如果簽發後才被
   撤銷，舊憑證應該跟著不再被信任

四層任一失敗，整體 `valid` 就是 `false`，`errors` 陣列列出所有沒過的原因。

## 已知限制

- 簽章金鑰只存在 process 記憶體，跟 `services/proof` 的 in-memory nonce ledger 是同一種
  demoOnly 限制——重啟就換一把新鑰，舊憑證會驗證失敗。真實世界這把私鑰該由供應商自己持有。
- 憑證簽發還沒接進任何正式 API 端點，只有 `issueCarbonFootprintVC()`/
  `verifyCarbonFootprintVC()` 兩個函式可以直接呼叫、也有完整測試，但案件狀態變化不會自動
  觸發簽發（例如案件到 READY_FOR_VERIFIER 時自動簽一張）——這是刻意留給團隊決定的下一步，
  不是忘記做。

## 測試

`tests/credential/smoke.js`（`npm run smoke:credential`），8 項：正常簽發/驗證、
不合規但誠實的憑證、竄改攻擊、未知簽發者、已撤銷身份拒絕簽發、驗證端獨立防禦縱深測試
（繞過簽發檢查手動簽出「不該存在」的憑證，證明 verify() 自己也會擋）、外層數字跟 proof
內部數字對不起來、過期憑證。
