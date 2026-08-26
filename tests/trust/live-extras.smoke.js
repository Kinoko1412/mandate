'use strict';

/**
 * tests/trust/live-extras.smoke.js — Day 5 追加③：真 zk-SNARK 電路 + vLEI 身份鏈驗證
 * 接進 trustAdapter 即時流程（trustAdapter.verifyRealZkForShipment /
 * verifyLiveIdentityForCase / evaluateTrustScenarioLive）。
 *
 * 原本叫 realzk.smoke.js，後來 vLEI 身份檢查也接進同一個 live-only 疊加層，改名反映
 * 實際涵蓋範圍——不是只測 ZK 了。
 *
 * 跟 tests/trust/smoke.js 的分工：那份測的是既有（同步）evaluateTrustScenario() 的
 * commitment 層攻擊矩陣，完全沒被這次改動碰到；這份測的是新增的 async 疊加層本身——
 * 真的呼叫 services/proof/zk.js 做 groth16 fullProve/verify（不是 mock），慢，但這是
 * 真正在測「電路/身份查核有沒有真的被跑」，不是測「程式碼形狀對不對」。
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const trustAdapter = require('../../server/trustAdapter');
const workflowStore = require('../../server/workflowStore');

const CASE_ID = 'CASE-2026-001';
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

async function api(method, path, role, body) {
  const headers = {};
  if (role) headers['x-demo-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://liveextras.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleFetchRequest(request);
  return { status: response.status, body: await response.json() };
}

async function main() {
  workflowStore.reset();

  await check('真實 HTTP E2E：正式 evaluator revalidate 到 READY_FOR_VERIFIER 時，proof.checks 真的含 real_zk_proof + vlei_identity pass', async () => {
    await api('POST', '/api/workflow/reset', 'Supplier', {});
    const specs = [
      ['electricity_bill', 'elec.pdf', 'liveextras-elec'],
      ['fuel_ledger', 'fuel.pdf', 'liveextras-fuel'],
      ['production_report', 'prod.pdf', 'liveextras-prod'],
      ['precursor_list', 'prec.pdf', 'liveextras-precursor'],
    ];
    for (const [type, filename, text] of specs) {
      const upload = await api('POST', '/api/evidence', 'Supplier', {
        caseId: CASE_ID,
        filename,
        mediaType: 'application/pdf',
        contentBase64: Buffer.from(text, 'utf8').toString('base64'),
        metadata: { type, coveredFrom: '2026-01-01', coveredTo: '2026-12-31', source: 'demo' },
      });
      assert.strictEqual(upload.status, 201);
      await api('POST', `/api/evidence/${upload.body.evidence.evidenceId}/confirm`, 'Supplier', { confirmed: true });
    }
    await api('POST', `/api/cases/${CASE_ID}/submit`, 'Supplier', {});
    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(revalidate.body.case.services.proof.verification, 'verified');

    const checks = revalidate.body.case.services.proof.checks;
    const zkChecks = checks.filter((c) => c.name === 'real_zk_proof');
    const identityChecks = checks.filter((c) => c.name === 'vlei_identity');
    assert.ok(zkChecks.length >= 2, `應該至少有 2 筆 real_zk_proof check（對應 SHIP-A/SHIP-B），實際 ${zkChecks.length}`);
    assert.ok(zkChecks.every((c) => c.status === 'pass'), 'real_zk_proof 全部應該 pass');
    assert.strictEqual(identityChecks.length, 1, '身份檢查是案件層級，一次就好，不用每批各查一次');
    assert.strictEqual(identityChecks[0].status, 'pass');
  });

  await check('verifyRealZkForShipment：intensityScaled × quantityTonnesScaled 跟已存檔 allocatedEmissionsScaled 對得起來時回 ok:true', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    assert.ok(trustContext.ok);
    const expectation = trustContext.shipmentExpectations[0];
    const outcome = await trustAdapter.verifyRealZkForShipment(trustContext, expectation);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.check.status, 'pass');
  });

  await check('攻擊：expectation.allocatedEmissionsScaled 被竄改成跟電路實際算出的不一致時，回 ok:false/PUBLIC_INPUT_MISMATCH', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const realExpectation = trustContext.shipmentExpectations[0];
    const tamperedExpectation = { ...realExpectation, allocatedEmissionsScaled: realExpectation.allocatedEmissionsScaled + 1 };
    const outcome = await trustAdapter.verifyRealZkForShipment(trustContext, tamperedExpectation);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reasonCode, 'PUBLIC_INPUT_MISMATCH');
  });

  await check('沒有設定 complianceThresholdScaled 的政策版本：直接 skip，不影響其他政策版本行為', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const expectation = trustContext.shipmentExpectations[0];
    const noThresholdContext = { ...trustContext, policyRecord: { ...trustContext.policyRecord, complianceThresholdScaled: undefined } };
    const outcome = await trustAdapter.verifyRealZkForShipment(noThresholdContext, expectation);
    assert.strictEqual(outcome.ok, null);
    assert.strictEqual(outcome.check.status, 'skipped');
  });

  await check('verifyLiveIdentityForCase：正常案件（ORG-TW-STEEL-SUPPLIER）通過 vLEI 身份鏈驗證', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const outcome = trustAdapter.verifyLiveIdentityForCase(trustContext);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.check.status, 'pass');
  });

  await check('攻擊：supplierOrgId 不在 vLEI Registry 內 → ok:false/AUTHORIZATION_INVALID（不是默默放行）', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const fakeOrgContext = { ...trustContext, caseRecord: { ...trustContext.caseRecord, supplierOrgId: 'ORG-DOES-NOT-EXIST' } };
    const outcome = trustAdapter.verifyLiveIdentityForCase(fakeOrgContext);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reasonCode, 'AUTHORIZATION_INVALID');
  });

  await check('攻擊：組織對到的身份鏈已撤銷 → ok:false/AUTHORIZATION_REVOKED，且不會被靜默放行到 GATE_OK', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const revokedOrgContext = {
      ...trustContext,
      caseRecord: { ...trustContext.caseRecord, supplierOrgId: 'ORG-DEMO-REVOKED-SUPPLIER' },
    };
    const outcome = trustAdapter.verifyLiveIdentityForCase(revokedOrgContext);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reasonCode, 'AUTHORIZATION_REVOKED');
  });

  await check('evaluateTrustScenarioLive：既有防線（commitment 層）沒過時，根本不會多花時間跑真電路或查身份', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const result = await trustAdapter.evaluateTrustScenarioLive({ trustContext, proofEnvelopes: [] });
    assert.strictEqual(result.proof.verification, 'failed');
    const extraChecks = result.proof.checks.filter((c) => c.name === 'real_zk_proof' || c.name === 'vlei_identity');
    assert.strictEqual(extraChecks.length, 0, '既有防線沒過就不該有任何額外 check——不是浪費運算，是語意上沒必要');
  });

  await check('evaluateTrustScenarioLive：身份檢查失敗時，把原本會是 GATE_OK 的結果覆寫成 BLOCKED（不是留著矛盾的 verified+身份失敗並存）', async () => {
    const trustContext = trustAdapter.buildCaseTrustContext(CASE_ID);
    const fakeOrgContext = { ...trustContext, caseRecord: { ...trustContext.caseRecord, supplierOrgId: 'ORG-DOES-NOT-EXIST' } };
    const envelopes = trustAdapter.generateShipmentProofEnvelopes(fakeOrgContext);
    const result = await trustAdapter.evaluateTrustScenarioLive({
      trustContext: fakeOrgContext,
      proofEnvelopes: envelopes,
      claimedInputHash: fakeOrgContext.expectedInputHash,
    });
    assert.strictEqual(result.gate.verification, 'failed');
    assert.strictEqual(result.gateResult.decision, 'BLOCKED');
    assert.ok(result.gate.reasonCodes.includes('AUTHORIZATION_INVALID'));
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  // snarkjs/ffjavascript 的 wasm curve engine 會留一些背景 handle 不主動關閉，
  // 讓 event loop 不會自然淨空——明確 exit，不要讓這份測試在 CI 裡卡死等 timeout。
  process.exit(failed > 0 ? 1 : 0);
}

main();
