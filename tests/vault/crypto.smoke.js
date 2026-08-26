'use strict';

/**
 * tests/vault/crypto.smoke.js — public/js/vault-crypto-core.js 的真實 round-trip 測試。
 *
 * 這裡測的是「拿到 PRF 輸出之後」的所有密碼學運算：包裝金鑰導出、私鑰包裝/解包裝、
 * ECIES 風格的內容加解密。全部呼叫 Node 內建的 globalThis.crypto.subtle（跟瀏覽器
 * 同一份 W3C WebCrypto 規格，不是 mock）。
 *
 * 沒有測、也測不了的部分：PRF 輸出本身怎麼來的（navigator.credentials.create/get
 * 的 prf extension，需要真瀏覽器 + 真裝置的 Face ID / Windows Hello）。這裡固定用一組
 * 假的 32 bytes 代替 PRF 輸出，驗證的是數學運算對不對，不是驗證生物辨識流程本身——那部分
 * 只能由人在真瀏覽器裡測。
 */

const assert = require('assert');
const VaultCryptoCore = require('../../public/js/vault-crypto-core.js');

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.stack || error.message}`);
  }
}

function fakePrfOutput() {
  // 真實情況下這是 navigator.credentials.get() 的 prf.results.first；這裡用固定亂數代替，
  // 只是為了讓測試可重現一把「假裝是 PRF 導出」的 32 bytes 對稱金鑰。
  return VaultCryptoCore.randomBytes(32);
}

async function main() {
  await check('包裝金鑰 round-trip：用假 PRF 輸出包裝私鑰、再解包裝，解出同一把可用的私鑰', async () => {
    const prf = fakePrfOutput();
    const wrapKey = await VaultCryptoCore.deriveWrapKeyFromPrf(prf);
    const { privateKey, publicKeyJwk } = await VaultCryptoCore.generateVaultKeypair();
    const { wrappedPrivateKeyBase64, wrapIvBase64 } = await VaultCryptoCore.wrapPrivateKey(privateKey, wrapKey);

    const unwrapped = await VaultCryptoCore.unwrapPrivateKey(wrappedPrivateKeyBase64, wrapIvBase64, wrapKey);

    // 用解包裝出來的私鑰實際做一次 ECIES 加解密，證明它是「真的能用」的同一把私鑰，
    // 不是只驗證型別對了。
    const plaintext = VaultCryptoCore.utf8ToBytes('round-trip 驗證用內容');
    const encrypted = await VaultCryptoCore.encryptForRecipient(plaintext, publicKeyJwk);
    const decrypted = await VaultCryptoCore.decryptFromSender(encrypted, unwrapped);
    assert.strictEqual(VaultCryptoCore.bytesToUtf8(decrypted), 'round-trip 驗證用內容');
  });

  await check('攻擊：用錯的包裝金鑰（模擬拿到別人 PRF 輸出）解包裝，AES-GCM 認證失敗直接丟例外', async () => {
    const prf = fakePrfOutput();
    const wrongPrf = fakePrfOutput();
    const wrapKey = await VaultCryptoCore.deriveWrapKeyFromPrf(prf);
    const wrongWrapKey = await VaultCryptoCore.deriveWrapKeyFromPrf(wrongPrf);
    const { privateKey } = await VaultCryptoCore.generateVaultKeypair();
    const { wrappedPrivateKeyBase64, wrapIvBase64 } = await VaultCryptoCore.wrapPrivateKey(privateKey, wrapKey);

    await assert.rejects(
      () => VaultCryptoCore.unwrapPrivateKey(wrappedPrivateKeyBase64, wrapIvBase64, wrongWrapKey),
      undefined,
      '錯的包裝金鑰不應該解得開'
    );
  });

  await check('內容加解密 round-trip：Supplier 用 Verifier 公鑰加密，Verifier 用私鑰解密，拿回原文', async () => {
    const { privateKey, publicKeyJwk } = await VaultCryptoCore.generateVaultKeypair();
    const original = VaultCryptoCore.utf8ToBytes('這是一份底稿內容，包含供應商製程細節。');
    const encrypted = await VaultCryptoCore.encryptForRecipient(original, publicKeyJwk);

    assert.ok(encrypted.ciphertextBase64, '應該產生密文');
    assert.notStrictEqual(
      VaultCryptoCore.bytesToUtf8(VaultCryptoCore.base64ToBytes(encrypted.ciphertextBase64)),
      '這是一份底稿內容，包含供應商製程細節。',
      '密文不應該直接是明文（不是隨便 base64 過去）'
    );

    const decrypted = await VaultCryptoCore.decryptFromSender(encrypted, privateKey);
    assert.strictEqual(VaultCryptoCore.bytesToUtf8(decrypted), '這是一份底稿內容，包含供應商製程細節。');
  });

  await check('攻擊：不同 Verifier 金鑰對無法解開彼此的密文（不是任何私鑰都能解）', async () => {
    const verifierA = await VaultCryptoCore.generateVaultKeypair();
    const verifierB = await VaultCryptoCore.generateVaultKeypair();
    const encrypted = await VaultCryptoCore.encryptForRecipient(
      VaultCryptoCore.utf8ToBytes('only-for-verifier-A'),
      verifierA.publicKeyJwk
    );
    await assert.rejects(
      () => VaultCryptoCore.decryptFromSender(encrypted, verifierB.privateKey),
      undefined,
      'Verifier B 的私鑰不應該解得開給 Verifier A 加密的內容'
    );
  });

  await check('攻擊：密文被竄改一個 byte，AES-GCM 認證失敗，不會悄悄解出錯誤內容', async () => {
    const { privateKey, publicKeyJwk } = await VaultCryptoCore.generateVaultKeypair();
    const encrypted = await VaultCryptoCore.encryptForRecipient(
      VaultCryptoCore.utf8ToBytes('tamper-test'),
      publicKeyJwk
    );
    const tamperedBytes = VaultCryptoCore.base64ToBytes(encrypted.ciphertextBase64);
    tamperedBytes[0] ^= 0xff;
    const tampered = { ...encrypted, ciphertextBase64: VaultCryptoCore.bytesToBase64(tamperedBytes) };

    await assert.rejects(
      () => VaultCryptoCore.decryptFromSender(tampered, privateKey),
      undefined,
      '被竄改的密文應該解密失敗，不是解出亂碼還被當成成功'
    );
  });

  await check('base64 helper round-trip：任意 bytes 編碼再解碼要拿回原始資料（含邊界長度 1/2/3）', async () => {
    for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const original = VaultCryptoCore.randomBytes(length);
      const encoded = VaultCryptoCore.bytesToBase64(original);
      const decoded = VaultCryptoCore.base64ToBytes(encoded);
      assert.deepStrictEqual([...decoded], [...original], `length=${length} 應該 round-trip 正確`);
    }
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
