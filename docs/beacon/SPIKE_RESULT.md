# KYA spike 結果（Day 1）

> 任務：`docs/beacon/SPIKE_KYA_DAY1.md`｜分支 `beacon/kya-spike`｜執行機器：32GB
> 狀態（2026-11-24）：**還沒有測試幣，鏈上 e2e 還沒跑**。以下分成「已實測」「已查原始碼」「還沒驗證」三類。

## 結論（2026-11-24 測試網實測後更新）
- **路線 2（authz）：在測試網跑通。** 授權（MsgGrant + allow_list，加上 feegrant）→ 額度內付款 0.05 MEC 成功（賣方實收 5000000 umec）→ 超額被擋（`requested amount is more than spend limit`）→ 付給非白名單地址被擋（`cannot send to … address: unauthorized`）→ 撤銷後被擋（`authorization not found`）。每一步都有 tx hash，見下面的實測紀錄。缺點是「背後是 ME ID」**不是鏈上強制**。
- **路線 1（CosmWasm）：已上鏈，鏈上 ME ID 檢查已證實可用。** code_id 37，合約 `me1pkm9d3556jcnvnfgxmfa0mzrf0t59c43fx53mz32yvmpfvyq2s8qx0dce3`（wasm sha256 `42a7d5a7…74db`，CI run 45353629950，commit 3342f0a）。店主還沒有 ME ID 時，代理付款被合約擋下，錯誤是 `owner has no ME ID on chain: codespace: did, code: 111`。這表示**合約透過 Stargate 查 `/metaearth.did.Query/Did` 在鏈上真的能用**；DID 查不到時，合約收到的是 ContractResult::Err。
- **待 DID**：店主的 Testnet ME ID 下來之後，跑 `node cli.js e2e-cw --contract me1pkm9…dce3`，補完正向流程：額度內成功 → 超過單筆上限被擋 → 超過每期額度被擋 → 非白名單被擋 → 撤銷後被擋。也要確認 ACTIVE 時 Stargate 的 JSON 和 REST 一樣。
- **等店主 DID（2026-11-24）**：使用者 16:27 替店主地址申請 Testnet ME ID（Advanced Verification），頁面顯示 Application Successful。32GB 從 16:28 起每 2.5 分鐘查 `/metaearth/did/did?address=me1hxf7…law7c`，到 17:58 共查 36 次，都是 `codespace did code 111: DID not found`。查鏈上交易紀錄（`transfer.recipient`／`message.sender` = 店主），只有我們自己發出的 13 筆，沒有任何 DID 或 KYC 相關交易。推測申請還在鏈下審核，沒有上鏈（**未驗證**，看不到審核狀態）。上一次選 Real-Person 也一直停在 Unverified。正向流程還沒跑。
- **測試用變體（2026-11-27）：借用他人公開 DID，只證明合約邏輯，不能當 Demo。** 店主的 ME ID 還在等官方回覆，所以另外建了 feature `test-did-subject` 的變體（`kya_cw_testdid.wasm`，sha256 `520be145…c726`，CI run 46005233620，commit 75f927f）。這個變體讓 spend 改查 `did_subject` 的 ME ID；資金、授權、撤銷仍然只認店主，config 會回傳 `test_only: true`。上鏈後是 **code_id 51**。
  - 正向合約 `me1075jr6qsl5vvnf4jt9xh9f947wvjr4djlf743vqjw65wcyfrhnzses9zea`（did_subject = `me17har8vf5x7z7kcy0kxcga32flk7rzs9kcpdgf4`，ACTIVE／KYC_LEVEL_TWO，min_kyc_level 1）：額度內 0.05 MEC 成功，賣方實收 5000000 umec → 超過單筆上限被擋 → 再付 0.1 成功，累計達到每期上限 → 超過每期額度被擋 → 非白名單被擋 → 撤銷 → 撤銷後被擋 → withdraw。**全部符合預期。**
  - 反例合約 `me1jy9xw4450y89t7csxfmq7hlysvx53r6r6peeqwljzdmkxljrluvqewwwdc`（did_subject = `me1p4che2r9385jqdtgshl5qs3pj32ezf56yzulzp`，ACTIVE／KYC_LEVEL_ONE，min_kyc_level 2）：付款被擋，錯誤是 `owner ME ID not eligible: status=DID_STATUS_ACTIVE kyc_level=1 (need ACTIVE and >= 2)`。
  - **新證實**：DID 存在時，合約透過 Stargate 拿到的 JSON 在鏈上能正確解析（`found=true`、`status=DID_STATUS_ACTIVE`、`kyc_level=2`），和 REST 的格式一致。
  - 測試網 `did_infos` 一共 258 筆，全部是 ACTIVE（TWO 165、ONE 93），找不到 INACTIVE 或 NONE 的地址，所以「DID 停用被擋」只在 cw-multi-test 驗證過。
  - 正式版（code_id 37，合約 `me1pkm9…dce3`）的邏輯沒有動。店主拿到 ME ID 後再跑 `node cli.js e2e-cw --contract me1pkm9d3556jcnvnfgxmfa0mzrf0t59c43fx53mz32yvmpfvyq2s8qx0dce3`。下表裡「合約內即時查店主 ME ID」那一步，在測試變體實際查的是 did_subject。
- **建議：路線 1 為主。** 只有路線 1 能做到「背後是 ME ID 由鏈上強制檢查」，交易也只有一筆 MsgExecuteContract，可以拿 40% 手續費分潤。路線 2 當備援，或拿來對照說明「為什麼需要合約」。

### 踩到的坑（已修）
1. **測試網每筆最低手續費 10000 umec**，不是按 gas price 算（錯誤：`fee must greater than or equal 10000umec`）。`lib.js` 已改成取 max(10000, gas × 0.02)。
2. **ME 測試網的 Gatekeeper 拒絕 wasm 浮點指令**（`Float operator detected: F32Load`），但 **cosmwasm-check 1.5.8 判 pass，沒抓到**。來源是 serde 的 untagged enum 和 deserialize_any。DID 欄位已改成只用字串解析，CI 也加了 `wasm-objdump` 浮點指令掃描。
3. 第一次 authz 實測因為手續費不足，所有交易都在 CheckTx 被拒，預期失敗的步驟被誤判為 PASS。已刪掉那批紀錄，並改成預期失敗的步驟必須核對失敗原因。

### 測試幣用量
店主：store code 0.00602 MEC，加上預存 0.5 MEC（還在合約裡，可以 withdraw），加上路線 2 付出的 0.05 MEC，以及數筆 0.0001 MEC 的手續費。

## 已實測（測試網唯讀，2026-11-24）
| 項目 | 結果 |
|---|---|
| denom | `/cosmos/bank/v1beta1/denoms_metadata`：base `umec`，`MEC` exponent 8 → **1 MEC = 10^8 umec** |
| 節點版本 | `node_info`：app `med` v2.0.18，commit `e725a569`，CometBFT 0.37.5 |
| 手續費參考 | 測試網一筆實際 MsgSend：gas_limit 500000，fee 10000 umec（gas price 0.02）；gas_used 約 12 萬 |
| 簽名模式 | 實際交易是 `SIGN_MODE_DIRECT` 加 `/cosmos.crypto.secp256k1.PubKey`，和我們的金鑰一致 |
| 帳戶型別 | 前 80 個帳戶：BaseAccount 66、EthAccount 13、ModuleAccount 1。EthAccount 的 JSON 是 `base_account{address,pub_key,account_number,sequence}` 加 `code_hash`，`tools/me-tx/lib.js` 的 `getAccount` 已處理 |
| ME ID REST | `GET /metaearth/did/did?address=me1qzxz57yv6sekvkaahgh6tj6cwqc4ntc6xakplw` → `{"info":{"did":"2605105872869",…,"status":"DID_STATUS_ACTIVE","regionId":"me_earth","kycLevel":"KYC_LEVEL_TWO","sub_account":""}}`。列表類端點（`did_documents`、`dids`）回 Not Implemented |
| 我們的 3 個地址 | 格式合法（REST 接受），帳戶還不存在，餘額 0，沒有 ME ID |
| 路線 2 simulate | 拿一個鏈上已存在的帳戶當 granter 做 simulate（不簽名、不廣播、不改狀態）：`MsgGrant(SendAuthorization 0.1 MEC + allow_list)` **OK**，gas 194908；`MsgGrantAllowance(BasicAllowance)` **OK**，gas 190987；`MsgRevoke`（還沒有授權）照預期失敗，錯誤是 `authorization not found` |
| wasm 上傳權限 | `/cosmwasm/wasm/v1/codes/params`：`code_upload_access` 和 `instantiate_default_permission` 都是 `Everybody` |

## CI 實測（GitHub Actions，2026-11-24，run 45346142896）
| 項目 | 結果 |
|---|---|
| `cargo test` | 單元測試 2/2、cw-multi-test 4/4 通過：授權 → 額度內付款 → 超過單筆上限被擋 → 超過每期額度被擋 → 非白名單收款人被擋 → 下一期額度重置 → 撤銷後被擋；店主沒有 ME ID 被擋；KYC 等級不夠或 DID 停用被擋，恢復後放行；到期被擋；非店主不能提款 |
| optimizer | `cosmwasm/optimizer:0.15.1`，`kya_cw.wasm` 239419 bytes，**sha256 `78159810e83a6700559036f66c6a0b5aeff2e32e4ecf8b5d22058bde65fa3fa2`**。兩次建置的雜湊相同，可以重現 |
| cosmwasm-check 1.5.8 | capabilities 設為 iterator、staking、stargate、cosmwasm_1_1～1_4 → `pass` |
| 部署用檔案 | 只用 CI artifact `kya-cw-wasm`（上面的 sha256）。Cargo.lock 已 commit |

注意：cw-multi-test 的 Stargate 是 mock，回應格式照測試網 REST 的實際 JSON 寫。鏈上真實的 Stargate 回應要等上鏈才算驗證。

## 已查原始碼（不是實測）
- `openmetaearth/me-hub` 的 `app/keepers/wasm_me_query.go`：Stargate 白名單有 `/metaearth.wstaking.Query/FixedDeposit`、`/metaearth.wstaking.Query/Region`、`/metaearth.did.Query/Did` 這三條。
- wasmd v0.43.0 的 `AcceptListStargateQuerier` 會呼叫 `ConvertProtoToJSONMarshal` → **合約收到的是 JSON，不是 protobuf**。request 的 `data` 要是 protobuf 編碼的 `QueryDid{address}`。合約的 `src/did.rs` 照這個格式寫，並用測試網實際 JSON 做單元測試。
- `proto/metaearth/did/did.proto`：`DidStatus`（INACTIVE=0、ACTIVE=1），`KycLevel`（NONE=0、ONE=1、TWO=2）。
- ME 的 cosmos-sdk fork（`v0.47.13-me-collect-genesis`）的 `SendAuthorization` **有 `allow_list`**。
- `go.mod`：wasmd v0.43.0、wasmvm v1.4.1，和任務檔一致。

## 還沒驗證
- 路線 1：上鏈的 `MsgStoreCode`（wasm 能不能被節點接受）、Stargate 查 DID 在鏈上的實際回應（特別是查不到 DID 時，錯誤是 SystemResult 還是 ContractResult；合約兩種都當成「沒有 ME ID」處理）。
- 路線 2：`MsgExec` 超額或撤銷後的錯誤訊息、feegrant 實際扣款、`allow_list` 擋下非白名單收款人。
- 兩條路線的簽名和廣播（`tools/me-tx/lib.js` 的 `signAndBroadcast`）都要等帳戶有錢才能測。

## 待辦和注意
- **@cosmjs 0.32.4 有安全性棄用警告**（elliptic 有已知問題，見 cosmos/cosmjs#1708）。目前只用在測試網金鑰，可以接受；之後要升到 ≥ 0.34。
- 本機用 rustup 安裝 Rust 被 Claude Code 的自動權限審核擋下；使用者改決定在 32GB 安裝 Docker Desktop（已裝，要重開機才能用）。合約的編譯和測試目前都由 GitHub Actions 負責。
- `workflow` scope 已由使用者授權，CI 已上線。

## 怎麼跑
```
cd tools/me-tx && npm install
node keygen.js owner agent seller      # 已產生；助記詞在 ~/.mandate-secrets/me-testnet-keys.json
node cli.js status                      # 三個地址的餘額和 ME ID
node cli.js probe-sim                   # 路線 2 唯讀 simulate
node cli.js e2e-authz                   # 有測試幣之後
gh run download <run id> -n kya-cw-wasm -D contracts/kya-cw   # 取得 CI 產物
node cli.js e2e-cw ../../contracts/kya-cw/artifacts/kya_cw.wasm
```

## 實測紀錄
（`cli.js` 會把每筆交易附加在這一節下面）


### 路線 2 authz 實測（2026-11-24T08:05:47.282Z，chain-id mechain_400-1）

| 路線 | 步驟 | 預期 | 結果 | code | tx hash | 鏈上訊息 |
|---|---|---|---|---|---|---|
| 路線2 authz | 授權：MsgGrant(SendAuthorization 0.1 MEC, allow_list=[seller]) + MsgGrantAllowance | success | ✅ | 0 | `76CC15567CA145D6E6CC3968A1AA1605BD49E05146ABC39FFD2C470465539F71` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmos.authz.v1beta1.MsgGrant"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"module" |
| 路線2 authz | 額度內付款 0.05 MEC（MsgExec，手續費由 feegrant 付） | success | ✅ | 0 | `72DF3726FE94F0618AA8756CB08035DDEEDC9A89D0E7F49AA9132166068308F5` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmos.authz.v1beta1.MsgExec"},{"key":"sender","value":"me1hjgw84q08gy9h09kuwl6nds5h92ggvj70w5rq7"},{"key":"module", |
| 路線2 authz | 超額 0.08 MEC（剩餘額度 0.05） | fail | ✅ | 5 | `F570D6FAF8F6CE6DA50C821A4A13C88F6E54A0E7B9B312C5FA089C5E2E286C31` | failed to execute message; message index: 0: requested amount is more than spend limit: insufficient funds |
| 路線2 authz | 付給不在 allow_list 的地址 | fail | ✅ | 4 | `D5C08F29EF20531A34C07982A6B2DFF270EC8A14A8CCD516EF5111458FF06A18` | failed to execute message; message index: 0: cannot send to me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c address: unauthorized（已人工核對：這是 SDK SendAuthorization 的 allow_list 拒絕訊息；第一次跑時腳本的比對字串沒涵蓋這句，所以自動判成 ❌） |
| 路線2 authz | 撤銷：MsgRevoke | success | ✅ | 0 | `8ED5DC1F43A3D188B8721D72F55D7BF37E7B149EC0DB94341999AB53C0119083` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmos.authz.v1beta1.MsgRevoke"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"module |
| 路線2 authz | 撤銷後付款 0.01 MEC | fail | ✅ | 2 | `3412A6219E8DF9B96B7484C8B830909357DC49C99A55CD80CA01C06A905C89F1` | failed to execute message; message index: 0: failed to update grant with key ?????u??????o???????c??????:?[??????T?2^/cosmos.bank.v1beta1.MsgSend: authorization not found |
| 路線2 authz | 收尾：MsgRevokeAllowance | success | ✅ | 0 | `079BC3CE3CFB7DA3747B11E301498B92B44FBC636D492AAB8E97999B6CFA0992` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmos.feegrant.v1beta1.MsgRevokeAllowance"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{" |

### 路線 1 CosmWasm 實測（店主尚無 ME ID）（2026-11-24T08:05:59.407Z，chain-id mechain_400-1）

| 路線 | 步驟 | 預期 | 結果 | code | tx hash | 鏈上訊息 |
|---|---|---|---|---|---|---|
| 路線1 CosmWasm | MsgStoreCode（wasm sha256 78159810e83a…） | success | ❌ | -1 | `(simulate)` | failed to execute message; message index: 0: Error calling the VM: Error compiling Wasm: Could not compile: WebAssembly translation error: Error in middleware Gatekeeper: Float operator detected: F32L |

### 路線 1 CosmWasm 實測（店主尚無 ME ID）（2026-11-24T08:14:01.025Z，chain-id mechain_400-1）

| 路線 | 步驟 | 預期 | 結果 | code | tx hash | 鏈上訊息 |
|---|---|---|---|---|---|---|
| 路線1 CosmWasm | MsgStoreCode（wasm sha256 42a7d5a799c8…） | success | ✅ | 0 | `217D4C68FCFFB885D4A34EE4C83AD8AB5A6A8EE11F7E4CC5E847FEF1AC6E241F` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgStoreCode"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"module" |
| 路線1 CosmWasm | MsgInstantiateContract(code 37，預存 0.5 MEC) | success | ✅ | 0 | `3A2E1313BA31A523C49EBDF8351C21EA3F64172BD9537123BD92DCF3B08DF7DA` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgInstantiateContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key |
| 路線1 CosmWasm | 授權：grant（單筆 0.1、每日 0.15 MEC、7 天、allowed=[seller]） | success | ✅ | 0 | `A0CE491AA74A3B8CC45B106B5D2BACAF3DE3BD0C9641E26BF4BE80228AECC841` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"m |
| 路線1 CosmWasm | query agent_status：owner_me_id.found=false，can_spend_now=false | - | ✅ | - | `-` | codespace: did, code: 111 |
| 路線1 CosmWasm | 店主沒有 ME ID → 額度內付款 0.05 MEC 應被擋（鏈上 Stargate 查 DID） | fail | ✅ | 5 | `45FF1EC7B4DB6F454F9B808283F184193116205D504DCEA4CBC47D6E76FE13D3` | failed to execute message; message index: 0: owner has no ME ID on chain: codespace: did, code: 111: execute wasm contract failed |

### 測試用變體：借用他人公開 DID，只證明合約邏輯，不能當 Demo（2026-11-27T13:20:14.708Z，chain-id mechain_400-1）

| 路線 | 步驟 | 預期 | 結果 | code | tx hash | 鏈上訊息 |
|---|---|---|---|---|---|---|
| 路線1 TEST-ONLY 借用DID | MsgStoreCode（TEST ONLY wasm sha256 520be1454ee3…） | success | ✅ | 0 | `B88D6E517753B1CD36033A03FA15A46917B603BAAA211216D25B00B169E456C5` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgStoreCode"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"module" |
| 路線1 TEST-ONLY 借用DID | MsgInstantiateContract(code 51，預存 0.3 MEC，min_kyc_level=1，did_subject=me17har8vf5x7z7kcy0kxcga32flk7rzs9kcpdgf4) | success | ✅ | 0 | `28FF98DAFC02DB48FD5787415696E9206B3B64EC55B1B4C213AB38AFA0EA9435` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgInstantiateContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key |
| 路線1 TEST-ONLY 借用DID | query config：did_subject=me17har8vf5x7z7kcy0kxcga32flk7rzs9kcpdgf4，test_only=true | - | ✅ | - | `-` | contract me1075jr6qsl5vvnf4jt9xh9f947wvjr4djlf743vqjw65wcyfrhnzses9zea |
| 路線1 TEST-ONLY 借用DID | 授權：grant（單筆 0.1、每日 0.15 MEC、7 天、allowed=[seller]） | success | ✅ | 0 | `EB20CA2082E18E34D9287F169896BD9391FA723C8EB855895ABFFC9D7E8A7531` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"m |
| 路線1 TEST-ONLY 借用DID | query agent_status：owner_me_id.found=true，can_spend_now=true | - | ✅ | - | `-` | DID_STATUS_ACTIVE |
| 路線1 TEST-ONLY 借用DID | 額度內付款 0.05 MEC（合約內即時查店主 ME ID） | success | ✅ | 0 | `9FE2EB89CB630A5E0583B3330541F5DCC7DD574A229A5A733C6D4ACA7A51F7EB` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hjgw84q08gy9h09kuwl6nds5h92ggvj70w5rq7"},{"key":"m |
| 路線1 TEST-ONLY 借用DID | 超過單筆上限 0.2 MEC | fail | ✅ | 5 | `A7F7086827489205ED8CAA5C0883AD360EA291398687C285C5ADDCE419C974A3` | failed to execute message; message index: 0: amount 20000000 exceeds per-tx limit 10000000: execute wasm contract failed |
| 路線1 TEST-ONLY 借用DID | 額度內再付 0.1 MEC（累計 0.15 = 每期上限） | success | ✅ | 0 | `32F8DD59BEC2B5E60FD4E29A1EF065B73670E40D896149924B15616F592C3C86` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hjgw84q08gy9h09kuwl6nds5h92ggvj70w5rq7"},{"key":"m |
| 路線1 TEST-ONLY 借用DID | 超過每期額度（再付 0.00001 MEC） | fail | ✅ | 5 | `E4DA32C6AE028B7E0CF37F96A1B8F5AB799085AC3AE3CAC7235ED98213E6E530` | failed to execute message; message index: 0: amount 1000 exceeds remaining period allowance 0: execute wasm contract failed |
| 路線1 TEST-ONLY 借用DID | 付給不在 allowed_recipients 的地址 | fail | ✅ | 5 | `2EE2D9DF8463FC126A9E862C0F753EEB58C56A7B69EC6D70FE85EF471044DBD5` | failed to execute message; message index: 0: recipient me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c is not in allowed_recipients: execute wasm contract failed |
| 路線1 TEST-ONLY 借用DID | 撤銷：revoke | success | ✅ | 0 | `43FD857F6A8A68B9B185820722F78C90750BE30A7106BC538C8FCA129752E323` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"m |
| 路線1 TEST-ONLY 借用DID | 撤銷後付款 0.01 MEC | fail | ✅ | 5 | `05C72D1A9A3E751D868DD69D806EADF3D7058922FD358DFFA9FB61E655944A74` | failed to execute message; message index: 0: mandate revoked: execute wasm contract failed |
| 路線1 TEST-ONLY 借用DID | 收尾：withdraw 剩餘預算 | success | ✅ | 0 | `37C385B55C63CFC0F32CEDD56FFD7F42B6A924E3B3D4567B0FF4C03937C5B7AE` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"m |
| 路線1 TEST-ONLY 借用DID | MsgInstantiateContract(code 51，預存 0.01 MEC，min_kyc_level=2，did_subject=me1p4che2r9385jqdtgshl5qs3pj32ezf56yzulzp) | success | ✅ | 0 | `38F692D7EFD53A79EFD29D85FF70B477B55DE64F1B0D9135F1D9194BF0A33760` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgInstantiateContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key |
| 路線1 TEST-ONLY 借用DID | query config：did_subject=me1p4che2r9385jqdtgshl5qs3pj32ezf56yzulzp，test_only=true | - | ✅ | - | `-` | contract me1jy9xw4450y89t7csxfmq7hlysvx53r6r6peeqwljzdmkxljrluvqewwwdc |
| 路線1 TEST-ONLY 借用DID | 授權：grant（單筆 0.1、每日 0.15 MEC、7 天、allowed=[seller]） | success | ✅ | 0 | `7726688D5C426CDAF71030E6FEED9A3626D6882A0609AE14142E4120737CA46C` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"m |
| 路線1 TEST-ONLY 借用DID | query agent_status：owner_me_id.found=true，can_spend_now=false | - | ✅ | - | `-` | DID_STATUS_ACTIVE |
| 路線1 TEST-ONLY 借用DID | did_subject 等級低於門檻（min_kyc_level=2）→ 付款 0.01 MEC 應被擋 | fail | ✅ | 5 | `24C3C1B2F5F041965256BA32C38FA2DC9918F0BD986AE3B3958BC92ECD32E4E4` | failed to execute message; message index: 0: owner ME ID not eligible: status=DID_STATUS_ACTIVE kyc_level=1 (need ACTIVE and >= 2): execute wasm contract failed |
| 路線1 TEST-ONLY 借用DID | 收尾：withdraw 剩餘預算 | success | ✅ | 0 | `5397539A289A508BBAA325F6C8B997E13FA7009848BFEBCA1FA7AEB1A4AE344B` | [{"msg_index":0,"events":[{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"me1hxf7vagxkklc59wgs4h7nudc5ts0nrnrglaw7c"},{"key":"m |
