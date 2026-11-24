# KYA spike 結果（Day 1）

> 任務：`docs/beacon/SPIKE_KYA_DAY1.md`｜分支 `beacon/kya-spike`｜執行機器：32GB
> 狀態（2026-11-24）：**還沒有測試幣，鏈上 e2e 還沒跑**。以下分成「已實測」「已查原始碼」「還沒驗證」三類。

## 結論（暫定，等 e2e 跑完再更新）
- **路線 2（authz）**：訊息層面已經確認可行。帶 `allow_list` 的 `MsgGrant(SendAuthorization)` 和 `MsgGrantAllowance` 在測試網 simulate 都通過。缺點是「背後是 ME ID」**不是鏈上強制**，只能由賣方或查詢端自己查。
- **路線 1（CosmWasm）**：合約和測試都寫好了，ME ID 是**鏈上強制**（Stargate 查 DID）。還沒編譯、還沒上鏈：本機沒有 Rust，建置交給 GitHub Actions。
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

## 已查原始碼（不是實測）
- `openmetaearth/me-hub` 的 `app/keepers/wasm_me_query.go`：Stargate 白名單有 `/metaearth.wstaking.Query/FixedDeposit`、`/metaearth.wstaking.Query/Region`、`/metaearth.did.Query/Did` 這三條。
- wasmd v0.43.0 的 `AcceptListStargateQuerier` 會呼叫 `ConvertProtoToJSONMarshal` → **合約收到的是 JSON，不是 protobuf**。request 的 `data` 要是 protobuf 編碼的 `QueryDid{address}`。合約的 `src/did.rs` 照這個格式寫，並用測試網實際 JSON 做單元測試。
- `proto/metaearth/did/did.proto`：`DidStatus`（INACTIVE=0、ACTIVE=1），`KycLevel`（NONE=0、ONE=1、TWO=2）。
- ME 的 cosmos-sdk fork（`v0.47.13-me-collect-genesis`）的 `SendAuthorization` **有 `allow_list`**。
- `go.mod`：wasmd v0.43.0、wasmvm v1.4.1，和任務檔一致。

## 還沒驗證
- 路線 1：合約能不能編譯、cw-multi-test 測試能不能通過（等 CI）、optimizer 產物能不能通過 `cosmwasm-check`（wasmvm 1.4 capabilities）、上鏈的 `MsgStoreCode`、Stargate 查 DID 在鏈上的實際回應（特別是查不到 DID 時，錯誤是 SystemResult 還是 ContractResult；合約兩種都當成「沒有 ME ID」處理）。
- 路線 2：`MsgExec` 超額或撤銷後的錯誤訊息、feegrant 實際扣款、`allow_list` 擋下非白名單收款人。
- 兩條路線的簽名和廣播（`tools/me-tx/lib.js` 的 `signAndBroadcast`）都要等帳戶有錢才能測。

## 待辦和注意
- **@cosmjs 0.32.4 有安全性棄用警告**（elliptic 有已知問題，見 cosmos/cosmjs#1708）。目前只用在測試網金鑰，可以接受；之後要升到 ≥ 0.34。
- 本機安裝 Rust（rustup）在 32GB 被 Claude Code 的自動權限審核擋下，等使用者決定。在那之前，合約的編譯和測試全部靠 GitHub Actions。
- GitHub token 沒有 `workflow` scope，`.github/workflows/kya-cw.yml` 推不上去，要使用者跑 `gh auth refresh -h github.com -s workflow`。

## 怎麼跑
```
cd tools/me-tx && npm install
node keygen.js owner agent seller      # 已產生；助記詞在 ~/.mandate-secrets/me-testnet-keys.json
node cli.js status                      # 三個地址的餘額和 ME ID
node cli.js probe-sim                   # 路線 2 唯讀 simulate
node cli.js e2e-authz                   # 有測試幣之後
node cli.js e2e-cw <CI 產出的 kya_cw.wasm>
```

## 實測紀錄
（`cli.js` 會把每筆交易附加在這一節下面）
