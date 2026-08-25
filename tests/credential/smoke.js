'use strict';

/**
 * tests/credential/smoke.js — services/credential（Day 5 追加功能①，JWT 格式碳足跡
 * Verifiable Credential）的端到端與攻擊測試。真的簽真的驗，不 mock 簽章或 ZK 驗證。
 */

const assert = require('assert');
const credential = require('../../services/credential');
const identity = require('../../services/identity');
const { signJwt } = require('../../services/credential/jwt');
const zk = require('../../services/proof/zk');
const { toScaled } = require('../../packages/contracts/fixedPoint');

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

const NORMAL_PARAMS = {
  actorId: 'actor-supplier-steel-01',
  caseId: 'CASE-2026-001',
  installationId: 'TW-STEEL-01',
  reportingYear: 2026,
  productionTonnes: 200,
  verifiedIntensity: 1.8,
};

async function main() {
  let normalJwt;

  await check('normal: 簽發 + 驗證，四層檢查都過，總排放量跟人工算的一致', async () => {
    const { jwt, payload } = await credential.issueCarbonFootprintVC(NORMAL_PARAMS);
    normalJwt = jwt;
    assert.strictEqual(payload.vc.credentialSubject.totalScaled, toScaled(200 * 1.8));
    const result = await credential.verifyCarbonFootprintVC(jwt);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.signatureValid, true);
    assert.strictEqual(result.notExpired, true);
    assert.strictEqual(result.zkProofValid, true);
    assert.strictEqual(result.issuerIdentityValid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  await check('non-compliant 情境：超過合規上限的憑證依然是誠實、可驗證的合法憑證（不是驗證失敗）', async () => {
    const { jwt } = await credential.issueCarbonFootprintVC({
      ...NORMAL_PARAMS,
      productionTonnes: 500, // 500*1.8=900 > 400 門檻
    });
    const result = await credential.verifyCarbonFootprintVC(jwt);
    assert.strictEqual(result.valid, true, 'compliant=false 不代表驗證失敗');
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    assert.strictEqual(payload.vc.credentialSubject.compliant, false);
  });

  await check('攻擊：竄改 payload 任一欄位（例如把 totalScaled 改小）→ 簽章驗證直接失敗', async () => {
    const [header, payloadB64, sig] = normalJwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.vc.credentialSubject.totalScaled = 1;
    const tampered = [header, Buffer.from(JSON.stringify(payload)).toString('base64url'), sig].join('.');
    const result = await credential.verifyCarbonFootprintVC(tampered);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.signatureValid, false);
    assert.strictEqual(result.payload, null, '簽章沒過就不該回傳內容給呼叫端使用');
  });

  await check('攻擊：宣稱的 iss 不在身份 Registry 內 → 拒絕（沒有公鑰可以驗）', async () => {
    const fakeKeyPair = require('crypto').generateKeyPairSync('ed25519');
    const fakeJwt = signJwt({ iss: 'actor-does-not-exist', sub: 'x', vc: {} }, fakeKeyPair.privateKey);
    const result = await credential.verifyCarbonFootprintVC(fakeJwt);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors[0].includes('不在身份 Registry 內'));
  });

  await check('攻擊：已撤銷身份的 actor 直接被拒絕簽發（不會簽出一張壞掉的憑證）', async () => {
    await assert.rejects(
      () =>
        credential.issueCarbonFootprintVC({
          ...NORMAL_PARAMS,
          actorId: 'actor-supplier-revoked-01',
        }),
      (err) => err.code === 'ISSUER_IDENTITY_INVALID'
    );
  });

  await check('防禦縱深：verify() 自己也會重查簽發者現在的身份狀態，不是只信任「簽發時應該有檢查過」', async () => {
    // 直接繞過 issueCarbonFootprintVC() 的簽發前檢查，用已撤銷身份自己的真金鑰手動簽一張
    // 「原本不該被簽出來」的憑證，藉此獨立測試 verify() 有沒有自己的防線，而不是依賴
    // issue() 那邊已經擋過一次。
    const revokedActorId = 'actor-supplier-revoked-01';
    const keyPair = identity.getSigningKeyPair(revokedActorId);
    const zkResult = await zk.generateRealZkProof({
      quantityScaled: [toScaled(1.0), 0, 0, 0],
      factorScaled: [toScaled(100), 0, 0, 0],
      complianceThresholdScaled: toScaled(400),
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      iss: revokedActorId,
      sub: 'CASE-FAKE',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      jti: 'urn:mandate:credential:forged-by-test',
      vc: {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'CarbonFootprintCredential'],
        credentialSubject: {
          caseId: 'CASE-FAKE',
          totalScaled: zkResult.totalScaled,
          compliant: zkResult.compliant,
          complianceThresholdScaled: toScaled(400),
          zkProof: { proof: zkResult.proof, publicSignals: zkResult.publicSignals },
        },
      },
    };
    const forgedJwt = signJwt(payload, keyPair.privateKey);
    const result = await credential.verifyCarbonFootprintVC(forgedJwt);
    assert.strictEqual(result.signatureValid, true, '簽章本身是用真金鑰簽的，應該要過');
    assert.strictEqual(result.zkProofValid, true, 'ZK proof 本身也是真的算對的，應該要過');
    assert.strictEqual(result.issuerIdentityValid, false, '但簽發者身份已撤銷，這層要擋下來');
    assert.strictEqual(result.valid, false, '整體 valid 要因為身份無效而是 false');
  });

  await check('攻擊：外層宣稱的 totalScaled 跟內嵌 ZK proof 的 publicSignals 對不起來（各自合法但兜不起來）', async () => {
    const steelKeyPair = identity.getSigningKeyPair('actor-supplier-steel-01');
    // 用一組跟宣稱數字不同的真實 ZK proof（proof 本身完全合法，只是證明的是另一個總數）
    const zkResult = await zk.generateRealZkProof({
      quantityScaled: [toScaled(1.0), 0, 0, 0],
      factorScaled: [toScaled(50), 0, 0, 0], // 真正的 total 應該是 50
      complianceThresholdScaled: toScaled(400),
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'actor-supplier-steel-01',
      sub: 'CASE-MISMATCH',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      jti: 'urn:mandate:credential:mismatch-test',
      vc: {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'CarbonFootprintCredential'],
        credentialSubject: {
          caseId: 'CASE-MISMATCH',
          totalScaled: toScaled(999), // 謊報成 999，proof 證明的其實是 50
          compliant: true,
          complianceThresholdScaled: toScaled(400),
          zkProof: { proof: zkResult.proof, publicSignals: zkResult.publicSignals },
        },
      },
    };
    const mismatchJwt = signJwt(payload, steelKeyPair.privateKey);
    const result = await credential.verifyCarbonFootprintVC(mismatchJwt);
    assert.strictEqual(result.signatureValid, true);
    assert.strictEqual(result.zkProofValid, false, '外層數字跟 proof 內部數字對不起來，這層要擋下來');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('對不起來')));
  });

  await check('攻擊：過期憑證', async () => {
    const keyPair = identity.getSigningKeyPair('actor-supplier-steel-01');
    const zkResult = await zk.generateRealZkProof({
      quantityScaled: [toScaled(1.8), 0, 0, 0],
      factorScaled: [toScaled(200), 0, 0, 0],
      complianceThresholdScaled: toScaled(400),
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'actor-supplier-steel-01',
      sub: 'CASE-2026-001',
      iat: nowSeconds - 7200,
      exp: nowSeconds - 3600, // 一小時前就過期了
      jti: 'urn:mandate:credential:expired-test',
      vc: {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'CarbonFootprintCredential'],
        credentialSubject: {
          caseId: 'CASE-2026-001',
          totalScaled: zkResult.totalScaled,
          compliant: zkResult.compliant,
          complianceThresholdScaled: toScaled(400),
          zkProof: { proof: zkResult.proof, publicSignals: zkResult.publicSignals },
        },
      },
    };
    const expiredJwt = signJwt(payload, keyPair.privateKey);
    const result = await credential.verifyCarbonFootprintVC(expiredJwt);
    assert.strictEqual(result.notExpired, false);
    assert.strictEqual(result.valid, false);
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
