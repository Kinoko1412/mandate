'use strict';

/**
 * public/js/vault-crypto-core.js — Evidence Vault 加密的純密碼學核心。
 *
 * 刻意跟 WebAuthn/PRF、fetch、DOM 完全分離：這裡只用 globalThis.crypto.subtle（標準
 * WebCrypto API），瀏覽器和 Node 都有（Node 19+ 的 globalThis.crypto 就是同一份實作），
 * 所以同一份檔案可以：
 *   (a) 被 public/js/vault-crypto.js 當瀏覽器 <script> 直接載入使用
 *   (b) 被 tests/vault/crypto.smoke.js 用 require() 在 Node 下真的做 encrypt/decrypt
 *       round-trip 測試——不用假裝、不用 mock WebCrypto，Node 的 crypto.subtle 就是真的
 *       W3C WebCrypto 實作。
 *
 * 唯一沒辦法在這裡測、只能在真瀏覽器 + 真裝置測的部分，是「PRF 輸出的 32 bytes 從哪裡
 * 來」——那是 vault-crypto.js 呼叫 navigator.credentials.create()/get() 拿到的，跟 Face
 * ID / Windows Hello 綁在一起，這個檔案完全不碰。這裡的測試會用一組固定的假 32 bytes
 * 代替，驗證的是「拿到 PRF 輸出之後，包裝/解包裝/加密/解密的數學運算對不對」，不是驗證
 * PRF 本身。
 *
 * 加密設計（ECIES 風格，非對稱信封加密）：
 *   - Verifier 註冊一次：本地生一組 ECDH P-256 金鑰對，公鑰明碼存伺服器，私鑰用 PRF
 *     衍生出的 AES-256-GCM 金鑰包起來才存伺服器（伺服器看到的私鑰全程是密文）。
 *   - Supplier 上傳時：用 Verifier 公鑰 + 一組臨時（ephemeral）ECDH 金鑰做 ECDH，過
 *     HKDF 導出一把一次性的 AES-256-GCM 內容金鑰加密檔案，把臨時公鑰一起存起來（不是密
 *     鑰本身，公鑰本來就可以公開）。
 *   - Verifier 開啟時：用自己解包出來的私鑰 + 存的臨時公鑰重新做同一次 ECDH，算出同一把
 *     內容金鑰解密。ECDH 的對稱性（dA·B = dB·A）讓雙方各自算出同一把共享金鑰，不需要另外
 *     傳遞內容金鑰本身。
 */

(function attach(root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    root.VaultCryptoCore = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
  const subtle = () => {
    const webCrypto = globalThis.crypto;
    if (!webCrypto || !webCrypto.subtle) {
      throw new Error('VAULT_CRYPTO_UNAVAILABLE: 這個環境沒有 WebCrypto (crypto.subtle)。');
    }
    return webCrypto.subtle;
  };

  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToBase64(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      result += B64_CHARS[b0 >> 2];
      result += B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
      result += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
      result += b2 === undefined ? '=' : B64_CHARS[b2 & 63];
    }
    return result;
  }

  function base64ToBytes(base64) {
    if (typeof base64 !== 'string') throw new Error('VAULT_CRYPTO_INVALID_BASE64');
    const clean = base64.replace(/=+$/, '');
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const char of clean) {
      const value = B64_CHARS.indexOf(char);
      if (value === -1) continue;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }

  function utf8ToBytes(text) {
    return new TextEncoder().encode(text);
  }

  function bytesToUtf8(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  /** PRF 輸出（32 bytes 隨機資料）→ 一把 AES-256-GCM「包裝金鑰」。純 HKDF，不涉及 ECDH。*/
  async function deriveWrapKeyFromPrf(prfBytes) {
    const baseKey = await subtle().importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8ToBytes('mandate-vault-wrap-v1') },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** 產生 Verifier 的 Vault 身份金鑰對（ECDH P-256）。extractable=true 是刻意的——
   * 私鑰馬上就要被包裝金鑰包起來，之後只有密文形式存在，跟私鑰本身可否匯出無關。*/
  async function generateVaultKeypair() {
    const keyPair = await subtle().generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const publicKeyJwk = await subtle().exportKey('jwk', keyPair.publicKey);
    return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicKeyJwk };
  }

  /** 用包裝金鑰把私鑰（JWK 形式）加密起來，回傳可以直接存伺服器的密文。*/
  async function wrapPrivateKey(privateKey, wrapKey) {
    const jwk = await subtle().exportKey('jwk', privateKey);
    const plaintext = utf8ToBytes(JSON.stringify(jwk));
    const iv = randomBytes(12);
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, wrapKey, plaintext);
    return {
      wrappedPrivateKeyBase64: bytesToBase64(new Uint8Array(ciphertext)),
      wrapIvBase64: bytesToBase64(iv),
    };
  }

  /** wrapPrivateKey 的反向操作：包裝金鑰錯（例如假裝拿到別人的 PRF 輸出）會讓 AES-GCM
   * 的認證標籤直接驗證失敗、丟出例外，不會是「解出一把錯的私鑰」這種難以察覺的錯誤。*/
  async function unwrapPrivateKey(wrappedPrivateKeyBase64, wrapIvBase64, wrapKey) {
    const iv = base64ToBytes(wrapIvBase64);
    const ciphertext = base64ToBytes(wrappedPrivateKeyBase64);
    const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv }, wrapKey, ciphertext);
    const jwk = JSON.parse(bytesToUtf8(new Uint8Array(plaintext)));
    return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  }

  async function importPublicJwk(publicKeyJwk) {
    return subtle().importKey('jwk', publicKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }

  async function deriveContentKey(ownPrivateKey, otherPublicKey) {
    const sharedBits = await subtle().deriveBits({ name: 'ECDH', public: otherPublicKey }, ownPrivateKey, 256);
    const baseKey = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8ToBytes('mandate-vault-content-v1') },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** Supplier 端：用 Verifier 公鑰加密內容。生一組臨時 ECDH 金鑰對只用這一次，
   * 臨時私鑰用完即丟（從來不會被存起來或傳出去），只有臨時公鑰隨密文一起存。*/
  async function encryptForRecipient(plaintextBytes, recipientPublicKeyJwk) {
    const recipientPublicKey = await importPublicJwk(recipientPublicKeyJwk);
    const ephemeral = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
    const contentKey = await deriveContentKey(ephemeral.privateKey, recipientPublicKey);
    const iv = randomBytes(12);
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, contentKey, plaintextBytes);
    const ephemeralPublicKeyJwk = await subtle().exportKey('jwk', ephemeral.publicKey);
    return {
      ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext)),
      ivBase64: bytesToBase64(iv),
      ephemeralPublicKeyJwk,
    };
  }

  /** Verifier 端：用自己解包出來的私鑰 + 密文裡的臨時公鑰，重算同一把內容金鑰解密。*/
  async function decryptFromSender(pkg, ownPrivateKey) {
    const ephemeralPublicKey = await importPublicJwk(pkg.ephemeralPublicKeyJwk);
    const contentKey = await deriveContentKey(ownPrivateKey, ephemeralPublicKey);
    const iv = base64ToBytes(pkg.ivBase64);
    const ciphertext = base64ToBytes(pkg.ciphertextBase64);
    const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv }, contentKey, ciphertext);
    return new Uint8Array(plaintext);
  }

  return {
    bytesToBase64,
    base64ToBytes,
    utf8ToBytes,
    bytesToUtf8,
    randomBytes,
    deriveWrapKeyFromPrf,
    generateVaultKeypair,
    wrapPrivateKey,
    unwrapPrivateKey,
    encryptForRecipient,
    decryptFromSender,
  };
});
