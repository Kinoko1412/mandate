'use strict';

/**
 * carbon-core smoke test — 跟 server/smoke.js 同一套風格（純 assert、無外部測試框架）。
 * 對照《可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊》p.16「測試與 Definition
 * of Done」Contract／Carbon 兩層的最低測試要求。
 * 執行：node tests/carbon-core/smoke.js
 */

const assert = require('assert');
const {
  validateInstallationYear,
  calculateAnnualEmissions,
  calculateIntensity,
  allocateShipment,
  reconcileAllocationLedger,
  allocateAllShipments,
  buildCalculationReceipt,
  CarbonCoreError,
} = require('../../services/carbon-core');
const { toScaled, fromScaled, mulScaled } = require('../../packages/contracts/fixedPoint');
const { schema, validateCanonical } = require('../../packages/contracts/validator');

const normalFixture = require('../../fixtures/normal.json');
const missingPeriodFixture = require('../../fixtures/missing_period.json');
const wrongFactorFixture = require('../../fixtures/wrong_factor.json');
const tamperedQuantityFixture = require('../../fixtures/tampered_quantity.json');

let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${err.stack || err.message}`);
  }
}

function runFixture(fixture) {
  return allocateAllShipments({
    installationYear: fixture.installationYear,
    shipments: fixture.shipments,
    policyProfile: fixture.policyProfile,
  });
}

function calculateNormalAnnual(overrides = {}) {
  return calculateAnnualEmissions({
    activities: normalFixture.activities,
    factorSet: normalFixture.factorSet,
    policyProfile: normalFixture.policyProfile,
    ...overrides,
  });
}

function assertResults(results, expectedList) {
  assert.strictEqual(results.length, expectedList.length, `結果筆數應為 ${expectedList.length}，實際 ${results.length}`);
  results.forEach((r, i) => {
    const expected = expectedList[i];
    assert.strictEqual(r.gateResult.shipmentId, expected.shipmentId, `第 ${i} 筆 shipmentId 不符`);
    assert.strictEqual(
      r.gateResult.decision,
      expected.decision,
      `${expected.shipmentId} decision 應為 ${expected.decision}，實際 ${r.gateResult.decision}（${JSON.stringify(r.gateResult.reasonCodes)}）`
    );
    assert.deepStrictEqual(
      r.gateResult.reasonCodes,
      expected.reasonCodes,
      `${expected.shipmentId} reasonCodes 應為 ${JSON.stringify(expected.reasonCodes)}，實際 ${JSON.stringify(r.gateResult.reasonCodes)}`
    );
    if (typeof expected.allocatedEmissions === 'number') {
      assert.ok(r.shipment, `${expected.shipmentId} 應該有 shipment 結果（沒被完全擋掉）`);
      assert.strictEqual(
        r.shipment.allocatedEmissions,
        expected.allocatedEmissions,
        `${expected.shipmentId} allocatedEmissions 應為 ${expected.allocatedEmissions}，實際 ${r.shipment.allocatedEmissions}`
      );
    }
    // GateResult canonical shape 檢查（規格 p.7）
    assert.ok(Array.isArray(r.gateResult.reasonCodes), 'reasonCodes 必須是陣列');
    assert.ok(Array.isArray(r.gateResult.checks), 'checks 必須是陣列');
    assert.ok(typeof r.gateResult.inputHash === 'string' && r.gateResult.inputHash.length > 0, 'inputHash 必須存在');
    assert.ok(typeof r.gateResult.evaluatedAt === 'string', 'evaluatedAt 必須存在');
  });
}

// ---- Contract：實際載入 schema-v1.json，驗 11 個 canonical entities ----

const normalReceipt = buildCalculationReceipt({
  installationYear: normalFixture.installationYear,
  activities: normalFixture.activities,
  factorSet: normalFixture.factorSet,
  policyProfile: normalFixture.policyProfile,
});

const canonicalEntities = {
  Case: normalFixture.case,
  InstallationYear: normalFixture.installationYear,
  Shipment: normalFixture.shipments[0],
  EvidenceItem: normalFixture.evidenceItems[0],
  IdentityContext: {
    actorId: 'ACTOR-DEMO', orgId: 'ORG-TW-STEEL-SUPPLIER', role: 'Supplier',
    assuranceLevel: 'demo', credentialRefs: [], mandateId: null, expiresAt: null, revocationStatus: 'active',
  },
  FactorSet: normalFixture.factorSet,
  PolicyProfile: normalFixture.policyProfile,
  ProofEnvelope: {
    proofId: 'PROOF-DEMO', circuitId: 'CIRCUIT-DEMO', publicInputs: {}, proof: 'demo',
    nonce: 'NONCE-DEMO', expiresAt: '2026-12-31T23:59:59Z', verificationKeyId: 'VK-DEMO',
  },
  GateResult: {
    decision: 'GATE_OK', reasonCodes: ['GATE_OK'], checks: [{ name: 'contract', status: 'pass' }],
    policyProfileId: 'CBAM-STEEL-2026-v1', evaluatedAt: '2026-08-24T09:00:00Z', inputHash: 'demo-hash',
  },
  RiskReport: {
    reportId: 'risk_demo', caseId: 'CASE-2026-001', entries: [],
    findings: [], missingEvidence: [], discrepancies: [], citations: [],
    summary: { facts: [], openIssues: [], nextActions: [], citations: [] },
    modelVersion: 'demo', promptVersion: 'demo', timestamp: '2026-08-24T09:00:00Z',
    reviewStatus: 'HUMAN_REVIEW_REQUIRED',
  },
  CalculationReceipt: normalReceipt,
};

check('contract: validator 實際載入 schema-v1.json 並通過 11 個 canonical entities', () => {
  assert.strictEqual(schema.$id, 'mandate/schema-v1');
  assert.strictEqual(Object.keys(canonicalEntities).length, 11);
  for (const [entityName, value] of Object.entries(canonicalEntities)) {
    assert.deepStrictEqual(validateCanonical(entityName, value), { valid: true, errors: [] }, entityName);
  }
});

check('contract: 11 個 canonical entities 缺 required 欄位皆失敗', () => {
  for (const [entityName, value] of Object.entries(canonicalEntities)) {
    const requiredField = schema.definitions[entityName].required[0];
    const invalid = { ...value };
    delete invalid[requiredField];
    assert.strictEqual(validateCanonical(entityName, invalid).valid, false, `${entityName}.${requiredField}`);
  }
});

check('contract: 11 個 canonical entities 錯 type 皆失敗', () => {
  const fields = {
    Case: 'caseId', InstallationYear: 'reportingYear', Shipment: 'quantityTonnes', EvidenceItem: 'version',
    IdentityContext: 'credentialRefs', FactorSet: 'issuer', PolicyProfile: 'cnCodes', ProofEnvelope: 'publicInputs',
    GateResult: 'reasonCodes', RiskReport: 'findings', CalculationReceipt: 'inputHash',
  };
  for (const [entityName, field] of Object.entries(fields)) {
    const original = canonicalEntities[entityName][field];
    const invalid = { ...canonicalEntities[entityName], [field]: Array.isArray(original) || typeof original === 'object' ? 'wrong' : [] };
    assert.strictEqual(validateCanonical(entityName, invalid).valid, false, `${entityName}.${field}`);
  }
});

check('contract: schema enum 未知值失敗', () => {
  const enumFields = {
    Case: 'status', InstallationYear: 'verificationStatus', Shipment: 'allocationStatus',
    EvidenceItem: 'type', IdentityContext: 'role', FactorSet: 'purpose',
    PolicyProfile: 'status', GateResult: 'decision',
  };
  for (const [entityName, field] of Object.entries(enumFields)) {
    const invalid = { ...canonicalEntities[entityName], [field]: 'UNKNOWN_ENUM' };
    assert.strictEqual(validateCanonical(entityName, invalid).valid, false, `${entityName}.${field}`);
  }
});

check('contract: schema 數值下界拒絕負數', () => {
  assert.strictEqual(validateCanonical('InstallationYear', { ...canonicalEntities.InstallationYear, productionTonnes: -1 }).valid, false);
  assert.strictEqual(validateCanonical('Shipment', { ...canonicalEntities.Shipment, quantityTonnes: -1 }).valid, false);
});

check('contract: 四個 fixtures 的六類核心 canonical entities 全部通過', () => {
  for (const fixture of [
    normalFixture,
    missingPeriodFixture,
    wrongFactorFixture,
    tamperedQuantityFixture,
  ]) {
    const entities = {
      Case: [fixture.case],
      InstallationYear: [fixture.installationYear],
      Shipment: fixture.shipments,
      EvidenceItem: fixture.evidenceItems,
      FactorSet: [fixture.factorSet],
      PolicyProfile: [fixture.policyProfile],
    };
    for (const [entityName, values] of Object.entries(entities)) {
      for (const value of values) {
        assert.deepStrictEqual(
          validateCanonical(entityName, value),
          { valid: true, errors: [] },
          `${fixture.description}: ${entityName}`
        );
      }
    }
  }
});

// ---- Fixture 端到端測試（對應規格 p.8 固定 Demo Fixture + 必備異常 Fixture） ----

check('normal fixture: SHIP-A/SHIP-B 都 GATE_OK，分攤數字正確（100x1.80=180, 60x1.80=108）', () => {
  assertResults(runFixture(normalFixture), normalFixture.expected);
});

check('normal fixture: 年度總排放 = sum(activity × factor) = 100×2 + 80×2 = 360', () => {
  const { totalEmissions } = calculateNormalAnnual();
  assert.strictEqual(totalEmissions, normalFixture.expectedAnnualEmissions);
});

check('normal fixture: calculateIntensity 反推回 1.80（annual emissions ÷ production tonnes）', () => {
  const { intensity } = calculateIntensity({
    annualEmissions: calculateNormalAnnual(),
    productionTonnes: normalFixture.installationYear.productionTonnes,
  });
  assert.strictEqual(intensity, normalFixture.installationYear.verifiedIntensity);
});

check('normal fixture: 固定輸入重算 3 次結果完全一致', () => {
  const runs = [1, 2, 3].map(() => calculateNormalAnnual().totalEmissions);
  assert.strictEqual(runs[0], runs[1]);
  assert.strictEqual(runs[1], runs[2]);
});

check('calculateAnnualEmissions: 真正加總 activity × factor 並保存 factor refs', () => {
  const result = calculateNormalAnnual();
  assert.deepStrictEqual(result.basis.terms.map((term) => term.factorRef), ['FACTOR-DEMO-ELECTRICITY', 'FACTOR-DEMO-FUEL']);
  assert.deepStrictEqual(result.basis.terms.map((term) => fromScaled(term.emissionsScaled)), [200, 160]);
});

check('calculateAnnualEmissions: 舊版 installationYear-only 循環呼叫應明確拒絕', () => {
  assert.throws(
    () => calculateAnnualEmissions(normalFixture.installationYear),
    (error) => error instanceof CarbonCoreError && error.reasonCode === 'MISSING_CALCULATION_CONTEXT'
  );
});

check('calculateAnnualEmissions: factorSet 不在 policy 允許清單應拒絕', () => {
  assert.throws(
    () => calculateNormalAnnual({ policyProfile: { ...normalFixture.policyProfile, allowedFactorSets: [] } }),
    (error) => error instanceof CarbonCoreError && error.reasonCode === 'FACTOR_NOT_ALLOWED'
  );
});

check('calculateAnnualEmissions: 負數 activity 應拒絕', () => {
  const activities = normalFixture.activities.map((activity, index) => index === 0 ? { ...activity, quantity: -1 } : activity);
  assert.throws(
    () => calculateNormalAnnual({ activities }),
    (error) => error instanceof CarbonCoreError && error.reasonCode === 'ZERO_OR_NEGATIVE_QUANTITY'
  );
});

check('calculateAnnualEmissions: 缺 factorRef 對應項應拒絕', () => {
  const activities = [{ ...normalFixture.activities[0], factorRef: 'FACTOR-MISSING' }];
  assert.throws(
    () => calculateNormalAnnual({ activities }),
    (error) => error instanceof CarbonCoreError && error.reasonCode === 'MISSING_CALCULATION_CONTEXT'
  );
});

check('calculateAnnualEmissions: 未知／不相容 activity unit 應拒絕', () => {
  const activities = [{ ...normalFixture.activities[0], unit: 'kg' }];
  assert.throws(
    () => calculateNormalAnnual({ activities }),
    (error) => error instanceof CarbonCoreError && error.reasonCode === 'UNKNOWN_UNIT'
  );
});

check('calculateAnnualEmissions: 定點輸入溢位應回 CALCULATION_OVERFLOW', () => {
  const activities = [{ ...normalFixture.activities[0], quantity: Number.MAX_SAFE_INTEGER }];
  assert.throws(
    () => calculateNormalAnnual({ activities }),
    (error) => error instanceof CarbonCoreError && error.reasonCode === 'CALCULATION_OVERFLOW'
  );
});

check('missing_period fixture: NEEDS_EVIDENCE / EVIDENCE_PERIOD_INCOMPLETE，不指控造假', () => {
  assertResults(runFixture(missingPeriodFixture), missingPeriodFixture.expected);
});

check('wrong_factor fixture: BLOCKED / FACTOR_NOT_ALLOWED（不在 PolicyProfile.allowedFactorSets）', () => {
  assertResults(runFixture(wrongFactorFixture), wrongFactorFixture.expected);
});

check('tampered_quantity fixture（Phase 1 詮釋版）: SHIP-A 單獨合法通過，SHIP-B 疊加後被 reconcileAllocationLedger 擋下', () => {
  assertResults(runFixture(tamperedQuantityFixture), tamperedQuantityFixture.expected);
});

// ---- validateInstallationYear 單元測試（規格 p.10：錯年度、未知單位、負數、零產量） ----

const baseInstallationYear = normalFixture.installationYear;

check('validateInstallationYear: 零產量應拋出 CarbonCoreError', () => {
  assert.throws(() => validateInstallationYear({ ...baseInstallationYear, productionTonnes: 0 }), CarbonCoreError);
});

check('validateInstallationYear: 負數強度應拋出 CarbonCoreError', () => {
  assert.throws(() => validateInstallationYear({ ...baseInstallationYear, verifiedIntensity: -1 }), CarbonCoreError);
});

check('validateInstallationYear: 未知單位（kg 而非 tonne）應拋出 CarbonCoreError', () => {
  assert.throws(() => validateInstallationYear({ ...baseInstallationYear, productionUnit: 'kg' }), CarbonCoreError);
});

check('validateInstallationYear: 錯年度（超出合理範圍）應拋出 CarbonCoreError', () => {
  assert.throws(() => validateInstallationYear({ ...baseInstallationYear, reportingYear: 1500 }), CarbonCoreError);
});

// ---- allocateShipment 單元測試（規格 p.10：超額分配、來源不一致；p.7 Shipment canonical shape） ----

check('allocateShipment: case context 不一致（installationId 對不上）應 BLOCKED / CASE_CONTEXT_MISMATCH', () => {
  const { gateResult } = allocateShipment({
    installationYear: baseInstallationYear,
    shipment: { shipmentId: 'SHIP-X', caseId: 'CASE-2026-001', installationId: 'WRONG-INSTALLATION', reportingYear: 2026, quantityTonnes: 10, quantityUnit: 'tonne' },
  });
  assert.strictEqual(gateResult.decision, 'BLOCKED');
  assert.deepStrictEqual(gateResult.reasonCodes, ['CASE_CONTEXT_MISMATCH']);
});

check('allocateShipment: 負數出貨量應 BLOCKED / ZERO_OR_NEGATIVE_QUANTITY', () => {
  const { gateResult } = allocateShipment({
    installationYear: baseInstallationYear,
    shipment: { shipmentId: 'SHIP-NEG', caseId: 'CASE-2026-001', installationId: 'TW-STEEL-01', reportingYear: 2026, quantityTonnes: -10, quantityUnit: 'tonne' },
  });
  assert.strictEqual(gateResult.decision, 'BLOCKED');
  assert.deepStrictEqual(gateResult.reasonCodes, ['ZERO_OR_NEGATIVE_QUANTITY']);
});

check('allocateShipment: 未知單位（kg）應 BLOCKED / UNKNOWN_UNIT', () => {
  const { gateResult } = allocateShipment({
    installationYear: baseInstallationYear,
    shipment: { shipmentId: 'SHIP-KG', caseId: 'CASE-2026-001', installationId: 'TW-STEEL-01', reportingYear: 2026, quantityTonnes: 100, quantityUnit: 'kg' },
  });
  assert.strictEqual(gateResult.decision, 'BLOCKED');
  assert.deepStrictEqual(gateResult.reasonCodes, ['UNKNOWN_UNIT']);
});

check('allocateShipment: installationYear.verificationStatus=draft 應 NEEDS_EVIDENCE / EVIDENCE_MISSING', () => {
  const draftYear = { ...baseInstallationYear, verificationStatus: 'draft' };
  const { gateResult } = allocateShipment({
    installationYear: draftYear,
    shipment: { shipmentId: 'SHIP-DRAFT', caseId: 'CASE-2026-001', installationId: 'TW-STEEL-01', reportingYear: 2026, quantityTonnes: 10, quantityUnit: 'tonne' },
  });
  assert.strictEqual(gateResult.decision, 'NEEDS_EVIDENCE');
  assert.deepStrictEqual(gateResult.reasonCodes, ['EVIDENCE_MISSING']);
});

// ---- reconcileAllocationLedger 單元測試（規格 p.10：重複 shipmentId） ----

check('reconcileAllocationLedger: 重複 shipmentId 應 BLOCKED / DUPLICATE_SHIPMENT_ID', () => {
  const dup = { shipmentId: 'SHIP-A', caseId: 'CASE-2026-001', installationId: 'TW-STEEL-01', reportingYear: 2026, quantityTonnes: 10, quantityUnit: 'tonne', factorSetId: 'CBAM-DEMO-2026-v1' };
  const allocations = [
    allocateShipment({ installationYear: baseInstallationYear, shipment: dup, policyProfile: normalFixture.policyProfile }),
    allocateShipment({ installationYear: baseInstallationYear, shipment: dup, policyProfile: normalFixture.policyProfile }),
  ];
  const reconciled = reconcileAllocationLedger({ installationYear: baseInstallationYear, allocations });
  assert.strictEqual(reconciled[0].gateResult.decision, 'GATE_OK');
  assert.strictEqual(reconciled[1].gateResult.decision, 'BLOCKED');
  assert.deepStrictEqual(reconciled[1].gateResult.reasonCodes, ['DUPLICATE_SHIPMENT_ID']);
});

// ---- buildCalculationReceipt 單元測試（規格 p.10：缺 policy／factor／context） ----

check('buildCalculationReceipt: 正常情況回傳 inputHash 與正確總排放', () => {
  const receipt = buildCalculationReceipt({
    installationYear: normalFixture.installationYear,
    activities: normalFixture.activities,
    factorSet: normalFixture.factorSet,
    policyProfile: normalFixture.policyProfile,
  });
  assert.strictEqual(receipt.result.totalEmissions, 360);
  assert.ok(typeof receipt.inputHash === 'string' && receipt.inputHash.length === 64, 'inputHash 應為 64 字元 sha256 hex');
  assert.deepStrictEqual(receipt.metadata, {
    factor: { factorSetId: 'CBAM-DEMO-2026-v1', version: '1', sourceHash: 'sha256:demo-factorset-v1' },
    policy: { policyProfileId: 'CBAM-STEEL-2026-v1', version: '1' },
    scale: 1_000_000,
    roundingRule: 'ROUND_HALF_UP_TO_NEAREST_SCALED_INTEGER',
    methodVersion: 'sum-activity-factor-v1',
  });
});

check('buildCalculationReceipt: 相同輸入 hash 可重現，factor/policy metadata 改變會改 hash', () => {
  const input = {
    installationYear: normalFixture.installationYear,
    activities: normalFixture.activities,
    factorSet: normalFixture.factorSet,
    policyProfile: normalFixture.policyProfile,
  };
  const first = buildCalculationReceipt(input);
  const second = buildCalculationReceipt(input);
  assert.strictEqual(first.inputHash, second.inputHash);
  assert.strictEqual(first.result.totalEmissionsScaled, second.result.totalEmissionsScaled);
  const changedFactor = buildCalculationReceipt({
    ...input,
    factorSet: { ...normalFixture.factorSet, version: '2', sourceHash: 'sha256:demo-factorset-v2' },
  });
  const changedPolicy = buildCalculationReceipt({
    ...input,
    policyProfile: { ...normalFixture.policyProfile, version: '2' },
  });
  const changedFactorValue = buildCalculationReceipt({
    ...input,
    factorSet: {
      ...normalFixture.factorSet,
      factors: normalFixture.factorSet.factors.map((factor, index) => index === 0 ? { ...factor, value: 3 } : factor),
    },
  });
  assert.notStrictEqual(first.inputHash, changedFactor.inputHash);
  assert.notStrictEqual(first.inputHash, changedPolicy.inputHash);
  assert.notStrictEqual(first.inputHash, changedFactorValue.inputHash);
  assert.notStrictEqual(first.result.totalEmissions, changedFactorValue.result.totalEmissions);
});

check('buildCalculationReceipt: 缺 factorSet 應拋出 CarbonCoreError', () => {
  assert.throws(
    () => buildCalculationReceipt({ installationYear: normalFixture.installationYear, activities: normalFixture.activities, policyProfile: normalFixture.policyProfile }),
    CarbonCoreError
  );
});

check('buildCalculationReceipt: 缺 policyProfile 應拋出 CarbonCoreError', () => {
  assert.throws(
    () => buildCalculationReceipt({ installationYear: normalFixture.installationYear, activities: normalFixture.activities, factorSet: normalFixture.factorSet }),
    CarbonCoreError
  );
});

// ---- fixedPoint 定點數單元測試（規格 p.10：溢位、捨入） ----

check('fixedPoint: toScaled/fromScaled 往返不失真', () => {
  assert.strictEqual(fromScaled(toScaled(1.8)), 1.8);
});

check('fixedPoint: mulScaled(1.80 x 100) = 180（跟直接乘法一致）', () => {
  const result = fromScaled(mulScaled(toScaled(1.8), toScaled(100)));
  assert.strictEqual(result, 180);
});

check('fixedPoint: mulScaled 中間值溢位應拋出 RangeError', () => {
  assert.throws(() => mulScaled(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), RangeError);
});

console.log('');
if (failed > 0) {
  console.log(`RESULT: ${failed} failed`);
  process.exit(1);
}
console.log('RESULT: all PASS');
process.exit(0);
