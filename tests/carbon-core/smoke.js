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

// ---- Fixture 端到端測試（對應規格 p.8 固定 Demo Fixture + 必備異常 Fixture） ----

check('normal fixture: SHIP-A/SHIP-B 都 GATE_OK，分攤數字正確（100x1.80=180, 60x1.80=108）', () => {
  assertResults(runFixture(normalFixture), normalFixture.expected);
});

check('normal fixture: 年度總排放 = 1.80 x 200 = 360', () => {
  const { totalEmissions } = calculateAnnualEmissions(normalFixture.installationYear);
  assert.strictEqual(totalEmissions, normalFixture.expectedAnnualEmissions);
});

check('normal fixture: calculateIntensity 反推回 1.80（annual emissions ÷ production tonnes）', () => {
  const { intensity } = calculateIntensity(normalFixture.installationYear);
  assert.strictEqual(intensity, normalFixture.installationYear.verifiedIntensity);
});

check('normal fixture: 固定輸入重算 3 次結果完全一致', () => {
  const runs = [1, 2, 3].map(() => calculateAnnualEmissions(normalFixture.installationYear).totalEmissions);
  assert.strictEqual(runs[0], runs[1]);
  assert.strictEqual(runs[1], runs[2]);
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
    factorSet: normalFixture.factorSet,
    policyProfile: normalFixture.policyProfile,
  });
  assert.strictEqual(receipt.result.totalEmissions, 360);
  assert.ok(typeof receipt.inputHash === 'string' && receipt.inputHash.length === 64, 'inputHash 應為 64 字元 sha256 hex');
});

check('buildCalculationReceipt: 缺 factorSet 應拋出 CarbonCoreError', () => {
  assert.throws(
    () => buildCalculationReceipt({ installationYear: normalFixture.installationYear, policyProfile: normalFixture.policyProfile }),
    CarbonCoreError
  );
});

check('buildCalculationReceipt: 缺 policyProfile 應拋出 CarbonCoreError', () => {
  assert.throws(
    () => buildCalculationReceipt({ installationYear: normalFixture.installationYear, factorSet: normalFixture.factorSet }),
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
