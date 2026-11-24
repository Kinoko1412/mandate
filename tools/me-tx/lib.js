// ME 測試網交易工具：用 REST 讀帳戶（可以處理 EthAccount）、SIGN_MODE_DIRECT 簽名、REST 廣播和 simulate。
// 不用 SigningStargateClient，因為 CosmJS 的 accountFromAny 不認得 /ethermint.types.v1.EthAccount。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DirectSecp256k1HdWallet, Registry, makeAuthInfoBytes, makeSignDoc, encodePubkey } = require('@cosmjs/proto-signing');
const { stringToPath } = require('@cosmjs/crypto');
const { toBase64, fromBase64, toHex, toUtf8 } = require('@cosmjs/encoding');
const { encodeSecp256k1Pubkey } = require('@cosmjs/amino');
const { TxRaw, TxBody } = require('cosmjs-types/cosmos/tx/v1beta1/tx');
const { MsgSend } = require('cosmjs-types/cosmos/bank/v1beta1/tx');
const { SendAuthorization } = require('cosmjs-types/cosmos/bank/v1beta1/authz');
const { MsgGrant, MsgExec, MsgRevoke } = require('cosmjs-types/cosmos/authz/v1beta1/tx');
const { MsgGrantAllowance, MsgRevokeAllowance } = require('cosmjs-types/cosmos/feegrant/v1beta1/tx');
const { BasicAllowance } = require('cosmjs-types/cosmos/feegrant/v1beta1/feegrant');
const { MsgStoreCode, MsgInstantiateContract, MsgExecuteContract } = require('cosmjs-types/cosmwasm/wasm/v1/tx');
const { Timestamp } = require('cosmjs-types/google/protobuf/timestamp');

const CFG = {
  rest: process.env.ME_REST_URL || 'https://beta-hub-1317.explorer-testnet.me',
  chainId: process.env.ME_CHAIN_ID || 'mechain_400-1',
  prefix: 'me',
  denom: 'umec', // 已用 /cosmos/bank/v1beta1/denoms_metadata 確認：MEC = 10^8 umec
  gasPrice: Number(process.env.ME_GAS_PRICE || '0.02'), // 測試網實際交易：500000 gas 付 10000 umec
  gasAdjust: 1.4,
  hdPath: "m/44'/118'/0'/0/0",
};
const SECRETS_FILE = path.join(process.env.MANDATE_SECRETS_DIR || path.join(os.homedir(), '.mandate-secrets'), 'me-testnet-keys.json');

const T = {
  MsgSend: '/cosmos.bank.v1beta1.MsgSend',
  SendAuthorization: '/cosmos.bank.v1beta1.SendAuthorization',
  MsgGrant: '/cosmos.authz.v1beta1.MsgGrant',
  MsgExec: '/cosmos.authz.v1beta1.MsgExec',
  MsgRevoke: '/cosmos.authz.v1beta1.MsgRevoke',
  MsgGrantAllowance: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
  MsgRevokeAllowance: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
  BasicAllowance: '/cosmos.feegrant.v1beta1.BasicAllowance',
  MsgStoreCode: '/cosmwasm.wasm.v1.MsgStoreCode',
  MsgInstantiateContract: '/cosmwasm.wasm.v1.MsgInstantiateContract',
  MsgExecuteContract: '/cosmwasm.wasm.v1.MsgExecuteContract',
};

const registry = new Registry([
  [T.MsgSend, MsgSend], [T.MsgGrant, MsgGrant], [T.MsgExec, MsgExec], [T.MsgRevoke, MsgRevoke],
  [T.MsgGrantAllowance, MsgGrantAllowance], [T.MsgRevokeAllowance, MsgRevokeAllowance],
  [T.MsgStoreCode, MsgStoreCode], [T.MsgInstantiateContract, MsgInstantiateContract], [T.MsgExecuteContract, MsgExecuteContract],
]);

async function http(method, p, body) {
  const res = await fetch(CFG.rest + p, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// ---- 金鑰 ----
async function loadWallet(role) {
  const store = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  if (!store[role]) throw new Error(`no key for role "${role}" in ${SECRETS_FILE}`);
  const w = await DirectSecp256k1HdWallet.fromMnemonic(store[role].mnemonic, { prefix: CFG.prefix, hdPaths: [stringToPath(CFG.hdPath)] });
  const [acc] = await w.getAccounts();
  return { wallet: w, address: acc.address, pubkey: acc.pubkey, role };
}
function addressOf(role) {
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'))[role].address;
}

// ---- 讀鏈 ----
// 回傳 { exists, accountNumber, sequence, type }；BaseAccount、EthAccount、vesting 都處理
async function getAccount(address) {
  const { status, json } = await http('GET', `/cosmos/auth/v1beta1/accounts/${address}`);
  if (status === 404 || (json.code && /not found/i.test(json.message || ''))) return { exists: false, accountNumber: 0, sequence: 0 };
  if (status !== 200) throw new Error(`getAccount ${status}: ${JSON.stringify(json)}`);
  const a = json.account;
  const base = a.base_account || (a.base_vesting_account && a.base_vesting_account.base_account) || a;
  return { exists: true, type: a['@type'], accountNumber: Number(base.account_number), sequence: Number(base.sequence) };
}
async function getBalance(address) {
  const { json } = await http('GET', `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${CFG.denom}`);
  return BigInt((json.balance && json.balance.amount) || '0');
}
// ME ID 查詢：{ found, info? }。info 欄位：did、address、status（DID_STATUS_ACTIVE…）、kycLevel（KYC_LEVEL_TWO…）
async function getDid(address) {
  const { status, json } = await http('GET', `/metaearth/did/did?address=${address}`);
  if (status === 200 && json.info) return { found: true, info: json.info };
  return { found: false, error: json.message || status };
}
async function smartQuery(contract, msg) {
  const q = toBase64(toUtf8(JSON.stringify(msg)));
  const { status, json } = await http('GET', `/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(q)}`);
  if (status !== 200) throw new Error(`smartQuery ${status}: ${JSON.stringify(json)}`);
  return json.data;
}

// ---- 組交易 ----
function buildTxBytes({ msgs, memo, pubkey, sequence, gasLimit, feeAmount, feeGranter, signature, accountNumber, chainId }) {
  const bodyBytes = registry.encode({ typeUrl: '/cosmos.tx.v1beta1.TxBody', value: { messages: msgs, memo: memo || '' } });
  const pk = encodePubkey(encodeSecp256k1Pubkey(pubkey));
  const authInfoBytes = makeAuthInfoBytes([{ pubkey: pk, sequence }], [{ denom: CFG.denom, amount: String(feeAmount) }], gasLimit, feeGranter, undefined);
  return { bodyBytes, authInfoBytes, signDoc: makeSignDoc(bodyBytes, authInfoBytes, chainId, accountNumber) };
}

// simulate：不驗簽名，可以拿任何「鏈上已存在」的地址當 signer 做唯讀試算（不會改變狀態）
async function simulate({ msgs, memo, pubkey, sequence, feeGranter }) {
  const { bodyBytes, authInfoBytes } = buildTxBytes({ msgs, memo, pubkey: pubkey || new Uint8Array(33).fill(2), sequence, gasLimit: 0, feeAmount: 0, feeGranter, accountNumber: 0, chainId: CFG.chainId });
  const txBytes = TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [new Uint8Array(64)] })).finish();
  const { status, json } = await http('POST', '/cosmos/tx/v1beta1/simulate', { tx_bytes: toBase64(txBytes) });
  return { ok: status === 200, gasUsed: json.gas_info ? Number(json.gas_info.gas_used) : undefined, error: status === 200 ? undefined : json.message, events: json.result && json.result.events };
}

// 簽名 → 廣播 → 等上鏈。回傳 { hash, code, rawLog, height, gasUsed }；code 不是 0 代表鏈上拒絕
async function signAndBroadcast(signer, msgs, { memo = '', feeGranter, gasLimit } = {}) {
  const acc = await getAccount(signer.address);
  if (!acc.exists) throw new Error(`account ${signer.address} not on chain yet (needs testnet MEC)`);
  if (!gasLimit) {
    const sim = await simulate({ msgs, memo, pubkey: signer.pubkey, sequence: acc.sequence, feeGranter });
    if (!sim.ok) return { simulated: true, code: -1, rawLog: sim.error };
    gasLimit = Math.ceil(sim.gasUsed * CFG.gasAdjust);
  }
  const feeAmount = Math.ceil(gasLimit * CFG.gasPrice);
  const { bodyBytes, authInfoBytes, signDoc } = buildTxBytes({ msgs, memo, pubkey: signer.pubkey, sequence: acc.sequence, gasLimit, feeAmount, feeGranter, accountNumber: acc.accountNumber, chainId: CFG.chainId });
  const { signature } = await signer.wallet.signDirect(signer.address, signDoc);
  const txBytes = TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [fromBase64(signature.signature)] })).finish();
  const { json } = await http('POST', '/cosmos/tx/v1beta1/txs', { tx_bytes: toBase64(txBytes), mode: 'BROADCAST_MODE_SYNC' });
  const r = json.tx_response || {};
  if (r.code) return { hash: r.txhash, code: r.code, rawLog: r.raw_log, checkTx: true };
  return waitTx(r.txhash);
}
async function waitTx(hash, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { status, json } = await http('GET', `/cosmos/tx/v1beta1/txs/${hash}`);
    if (status === 200 && json.tx_response) {
      const r = json.tx_response;
      return { hash, code: r.code, rawLog: r.raw_log, height: r.height, gasUsed: r.gas_used, events: r.events };
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { hash, code: -2, rawLog: 'timeout waiting for tx' };
}

// ---- 訊息 ----
const coins = (amount) => [{ denom: CFG.denom, amount: String(amount) }];
const ts = (date) => Timestamp.fromPartial({ seconds: BigInt(Math.floor(date.getTime() / 1000)), nanos: 0 });
const M = {
  send: (from, to, amount) => ({ typeUrl: T.MsgSend, value: MsgSend.fromPartial({ fromAddress: from, toAddress: to, amount: coins(amount) }) }),
  // 路線 2：SendAuthorization（ME 的 SDK fork v0.47.13 有 allow_list 欄位，已查原始碼）
  grantSend: (granter, grantee, spendLimit, allowList, expiration) => ({
    typeUrl: T.MsgGrant,
    value: MsgGrant.fromPartial({
      granter, grantee,
      grant: {
        authorization: { typeUrl: T.SendAuthorization, value: SendAuthorization.encode(SendAuthorization.fromPartial({ spendLimit: coins(spendLimit), allowList: allowList || [] })).finish() },
        expiration: expiration ? ts(expiration) : undefined,
      },
    }),
  }),
  exec: (grantee, innerMsgs) => ({
    typeUrl: T.MsgExec,
    value: MsgExec.fromPartial({ grantee, msgs: innerMsgs.map((m) => ({ typeUrl: m.typeUrl, value: registry.encode(m) })) }),
  }),
  revoke: (granter, grantee, msgTypeUrl = T.MsgSend) => ({ typeUrl: T.MsgRevoke, value: MsgRevoke.fromPartial({ granter, grantee, msgTypeUrl }) }),
  grantAllowance: (granter, grantee, spendLimit, expiration) => ({
    typeUrl: T.MsgGrantAllowance,
    value: MsgGrantAllowance.fromPartial({
      granter, grantee,
      allowance: { typeUrl: T.BasicAllowance, value: BasicAllowance.encode(BasicAllowance.fromPartial({ spendLimit: coins(spendLimit), expiration: expiration ? ts(expiration) : undefined })).finish() },
    }),
  }),
  revokeAllowance: (granter, grantee) => ({ typeUrl: T.MsgRevokeAllowance, value: MsgRevokeAllowance.fromPartial({ granter, grantee }) }),
  // 路線 1：CosmWasm
  storeCode: (sender, wasmBytes) => ({ typeUrl: T.MsgStoreCode, value: MsgStoreCode.fromPartial({ sender, wasmByteCode: wasmBytes }) }),
  instantiate: (sender, codeId, msg, label, funds = 0, admin = '') => ({
    typeUrl: T.MsgInstantiateContract,
    value: MsgInstantiateContract.fromPartial({ sender, admin, codeId: BigInt(codeId), label, msg: toUtf8(JSON.stringify(msg)), funds: funds ? coins(funds) : [] }),
  }),
  execute: (sender, contract, msg, funds = 0) => ({
    typeUrl: T.MsgExecuteContract,
    value: MsgExecuteContract.fromPartial({ sender, contract, msg: toUtf8(JSON.stringify(msg)), funds: funds ? coins(funds) : [] }),
  }),
};

function findEventAttr(events, type, key) {
  for (const e of events || []) if (e.type === type) for (const a of e.attributes) if (a.key === key) return a.value;
  return undefined;
}

module.exports = { CFG, T, M, registry, http, loadWallet, addressOf, getAccount, getBalance, getDid, smartQuery, simulate, signAndBroadcast, waitTx, findEventAttr, toHex, SECRETS_FILE };
