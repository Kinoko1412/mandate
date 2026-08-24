'use strict';

/**
 * tests/trust/smoke.js — Day 3 trust engine（services/proof、services/factor-registry、
 * services/policy-gate、trustAdapter 的正式 evaluator）。跟 tests/carbon-core、
 * tests/workflow 同款風格：純 assert，無外部框架。
 *
 * 涵蓋範圍（對照 DAY3_TRUST_ENGINE_HANDOFF.md §11 DoD）：
 *   1. 三個新服務各自的單元測試
 *   2. §10 攻擊矩陣全部 8 列，透過 trustAdapter.evaluateTrustScenario() 組合驗證
 *   3. E2E：走真實 HTTP（reset → evidence → submit → revalidate）用「正式 evaluator」
 *      （不是 setEvaluatorForTests 的 mock）把 normal fixture 推到 READY_FOR_VERIFIER——
 *      這是 hand-off 結尾點名的「第一個驗收」。
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const trustAdapter = require('../../server/trustAdapter');
const { resolveFactorSet } = require('../../services/factor-registry');
const { verifyProofEnvelope, generateDemoProofEnvelope, _resetForTests: resetProofNonces } = require('../../services/proof');
const { evaluateGate } = require('../../services/policy-gate');
const { toScaled } = require('../../packages/contracts/fixedPoint');
const { REASON_CODE, GATE_DECISION } = require('../../packages/contracts/enums');

const CASE_ID = 'CASE-2026-001';
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
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
  const request = new Request(`http://trust.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleFetchRequest(request);
  return { status: response.status, body: await response.json() };
}

function contentBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function submitNormalCaseViaHttp() {
  await api('POST', '/api/workflow/reset', 'Supplier', {});
  const specs = [
    ['electricity_bill', 'elec.pdf', 'trust-smoke-elec'],
    ['fuel_ledger', 'fuel.pdf', 'trust-smoke-fuel'],
    ['production_report', 'prod.pdf', 'trust-smoke-prod'],
    ['precursor_list', 'prec.pdf', 'trust-smoke-precursor'],
  ];
  const uploaded = [];
  for (const [type, filename, text] of specs) {
    const response = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename,
      mediaType: 'application/pdf',
      contentBase64: contentBase64(text),
      metadata: { type, coveredFrom: '2026-01-01', coveredTo: '2026-12-31', source: 'demo' },
    });
    assert.strictEqual(response.status, 201);
    uploaded.push(response.body.evidence);
  }
  for (const evidence of uploaded) {
    const response = await api('POST', `/api/evidence/${evidence.evidenceId}/confirm`, 'Supplier', { confirmed: true });
    assert.strictEqual(response.status, 200);
  }
  const submit = await api('POST', `/api/cases/${CASE_ID}/submit`, 'Supplier', {});
  assert.strictEqual(submit.status, 200);
  return submit;
}

function demoScenarioInput(overrides = {}) {
  const ctx = trustAdapter.getDemoContext();
  const proofEnvelope = overrides.proofEnvelope || generateDemoProofEnvelope({
    caseId: ctx.caseId,
    policyProfileId: ctx.policyProfile.policyProfileId,
    circuitId: ctx.policyProfile.circuitId,
    inputHash: ctx.inputHash,
    quantityTonnesScaled: ctx.quantityTonnesScaled,
  });
  return {
    caseId: ctx.caseId,
    policyProfileId: ctx.policyProfile.policyProfileId,
    inputHash: ctx.inputHash,
    policyProfile: ctx.policyProfile,
    factorSetId: ctx.factorSetId,
    quantityTonnesScaled: ctx.quantityTonnesScaled,
    evidenceReady: true,
    ...overrides,
    proofEnvelope,
  };
}

async function main() {
  // -------------------------------------------------------------------
  // 1. 服務層單元測試
  // -------------------------------------------------------------------

  await check('factor-registry: active factorSet 通過', () => {
    const result = resolveFactorSet('CBAM-DEMO-2026-v1', {
      policyProfile: { allowedFactorSets: ['CBAM-DEMO-2026-v1'] },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.record.status, 'active');
  });

  await check('factor-registry: 不在允許清單回 FACTOR_NOT_ALLOWED', () => {
    const result = resolveFactorSet('CBAM-DEMO-2026-v1', {
      policyProfile: { allowedFactorSets: ['SOME-OTHER-FACTOR-SET'] },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.FACTOR_NOT_ALLOWED]);
  });

  await check('factor-registry: 未知 factorSetId（不在 registry）回 FACTOR_NOT_ALLOWED', () => {
    const result = resolveFactorSet('FS-SELF-MADE-FAKE', {
      policyProfile: { allowedFactorSets: ['FS-SELF-MADE-FAKE'] },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.FACTOR_NOT_ALLOWED]);
  });

  await check('factor-registry: revoked 回 AUTHORIZATION_REVOKED', () => {
    const result = resolveFactorSet('CBAM-DEMO-2026-REVOKED-v1', {
      policyProfile: { allowedFactorSets: ['CBAM-DEMO-2026-REVOKED-v1'] },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.AUTHORIZATION_REVOKED]);
  });

  await check('factor-registry: expired 回 FACTOR_EXPIRED', () => {
    const result = resolveFactorSet('CBAM-DEMO-2026-EXPIRED-v1', {
      policyProfile: { allowedFactorSets: ['CBAM-DEMO-2026-EXPIRED-v1'] },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.FACTOR_EXPIRED]);
  });

  await check('proof: 合法 envelope 驗證通過並回傳 inputHash', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({
      caseId: CASE_ID, policyProfileId: 'CBAM-STEEL-2026-v1', circuitId: 'cbam-demo-qty-v1',
      inputHash: 'hash-abc', quantityTonnesScaled: toScaled(160),
    });
    const result = verifyProofEnvelope(envelope, {
      caseId: CASE_ID, policyProfileId: 'CBAM-STEEL-2026-v1', circuitId: 'cbam-demo-qty-v1',
      inputHash: 'hash-abc', quantityTonnesScaled: toScaled(160),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.inputHash, 'hash-abc');
  });

  await check('proof: circuitId 不符回 PROOF_CONTEXT_MISMATCH', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({
      caseId: CASE_ID, policyProfileId: 'CBAM-STEEL-2026-v1', circuitId: 'wrong-circuit',
      inputHash: 'hash-abc', quantityTonnesScaled: toScaled(160),
    });
    const result = verifyProofEnvelope(envelope, {
      caseId: CASE_ID, policyProfileId: 'CBAM-STEEL-2026-v1', circuitId: 'cbam-demo-qty-v1',
      inputHash: 'hash-abc', quantityTonnesScaled: toScaled(160),
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.PROOF_CONTEXT_MISMATCH]);
  });

  await check('policy-gate: evidenceReady=false 回 NEEDS_EVIDENCE（不理會 factor/proof 是否通過）', () => {
    const gateResult = evaluateGate({
      policyProfileId: 'CBAM-STEEL-2026-v1',
      factorResult: { ok: true, checks: [], reasonCodes: [] },
      proofResult: { ok: true, checks: [], reasonCodes: [] },
      evidenceReady: false,
      inputHash: 'hash-abc',
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.NEEDS_EVIDENCE);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE]);
  });

  await check('policy-gate: inputHash 即使 BLOCKED 也是必填欄位（schema 要求）', () => {
    const gateResult = evaluateGate({
      policyProfileId: 'CBAM-STEEL-2026-v1',
      factorResult: { ok: false, checks: [], reasonCodes: [REASON_CODE.FACTOR_NOT_ALLOWED] },
      proofResult: { ok: true, checks: [], reasonCodes: [] },
      evidenceReady: true,
      inputHash: 'hash-abc',
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.strictEqual(typeof gateResult.inputHash, 'string');
    assert.ok(gateResult.inputHash.length > 0);
  });

  // -------------------------------------------------------------------
  // 2. §10 攻擊矩陣（8 列），透過 trustAdapter.evaluateTrustScenario() 組合驗證
  // -------------------------------------------------------------------

  await check('attack matrix: normal → GATE_OK，proof/gate 皆 verified', () => {
    resetProofNonces();
    const { proof, gate, gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput());
    assert.strictEqual(gateResult.decision, GATE_DECISION.GATE_OK);
    assert.strictEqual(proof.verification, 'verified');
    assert.strictEqual(gate.verification, 'verified');
    trustAdapter.validateResult({ proof, gate }); // 必須通過 adapter 契約驗證
  });

  await check('attack matrix: tampered_quantity（Proof 宣稱 100t，payload 120t）→ BLOCKED/PUBLIC_INPUT_MISMATCH', () => {
    resetProofNonces();
    const ctx = trustAdapter.getDemoContext();
    const proofEnvelope = generateDemoProofEnvelope({
      caseId: ctx.caseId,
      policyProfileId: ctx.policyProfile.policyProfileId,
      circuitId: ctx.policyProfile.circuitId,
      inputHash: ctx.inputHash,
      quantityTonnesScaled: toScaled(100), // Proof 聲稱 100 噸
    });
    const { gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput({
      proofEnvelope,
      quantityTonnesScaled: toScaled(120), // 實際 payload 是 120 噸
    }));
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PUBLIC_INPUT_MISMATCH]);
  });

  await check('attack matrix: replayed（同一 nonce 用兩次）→ 第二次 BLOCKED/NONCE_REUSED', () => {
    resetProofNonces();
    const ctx = trustAdapter.getDemoContext();
    const proofEnvelope = generateDemoProofEnvelope({
      caseId: ctx.caseId,
      policyProfileId: ctx.policyProfile.policyProfileId,
      circuitId: ctx.policyProfile.circuitId,
      inputHash: ctx.inputHash,
      quantityTonnesScaled: ctx.quantityTonnesScaled,
    });
    const first = trustAdapter.evaluateTrustScenario(demoScenarioInput({ proofEnvelope }));
    assert.strictEqual(first.gateResult.decision, GATE_DECISION.GATE_OK);
    const second = trustAdapter.evaluateTrustScenario(demoScenarioInput({ proofEnvelope }));
    assert.strictEqual(second.gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(second.gateResult.reasonCodes, [REASON_CODE.NONCE_REUSED]);
  });

  await check('attack matrix: revoked factorSet → BLOCKED/AUTHORIZATION_REVOKED', () => {
    resetProofNonces();
    const ctx = trustAdapter.getDemoContext();
    const { gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput({
      factorSetId: 'CBAM-DEMO-2026-REVOKED-v1',
      policyProfile: { ...ctx.policyProfile, allowedFactorSets: ['CBAM-DEMO-2026-REVOKED-v1'] },
    }));
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.AUTHORIZATION_REVOKED]);
  });

  await check('attack matrix: expiry（Proof expiresAt 已過）→ BLOCKED/PROOF_EXPIRED', () => {
    resetProofNonces();
    const ctx = trustAdapter.getDemoContext();
    const expiredEnvelope = generateDemoProofEnvelope({
      caseId: ctx.caseId,
      policyProfileId: ctx.policyProfile.policyProfileId,
      circuitId: ctx.policyProfile.circuitId,
      inputHash: ctx.inputHash,
      quantityTonnesScaled: ctx.quantityTonnesScaled,
      ttlMs: -1000,
    });
    const { gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput({ proofEnvelope: expiredEnvelope }));
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PROOF_EXPIRED]);
  });

  await check('attack matrix: nonce 缺失 → BLOCKED/PROOF_INVALID', () => {
    resetProofNonces();
    const ctx = trustAdapter.getDemoContext();
    const envelope = generateDemoProofEnvelope({
      caseId: ctx.caseId,
      policyProfileId: ctx.policyProfile.policyProfileId,
      circuitId: ctx.policyProfile.circuitId,
      inputHash: ctx.inputHash,
      quantityTonnesScaled: ctx.quantityTonnesScaled,
    });
    delete envelope.nonce;
    const { gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput({ proofEnvelope: envelope }));
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PROOF_INVALID]);
  });

  await check('attack matrix: wrong_factor（factorSetId 不在 allowed）→ BLOCKED/FACTOR_NOT_ALLOWED', () => {
    resetProofNonces();
    const { gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput({
      factorSetId: 'FS-SELF-MADE-FAKE',
    }));
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.FACTOR_NOT_ALLOWED]);
  });

  await check('attack matrix: missing_period（evidenceReady=false）→ NEEDS_EVIDENCE/EVIDENCE_PERIOD_INCOMPLETE', () => {
    resetProofNonces();
    const { gateResult } = trustAdapter.evaluateTrustScenario(demoScenarioInput({ evidenceReady: false }));
    assert.strictEqual(gateResult.decision, GATE_DECISION.NEEDS_EVIDENCE);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE]);
  });

  // -------------------------------------------------------------------
  // 3. E2E：真實 HTTP + 正式 evaluator（非 mock）— hand-off 結尾點名的「第一個驗收」
  // -------------------------------------------------------------------

  await check('E2E: normal fixture 走完整 HTTP 流程，用正式 evaluator（非 mock）revalidate 到 READY_FOR_VERIFIER', async () => {
    resetProofNonces();
    trustAdapter.resetEvaluatorForTests();
    trustAdapter.setEvaluatorForTests(trustAdapter.productionEvaluator); // 明確接上「正式」evaluator，不是隨手寫的 mock
    const submit = await submitNormalCaseViaHttp();
    assert.strictEqual(submit.body.case.status, 'METHOD_REVIEW');

    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(revalidate.body.readiness.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(revalidate.body.case.services.proof.verification, 'verified');
    assert.strictEqual(revalidate.body.case.services.gate.verification, 'verified');
    assert.strictEqual(revalidate.body.case.services.agent.status, 'unavailable'); // Agent 不阻擋 READY
    assert.match(revalidate.body.case.readyDisclaimer, /不代表正式查驗完成/);

    // 沒有正式查驗誤述字樣
    const serialized = JSON.stringify(revalidate.body);
    for (const forbidden of ['CBAM Certified', 'Officially Approved', '海關已核准', '官方查驗完成', 'Registry 已提交']) {
      assert.ok(!serialized.includes(forbidden), `revalidate response 不應包含「${forbidden}」`);
    }
  });

  await check('E2E: 重複點擊 revalidate 不會誤觸 nonce 重放（正式 evaluator 每次都重新產生 Proof）', async () => {
    const first = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    const second = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(first.body.case.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(second.body.case.status, 'READY_FOR_VERIFIER');
    assert.deepStrictEqual(second.body.readiness.reasonCodes, []);
  });

  trustAdapter.resetEvaluatorForTests(); // 收尾：確保跑完這個檔案後回到 unavailable，不影響其他 smoke 檔案

  console.log(`\nRESULT: ${failed === 0 ? 'all PASS' : `${failed} failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
