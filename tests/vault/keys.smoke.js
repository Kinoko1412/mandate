'use strict';

/**
 * tests/vault/keys.smoke.js — Vault 加密金鑰註冊/查詢端點（server/workflowApi.js 的
 * getVaultKeyStatus / registerVaultKey，走 server/vaultKeys.js 存放）。
 *
 * 跟 tests/vault/crypto.smoke.js 的分工：那份測的是密碼學運算本身對不對；這份測的是
 * HTTP 層——角色守門、欄位驗證、以及「沒註冊時上傳/開啟走既有明碼路徑完全不受影響」
 * 這個回溯相容保證，走真實 handleFetchRequest，不是直接呼叫內部函式。
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const workflowStore = require('../../server/workflowStore');
const vaultKeys = require('../../server/vaultKeys');

const CASE_ID = 'CASE-2026-001';
let passed = 0;
let failed = 0;

async function api(method, path, role, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (role) headers['x-demo-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://vault-keys.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleFetchRequest(request);
  assert.ok(response, `API route ${path} should be handled`);
  return { status: response.status, body: await response.json() };
}

function contentBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

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

const FAKE_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl4P3ecdlp0Q9WjeykYqu3iprxE9pdRQqDD2xh0Xg',
};

async function main() {
  workflowStore.reset();
  vaultKeys.reset();

  await check('尚未註冊時查詢狀態：registered: false', async () => {
    const { status, body } = await api('GET', '/api/vault/keys/verifier', 'Supplier');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.registered, false);
  });

  await check('角色守門：Supplier 不能註冊 Vault 金鑰', async () => {
    const { status, body } = await api('POST', '/api/vault/keys/verifier', 'Supplier', {
      credentialId: 'cred-1',
      publicKeyJwk: FAKE_JWK,
      wrappedPrivateKeyBase64: 'AAAA',
      wrapIvBase64: 'BBBB',
      prfSaltBase64: 'CCCC',
    });
    assert.strictEqual(status, 403);
    assert.strictEqual(body.code, 'ROLE_FORBIDDEN');
  });

  await check('欄位驗證：缺欄位一律拒絕，不會存半殘資料', async () => {
    const { status, body } = await api('POST', '/api/vault/keys/verifier', 'Verifier', {
      credentialId: 'cred-1',
      publicKeyJwk: FAKE_JWK,
      // 故意漏掉 wrappedPrivateKeyBase64
      wrapIvBase64: 'BBBB',
      prfSaltBase64: 'CCCC',
    });
    assert.strictEqual(status, 400);
    assert.strictEqual(body.code, 'INVALID_VAULT_KEY_PAYLOAD');
    const check2 = await api('GET', '/api/vault/keys/verifier', 'Supplier');
    assert.strictEqual(check2.body.registered, false, '驗證失敗不應該留下部分資料');
  });

  let registeredKeyId;
  await check('Verifier 成功註冊：回傳 keyId，且會留稽核紀錄', async () => {
    const { status, body } = await api('POST', '/api/vault/keys/verifier', 'Verifier', {
      credentialId: 'cred-1',
      publicKeyJwk: FAKE_JWK,
      wrappedPrivateKeyBase64: 'd3JhcHBlZC1wcml2YXRlLWtleQ==',
      wrapIvBase64: 'aXYtYnl0ZXM=',
      prfSaltBase64: 'cHJmLXNhbHQ=',
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.registered, true);
    assert.ok(body.keyId);
    registeredKeyId = body.keyId;

    const audit = await api('GET', `/api/cases/${CASE_ID}/audit`, 'Supplier');
    const event = audit.body.events.find((item) => item.action === 'VAULT_KEY_REGISTER');
    assert.ok(event, '應該要有 VAULT_KEY_REGISTER 稽核事件');
    assert.strictEqual(event.result, 'ALLOW');
  });

  await check('註冊後查詢：任何角色都能讀到公鑰（Supplier 上傳前要用）', async () => {
    const { status, body } = await api('GET', '/api/vault/keys/verifier', 'Supplier');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.registered, true);
    assert.strictEqual(body.keyId, registeredKeyId);
    assert.deepStrictEqual(body.publicKeyJwk, FAKE_JWK);
    assert.ok(body.wrappedPrivateKeyBase64, 'Verifier 自己要能讀到已包裝私鑰去解包裝');
  });

  await check('重新註冊會覆蓋舊金鑰（換一組新 keyId）', async () => {
    const { body } = await api('POST', '/api/vault/keys/verifier', 'Verifier', {
      credentialId: 'cred-2',
      publicKeyJwk: FAKE_JWK,
      wrappedPrivateKeyBase64: 'bmV3LXdyYXBwZWQ=',
      wrapIvBase64: 'bmV3LWl2',
      prfSaltBase64: 'bmV3LXNhbHQ=',
    });
    assert.notStrictEqual(body.keyId, registeredKeyId);
    const status = await api('GET', '/api/vault/keys/verifier', 'Verifier');
    assert.strictEqual(status.body.credentialId, 'cred-2');
  });

  await check('回溯相容：沒帶任何 vault 加密欄位的上傳，行為跟改動前完全一樣（明碼路徑）', async () => {
    await api('POST', '/api/workflow/reset', 'Supplier', {});
    const upload = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename: 'plain.pdf',
      mediaType: 'application/pdf',
      contentBase64: contentBase64('plain content'),
      metadata: { type: 'electricity_bill', coveredFrom: '2026-01-01', coveredTo: '2026-12-31', source: 'demo' },
    });
    assert.strictEqual(upload.status, 201);
    assert.strictEqual(upload.body.evidence.vaultEncrypted, false);
  });

  await check('vaultEncrypted:true 但缺加密欄位：拒絕存半殘密文', async () => {
    const upload = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename: 'half-encrypted.pdf',
      mediaType: 'application/pdf',
      contentBase64: contentBase64('ciphertext-ish'),
      vaultEncrypted: true,
      // 故意漏掉 vaultIvBase64/vaultEphemeralPublicKeyJwk/vaultKeyId
      metadata: { type: 'fuel_ledger', coveredFrom: '2026-01-01', coveredTo: '2026-12-31', source: 'demo' },
    });
    assert.strictEqual(upload.status, 400);
    assert.strictEqual(upload.body.code, 'INVALID_VAULT_ENCRYPTION_PAYLOAD');
  });

  await check('vaultEncrypted:true 欄位齊全：正確存入，且 accessVault 回傳解密所需欄位', async () => {
    const upload = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename: 'encrypted.pdf',
      mediaType: 'application/pdf',
      contentBase64: contentBase64('ciphertext-bytes'),
      vaultEncrypted: true,
      vaultIvBase64: 'aXYtYnl0ZXM=',
      vaultEphemeralPublicKeyJwk: FAKE_JWK,
      vaultKeyId: registeredKeyId,
      metadata: { type: 'production_report', coveredFrom: '2026-01-01', coveredTo: '2026-12-31', source: 'demo' },
    });
    assert.strictEqual(upload.status, 201);
    assert.strictEqual(upload.body.evidence.vaultEncrypted, true);
    const evidenceId = upload.body.evidence.evidenceId;

    const grant = await api('POST', '/api/vault/grants', 'Supplier', {
      caseId: CASE_ID,
      evidenceIds: [evidenceId],
      subject: 'demo-verifier-001',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.strictEqual(grant.status, 201);

    const opened = await api('GET', `/api/vault/items/${evidenceId}`, 'Verifier', undefined, {
      'x-vault-token': grant.body.token,
    });
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(opened.body.evidence.vaultEncrypted, true);
    assert.deepStrictEqual(opened.body.evidence.vaultEphemeralPublicKeyJwk, FAKE_JWK);
    assert.strictEqual(opened.body.evidence.vaultIvBase64, 'aXYtYnl0ZXM=');
  });

  await check('金鑰輪替：舊版本仍然查得到（保留期限內），且跟目前最新版本是不同 keyId', async () => {
    const before = await api('GET', '/api/vault/keys/verifier', 'Verifier');
    const oldKeyId = before.body.keyId;

    const rotated = await api('POST', '/api/vault/keys/verifier', 'Verifier', {
      credentialId: 'cred-rotated',
      publicKeyJwk: FAKE_JWK,
      wrappedPrivateKeyBase64: 'cm90YXRlZC13cmFwcGVk',
      wrapIvBase64: 'cm90YXRlZC1pdg==',
      prfSaltBase64: 'cm90YXRlZC1zYWx0',
    });
    assert.strictEqual(rotated.status, 201);
    const newKeyId = rotated.body.keyId;
    assert.notStrictEqual(newKeyId, oldKeyId);

    const current = await api('GET', '/api/vault/keys/verifier', 'Verifier');
    assert.strictEqual(current.body.keyId, newKeyId, '查詢應該回傳最新版本');

    const oldVersion = await api('GET', `/api/vault/keys/verifier/${oldKeyId}`, 'Verifier');
    assert.strictEqual(oldVersion.status, 200, '舊版本在保留期限內應該還查得到');
    assert.strictEqual(oldVersion.body.keyId, oldKeyId);
  });

  await check('金鑰輪替：超過保留上限（MAX_HISTORY）的最舊版本會被真的淘汰，回 404', async () => {
    workflowStore.reset();
    vaultKeys.reset();
    const keyIds = [];
    for (let i = 0; i < vaultKeys.MAX_HISTORY + 2; i += 1) {
      const { body } = await api('POST', '/api/vault/keys/verifier', 'Verifier', {
        credentialId: `cred-${i}`,
        publicKeyJwk: FAKE_JWK,
        wrappedPrivateKeyBase64: `d3JhcHBlZC0ke2l9`,
        wrapIvBase64: 'aXY=',
        prfSaltBase64: 'c2FsdA==',
      });
      keyIds.push(body.keyId);
    }
    const oldestKeyId = keyIds[0];
    const newestKeyId = keyIds[keyIds.length - 1];

    const oldest = await api('GET', `/api/vault/keys/verifier/${oldestKeyId}`, 'Verifier');
    assert.strictEqual(oldest.status, 404, '超過保留上限的最舊版本應該真的被淘汰');
    assert.strictEqual(oldest.body.code, 'VAULT_KEY_VERSION_NOT_FOUND');

    const newest = await api('GET', `/api/vault/keys/verifier/${newestKeyId}`, 'Verifier');
    assert.strictEqual(newest.status, 200, '保留上限內的版本應該還在');

    const history = await api('GET', '/api/vault/keys/verifier', 'Verifier');
    assert.strictEqual(history.body.history.length, vaultKeys.MAX_HISTORY, `歷史紀錄數應該剛好等於 MAX_HISTORY（${vaultKeys.MAX_HISTORY}）`);
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
