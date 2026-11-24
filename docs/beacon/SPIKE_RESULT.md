# KYA spike 結果（Day 1）

> 任務：`docs/beacon/SPIKE_KYA_DAY1.md`｜分支 `beacon/kya-spike`｜執行機器：32GB
> 狀態（2026-11-24）：**還沒有測試幣，鏈上 e2e 還沒跑**。以下分成「已實測」「已查原始碼」「還沒驗證」三類。

## 結論（暫定，等 e2e 跑完再更新）
- **路線 2（authz）**：訊息層面已經確認可行。帶 `allow_list` 的 `MsgGrant(SendAuthorization)` 和 `MsgGrantAllowance` 在測試網 simulate 都通過。缺點是「背後是 ME ID」**不是鏈上強制**，只能由賣方或查詢端自己查。
- **路線 1（CosmWasm）**：合約寫好了，ME ID 是**鏈上強制**（Stargate 查 DID）。CI 的單元測試和 cw-multi-test 6/6 通過；optimizer 產物通過 `cosmwasm-check`（以 wasmvm 1.4 的 capabilities 檢查）。**還沒上鏈**（等測試幣）。
- 暫時建議：**路線 1 為主、路線 2 為備援**。理由：題目要的是「背後是 ME ID 由鏈上檢查」，只有路線 1 做得到。路線 1 也只有一筆 `MsgExecuteContract`，可以拿到 40% 手續費分潤；路線 2 用 `MsgExec` 包起來就拿不到。這個建議要等實測確認 Stargate 查詢在鏈上真的能用。

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
