# Mandate — RFC 3161 時戳實踐計畫

**文件狀態**：V2(2026-09-12 已接進正式流程並部署到個人測試站 `https://mandate.david460525.workers.dev`——`server/workflowApi.js` 的 `revalidateCase()` 在 Gate 判 GATE_OK 時會呼叫 `services/timestamp`,結果寫進稽核紀錄,已在**真實部署的 Workers 上**對 DigiCert 取得真實 tsToken 並驗證能從 `GET /api/cases/:caseId/audit` 讀回;`docs/作品說明.txt` 文案措辭仍未更新,見下方第9節)
**產品**：Mandate(CBAM／嵌入排放 碳數據信任閘門 Agent)
**對齊**：`docs/作品說明.txt` 貳、五「防篡改的稽核軌跡」與肆、四「時點證明」的既有文案;柒、二里程碑第三階段
**語言**：繁體中文為主;識別子、欄位名維持英文

---

## 0. 背景與現況

2026-09-11 稽核發現:`docs/作品說明.txt` 把「關鍵事件以符合 RFC 3161 之時戳憑證固定時點」寫成現在式、列為五大特色之一,但直接查 `mandate` repo(搜 `3161`／`timestamp`／`tsa`／`timeStampToken`)確認**目前完全沒有實作**——沒有 TSA 串接、沒有 ASN.1 編解碼、沒有任何時戳相關程式碼。唯一的命中是 `.wrangler` build cache 裡一段 ZK 證明常數字串裡剛好含有子字串 "3161",純屬巧合。

作為對照,同一批文案裡的另外兩項證明能力都是真的:
- **可驗證憑證(VC)**:`services/credential/index.js` + `jwt.js`,W3C VC-JWT 序列化,Node 內建 `crypto` 簽章/驗證,已實作。
- **zk-SNARK 計算證明**:`circuits/carbon_proof.circom` + `services/proof/zk.js`,Circom 電路已編譯、已 trusted setup、已在 Cloudflare Workers workerd runtime 跑通 prove+verify 全流程(見 `circuits/README.md`),已實作。

本文件的目的是把「時點證明」從落差補成第三項真實能力,或至少產出一份誠實、可執行的實踐計畫,讓提案文件的敘述有真正的工程依據可以對照。

---

## 1. 命題與範圍

沿用 `docs/作品說明.txt` 肆、三「信任閘門層」既有設計:每次案件狀態變更(`GateResult`)已經留下可稽核紀錄,`evaluateGate()`(`services/policy-gate/index.js`)回傳的物件已含 `inputHash`、`decision`、`evaluatedAt`、`policyProfileId`、`shipmentId`。

**命題**:對「Gate 判定完成」這個關鍵事件,取其規範化雜湊值,向符合 RFC 3161 的時間戳記機構(TSA)取得時戳權杖(TimeStampToken),證明「這個雜湊值在某個時間點之前已經存在」——不揭露判定內容本身,只鎖定時間點,可搭配既有的 `inputHash`/`factorSetHash` 雜湊鏈,形成「內容防篡改 + 時序防篡改」兩層防線。

**不做的事**(比照 `zk.js` 檔頭的架構取捨風格,明確劃界):
- 不做長期時戳(RFC 3161 只證明「送出時已存在」,不解決憑證/簽章過期後的長期驗證問題,那是 RFC 3161 archive/RFC 4998 evidence record 的範疇,超出本次範圍)。
- 不做多 TSA 冗餘簽章(先求单一 TSA 可信、可運作,冗餘簽章列為未來優化)。
- 不改變 `evaluateGate()` 既有回傳形狀的必要欄位,時戳資訊以**附加**欄位掛上去,不影響既有 43+ 項測試的斷言(比照 `services/proof/zk.js` 檔頭說明的「疊加不取代」原則)。

---

## 2. TSA(時間戳記機構)選型

提案文件寫的目標是中華電信 ePKI 體系下的 eTSCA(時戳憑證管理中心)。但根據 `中華電信智慧創新應用大賽/記憶.md`(第71行)已查證的結果:**eTSCA 於 2025-07-14 公告因服務機制重整,停止受理新憑證投單申請**。這代表現階段無法用 eTSCA 帳號做出一個真正能動的 demo——這是選型必須面對的真實限制,不能假裝不存在。

**因應策略:分兩層**

| 層級 | 用途 | 選擇 |
|---|---|---|
| **建置/demo 用 TSA** | 讓功能現在就能真的動起來、有真實 TimeStampToken 可展示 | 選一個目前公開可用、免帳號申請、符合 RFC 3161 的公開 TSA(候選見下) |
| **正式導入路徑(維持文案原意)** | 提案裡「可對接國內時戳憑證服務,例如 eTSCA」的承諾 | 架構做成可替換介面卡(adapter),eTSCA 重新開放受理後直接換掉 base URL + 信任錨即可,不用改動呼叫端程式碼 |

**2026-09-11～12 已完成實測(含一次更正),結論見 `../../../實驗記錄/RFC3161_TSA連通性測試_20260911.md`**(含國內選項查證、四個候選的真實 TimeStampReq/Resp 二進位證據檔、簽章鏈驗證)。摘要:
- 國內選項現在都接不到——eTSCA 確認仍是全面停止受理投單;TWCA 的 TSA 服務要登入客戶儀表板、年費訂閱制,沒有公開試用端點,無法免費立即驗證。
- 四個候選公開 TSA 全部回應 `Status: Granted`,且**全部**完成端到端簽章鏈驗證(`openssl ts -verify` → `Verification: OK`)——初版測試只驗了 FreeTSA 就下「唯一驗證通過」的結論是誤判,補測後發現 DigiCert/Sectigo/GlobalSign 三家也都驗證通過,且它們的根憑證是**公開信任的 WebPKI 根**,信任基礎比 FreeTSA 自我簽發的根更強。DigiCert/Sectigo/GlobalSign 三家再細比:GlobalSign 延遲最低但憑證名稱寫明「for CodeSign」(場景疑慮),Sectigo 命名通用但延遲比 DigiCert 慢。**已定案 DigiCert(`http://timestamp.digicert.com`)為建置/demo 階段的預設 TSA**(信任鏈與 Sectigo/GlobalSign 同級、命名無場景疑慮、延遲小勝 Sectigo),備援順位 Sectigo > GlobalSign > FreeTSA。

候選公開 TSA(皆為業界常見、用於程式碼簽章時戳的公開服務,**但清單裡每一個的目前可用性、速率限制、使用條款都必須在動工前重新驗證,不能只憑既有印象假設可用**——這正是本專案自己在 vault 記過的教訓「查不到/沒查證的東西不能直接寫進正文」的同一原則。**此段已於 2026-09-11～12 完成驗證,見上方摘要與實驗紀錄檔**):

- **DigiCert 公開 TSA(`http://timestamp.digicert.com`)— 已選定為預設**
- Sectigo 公開 TSA(`http://timestamp.sectigo.com`)
- GlobalSign 公開 TSA(`http://timestamp.globalsign.com/tsa/r6advanced1`)
- FreeTSA.org(`https://freetsa.org/tsr`,明確標榜免費開放)

**第一個實作任務就是逐一送出真實 TimeStampReq 探測,確認誰現在真的可用、回應多快、有沒有 rate limit**,不是先挑一個就假設能用到底——這個驗證步驟本身應該寫成一支獨立腳本(見第7節測試計畫),而不是留到整合時才發現踩雷。

---

## 3. 架構設計

比照 `services/credential/`(VC,身分根可替換)與 `services/proof/`(ZK,circuit/TSA 都要能換)的既有模式,新增 `services/timestamp/`:

```
services/timestamp/
  index.js       — 對外介面:requestTimestamp(hashHex) / verifyTimestamp(tsToken, hashHex)
  rfc3161.js     — 低階 ASN.1:建 TimeStampReq、解 TimeStampResp/TimeStampToken
  tsaAdapter.js  — 可替換的 TSA 端點設定(baseUrl、信任錨憑證、逾時/重試策略)
```

> **2026-09-12 更正(實作後才發現的真實限制)**:下面這版介面草案在真的寫的時候改了一個關鍵設計——`requestTimestamp`/`verifyTimestamp` 收的是**原始內容(payload)**,不是預先算好的雜湊值(`hashHex`)。原因:驗證端選用的 `pkijs` 對 RFC 3161 TSTInfo 型別內容有特殊處理,`SignedData.verify()` 會對呼叫端傳入的 `data` **重新雜湊一次**去比對 TSTInfo 內的 messageImprint——如果直接餵已經算好的雜湊值進去,會變成「雜湊的雜湊」比對不上。改收原始內容、由模組自己統一負責雜湊,請求與驗證兩邊用同一套邏輯,避開了這個 pkijs API 的隱性限制,呼叫端(第5節整合點)因此要傳「規範化後的原始內容」而不是「雜湊值」。實際介面(已實作並通過測試,見 `services/timestamp/index.js`):

```js
// services/timestamp/index.js(已實作)
async function requestTimestamp(payload, { hashAlgo = 'sha256', tsaProfileId, tsaUrl, timeoutMs = 15000 } = {}) {
  // payload: string | ArrayBuffer | Uint8Array —— 規範化後的原始內容,不是雜湊值
  // 回傳 { status: 'ok'|'tsa_unreachable'|'tsa_error', tsaUrl, hashAlgo, hashHex, tsToken, requestedAt, ... }
}

async function verifyTimestamp({ tsToken, payload, hashAlgo = 'sha256' }) {
  // 回傳 { valid: boolean, genTime, reasonCodes }
}

module.exports = { requestTimestamp, verifyTimestamp, TSA_PROFILES };
```

實作細節:簽章驗證用 `pkijs`(CMS SignedData,底層走 WebCrypto),ASN.1 編解碼用 `@peculiar/asn1-tsp`/`@peculiar/asn1-cms`/`@peculiar/asn1-schema`/`@peculiar/asn1-x509`(純 JS,無原生依賴)。原計畫也列過 `@peculiar/x509`,實作時發現它依賴 `tsyringe` + `reflect-metadata` 這套 DI 框架(會在載入時丟 polyfill 錯誤),對 Workers 環境是不必要的複雜度來源,已改用更輕量的 `pkijs` 做憑證鏈/簽章驗證,`@peculiar/x509` 未列入相依套件。

**跟現有架構的接點**:`services/policy-gate/index.js` 的 `evaluateGate()` 不直接呼叫時戳服務(維持它是純函式、無 I/O 的既有特性,不能為了時戳打破這個契約)。時戳改在呼叫端(例如 `server/trustAdapter.js` 或對應的 worker handler)於拿到 `GateResult` 之後,非同步呼叫 `requestTimestamp()`,把結果**另外存**成一筆稽核紀錄,不塞進 `GateResult` 本體——這樣即使 TSA 暫時不可用,Gate 判定本身完全不受影響(容錯關鎖在「時戳」這個增量能力上,不能讓外部 TSA 的可用性變成放行流程的單點故障)。

**2026-09-12 現況(已接入正式流程並部署)**:實際整合點落在 `server/workflowApi.js` 的 `revalidateCase()`,不是直接改 `trustAdapter.js`(維持 `evaluateGate()` 純函式、`trustAdapter.evaluate()` 回傳形狀都不動,把改動範圍完全限縮在 `workflowApi.js` + `workflowStore.js`,不去碰已有 43+ 項測試覆蓋的 trust engine)。實際做法(跟第5節原始建議的差異,是接線時發現的真實限制):
- 只用 `result.gate.inputHash` 存在與否判斷是否 GATE_OK(這是 `trustAdapter.evaluate()` 回傳形狀裡唯一在 GATE_OK 時才有的欄位),canonical payload 簡化成 `{caseId, inputHash, verification, reasonCodes}`,不含原設計裡的 `policyProfileId`/`shipmentId`/`evaluatedAt`(那些欄位在 `evaluateGate()` 內部有,但沒有被傳到 `workflowApi.js` 這一層,要拿到得改動 `trustAdapter.js` 的回傳形狀,風險與範圍都不成比例)。
- 用 `await` 同步等待,不是 Cloudflare Workers 的 `ctx.waitUntil()` 背景執行——理由與取捨見 `server/workflowApi.js` 的 `timestampGateResultIfEnabled()` 函式開頭註解。
- 新增環境變數 `ENABLE_RFC3161_TIMESTAMP`(見 `worker/index.js`/`wrangler.toml`),**預設關閉**,只有明確設為 `"true"` 才會真的打網路——這是為了不讓 `tests/trust/smoke.js` 等既有 43+ 項測試意外連上真實 DigiCert,同時保留一支獨立測試 `tests/workflow/timestampIntegration.smoke.js` 自己開這個開關驗證真實接線。
- 時戳結果寫進 `workflowStore.appendAudit()` 的新欄位 `timestampProof`,透過既有的 `GET /api/cases/:caseId/audit` 端點可以讀回,不需要新增 API。
- 已部署到個人 Cloudflare 測試帳號的 `mandate.david460525.workers.dev`(`wrangler.toml` 的 `[vars]` 已加 `ENABLE_RFC3161_TIMESTAMP = "true"`),並在**真實部署的 Workers 上**(不是本機)完整跑過一次 reset→evidence→submit→revalidate→讀 audit,`timestampProof.status` 確認是 `"ok"`、`tsaUrl` 是 DigiCert、`tsToken` 是真實 CMS/PKCS7 簽章 blob。測試完已把 demo 案件 reset 回乾淨狀態。

---

## 4. 依賴函式庫選型與 Workers 相容性

跟 ZK 電路(`services/proof/workersWasmCompat.js`)踩過的 WASM 動態編譯坑不同,RFC 3161 只需要 **ASN.1(DER)編解碼 + HTTP 請求 + 簽章驗證**,三者在 Cloudflare Workers(workerd)裡原生支援(`fetch` 內建;WebCrypto `crypto.subtle` 內建),**不需要 WASM,理論上比 ZK 電路好處理很多**——這點在跟隊友/評審溝通時可以明確講,不用讓「時戳」聽起來跟 ZK 一樣是硬仗。

建議函式庫(待第一個任務實測確認相容性,不能只憑套件說明假設能在 workerd 跑):

- `@peculiar/asn1-schema` + `@peculiar/asn1-tsp`:PeculiarVentures 維護,純 JS 沒有原生依賴,提供 RFC 3161 TimeStampReq/TimeStampResp 的 ASN.1 schema,用來建構請求、解析回應。
- `@peculiar/x509` 或 `pkijs`(+`asn1js`):驗證 TSA 回應的 CMS SignedData 簽章,底層走 WebCrypto,Workers 相容。
- 如果上述套件在 workerd 下有相容性問題(例如意外拉進 Node-only API),備援方案是照抄 `circuits/workers-compat-check/` 的模式,先寫一支獨立 `services/timestamp/workers-compat-check/` 腳本,用 `wrangler dev` 實測,問題排除後再整合進主流程——不要在還沒驗證 Workers 相容性之前就把呼叫寫進 `worker/index.js` 的主路徑。

---

## 5. 整合點:時戳什麼「關鍵事件」

對照 `docs/作品說明.txt` 貳、五「防篡改的稽核軌跡」的既有敘述(係數集合雜湊鎖定 + 關鍵事件時戳),建議的「關鍵事件」定義為:

**首選:`evaluateGate()` 的判定結果**(`services/policy-gate/index.js`)。理由:
- 已經有現成的 `inputHash` 欄位可以直接拿來時戳,不用另外設計雜湊規範化邏輯。
- `decision`(`GATE_OK` / `NEEDS_EVIDENCE` / `BLOCKED`)是整個信任閘門層唯一的放行點,時戳這個事件最貼合「查驗機構可回溯稽核鏈」的產品敘述(肆、三已寫「任何案件因而無法在未滿足前置條件下前進,每次狀態變更亦留下可稽核紀錄」)。

雜湊規範化建議:`sha256(canonicalJSON({ inputHash, decision, policyProfileId, shipmentId, evaluatedAt }))`,不要直接對整個 `GateResult`(含 `checks` 陣列)雜湊,避免日後 `checks` 內部措辭微調就讓歷史時戳全部失效。

次選(第二階段再做,不在第一版範圍):`factor-registry` 的 `factorSetHash` 鎖定事件,理由是係數集合變動頻率遠低於逐案 Gate 判定,時戳的邊際價值較低,先做高頻、高稽核價值的 Gate 判定即可。

---

## 6. 資料模型變更

在既有稽核紀錄(案件狀態變更留存的稽核鏈,實際儲存位置需對照 `server/trustAdapter.js` 現有寫入邏輯確認)新增一個獨立的關聯紀錄,不修改 `GateResult` 本體形狀:

```js
// 新增稽核紀錄型別草案:TimestampProof
{
  gateResultInputHash: string,   // 對應被時戳的 GateResult.inputHash
  tsaUrl: string,
  tsToken: string,               // base64 DER TimeStampToken,完整保留供第三方獨立驗證
  genTime: string,                // ISO8601,TSA 回應內的時戳時間
  hashAlgo: 'sha256',
  requestedAt: string,            // 本地請求發出時間(可能跟 genTime 有些微落差,兩者都留)
  status: 'ok' | 'tsa_unreachable' | 'tsa_error',
}
```

`status` 三態的意義:時戳服務是**增量**能力,不是放行的必要條件(見第3節容錯設計),所以要能誠實記錄「這筆有沒有拿到時戳、拿不到是為什麼」,而不是讓呼叫失敗變成靜默丟棄或讓整個案件卡住。

---

## 7. 測試計畫

比照這個 repo 已經建立的測試風格(`tests/trust/zk.smoke.js` 用真電路做端到端測試、`tests/proof/workersWasmCompat.smoke.js` 驗證 Workers 相容性、以及你在其他專案用 `node --test` mock `fetch` 做離線單元測試的既有習慣):

1. **離線單元測試**(`tests/timestamp/rfc3161.unit.js`):mock `fetch`,測 `buildTimeStampReq`/`parseTimeStampResp` 的 ASN.1 編解碼正確性、`verifyTimestamp` 對「雜湊不符」「簽章不符」「過期憑證」各種異常輸入的判斷邏輯——不需要真的打網路就能跑,CI 可以常態執行。
2. **真實整合 smoke test**(`tests/timestamp/rfc3161.integration.smoke.js`):對第2節選定的公開 TSA 送真實請求、驗證真實回應,**不放進預設 `npm test`**(比照 `circuits/workers-compat-check/` 不是預設套件的一部分),因為依賴外部服務可用性,手動執行、或排進 CI 的獨立 nightly job。
3. **Workers 相容性檢查**(`services/timestamp/workers-compat-check/`):用 `wrangler dev` 實測 ASN.1 函式庫 + WebCrypto 驗證在 workerd 下能否正常運作,產出結論記錄進本文件或獨立 README(比照 `circuits/README.md` 的「已在真正的 Cloudflare Workers runtime 跑通」寫法,要真的跑過才能這樣寫,不能用「理論上應該可以」代替)。

---

## 8. 工作分解與工時估計

| 項目 | 估計工時 | 備註 |
|---|---|---|
| TSA 候選逐一探測、選定建置用 TSA | 0.25 天 | 第一個任務,阻塞後續所有工作 |
| `rfc3161.js`:TimeStampReq 建構、TimeStampResp 解析 | 0.5 天 | ASN.1 schema 用現成套件,不用手刻 |
| `index.js` + `tsaAdapter.js`:對外介面、可替換端點設定 | 0.25 天 | |
| `verifyTimestamp` 簽章驗證(WebCrypto) | 0.5 天 | 若需要驗證憑證鏈回信任錨,時間可能拉長,視選定 TSA 的憑證鏈複雜度而定 |
| 整合進 `server/trustAdapter.js`(或對應 worker handler)呼叫點 + 資料模型 | 0.5 天 | |
| 離線單元測試 | 0.25 天 | |
| Workers 相容性檢查(`wrangler dev` 實測) | 0.5 天 | 若函式庫踩到 workerd 相容性問題,可能需要額外時間排查(比照 ZK 電路當時的 WASM 坑) |
| **合計** | **約 2.5–3 天專注工時** | 明顯比 ZK 電路(含 trusted setup、Workers WASM 相容性排查)輕,原因見第4節 |

**這個估計的意義**:如果比賽時程還有 2.5–3 天可運用,「時戳」不必只停在文件裡當第三階段遠景,有機會在賽事結束前補成第三項真實能力,補齊「五大特色」文案跟程式碼的落差。如果時程不夠,至少提案文件的措辭要照 `記憶.md` 第93行的既定決議改成設計語氣,不能維持現在式的過度宣稱。

---

## 9. 交件前(或動工前)待確認清單

- [x] 實測第2節候選 TSA,確認至少一個現在真的可用、可匿名送出請求、無需申請帳號——**2026-09-11～12 完成(含一次更正),選定 DigiCert,見 `../../../實驗記錄/RFC3161_TSA連通性測試_20260911.md`**
- [x] 確認 DigiCert 與 Sectigo(備援)的公開端點使用條款沒有限制本專案這種用途——**2026-09-12 完成,見 `../../../實驗記錄/RFC3161_TSA連通性測試_20260911.md` 第五節條款查證**
- [x] 確認選用的 ASN.1 函式庫在 `wrangler dev` 下能正常運作——**2026-09-12 完成,`services/timestamp/workers-compat-check/` 在真實 workerd 跑通,`passed:true`,無需 WASM,比 ZK 電路輕鬆很多(見第4節)**
- [x] 實作 `services/timestamp/`(`tsaAdapter.js`/`rfc3161.js`/`index.js`)、離線單元測試(`tests/timestamp/rfc3161.unit.js`,10/10 過)、真實整合測試(`tests/timestamp/rfc3161.integration.smoke.js`,對 DigiCert 與 Sectigo 皆 4/4 過)——**2026-09-12 完成**
- [x] 接進正式流程(`server/workflowApi.js` 的 `revalidateCase()`)並部署到 `https://mandate.david460525.workers.dev`——**2026-09-12 完成**,細節見上方「2026-09-12 現況」;既有 `tests/trust/smoke.js`(43+ 項)、`tests/workflow/smoke.js`、`tests/trust/live-extras.smoke.js`、`tests/dpp/smoke.js`、`tests/ui/static-contract.js` 全部重跑確認零回歸,新增 `tests/workflow/timestampIntegration.smoke.js` 驗證真實接線;已在真實部署的 Workers 上跑過一次完整流程並讀回真實 tsToken。
- [ ] `docs/作品說明.txt` 貳、五與肆、四的時戳敘述仍是現在式——現在反而更需要處理,因為現在**已經是真的實作+已部署**,原本「文件寫太早」的問題變成「文件的現在式描述終於對得上程式碼了,但措辭本身(何時完成、對接哪個 TSA)可以更精確」,建議下一步處理
- [ ] eTSCA 是否重新開放受理,若賽後想真的採購正式服務,需要重新查證最新狀態(`記憶.md` 第71行的查證時間點是先前某次 session,可能已過期)
- [ ] DigiCert 公開端點沒有找到官方速率限制文件(見實驗記錄),`services/timestamp/index.js` 目前沒有內建重試/節流邏輯,`revalidateCase()` 目前也沒有針對這個 endpoint 額外節流——demo 場景下呼叫頻率低,風險可控,但若之後要開放給多個使用者同時操作,建議先補上
- [ ] `mandate` repo 裡這次的所有改動(`services/timestamp/`、`docs/trust/RFC3161_TIMESTAMP_PLAN.md`、`server/workflowApi.js`、`server/workflowStore.js`、`worker/index.js`、`wrangler.toml`、`package.json`、`tests/`)**都還沒 commit**,只有本機檔案變更 + 已部署的 Workers 版本,git 歷史目前對不上線上版本
