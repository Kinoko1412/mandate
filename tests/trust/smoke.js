'use strict';

/**
 * tests/trust/smoke.js — Day 3 trust engine（services/proof、services/factor-registry、
 * services/policy-registry、services/policy-gate、trustAdapter 的正式 evaluator）。
 * 跟 tests/carbon-core、tests/workflow 同款風格：純 assert，無外部框架。
 *
 * 涵蓋範圍：
 *   1. 四個服務各自的單元測試（含 P1 修正新增的 registry 欄位比對、commitment 重算、
 *      nonce ledger TTL／容量／原子消費）
 *   2. 攻擊矩陣（規格 p.8 Fixture 表 + 分工計畫 p.9 攻擊驗收表），透過
 *      trustAdapter.evaluateTrustScenario() 對「真實案件快照」注入攻擊 envelope
 *   3. E2E：走真實 HTTP（reset → evidence → submit → revalidate）用正式 evaluator
 *      把 normal 推到 READY_FOR_VERIFIER；缺半年證據推到 NEEDS_EVIDENCE
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const trustAdapter = require('../../server/trustAdapter');
const { resolveFactorSet, factorSetSnapshotHash, getFactorSetRecord } = require('../../services/factor-registry');
const { resolvePolicyProfile, getPolicyRecord } = require('../../services/policy-registry');
const {
  verifyProofEnvelope,
  generateDemoProofEnvelope,
  buildProofCommitment,
  createMemoryNonceLedger,
  setNonceLedger,
  getNonceLedger,
  _resetForTests: resetProofNonces,
} = require('../../services/proof');
const { evaluateGate, evaluateEvidenceCoverage } = require('../../services/policy-gate');
const { toScaled } = require('../../packages/contracts/fixedPoint');
const { REASON_CODE, GATE_DECISION } = require('../../packages/contracts/enums');
const normalFixture = require('../../fixtures/normal.json');

const CASE_ID = 'CASE-2026-001';
const FULL_YEAR = { coveredFrom: '2026-01-01', coveredTo: '2026-12-31' };
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

/**
 * 走真實 HTTP 把 Demo 案件推到已提交狀態。`periods` 可覆寫個別證據的涵蓋期間，
 * 用來造「電費只涵蓋 1–6 月」這種真實缺期情境（不是傳布林旗標給 Gate）。
 */
async function submitCaseViaHttp(periods = {}) {
  await api('POST', '/api/workflow/reset', 'Supplier', {});
  const specs = [
    ['electricity_bill', 'elec.pdf', 'trust-smoke-elec'],
    ['fuel_ledger', 'fuel.pdf', 'trust-smoke-fuel'],
    ['production_report', 'prod.pdf', 'trust-smoke-prod'],
    ['precursor_list', 'prec.pdf', 'trust-smoke-precursor'],
  ];
  const uploaded = [];
  for (const [type, filename, text] of specs) {
    const period = periods[type] || FULL_YEAR;
    const response = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename,
      mediaType: 'application/pdf',
      contentBase64: contentBase64(text),
      metadata: { type, coveredFrom: period.coveredFrom, coveredTo: period.coveredTo, source: 'demo' },
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

/** 準備一份「已提交、證據齊全」的真實案件快照供攻擊矩陣使用。 */
async function preparedContext() {
  resetProofNonces();
  await submitCaseViaHttp();
  const context = trustAdapter.buildCaseTrustContext(CASE_ID);
  assert.strictEqual(context.ok, true);
  assert.strictEqual(context.shipmentExpectations.length, 2);
  return context;
}

function envelopesFor(context, mutate) {
  return context.shipmentExpectations.map((expectation, index) => {
    const envelope = generateDemoProofEnvelope({
      circuitId: context.circuitId,
      publicInputs: trustAdapter.expectedPublicInputs(context, expectation),
      now: context.now,
    });
    return mutate ? mutate(envelope, index, expectation) : envelope;
  });
}

/** 攻擊者改了 publicInputs 之後，重新算一份「格式正確」的 commitment。 */
function recommit(envelope) {
  return {
    ...envelope,
    proof: buildProofCommitment({
      circuitId: envelope.circuitId,
      verificationKeyId: envelope.verificationKeyId,
      publicInputs: envelope.publicInputs,
      nonce: envelope.nonce,
    }),
  };
}

function withPublicInputs(envelope, patch) {
  return recommit({ ...envelope, publicInputs: { ...envelope.publicInputs, ...patch } });
}

async function main() {
  // -------------------------------------------------------------------
  // 1. Factor Registry
  // -------------------------------------------------------------------

  await check('factor-registry: active factorSet 通過並回傳不可變快照 hash', () => {
    const result = resolveFactorSet('CBAM-DEMO-2026-v1', {
      policyProfile: { allowedFactorSets: ['CBAM-DEMO-2026-v1'] },
      factorSet: normalFixture.factorSet,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.record.status, 'active');
    assert.strictEqual(result.factorSetHash, factorSetSnapshotHash(getFactorSetRecord('CBAM-DEMO-2026-v1')));
    assert.match(result.factorSetHash, /^sha256:[0-9a-f]{64}$/);
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

  await check('factor-registry: issuer／purpose／version／sourceHash 被調包時回 FACTOR_NOT_ALLOWED', () => {
    for (const patch of [
      { issuer: 'self-declared-authority' },
      { purpose: 'CBAM_DEFAULT' },
      { version: '99' },
      { sourceHash: 'sha256:self-made' },
    ]) {
      const result = resolveFactorSet('CBAM-DEMO-2026-v1', {
        policyProfile: { allowedFactorSets: ['CBAM-DEMO-2026-v1'] },
        factorSet: { ...normalFixture.factorSet, ...patch },
      });
      assert.strictEqual(result.ok, false, `${Object.keys(patch)[0]} 被調包時應失敗`);
      assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.FACTOR_NOT_ALLOWED]);
    }
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

  // -------------------------------------------------------------------
  // 2. Policy Registry
  // -------------------------------------------------------------------

  await check('policy-registry: 權威政策通過並回傳不可變快照 hash', () => {
    const result = resolvePolicyProfile('CBAM-STEEL-2026-v1', {
      caseRecord: normalFixture.case,
      installationYear: normalFixture.installationYear,
      declaredPolicyProfile: normalFixture.policyProfile,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.record.circuitId, 'cbam-demo-qty-v1');
    assert.match(result.policySnapshotHash, /^sha256:[0-9a-f]{64}$/);
  });

  await check('policy-registry: 未知 policyProfileId 回 POLICY_NOT_APPLICABLE', () => {
    const result = resolvePolicyProfile('CBAM-STEEL-9999-SELFMADE', {});
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.POLICY_NOT_APPLICABLE]);
  });

  await check('policy-registry: inactive／已失效政策回 POLICY_NOT_APPLICABLE', () => {
    const result = resolvePolicyProfile('CBAM-STEEL-2025-RETIRED-v1', {
      caseRecord: normalFixture.case,
      installationYear: normalFixture.installationYear,
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.POLICY_NOT_APPLICABLE]);
  });

  await check('policy-registry: 錯 CN code 與錯年度都回 POLICY_NOT_APPLICABLE', () => {
    const wrongCn = resolvePolicyProfile('CBAM-STEEL-2026-v1', {
      caseRecord: { ...normalFixture.case, cnCode: '72099999' },
      installationYear: normalFixture.installationYear,
    });
    assert.strictEqual(wrongCn.ok, false);
    assert.deepStrictEqual(wrongCn.reasonCodes, [REASON_CODE.POLICY_NOT_APPLICABLE]);

    const wrongYear = resolvePolicyProfile('CBAM-STEEL-2026-v1', {
      caseRecord: normalFixture.case,
      installationYear: { ...normalFixture.installationYear, reportingYear: 2025 },
    });
    assert.strictEqual(wrongYear.ok, false);
    assert.deepStrictEqual(wrongYear.reasonCodes, [REASON_CODE.POLICY_NOT_APPLICABLE]);
  });

  await check('policy-registry: 案件偷改 allowedFactorSets／circuitId 會被 immutable snapshot 比對擋下', () => {
    for (const patch of [
      { allowedFactorSets: ['CBAM-DEMO-2026-v1', 'FS-SELF-MADE-FAKE'] },
      { circuitId: 'attacker-circuit' },
      { requiredEvidence: ['electricity_bill'] },
      { version: '99' },
    ]) {
      const result = resolvePolicyProfile('CBAM-STEEL-2026-v1', {
        caseRecord: normalFixture.case,
        installationYear: normalFixture.installationYear,
        declaredPolicyProfile: { ...normalFixture.policyProfile, ...patch },
      });
      assert.strictEqual(result.ok, false, `${Object.keys(patch)[0]} 被偷改時應失敗`);
      assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.POLICY_NOT_APPLICABLE]);
    }
  });

  // -------------------------------------------------------------------
  // 3. Proof：commitment 重算、context 綁定、nonce ledger
  // -------------------------------------------------------------------

  const proofBase = {
    caseId: CASE_ID,
    shipmentId: 'SHIP-A',
    installationId: 'TW-STEEL-01',
    reportingYear: 2026,
    quantityTonnesScaled: toScaled(100),
    allocatedEmissionsScaled: toScaled(180),
    policyProfileId: 'CBAM-STEEL-2026-v1',
    factorSetId: 'CBAM-DEMO-2026-v1',
    inputHash: 'hash-abc',
  };

  await check('proof: 合法 envelope 驗證通過、回傳 inputHash 且不消費 nonce', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({ circuitId: 'cbam-demo-qty-v1', publicInputs: proofBase });
    const result = verifyProofEnvelope(envelope, { ...proofBase, circuitId: 'cbam-demo-qty-v1' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.inputHash, 'hash-abc');
    assert.strictEqual(result.nonce, envelope.nonce);
    assert.strictEqual(getNonceLedger().size(), 0); // verify 只查不消費
    assert.ok(result.checks.some((c) => c.name === 'proof_commitment' && c.status === 'pass'));
    assert.ok(result.checks.some((c) => c.name === 'cryptographic_proof' && c.status === 'skipped'));
  });

  await check('proof: 偽造 proof bytes（commitment 重算不符）回 PROOF_INVALID', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({ circuitId: 'cbam-demo-qty-v1', publicInputs: proofBase });
    for (const forged of [
      'demoOnly:sha256:' + 'f'.repeat(64),
      'demoOnly:sha256:deadbeef',
      envelope.proof.slice(0, -1) + (envelope.proof.endsWith('a') ? 'b' : 'a'),
      'totally-not-a-commitment',
    ]) {
      const result = verifyProofEnvelope({ ...envelope, proof: forged }, { ...proofBase, circuitId: 'cbam-demo-qty-v1' });
      assert.strictEqual(result.ok, false, `偽造 proof=${forged.slice(0, 24)} 應失敗`);
      assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.PROOF_INVALID]);
    }
  });

  await check('proof: 竄改 publicInputs 但不重算 commitment 也會被擋（PUBLIC_INPUT_MISMATCH 或 PROOF_INVALID）', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({ circuitId: 'cbam-demo-qty-v1', publicInputs: proofBase });
    const tampered = {
      ...envelope,
      publicInputs: { ...envelope.publicInputs, quantityTonnesScaled: toScaled(120) },
    };
    const result = verifyProofEnvelope(tampered, { ...proofBase, circuitId: 'cbam-demo-qty-v1' });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.PUBLIC_INPUT_MISMATCH]);
  });

  await check('proof: publicInputs.nonce／expiry 與 envelope 本體不符回 PROOF_CONTEXT_MISMATCH', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({ circuitId: 'cbam-demo-qty-v1', publicInputs: proofBase });
    const swapped = recommit({
      ...envelope,
      publicInputs: { ...envelope.publicInputs, nonce: 'another-nonce-value-01' },
    });
    const result = verifyProofEnvelope(swapped, { ...proofBase, circuitId: 'cbam-demo-qty-v1' });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.PROOF_CONTEXT_MISMATCH]);
  });

  await check('proof: circuitId 不符回 PROOF_CONTEXT_MISMATCH', () => {
    resetProofNonces();
    const envelope = generateDemoProofEnvelope({ circuitId: 'wrong-circuit', publicInputs: proofBase });
    const result = verifyProofEnvelope(envelope, { ...proofBase, circuitId: 'cbam-demo-qty-v1' });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.reasonCodes, [REASON_CODE.PROOF_CONTEXT_MISMATCH]);
  });

  await check('nonce ledger: TTL 到期後自動回收，容量上限會淘汰最舊記錄', () => {
    const ledger = createMemoryNonceLedger({ ttlMs: 1000, maxEntries: 2 });
    const t0 = new Date('2026-08-24T00:00:00Z');
    assert.strictEqual(ledger.consumeAll(['nonce-aaaa-0001'], t0).ok, true);
    assert.strictEqual(ledger.has('nonce-aaaa-0001', t0), true);
    const t1 = new Date(t0.getTime() + 2000);
    assert.strictEqual(ledger.has('nonce-aaaa-0001', t1), false); // TTL 過期
    ledger.consumeAll(['nonce-aaaa-0002'], t1);
    ledger.consumeAll(['nonce-aaaa-0003'], t1);
    ledger.consumeAll(['nonce-aaaa-0004'], t1);
    assert.ok(ledger.size() <= 2, `容量上限應為 2，實際 ${ledger.size()}`);
  });

  await check('nonce ledger: consumeAll 是原子的（整批有一個重複就完全不寫入）', () => {
    const ledger = createMemoryNonceLedger();
    assert.strictEqual(ledger.consumeAll(['nonce-batch-0001']).ok, true);
    const result = ledger.consumeAll(['nonce-batch-0002', 'nonce-batch-0001']);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'ALREADY_CONSUMED');
    assert.strictEqual(ledger.has('nonce-batch-0002'), false); // 沒有被部分寫入
    const duplicated = ledger.consumeAll(['nonce-batch-0003', 'nonce-batch-0003']);
    assert.strictEqual(duplicated.ok, false);
    assert.strictEqual(duplicated.reason, 'DUPLICATE_IN_BATCH');
  });

  await check('nonce ledger: adapter hook 可注入替代實作並驗介面', () => {
    const original = getNonceLedger();
    assert.throws(() => setNonceLedger({}), TypeError);
    const injected = createMemoryNonceLedger({ ttlMs: 60000, maxEntries: 10 });
    setNonceLedger(injected);
    assert.strictEqual(getNonceLedger(), injected);
    setNonceLedger(original);
    assert.strictEqual(getNonceLedger(), original);
  });

  // -------------------------------------------------------------------
  // 4. Policy Gate：decision 順序與真實證據涵蓋
  // -------------------------------------------------------------------

  await check('policy-gate: 證據涵蓋依真實 metadata 計算——全年通過、電費只到 6/30 回 EVIDENCE_PERIOD_INCOMPLETE', () => {
    const full = evaluateEvidenceCoverage({
      installationYear: normalFixture.installationYear,
      evidence: normalFixture.evidenceItems,
      requiredEvidence: normalFixture.policyProfile.requiredEvidence,
    });
    assert.strictEqual(full.ok, true);

    const short = evaluateEvidenceCoverage({
      installationYear: normalFixture.installationYear,
      evidence: normalFixture.evidenceItems.map((item) =>
        item.type === 'electricity_bill' ? { ...item, coveredTo: '2026-06-30' } : item
      ),
      requiredEvidence: normalFixture.policyProfile.requiredEvidence,
    });
    assert.strictEqual(short.ok, false);
    assert.deepStrictEqual(short.reasonCodes, [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE]);
    assert.strictEqual(short.incompleteTypes[0].type, 'electricity_bill');
  });

  await check('policy-gate: requiredEvidence 缺一類回 EVIDENCE_MISSING', () => {
    const result = evaluateEvidenceCoverage({
      installationYear: normalFixture.installationYear,
      evidence: normalFixture.evidenceItems.filter((item) => item.type !== 'precursor_list'),
      requiredEvidence: normalFixture.policyProfile.requiredEvidence,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasonCodes.includes(REASON_CODE.EVIDENCE_MISSING));
    assert.deepStrictEqual(result.missingTypes, ['precursor_list']);
  });

  await check('policy-gate: 硬失敗優先於缺件（規格 p.13 Final Mapping）', () => {
    const gateResult = evaluateGate({
      policyProfileId: 'CBAM-STEEL-2026-v1',
      policyResult: { ok: true, checks: [], reasonCodes: [] },
      factorResult: { ok: false, checks: [], reasonCodes: [REASON_CODE.FACTOR_NOT_ALLOWED] },
      proofResult: { ok: true, checks: [], reasonCodes: [] },
      evidenceResult: { ok: false, checks: [], reasonCodes: [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE] },
      inputHash: 'hash-abc',
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.FACTOR_NOT_ALLOWED]);
    assert.strictEqual(typeof gateResult.inputHash, 'string');
  });

  await check('policy-gate: 只有缺件時回 NEEDS_EVIDENCE 而不是 BLOCKED', () => {
    const gateResult = evaluateGate({
      policyProfileId: 'CBAM-STEEL-2026-v1',
      policyResult: { ok: true, checks: [], reasonCodes: [] },
      factorResult: { ok: true, checks: [], reasonCodes: [] },
      proofResult: { ok: true, checks: [], reasonCodes: [] },
      evidenceResult: { ok: false, checks: [], reasonCodes: [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE] },
      inputHash: 'hash-abc',
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.NEEDS_EVIDENCE);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE]);
  });

  // -------------------------------------------------------------------
  // 5. 攻擊矩陣：對「真實案件快照」注入攻擊 envelope
  // -------------------------------------------------------------------

  await check('attack matrix: normal 兩批全驗證 → GATE_OK，proof/gate 皆 verified', async () => {
    const context = await preparedContext();
    const { proof, gate, gateResult } = trustAdapter.evaluateTrustScenario({
      trustContext: context,
      proofEnvelopes: envelopesFor(context),
      claimedInputHash: context.expectedInputHash,
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.GATE_OK);
    assert.strictEqual(proof.verification, 'verified');
    assert.strictEqual(gate.verification, 'verified');
    assert.strictEqual(proof.inputHash, context.expectedInputHash);
    trustAdapter.validateResult({ proof, gate });
    assert.ok(proof.checks.some((c) => c.name === 'nonce_consume' && c.status === 'pass'));
  });

  await check('attack matrix: 任意 inputHash（呼叫端自帶）→ BLOCKED/PUBLIC_INPUT_MISMATCH', async () => {
    const context = await preparedContext();
    const { proof, gateResult } = trustAdapter.evaluateTrustScenario({
      trustContext: context,
      proofEnvelopes: envelopesFor(context),
      claimedInputHash: 'sha256:attacker-chosen-input-hash',
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.ok(gateResult.reasonCodes.includes(REASON_CODE.PUBLIC_INPUT_MISMATCH));
    assert.strictEqual(proof.verification, 'failed');
  });

  await check('attack matrix: envelope 夾帶假 inputHash → BLOCKED/PUBLIC_INPUT_MISMATCH', async () => {
    const context = await preparedContext();
    const envelopes = envelopesFor(context, (envelope, index) =>
      index === 0 ? withPublicInputs(envelope, { inputHash: 'sha256:forged-receipt' }) : envelope
    );
    const { gateResult } = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: envelopes });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PUBLIC_INPUT_MISMATCH]);
  });

  await check('attack matrix: tampered_quantity（Proof 宣稱 100t，實際批次 120t）→ BLOCKED/PUBLIC_INPUT_MISMATCH', async () => {
    const context = await preparedContext();
    // SHIP-A 實際 100 噸；攻擊者宣稱 120 噸並重算一份格式正確的 commitment。
    const envelopes = envelopesFor(context, (envelope, index) =>
      index === 0
        ? withPublicInputs(envelope, {
            quantityTonnesScaled: toScaled(120),
            allocatedEmissionsScaled: toScaled(216),
          })
        : envelope
    );
    const { gateResult } = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: envelopes });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PUBLIC_INPUT_MISMATCH]);
  });

  await check('attack matrix: 偽造 proof commitment → BLOCKED/PROOF_INVALID', async () => {
    const context = await preparedContext();
    const envelopes = envelopesFor(context, (envelope, index) =>
      index === 0 ? { ...envelope, proof: `demoOnly:sha256:${'0'.repeat(64)}` } : envelope
    );
    const { gateResult } = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: envelopes });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PROOF_INVALID]);
  });

  await check('attack matrix: SHIP-A 的 Proof 套到 SHIP-B → BLOCKED/PROOF_CONTEXT_MISMATCH', async () => {
    const context = await preparedContext();
    const [shipA] = envelopesFor(context);
    // SHIP-B 位置塞一份綁在 SHIP-A 的 envelope（不同物件、同樣內容）。
    const { gateResult } = trustAdapter.evaluateTrustScenario({
      trustContext: context,
      proofEnvelopes: [shipA, { ...shipA }],
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PROOF_CONTEXT_MISMATCH]);
  });

  await check('attack matrix: 換年度／換工廠／換政策／換係數的 Proof 都回 PROOF_CONTEXT_MISMATCH', async () => {
    for (const patch of [
      { reportingYear: 2025 },
      { installationId: 'TW-STEEL-99' },
      { policyProfileId: 'CBAM-STEEL-2026-REVOKEDFACTOR-v1' },
      { policyVersion: '99' },
      { policySnapshotHash: 'sha256:self-made-policy' },
      { factorSetId: 'CBAM-DEMO-2026-EXPIRED-v1' },
      { factorSetHash: 'sha256:self-made-factor' },
      { caseId: 'CASE-2026-999' },
    ]) {
      const context = await preparedContext();
      const envelopes = envelopesFor(context, (envelope, index) =>
        index === 0 ? withPublicInputs(envelope, patch) : envelope
      );
      const { gateResult } = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: envelopes });
      assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED, `${Object.keys(patch)[0]} 應被擋`);
      assert.deepStrictEqual(
        gateResult.reasonCodes,
        [REASON_CODE.PROOF_CONTEXT_MISMATCH],
        `${Object.keys(patch)[0]} 應回 PROOF_CONTEXT_MISMATCH`
      );
    }
  });

  await check('attack matrix: Proof 過期 → BLOCKED/PROOF_EXPIRED', async () => {
    const context = await preparedContext();
    const envelopes = context.shipmentExpectations.map((expectation) =>
      generateDemoProofEnvelope({
        circuitId: context.circuitId,
        publicInputs: trustAdapter.expectedPublicInputs(context, expectation),
        now: context.now,
        ttlMs: -1000,
      })
    );
    const { gateResult } = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: envelopes });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.PROOF_EXPIRED]);
  });

  await check('attack matrix: nonce 缺失／格式錯 → BLOCKED/PROOF_INVALID', async () => {
    const context = await preparedContext();
    const missing = envelopesFor(context, (envelope, index) => {
      if (index !== 0) return envelope;
      const copy = { ...envelope };
      delete copy.nonce;
      return copy;
    });
    const first = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: missing });
    assert.strictEqual(first.gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(first.gateResult.reasonCodes, [REASON_CODE.PROOF_INVALID]);

    const context2 = await preparedContext();
    const badFormat = envelopesFor(context2, (envelope, index) =>
      index === 0 ? { ...envelope, nonce: 'short' } : envelope
    );
    const second = trustAdapter.evaluateTrustScenario({ trustContext: context2, proofEnvelopes: badFormat });
    assert.strictEqual(second.gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(second.gateResult.reasonCodes, [REASON_CODE.PROOF_INVALID]);
  });

  await check('attack matrix: 重放同一組 Proof → 第二次 BLOCKED/NONCE_REUSED', async () => {
    const context = await preparedContext();
    const envelopes = envelopesFor(context);
    const first = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: envelopes });
    assert.strictEqual(first.gateResult.decision, GATE_DECISION.GATE_OK);
    const second = trustAdapter.evaluateTrustScenario({
      trustContext: context,
      proofEnvelopes: envelopes.map((envelope) => ({ ...envelope })),
    });
    assert.strictEqual(second.gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(second.gateResult.reasonCodes, [REASON_CODE.NONCE_REUSED]);
  });

  await check('attack matrix: 失敗請求不占用 nonce（invalid request nonce poisoning）', async () => {
    const context = await preparedContext();
    const honest = envelopesFor(context);
    const victimNonces = honest.map((envelope) => envelope.nonce);

    // 攻擊者拿同一組 nonce 發一個偽造 commitment 的請求 → 必須失敗且不寫入 ledger。
    const poisoned = honest.map((envelope) => ({ ...envelope, proof: `demoOnly:sha256:${'1'.repeat(64)}` }));
    const attack = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: poisoned });
    assert.strictEqual(attack.gateResult.decision, GATE_DECISION.BLOCKED);
    assert.ok(victimNonces.every((nonce) => getNonceLedger().has(nonce) === false), '失敗請求不得占用 nonce');

    // 正常持有人再送同一組 nonce 的合法 Proof → 仍然可以通過。
    const honestRun = trustAdapter.evaluateTrustScenario({ trustContext: context, proofEnvelopes: honest });
    assert.strictEqual(honestRun.gateResult.decision, GATE_DECISION.GATE_OK);
    assert.ok(victimNonces.every((nonce) => getNonceLedger().has(nonce) === true));
  });

  await check('attack matrix: revoked／expired／wrong factorSet 的 reason code 穩定', async () => {
    const cases = [
      ['CBAM-DEMO-2026-REVOKED-v1', REASON_CODE.AUTHORIZATION_REVOKED],
      ['CBAM-DEMO-2026-EXPIRED-v1', REASON_CODE.FACTOR_EXPIRED],
      ['FS-SELF-MADE-FAKE', REASON_CODE.FACTOR_NOT_ALLOWED],
    ];
    for (const [factorSetId, expectedCode] of cases) {
      const context = await preparedContext();
      const attacked = {
        ...context,
        factorResult: resolveFactorSet(factorSetId, {
          policyProfile: { allowedFactorSets: [factorSetId] },
        }),
      };
      const { gateResult } = trustAdapter.evaluateTrustScenario({
        trustContext: attacked,
        proofEnvelopes: envelopesFor(context),
      });
      assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED, `${factorSetId} 應被擋`);
      assert.deepStrictEqual(gateResult.reasonCodes, [expectedCode], `${factorSetId} reason code 應穩定`);
    }
  });

  await check('attack matrix: 不適用政策 → BLOCKED/POLICY_NOT_APPLICABLE', async () => {
    const context = await preparedContext();
    const attacked = {
      ...context,
      policyResult: resolvePolicyProfile('CBAM-STEEL-2025-RETIRED-v1', {
        caseRecord: context.caseRecord,
        installationYear: context.installationYear,
      }),
    };
    const { gateResult } = trustAdapter.evaluateTrustScenario({
      trustContext: attacked,
      proofEnvelopes: envelopesFor(context),
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.deepStrictEqual(gateResult.reasonCodes, [REASON_CODE.POLICY_NOT_APPLICABLE]);
  });

  await check('attack matrix: 已存檔 CalculationReceipt 被換掉 → BLOCKED/PUBLIC_INPUT_MISMATCH', async () => {
    const context = await preparedContext();
    const attacked = { ...context, storedInputHash: 'sha256:swapped-receipt' };
    const { gateResult } = trustAdapter.evaluateTrustScenario({
      trustContext: attacked,
      proofEnvelopes: envelopesFor(context),
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.ok(gateResult.reasonCodes.includes(REASON_CODE.PUBLIC_INPUT_MISMATCH));
  });

  await check('attack matrix: 批次分攤數字與 intensity × quantity 重算不符 → BLOCKED/CASE_CONTEXT_MISMATCH', async () => {
    const context = await preparedContext();
    const attacked = { ...context, shipmentMismatches: ['SHIP-A（已計算分攤排放與重算結果不一致）'] };
    const { gateResult } = trustAdapter.evaluateTrustScenario({
      trustContext: attacked,
      proofEnvelopes: envelopesFor(context),
    });
    assert.strictEqual(gateResult.decision, GATE_DECISION.BLOCKED);
    assert.ok(gateResult.reasonCodes.includes(REASON_CODE.CASE_CONTEXT_MISMATCH));
  });

  // -------------------------------------------------------------------
  // 6. E2E：真實 HTTP + 正式 evaluator（非 mock）
  // -------------------------------------------------------------------

  await check('E2E: normal fixture 走完整 HTTP 流程，正式 evaluator revalidate 到 READY_FOR_VERIFIER', async () => {
    resetProofNonces();
    trustAdapter.resetEvaluatorForTests(); // 現在等於「正式 evaluator」
    const submit = await submitCaseViaHttp();
    assert.strictEqual(submit.body.case.status, 'METHOD_REVIEW');

    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(revalidate.body.readiness.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(revalidate.body.case.services.proof.verification, 'verified');
    assert.strictEqual(revalidate.body.case.services.gate.verification, 'verified');
    assert.strictEqual(revalidate.body.case.services.agent.status, 'unavailable'); // Agent 不阻擋 READY
    assert.match(revalidate.body.case.readyDisclaimer, /不代表正式查驗完成/);
    assert.strictEqual(revalidate.body.case.carbon.shipments.length, 2);

    const serialized = JSON.stringify(revalidate.body);
    for (const forbidden of ['CBAM Certified', 'Officially Approved', '海關已核准', '官方查驗完成', 'Registry 已提交']) {
      assert.ok(!serialized.includes(forbidden), `revalidate response 不應包含「${forbidden}」`);
    }
    // 誠實揭露：回應裡的 proof checks 必須留著 demoOnly／未執行 zk-SNARK 的痕跡。
    assert.ok(serialized.includes('demoOnly'));
    assert.ok(
      revalidate.body.case.services.proof.checks.some(
        (item) => item.name === 'cryptographic_proof' && item.status === 'skipped'
      )
    );
  });

  await check('E2E: 重複點擊 revalidate 不會誤觸 nonce 重放（每次重新產生 Proof）', async () => {
    const first = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    const second = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(first.body.case.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(second.body.case.status, 'READY_FOR_VERIFIER');
    assert.deepStrictEqual(second.body.readiness.reasonCodes, []);
  });

  await check('E2E: 電費只涵蓋 1–6 月（真實 metadata）→ NEEDS_EVIDENCE/EVIDENCE_PERIOD_INCOMPLETE', async () => {
    resetProofNonces();
    trustAdapter.resetEvaluatorForTests();
    const submit = await submitCaseViaHttp({
      electricity_bill: { coveredFrom: '2026-01-01', coveredTo: '2026-06-30' },
    });
    assert.strictEqual(submit.body.case.status, 'METHOD_REVIEW');

    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    assert.strictEqual(revalidate.body.case.status, 'NEEDS_EVIDENCE');
    assert.strictEqual(revalidate.body.readiness.status, 'NEEDS_EVIDENCE');
    assert.deepStrictEqual(revalidate.body.readiness.reasonCodes, ['EVIDENCE_PERIOD_INCOMPLETE']);
    assert.strictEqual(revalidate.body.case.services.gate.verification, 'failed');
    assert.notStrictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
  });

  await check('E2E: 補齊全年證據後重驗可回到 READY_FOR_VERIFIER', async () => {
    resetProofNonces();
    await submitCaseViaHttp();
    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
  });

  await check('E2E: Agent 維持 unavailable 不阻擋 READY（契約保留）', async () => {
    const detail = await api('GET', `/api/cases/${CASE_ID}`, 'Supplier');
    assert.strictEqual(detail.body.case.services.agent.status, 'unavailable');
    assert.strictEqual(detail.body.case.status, 'READY_FOR_VERIFIER');
  });

  trustAdapter.resetEvaluatorForTests();

  console.log(`\nRESULT: ${failed === 0 ? 'all PASS' : `${failed} failed`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
