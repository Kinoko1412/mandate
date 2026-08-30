'use strict';

/**
 * public/js/vault-crypto.js — WebAuthn PRF 膠水層，包在 vault-crypto-core.js（純密碼學）
 * 外面，負責跟 navigator.credentials／伺服器溝通。這個檔案本身刻意不含任何密碼學運算，
 * 只做三件事：觸發生物辨識拿 PRF 輸出、跟伺服器交換金鑰資料、把結果轉交給 core 做運算。
 *
 * 依賴載入順序：index.html 裡這支檔案要排在 vault-crypto-core.js 之後、case-workflow.js
 * 之前——`window.VaultCrypto` 是給 case-workflow.js 用的公開介面。
 *
 * 安全性說明：這裡的 navigator.credentials.create()/get() ceremony **不是**登入驗證，
 * 純粹是觸發一次生物辨識、拿到 PRF 輸出的手段（詳見 server/vaultKeys.js 檔頭註解）。
 * 案件的存取控制完全還是既有的 Grant/token 機制在把關；這裡只負責「密文解不解得開」。
 */

(function attach(root) {
  const Core = root.VaultCryptoCore;
  if (!Core) {
    throw new Error('vault-crypto.js 需要先載入 vault-crypto-core.js');
  }

  const STATUS_ENDPOINT = '/api/vault/keys/verifier';

  // 這個 session（分頁）快取已解包裝的私鑰，同一次瀏覽器 session 內不用每次開底稿
  // 都重按一次指紋——就像密碼管理器解鎖一次、同一個 session 內不用每個項目都重驗證。
  // 用 Map 而不是單一變數是因為金鑰輪替之後，同一個 session 裡可能要同時解開「用最新
  // 金鑰加密的新底稿」跟「用舊金鑰加密、還在保留期限內的舊底稿」——各自快取各自的版本。
  const unlockedKeyCache = new Map(); // keyId -> CryptoKey

  function assertWebAuthnAvailable() {
    if (!root.PublicKeyCredential) {
      const error = new Error('此瀏覽器不支援 WebAuthn。');
      error.code = 'WEBAUTHN_NOT_SUPPORTED';
      throw error;
    }
  }

  async function isPlatformAuthenticatorAvailable() {
    if (!root.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
      return false;
    }
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  function mapWebAuthnError(error) {
    // 只有「我們自己丟出來、code 是字串」的錯誤才算已經處理過。原生 DOMException
    // 也有一個 `.code`，但那是舊版 DOM Level 3 的數字代碼（例如 SecurityError=18），
    // 之前這裡沒分辨字串/數字，導致原生錯誤被誤判成「已經處理過」直接原樣丟出去，
    // 使用者看到的是英文原始訊息 + 一個沒人看得懂的數字 reason code——這是真的實機
    // 操作測試（不是看程式碼）才抓到的 bug，見 記憶.md 對應段落。
    if (error && typeof error.code === 'string') return error;
    if (error && error.name === 'NotAllowedError') {
      const mapped = new Error('已取消裝置驗證。');
      mapped.code = 'WEBAUTHN_USER_CANCELLED';
      return mapped;
    }
    if (error && error.name === 'SecurityError') {
      const mapped = new Error(
        '目前網址不支援 Vault 裝置驗證（WebAuthn 不接受 IP 位址當網域，例如 127.0.0.1）。'
      );
      mapped.code = 'WEBAUTHN_INVALID_DOMAIN';
      return mapped;
    }
    const mapped = new Error((error && error.message) || 'WebAuthn 操作失敗。');
    mapped.code = 'WEBAUTHN_FAILED';
    return mapped;
  }

  async function fetchJson(path, options = {}) {
    const headers = { 'x-demo-role': options.role, ...(options.headers || {}) };
    const init = { method: options.method || 'GET', headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    const body = await response.json();
    if (!response.ok) throw body;
    return body;
  }

  /** Supplier 上傳前、Verifier 開底稿前都會查這個——回傳有沒有註冊、公鑰是什麼。*/
  async function getVaultKeyStatus(role) {
    return fetchJson(STATUS_ENDPOINT, { role });
  }

  /** 從 create()/get() 的 clientExtensionResults 裡取出 PRF 輸出（ArrayBuffer）。
   * 有些驗證器在 create() 當下就給結果，有些要等到後續一次 get() 才給——由呼叫端決定
   * 要不要補一次 get()，這個函式只負責讀，不負責補。*/
  function extractPrfBytes(credential) {
    const results = credential.getClientExtensionResults ? credential.getClientExtensionResults() : {};
    const prf = results && results.prf;
    if (!prf) {
      // 2026-08-29：使用者反映補打一次還是失敗，代表不是單純「時機沒抓好」那種偶發
      // 問題——留一份完整的 clientExtensionResults 原始內容在 console，下次再發生時
      // 才看得出來是「這台裝置的驗證器連 prf 物件都沒回」還是「有回但缺 first」，
      // 沒辦法只憑猜的繼續加重試次數。
      console.warn('[VaultCrypto] PRF extension missing from clientExtensionResults', results);
      return { enabled: false, bytes: null };
    }
    if (!prf.enabled && prf.enabled !== undefined) {
      console.warn('[VaultCrypto] PRF extension explicitly disabled by authenticator', results);
      return { enabled: false, bytes: null };
    }
    const first = prf.results && prf.results.first;
    if (!first) {
      console.warn('[VaultCrypto] PRF enabled but no results.first returned', results);
    }
    return { enabled: true, bytes: first ? new Uint8Array(first) : null };
  }

  /**
   * 註冊流程：生 salt → create() 觸發生物辨識 → 確認 PRF 支援 → 必要時補一次 get() 拿
   * 實際的 PRF bytes → 導出包裝金鑰 → 生 Vault 金鑰對 → 包裝私鑰 → 存到伺服器。
   */
  async function registerVerifierVaultKey() {
    assertWebAuthnAvailable();
    try {
      const salt = Core.randomBytes(32);
      const challenge = Core.randomBytes(32);
      const userId = Core.utf8ToBytes('demo-verifier-001');

      const credential = await navigator.credentials.create({
        publicKey: {
          rp: { name: 'Mandate CBAM Trust Gate' },
          user: { id: userId, name: 'demo-verifier-001', displayName: 'Demo Verifier' },
          challenge,
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          extensions: { prf: { eval: { first: salt } } },
        },
      });
      if (!credential) throw Object.assign(new Error('未取得裝置憑證。'), { code: 'WEBAUTHN_FAILED' });

      let prf = extractPrfBytes(credential);
      if (!prf.enabled) {
        const error = new Error('裝置的驗證器不支援 PRF 擴充。');
        error.code = 'WEBAUTHN_PRF_UNSUPPORTED';
        throw error;
      }
      if (!prf.bytes) {
        // 有些驗證器只在 get() 時才吐出 PRF 結果，這裡補一次同樣 salt 的斷言。
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: Core.randomBytes(32),
            allowCredentials: [{ id: credential.rawId, type: 'public-key' }],
            userVerification: 'required',
            extensions: { prf: { eval: { first: salt } } },
          },
        });
        prf = extractPrfBytes(assertion);
        if (!prf.bytes) {
          const error = new Error('裝置的驗證器不支援 PRF 擴充。');
          error.code = 'WEBAUTHN_PRF_UNSUPPORTED';
          throw error;
        }
      }

      const wrapKey = await Core.deriveWrapKeyFromPrf(prf.bytes);
      const keypair = await Core.generateVaultKeypair();
      const { wrappedPrivateKeyBase64, wrapIvBase64 } = await Core.wrapPrivateKey(keypair.privateKey, wrapKey);

      const result = await fetchJson(STATUS_ENDPOINT, {
        method: 'POST',
        role: 'Verifier',
        body: {
          credentialId: Core.bytesToBase64(new Uint8Array(credential.rawId)),
          publicKeyJwk: keypair.publicKeyJwk,
          wrappedPrivateKeyBase64,
          wrapIvBase64,
          prfSaltBase64: Core.bytesToBase64(salt),
        },
      });

      unlockedKeyCache.set(result.keyId, keypair.privateKey);
      return result;
    } catch (error) {
      throw mapWebAuthnError(error);
    }
  }

  /** 註冊/輪替是同一套 ceremony——輪替只是語意上更清楚：舊金鑰版本仍然保留（見
   * server/vaultKeys.js 的 history 設計），不是砍掉重練，只是「新上傳從此改用新的一把」。*/
  const rotateVerifierVaultKey = registerVerifierVaultKey;

  /**
   * 開底稿前呼叫。keyId 省略時解鎖「目前最新」那把（給沒有輪替過的一般情境用）；
   * 帶 keyId 時解鎖「當初加密這份底稿時用的那個版本」——金鑰輪替後，舊底稿要用舊版本
   * 才解得開，不是永遠用最新的那把。同一 session 內每個版本各自快取一次。
   */
  async function unlockVerifierVaultKey(keyId) {
    const cacheKey = keyId || '__latest__';
    if (unlockedKeyCache.has(cacheKey)) return unlockedKeyCache.get(cacheKey);
    assertWebAuthnAvailable();
    try {
      const status = keyId
        ? await fetchJson(`${STATUS_ENDPOINT}/${encodeURIComponent(keyId)}`, { role: 'Verifier' })
        : await getVaultKeyStatus('Verifier');
      if (!status.registered) {
        const error = new Error(
          keyId ? '此金鑰版本已超過保留期限或不存在，無法解密。' : '此裝置尚未註冊 Vault 金鑰，無法解密。'
        );
        error.code = keyId ? 'VAULT_KEY_VERSION_NOT_FOUND' : 'VAULT_KEY_NOT_REGISTERED';
        throw error;
      }
      // 已經在 unlockedKeyCache 裡快取過「真正的 keyId」，避免同一把金鑰被用不同的
      // cacheKey（'__latest__' vs 實際 keyId）各解鎖一次、多按一次指紋。
      if (unlockedKeyCache.has(status.keyId)) {
        const cached = unlockedKeyCache.get(status.keyId);
        unlockedKeyCache.set(cacheKey, cached);
        return cached;
      }
      const salt = Core.base64ToBytes(status.prfSaltBase64);
      const credentialIdBytes = Core.base64ToBytes(status.credentialId);

      const requestAssertion = () => navigator.credentials.get({
        publicKey: {
          challenge: Core.randomBytes(32),
          allowCredentials: [{ id: credentialIdBytes, type: 'public-key' }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: salt } } },
        },
      });

      let assertion = await requestAssertion();
      let prf = extractPrfBytes(assertion);
      if (!prf.bytes) {
        // 2026-08-29：Windows Hello／Chrome 的 PRF 偶爾第一次斷言吐不出結果（CTAP2/TPM
        // 溝通時機問題，不是裝置真的不支援——這正是使用者反映「有時候輸完 PIN 會報
        // 不支援 PRF」的成因，devtools 裡重試幾乎都會成功）。用同一組 salt 補一次斷言，
        // 跟 registerVerifierVaultKey() 註冊流程的補呼叫同一個道理；使用者要再驗證一次
        // 裝置（多按一次指紋/PIN），但比起直接判死刑、要求換裝置合理很多。
        assertion = await requestAssertion();
        prf = extractPrfBytes(assertion);
      }
      if (!prf.bytes) {
        const error = new Error('裝置的驗證器不支援 PRF 擴充。');
        error.code = 'WEBAUTHN_PRF_UNSUPPORTED';
        throw error;
      }

      const wrapKey = await Core.deriveWrapKeyFromPrf(prf.bytes);
      const privateKey = await Core.unwrapPrivateKey(status.wrappedPrivateKeyBase64, status.wrapIvBase64, wrapKey);
      unlockedKeyCache.set(status.keyId, privateKey);
      unlockedKeyCache.set(cacheKey, privateKey);
      return privateKey;
    } catch (error) {
      throw mapWebAuthnError(error);
    }
  }

  function clearSessionCache() {
    unlockedKeyCache.clear();
  }

  /** Supplier 上傳時呼叫。回傳 null 代表 Verifier 尚未註冊，呼叫端應退回明碼上傳。*/
  async function encryptForVault(plaintextBytes) {
    const status = await getVaultKeyStatus('Supplier');
    if (!status.registered) return null;
    const pkg = await Core.encryptForRecipient(plaintextBytes, status.publicKeyJwk);
    return {
      contentBase64: pkg.ciphertextBase64,
      vaultEncrypted: true,
      vaultIvBase64: pkg.ivBase64,
      vaultEphemeralPublicKeyJwk: pkg.ephemeralPublicKeyJwk,
      vaultKeyId: status.keyId,
    };
  }

  /** Verifier 開底稿/下載時呼叫。evidenceRecord.vaultEncrypted 為 false 時直接走明碼路徑，
   * 完全不觸發 WebAuthn。帶 vaultKeyId 就解鎖「當初加密用的那個版本」——金鑰輪替後，
   * 舊底稿不能假設用最新那把金鑰解得開。*/
  async function decryptFromVault(evidenceRecord) {
    if (!evidenceRecord.vaultEncrypted) {
      return Core.base64ToBytes(evidenceRecord.contentBase64);
    }
    const privateKey = await unlockVerifierVaultKey(evidenceRecord.vaultKeyId);
    return Core.decryptFromSender(
      {
        ciphertextBase64: evidenceRecord.contentBase64,
        ivBase64: evidenceRecord.vaultIvBase64,
        ephemeralPublicKeyJwk: evidenceRecord.vaultEphemeralPublicKeyJwk,
      },
      privateKey
    );
  }

  root.VaultCrypto = {
    isPlatformAuthenticatorAvailable,
    getVaultKeyStatus,
    registerVerifierVaultKey,
    rotateVerifierVaultKey,
    unlockVerifierVaultKey,
    clearSessionCache,
    encryptForVault,
    decryptFromVault,
  };
})(typeof window !== 'undefined' ? window : globalThis);
