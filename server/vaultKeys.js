'use strict';

/**
 * server/vaultKeys.js — Verifier 的 Vault 身份金鑰（WebAuthn PRF 版）伺服器端儲存，
 * 含金鑰輪替（Key Rotation）支援。
 *
 * 跟 services/identity 的 in-memory demoOnly 限制是同一種：純記憶體、重啟即清空、
 * 只支援 workflowStore.DEMO_ACTORS.Verifier 這唯一一位固定 Demo Verifier
 * （createGrant() 本來就把 Grant subject 寫死成同一人，這裡延續同一個假設）。
 *
 * 存的東西全部經得起「伺服器被完整讀取」這個假設：
 *   - publicKeyJwk：本來就該公開的公鑰
 *   - wrappedPrivateKeyBase64 / wrapIvBase64：私鑰的 AES-GCM 密文，包裝金鑰只存在
 *     Verifier 自己瀏覽器裡臨時算出來的那一刻，從來沒有送到這裡——伺服器完整外洩，
 *     這幾個欄位單獨存在也解不開任何底稿。
 *   - prfSaltBase64：不是秘密，只是 PRF eval.first 的應用端輸入，重新觸發 PRF 時要用
 *     同一份才能導出同一把包裝金鑰；外洩也不構成風險，只是讓別人知道「要用這組 salt」，
 *     沒有裝置 + 生物辨識還是算不出 PRF 輸出本身。
 *
 * 刻意不做的事：不驗證 WebAuthn attestation/assertion 簽章。這裡的 WebAuthn ceremony
 * 純粹是「觸發一次生物辨識、拿到 PRF 輸出」的手段，不是拿來給伺服器判斷登入身份——
 * 案件的存取控制本來就由既有 Grant/token 機制把關（accessVault），這一層完全不重複
 * 判斷一次「這個人是不是 Verifier」。跳過完整 CBOR/COSE attestation 驗證，是因為就算
 * 驗證通過，也不會多授予任何權限；反過來做了也不會少擋任何攻擊——這裡的安全性來自
 * PRF 輸出本身的不可預測性，不是來自伺服器驗證了簽章。
 *
 * 金鑰輪替設計：每次註冊/輪替都是「新增一個版本」而不是覆蓋——`history` 是依時間排序
 * 的陣列，`getVerifierKey()` 永遠回傳最新一把（Supplier 加密新上傳一律用這把），舊版本
 * 保留 `MAX_HISTORY` 筆供解密舊底稿用，超過上限的最舊版本會被真的丟棄（不是無限保留，
 * 這正是輪替要解決的問題本身——外洩的曝光範圍要隨時間縮小，不是無限累積一個永遠洗不掉
 * 的金鑰清單）。舊底稿一旦其對應的 keyId 被丟棄的版本淘汰，就再也無法解密——這是刻意的
 * 取捨，不是 bug；真的要保留超長期限存取，要另外做「用新金鑰重新包一份」的遷移機制，
 * 這裡沒有做（demoOnly，見已知限制）。
 */

const MAX_HISTORY = 5;

let history = []; // 新到舊排序：history[0] 永遠是目前最新一把
let sequence = 0;

function reset() {
  history = [];
  sequence = 0;
}

function getVerifierKey() {
  return history.length ? { ...history[0] } : null;
}

function getVerifierKeyById(keyId) {
  const found = history.find((entry) => entry.keyId === keyId);
  return found ? { ...found } : null;
}

function listVerifierKeyHistory() {
  return history.map((entry) => ({
    keyId: entry.keyId,
    createdAt: entry.createdAt,
    current: entry === history[0],
  }));
}

function validateInput(input) {
  const required = [
    'credentialId',
    'publicKeyJwk',
    'wrappedPrivateKeyBase64',
    'wrapIvBase64',
    'prfSaltBase64',
  ];
  for (const field of required) {
    if (!input || typeof input[field] === 'undefined' || input[field] === null) {
      throw new TypeError(`vaultKeys: 缺少必要欄位 ${field}`);
    }
  }
  if (typeof input.credentialId !== 'string' || !input.credentialId.trim()) {
    throw new TypeError('vaultKeys: credentialId 必須是非空字串');
  }
  if (typeof input.publicKeyJwk !== 'object' || Array.isArray(input.publicKeyJwk)) {
    throw new TypeError('vaultKeys: publicKeyJwk 必須是物件');
  }
  for (const field of ['wrappedPrivateKeyBase64', 'wrapIvBase64', 'prfSaltBase64']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      throw new TypeError(`vaultKeys: ${field} 必須是非空字串`);
    }
  }
}

/** 註冊（history 是空的）跟輪替（history 已有舊版本）走同一個函式——語意上都是
 * 「新增一個目前最新的金鑰版本」，差別只在有沒有舊版本被保留下來而已。*/
function addVerifierKey(input) {
  validateInput(input);
  sequence += 1;
  const entry = {
    keyId: `vaultkey_${String(sequence).padStart(4, '0')}`,
    credentialId: input.credentialId,
    publicKeyJwk: input.publicKeyJwk,
    wrappedPrivateKeyBase64: input.wrappedPrivateKeyBase64,
    wrapIvBase64: input.wrapIvBase64,
    prfSaltBase64: input.prfSaltBase64,
    createdAt: new Date().toISOString(),
    demoOnly: true,
  };
  history = [entry, ...history].slice(0, MAX_HISTORY);
  return { ...entry };
}

// 向後相容別名——registerVaultKey 呼叫端原本叫這個名字。
const setVerifierKey = addVerifierKey;
const rotateVerifierKey = addVerifierKey;

module.exports = {
  reset,
  getVerifierKey,
  getVerifierKeyById,
  listVerifierKeyHistory,
  addVerifierKey,
  setVerifierKey,
  rotateVerifierKey,
  MAX_HISTORY,
};
