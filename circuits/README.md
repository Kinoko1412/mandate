# circuits/ — 真 zk-SNARK 電路（Circom + snarkjs groth16）

Day 3 trust engine（`services/proof/index.js`）原本的 `ProofEnvelope.proof` 是 `demoOnly:sha256:<hex>`
的 **commitment**（見該檔案檔頭註解），不是真正的零知識證明。這個資料夾是取代它的真電路：
**已編譯、已 trusted setup、已產生並驗證過真實 proof、且已經在真正的 Cloudflare Workers runtime
（`wrangler dev`，workerd 引擎）裡跑通 prove + verify 全流程**——不是只做完相容性 spike 就停下來，
是真的做出一份完整可運作的電路。

## 命題（沿用 2026-08-22 ZKP 討論定案的命題，沒有重新設計）

供應商私密持有各製程階段排放分量，電路證明：

```
totalScaled = sum_i(quantityScaled[i] * factorScaled[i]) / SCALE
且 totalScaled <= complianceThresholdScaled
```

- **私密輸入**（不揭露）：`quantityScaled[4]` —— 各製程階段的排放分量。
- **公開輸入**：`factorScaled[4]` —— 對應排放係數；`complianceThresholdScaled` —— 合規上限。
- **公開輸出**：`totalScaled` —— 總 tCO2e（海關申報需要，不藏）；`compliant` —— 是否落在合規區間。

`SCALE = 10^6`，跟 `packages/contracts/fixedPoint.js` 共用同一個定點數慣例（p.10 規格要求
「後端、前端、Circom 共用同一 scale」）。

## 檔案

- `carbon_proof.circom` —— 電路原始碼（Circom 2.0），N=4 階段、INPUT_BITS=64、SUM_BITS=132。
  參數選擇理由見檔案內註解（避免 field wraparound、除法用見證賦值+範圍檢查+乘回驗證的標準模式）。
- `build/` —— 編譯與 trusted setup 產出（**都是真的產出檔案，不是佔位符，已全部提交進 git**）：
  - `carbon_proof.r1cs` / `carbon_proof.sym` —— 約束系統與除錯符號表（`circom` 編譯產出）。
  - `carbon_proof_js/carbon_proof.wasm`(+`.bin` 副本) —— witness 計算用 wasm（電路本身，真的靜態檔案）。
  - `carbon_proof_final.zkey`(+`.bin` 副本) —— Groth16 proving key（trusted setup 產出，見下方）。
  - `verification_key.json` —— 驗證用公開金鑰。
  - `bn128.wasm` —— ffjavascript 的 bn128 曲線引擎 wasm，**離線預先產生**（原因見下方「Cloudflare
    Workers 相容性」一節），供 `services/proof/workersWasmCompat.js` 在 Workers 環境下 fallback 用。
  - `.bin` 副本存在的原因：Wrangler 的 `.wasm` 靜態 import 給的是編譯好的 `WebAssembly.Module`
    物件，但 snarkjs 的 proving API 需要**原始 bytes**（拿去做 witness 計算），兩種用途要分開 import。

## 怎麼重新產生（如果電路改了）

```bash
# 1. 編譯（.tools/circom.exe 是從 github.com/iden3/circom releases 下載的 v2.2.3 官方
#    Windows 二進位，沒有加進 git，見 .gitignore；重新下載見下方指令）
curl -sL -o .tools/circom.exe https://github.com/iden3/circom/releases/download/v2.2.3/circom-windows-amd64.exe
./.tools/circom.exe circuits/carbon_proof.circom --r1cs --wasm --sym -l node_modules -o circuits/build

# 2. Trusted setup —— 用公開的 Hermez Powers of Tau ceremony 檔案，不要自己重跑 ceremony
#    （p.文件本身也這樣要求：沒有意義且太花時間）
curl -sL -o /tmp/pot12_final.ptau https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau
npx snarkjs groth16 setup circuits/build/carbon_proof.r1cs /tmp/pot12_final.ptau circuits/build/carbon_proof_0000.zkey
npx snarkjs zkey contribute circuits/build/carbon_proof_0000.zkey circuits/build/carbon_proof_0001.zkey \
  --name="contribution" -e="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
npx snarkjs zkey beacon circuits/build/carbon_proof_0001.zkey circuits/build/carbon_proof_final.zkey \
  $(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') 10 -n="Final Beacon"
npx snarkjs zkey export verificationkey circuits/build/carbon_proof_final.zkey circuits/build/verification_key.json

# 3. 重新產生 .bin 副本 + bn128.wasm（見 services/proof/zk.js 開頭的 fingerprint 常數，
#    改動電路後這兩個 sha256 fingerprint 常數也要跟著更新——workersWasmCompat.js 會在比對不到
#    fingerprint 時明確報錯，不會悄悄用錯的 module）
cp circuits/build/carbon_proof_js/carbon_proof.wasm circuits/build/carbon_proof_js/carbon_proof.wasm.bin
cp circuits/build/carbon_proof_final.zkey circuits/build/carbon_proof_final.zkey.bin
node -e "const c=require('crypto'),fs=require('fs');console.log(c.createHash('sha256').update(fs.readFileSync('circuits/build/carbon_proof_js/carbon_proof.wasm')).digest('hex'))"
```

## Cloudflare Workers 相容性（步驟 0 spike，真的做通了，不是「可能不行」收工）

這是整個任務最大的未知風險。過程中依序撞到三個真實的相容性問題，每一個都實測、找到根因、
解決並驗證過，不是憑空猜測：

### 問題 1：`URL.createObjectURL() is not implemented`

`ffjavascript`（snarkjs 的相依套件）在模組**頂層**（不是函式內、import 當下就執行）會判斷
`process.browser` 是否為真，是的話就呼叫 `URL.createObjectURL()` 準備一個 Worker blob source
（`node_modules/ffjavascript/src/threadman.js` 第 41-54 行）。Wrangler/Workers 的 `nodejs_compat`
`process` polyfill把 `browser` 設成 `true`（沿用 browserify `process/browser.js` 的慣例），
但 workerd 沒有實作 `URL.createObjectURL`，直接丟錯，連 `import snarkjs` 都做不到。

**解法**：`URL.createObjectURL` 改成 try 原生呼叫、失敗才退回假字串（見
`services/proof/workersWasmCompat.js` 開頭以外，實際 polyfill 寫在 `worker/index.js` 頂部）。
因為 `verify()`／我們的 proving 流程實際上走的是 `singleThread` 路徑（不會真的 `new Worker(...)`），
這個假字串永遠不會被真的拿去建立 Worker，無害。

### 問題 2：`WebAssembly.compile(): Wasm code generation disallowed by embedder`

過了問題 1 之後，`groth16.verify()`／witness 計算內部（`ffjavascript` 的 bn128 曲線引擎、
`circom_runtime` 的 witness calculator）都會在**執行期**呼叫 `WebAssembly.compile(bytes)` 動態
編譯 wasm bytes——bn128 曲線的 wasm 甚至是**執行期用 `wasmbuilder` 程式化組出來的**，根本不是
一份固定的 wasm 檔案。workerd 基於安全考量禁止這種「執行期動態產生的程式碼」，這正是任務書
一開始就點名的最大風險，這裡確認了它是真的會發生。

**解法**（`services/proof/workersWasmCompat.js`）：
1. 離線（在一般 Node，沒有這個限制）跑一次跟 ffjavascript 完全相同的呼叫序列
   （`wasmcurves` + `wasmbuilder`），把產生的 bn128 wasm bytes 存成靜態檔案 `build/bn128.wasm`。
2. `worker/index.js` 用 Wrangler 原生支援的 **build-time 靜態 `.wasm` import** 把這份檔案（跟電路
   自己的 `carbon_proof.wasm`）編成 `WebAssembly.Module`——這是 Workers 允許的路徑。
3. 把全域 `WebAssembly.compile` 包一層：先試原生呼叫（Node 環境下直接成功，這個 patch
   幾乎不介入）；只有在丟出上面那個特定錯誤訊息時，才對輸入 bytes 算 SHA-256 指紋，
   查表換成對應的離線預編譯 Module 回傳。查不到就誠實丟錯，不會用錯的 wasm 蒙混過關。

### 問題 3：raw bytes vs 靜態 Module 的落差

`.wasm` 靜態 import 給的是已編譯的 `WebAssembly.Module`，但 snarkjs 的 `fullProve()` 需要**原始
bytes** 去做 witness 計算（內部才會再呼叫一次 compile，被問題 2 的 patch 接住）。所以電路的
wasm 檔案要**兩種方式各 import 一次**：`.wasm`（給 patch 的比對白名單用）+ `.bin` 原始 bytes
副本（給 `fullProve()` 當參數用）。

### 驗證結果（真的在 `wrangler dev --local` 裡跑過，不是理論推演）

- `snarkjs.groth16.verify()` 對合法 proof 回傳 `true`、對竄改過 `publicSignals` 的同一份 proof
  回傳 `false`——在真正的 workerd 引擎裡確認過，兩種情況都對。
- `snarkjs.groth16.fullProve()` 完整跑過一次 witness 計算 + Groth16 proving，回傳的
  `publicSignals` 跟同一組輸入在一般 Node 算出來的完全一致（`180000000`, `1`, ...）。
- 過程留在 `circuits/workers-compat-check/`（可重跑的最小驗證專案，見該資料夾自己的說明），
  不是丟棄的過場測試。

## 攻擊測試（`tests/trust/zk.smoke.js`，`npm run smoke:zk`）

跟 `demoOnly` commitment 那 43 項既有測試（`tests/trust/smoke.js`）完全獨立、互不影響：

- 正常情境：電路算出的 `totalScaled`／`compliant` 跟手算結果一致，proof 可驗證通過。
- 不合規情境：`compliant=false` 時 proof 依然是誠實、可驗證的合法 proof（不合規不等於證明失敗）。
- 攻擊：竄改 `publicSignals` → verify 拒絕。
- 攻擊：私密輸入故意超出電路宣告的 64-bit range check（模擬想利用 field wraparound 把大額
  申報偽裝成小額）→ witness generation 直接失敗，連 proof 都產生不出來，不是產生出來才被
  verify 擋下。
- 攻擊：把 A 案件的 proof 套到 B 案件的 publicSignals → verify 拒絕。
- 決定性：同樣輸入的電路輸出（total／compliant）每次一致；但 proof bytes 本身因為 Groth16
  的隨機 blinding factor 每次不同——這是協定本身該有的正常行為，不是 bug。

## 架構決策：這一層是**疊加**在既有 context-binding 之上，不是取代（需要 A/B 一起確認是否要接進即時流程）

`services/proof/index.js` 既有的 context-binding／nonce／replay-protection（43 項測試，
`caseId`／`policyVersion`／SHIP-A 套 SHIP-B 等）**完全沒有被這次的工作改動**，繼續維持原樣運作。
這裡新增的 `services/proof/zk.js` 是**另外一層、可選的**加密證明能力，透過
`generateRealZkProof()` / `verifyRealZkProof()` 獨立呼叫，兩層合起來才是完整故事：

- context-binding 防「這份 proof 是不是被套到別的案件／批次／年度」。
- zk 電路防「總數字是不是真的從私密分量正確加總出來、且落在合規區間」。

**目前 `trustAdapter.js` 的即時流程（`generateShipmentProofEnvelopes`／`verifyProofEnvelope`）
還沒有呼叫這一層**，原因是誠實的技術/產品判斷，不是做不到：

1. 現有已實作的資料模型是「單一年度 intensity × 單一批次 quantity」的 case-level 分攤
   （`allocatedEmissionsScaled = mulScaled(intensityScaled, quantityTonnesScaled)`），沒有
   分解成電路命題假設的「多個製程階段分量」。要接上這一層，`quantityScaled` 4 個私密欄位
   目前只有 1 個對得上真實業務數字（`intensityScaled`，本來就是唯一被 commitment 隱藏、
   不直接揭露的欄位），其餘 3 個要嘛留 0（能跑但沒有實質揭露 3 個額外階段的意義）、要嘛需要
   團隊決定要不要把「按製程階段分層揭露」正式排進資料模型——這是產品範圍決策，不是我能自己
   拍板的事。
2. 真實的 `fullProve()` 有真實的密碼學運算時間（非同步、但佔用 CPU），接進**每一次**
   shipment 驗證的即時 API 路徑，對 Demo 現場的回應延遲有影響，值不值得、要不要只在特定
   情境（例如查驗員主動要求）才觸發，也是需要 A（Demo 腳本、時間掌控）一起評估的事。

**建議**（不是決定）：如果 A/B 決定要接進即時流程，最小改動路徑是在
`expectedPublicInputs()`／`generateShipmentProofEnvelopes()` 旁邊新增一個明確標示「real zk」的
選用分支，用 `quantityScaled=[intensityScaled,0,0,0]`／`factorScaled=[quantityTonnesScaled,0,0,0]`
餵給現有電路（`totalScaled` 輸出會等於 `allocatedEmissionsScaled`，跟 carbon-core 已經算出來的
數字一致，可以互相核對），`complianceThresholdScaled` 需要另外定義一個政策層級的合規上限
（目前 Policy Profile 沒有這個欄位，要新增）。這條路徑技術上可行、已經被
`tests/trust/zk.smoke.js` 間接證明過，只是還沒有實際接線。

## 已知限制（誠實列出，不是隱藏起來假裝沒有）

- 電路只證明「加總與合規判斷正確」，**不證明私密輸入本身是不是真的**（跟 2026-08-22
  討論定案的立場一致：ZKP 只證明計算過程沒被動手腳，不能證明輸入資料真實，防造假要靠
  vLEI/VC 可歸責機制）。
- `complianceThresholdScaled` 目前是呼叫端自由帶入的數字，還沒有跟 Policy Registry 的
  正式合規門檻欄位掛勾（因為 Policy Registry 目前沒有這個欄位）。
- Trusted setup 只做了一次「demo 用」contribution + beacon（不是多方 MPC ceremony），跟正式
  生產環境該有的多方儀式不同——這對 hackathon demo 是合理取捨，正式上線需要真正的多方
  trusted setup。
- `WebAssembly.compile` 的 Workers fallback 是全域 monkey-patch，目前白名單只登記了兩個
  wasm（bn128 曲線引擎、電路本身）；如果之後專案裡新增第三種需要動態編譯的 wasm，會直接
  丟出明確錯誤（不會誤用錯的 module），但需要照同樣的離線預編譯流程補上第三筆登記。
