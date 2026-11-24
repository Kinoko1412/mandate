# Spike：ME 上的 Know-Your-Agent 額度合約（Day 1 可行性驗證）

> 發派：2026-11-24，筆電（documents-fc）→ 32GB。完成後請回報給筆電端工作階段 `documents-fc`。
> 方向（使用者 2026-11-24 決定）：**ME 生態裡的 AI 代理付款**：ME Pass 用戶的 AI 代理，在鏈上額度內付 MEC 購買 ME 生態裡的服務；賣方（另一個 ME DApp 或服務）出貨前查「這個代理背後是 ACTIVE、KYC 等級達標的 ME ID，額度還夠、沒被撤銷」。
> 背景：先讀 `docs/beacon/HANDOFF.md` 最上面一節和 `docs/beacon/ME_NETWORK_TECH_NOTES.md`。HANDOFF 第 2～4 節是舊方向，**不要照那裡做**。

## 這次只回答一個問題
**哪條技術路線能在 ME 測試網上真的跑通「授權 → 額度內付款成功 → 超額被擋 → 撤銷後被擋」，而且「背後是 ME ID」由鏈上檢查？**
這一步不做產品、不做畫面。

## 已查證的事實（2026-11-24，不用重查）
- ME ID 主帳戶一定是 **Cosmos secp256k1** 金鑰。測試網 244 個 DID 裡 237 個是 `/cosmos.crypto.secp256k1.PubKey`，0 個是 ethsecp256k1。`x/kyc/keeper/msg_server_sub_account.go` 也規定主帳戶不能是 eth 帳戶。**MetaMask／0x 地址查不到 ME ID。**
- 子帳戶（ETH 地址）查 `/metaearth/did/did?address=` 會回 `DID not found`。
- CosmWasm 可以透過 Stargate 查 `/metaearth.did.Query/Did`（`app/keepers/wasm_me_query.go`，白名單只有 3 條，沒有 EVM 查詢）。節點是 wasmd v0.43.0、wasmvm v1.4.1，SDK 是 v0.47.13 的 fork。
- 測試網 `code_upload_access = Everybody`。
- authz、feegrant 模組已啟用。authz 不能包 `MsgEthereumTx`。EVM 交易不走 feegrant。
- 手續費分潤（`app/ante/fee_deduct.go`）：一筆交易**只有** `MsgExecuteContract` 時，40% 給合約建立者。用 `MsgExec` 包起來就拿不到。
- CosmJS 的 `accountFromAny` 不認 `/ethermint.types.v1.EthAccount`。官方 JS SDK（`openmetaearth/meta-earth-js-sdk@a56f3e9`）的 `src/me-client-utils/` 有自己組交易、用 REST 讀帳戶的做法，金鑰路徑是 m/44'/118'，前綴 `me`。npm 上裝不到，要直接複製原始碼。
- ME Pass 開放平台文件（https://mepassportal-open.mec.me/zh-TW/docs/article_1 ～ article_5）有 JSBridge `sendAuthSign`，`type` 可以是 `'MsgSend' | 'MsgNewRecord' | 'MsgExecuteContract' | string`；`getUserInfo` 會回 `authStatus`。
- 測試網：REST（HTTPS）`https://beta-hub-1317.explorer-testnet.me`，RPC `https://beta-hub-26657.explorer-testnet.me`，chain-id `mechain_400-1`。單位：1 MEC = 10^8 umec（請再確認 denom 名稱）。
- 水龍頭只能**手動**領（每個地址每天 2 MEC，要 email 驗證碼），Testnet ME ID 也在水龍頭頁面手動申請。**這兩件事要使用者本人做。**

## 兩條路線都要試（兩位審查者意見相反，用實測決定）
**路線 1：單一 CosmWasm「KYA 額度合約」**（生態負責人建議）
- 店主預存 MEC 預算進合約 → 設定代理地址、單筆上限、每期額度（滾動期間）、到期時間。
- 代理呼叫 `spend { to, amount, memo }`：合約即時用 Stargate 查店主的 DID，必須 `status == ACTIVE` 且 `kycLevel >= 門檻`，再檢查額度、到期、撤銷，通過才轉帳給賣方。
- 店主可以 `revoke`；任何人可以 `query agent_status { agent }`。
- 必須相容 **cosmwasm-std 1.x**（wasmvm 1.4），不能用 2.x。用 Docker 的 `cosmwasm/optimizer`（選相容 1.x 的版本）建置，避免 bulk-memory／reference-types 被拒。
- 用 cw-multi-test 寫單元測試，Stargate 的 DID 查詢要用 mock。

**路線 2：原生 authz**（工程師建議）
- 店主 `MsgGrant(SendAuthorization{spend_limit, allow_list=[賣方]}, expiration)`，加上 `MsgGrantAllowance`（feegrant）。
- 代理 `MsgExec(MsgSend)`；撤銷用 `MsgRevoke`。
- 「背後是 ME ID」由賣方或查詢端查授權人的 DID。注意：這不是鏈上強制。
- 要確認：ME fork 的 `SendAuthorization` 有沒有 `allow_list`。

## 要交付的東西
1. 新分支 **`beacon/kya-spike`**，從 `beacon/me-network` 開，**推到 `origin`（Kinoko1412/mandate）**。不要推 `main`，也不要推隊友的 `team` repo。
2. `contracts/kya-cw/`：路線 1 的合約原始碼、單元測試、建置腳本，以及 optimizer 產出的 `.wasm` 的 sha256（`.wasm` 本身不要 commit）。
3. `tools/me-tx/`：Node 腳本，至少能：
   - 產生 Cosmos 金鑰（m/44'/118'，前綴 `me`），**私鑰存在 repo 外面**（例如 `~/.mandate-secrets/`），只印出地址。
   - 用 REST 讀帳戶（要能處理 EthAccount），簽名並廣播：`MsgStoreCode`、`MsgInstantiateContract`、`MsgExecuteContract`、`MsgGrant`、`MsgExec`、`MsgRevoke`、`MsgGrantAllowance`。
   - 一個 `e2e` 指令，帳戶有錢之後一次跑完兩條路線的「授權 → 額度內成功 → 超額被擋 → 撤銷後被擋」，把每筆 tx hash 和結果寫進 `docs/beacon/SPIKE_RESULT.md`。
4. 在沒有測試幣之前，先做到能做的部分：
   - 產生 3 個測試地址（店主、代理、賣方），把地址回報給筆電端，由使用者手動去領測試幣、申請 Testnet ME ID。
   - 唯讀驗證：找一個測試網上已有 DID 的地址，用 REST 和（如果做得到）合約的 query 模擬確認 Stargate 查詢的回應格式。
   - 能 `simulate` 的就先 simulate。
5. 回報：`SPIKE_RESULT.md` 加一段結論，寫明每條路線**實測**到哪一步、卡在哪裡、建議選哪條，以及哪些還沒驗證。

## 規則
- **不碰任何人的私鑰**：只用自己產生的測試網金鑰。這只是測試網，不要動主網。
- 不 commit 秘密（金鑰、助記詞、`.env`）。
- 不改 `server/policy.js` 和其他舊功能，這個 spike 只新增檔案。
- 判斷不了、或需要使用者本人做的事（領測試幣、申請 Testnet ME ID、email 驗證碼），直接停下來回報，不要繞過。
- 子 agent 照 32GB 的 `agent-cap.ps1` 上限派。結束時關掉自己開的 Docker 容器、dev server。
