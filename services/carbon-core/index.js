'use strict';

/**
 * carbon-core — Canonical Data Model 版本，對照《可信碳排證據Agent_VibeCodingAI
 * 完整工程規格與指令手冊》p.10 Carbon Core 實作規格逐項實作：
 *   validateInstallationYear / calculateAnnualEmissions / calculateIntensity /
 *   allocateShipment / reconcileAllocationLedger / buildCalculationReceipt
 *
 * 不做的事（Phase 1 範圍外，文件 p.19 COPY PROMPT 1 明講「不要做 UI、Agent 或 ZKP」）：
 *   - 不查 FactorSet 本身是不是官方核准（那是官方允許清單，只在這裡驗「是否在
 *     policyProfile.allowedFactorSets 清單裡」，不驗清單本身的權威性）
 *   - 不驗 ZKP Proof
 *   - 不做 Evidence Agent 的抽取/勾稽
 */

const crypto = require('crypto');
const { CASE_STATUS, GATE_DECISION, REASON_CODE, VERIFICATION_STATUS } = require('../../packages/contracts/enums');
const { toScaled, fromScaled, mulScaled, addScaled } = require('../../packages/contracts/fixedPoint');

class CarbonCoreError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'CarbonCoreError';
    this.reasonCode = reasonCode;
  }
}

function assertPositiveNumber(value, reasonCode, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CarbonCoreError(reasonCode, `${label} 必須是大於 0 的有限數字，收到 ${JSON.stringify(value)}`);
  }
}

function assertNonEmptyString(value, reasonCode, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CarbonCoreError(reasonCode, `${label} 必須是非空字串，收到 ${JSON.stringify(value)}`);
  }
}

/**
 * 純日期字串（YYYY-MM-DD）補上邊界時間，避免 Date.parse 把「12/31」當成
 * 00:00:00Z、誤判涵蓋不到年底。
 */
function normalizeDateBoundary(dateStr, boundary) {
  if (typeof dateStr === 'string' && !dateStr.includes('T')) {
    return boundary === 'end' ? `${dateStr}T23:59:59Z` : `${dateStr}T00:00:00Z`;
  }
  return dateStr;
}

function stableStringify(obj) {
  // 依 key 排序後再 stringify，確保同樣內容不管欄位順序都算出同一個 Hash。
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

// ---------------------------------------------------------------------------
// validateInstallationYear
// ---------------------------------------------------------------------------

/**
 * 驗年度、產量、邊界、路線、單位（規格 p.10）。
 * 拒絕條件：錯年度、未知單位、負數、零產量。
 *
 * 輸入允許帶 productionUnit / intensityUnit 兩個「NOT IN canonical schema」的
 * 驗證用欄位（不是 InstallationYear 正式欄位，純粹讓這個函式能測「未知單位」這個
 * 規格明講要測的案例）——回傳的物件只保留 canonical 欄位，不含這兩個驗證用欄位。
 */
function validateInstallationYear(input) {
  if (!input || typeof input !== 'object') {
    throw new CarbonCoreError(REASON_CODE.MISSING_CALCULATION_CONTEXT, 'installationYear 為必填物件');
  }

  const {
    installationId, operatorOrgId, reportingYear, productionRoute, systemBoundaryVersion,
    productionTonnes, verifiedIntensity, verificationStatus,
    productionUnit, intensityUnit, evidenceCoverage, evidenceRefs,
  } = input;

  assertNonEmptyString(installationId, REASON_CODE.MISSING_CALCULATION_CONTEXT, 'installationId');
  assertNonEmptyString(operatorOrgId, REASON_CODE.MISSING_CALCULATION_CONTEXT, 'operatorOrgId');
  assertNonEmptyString(productionRoute, REASON_CODE.MISSING_CALCULATION_CONTEXT, 'productionRoute');
  assertNonEmptyString(systemBoundaryVersion, REASON_CODE.MISSING_CALCULATION_CONTEXT, 'systemBoundaryVersion');

  if (!Number.isInteger(reportingYear) || reportingYear < 2000 || reportingYear > 2100) {
    throw new CarbonCoreError(REASON_CODE.INVALID_REPORTING_YEAR, `reportingYear 必須是合理的西元年份整數，收到 ${JSON.stringify(reportingYear)}`);
  }

  if (productionUnit !== undefined && productionUnit !== 'tonne') {
    throw new CarbonCoreError(REASON_CODE.UNKNOWN_UNIT, `productionUnit 須為 tonne，收到 ${JSON.stringify(productionUnit)}`);
  }
  if (intensityUnit !== undefined && intensityUnit !== 'tCO2e/tonne') {
    throw new CarbonCoreError(REASON_CODE.UNKNOWN_UNIT, `intensityUnit 須為 tCO2e/tonne，收到 ${JSON.stringify(intensityUnit)}`);
  }

  assertPositiveNumber(productionTonnes, REASON_CODE.ZERO_OR_NEGATIVE_QUANTITY, 'productionTonnes');
  assertPositiveNumber(verifiedIntensity, REASON_CODE.ZERO_OR_NEGATIVE_QUANTITY, 'verifiedIntensity');

  if (!Object.values(VERIFICATION_STATUS).includes(verificationStatus)) {
    throw new CarbonCoreError(REASON_CODE.MISSING_CALCULATION_CONTEXT, `verificationStatus 必須是 ${Object.values(VERIFICATION_STATUS).join('/')} 之一，收到 ${JSON.stringify(verificationStatus)}`);
  }

  return {
    installationId,
    operatorOrgId,
    reportingYear,
    productionRoute,
    systemBoundaryVersion,
    productionTonnes,
    verifiedIntensity,
    verificationStatus,
    evidenceCoverage: evidenceCoverage || null,
    evidenceRefs: evidenceRefs || [],
  };
}

// ---------------------------------------------------------------------------
// calculateAnnualEmissions / calculateIntensity
// ---------------------------------------------------------------------------

/**
 * sum(activity * factor)（規格 p.10）。單一製程 Demo 情境下，activity=productionTonnes、
 * factor=verifiedIntensity，等同 sum 只有一項——多製程/多 precursor 分項加總留給之後
 * 有真實 BOM 資料時再擴充，不在 Phase 1 硬做假的分項。
 * 拒絕條件：factor 不允許（由呼叫方帶 policyProfile 才檢查，見 allocateShipment）、
 * 溢位（mulScaled 內建溢位偵測）、缺必要項（validateInstallationYear 已檔）。
 */
function calculateAnnualEmissions(rawInstallationYear) {
  const installationYear = validateInstallationYear(rawInstallationYear);
  const intensityScaled = toScaled(installationYear.verifiedIntensity);
  const productionScaled = toScaled(installationYear.productionTonnes);
  const totalEmissionsScaled = mulScaled(productionScaled, intensityScaled);

  return {
    totalEmissionsScaled,
    totalEmissions: fromScaled(totalEmissionsScaled),
    unit: 'tCO2e',
    basis: {
      productionTonnes: installationYear.productionTonnes,
      verifiedIntensity: installationYear.verifiedIntensity,
    },
  };
}

/**
 * annual emissions ÷ production tonnes（規格 p.10）。
 * 拒絕條件：零產量（validateInstallationYear 已檔）、精度未定義（固定用
 * packages/contracts/fixedPoint 的 SCALE，不會有精度未定義的情況）。
 */
function calculateIntensity(rawInstallationYear) {
  const { totalEmissionsScaled } = calculateAnnualEmissions(rawInstallationYear);
  const installationYear = validateInstallationYear(rawInstallationYear);
  const productionScaled = toScaled(installationYear.productionTonnes);

  // 定點除法：(a * SCALE) / b，四捨五入。
  const { SCALE } = require('../../packages/contracts/fixedPoint');
  const intensityScaled = Math.round((totalEmissionsScaled * SCALE) / productionScaled);

  return {
    intensityScaled,
    intensity: fromScaled(intensityScaled),
    unit: 'tCO2e/tonne',
  };
}

// ---------------------------------------------------------------------------
// checkEvidenceCoverage（NOT IN SPEC 的輔助函式，供 allocateShipment 內部呼叫）
// ---------------------------------------------------------------------------

function checkEvidenceCoverage(installationYear) {
  const { reportingYear, evidenceCoverage } = installationYear;
  if (!evidenceCoverage || !evidenceCoverage.periodStart || !evidenceCoverage.periodEnd) {
    return { covered: false, message: '缺少 evidenceCoverage，無法確認證據涵蓋期間。' };
  }
  const yearStart = Date.parse(`${reportingYear}-01-01T00:00:00Z`);
  const yearEnd = Date.parse(`${reportingYear}-12-31T23:59:59Z`);
  const coverStart = Date.parse(normalizeDateBoundary(evidenceCoverage.periodStart, 'start'));
  const coverEnd = Date.parse(normalizeDateBoundary(evidenceCoverage.periodEnd, 'end'));

  if (!Number.isFinite(coverStart) || !Number.isFinite(coverEnd)) {
    return { covered: false, message: 'evidenceCoverage 日期格式無法解析。' };
  }
  if (coverStart > yearStart || coverEnd < yearEnd) {
    return {
      covered: false,
      message: `證據只涵蓋 ${evidenceCoverage.periodStart} ~ ${evidenceCoverage.periodEnd}，未覆蓋整個 ${reportingYear} 曆年。`,
    };
  }
  return { covered: true, message: null };
}

// ---------------------------------------------------------------------------
// allocateShipment（只做「這一批自己」合不合法，不查跨批次累計——那是 reconcileAllocationLedger 的責任）
// ---------------------------------------------------------------------------

/**
 * intensity × quantity；綁工廠／年度（規格 p.10）。
 * 拒絕條件：超額分配（NOT IN 這個函式的責任——文件把「超額分配」列在
 * reconcileAllocationLedger，不在 allocateShipment，這裡只做單批次自身的合法性）、
 * 來源不一致（case/installation/year 對不上）。
 */
function allocateShipment({ installationYear: rawInstallationYear, shipment, policyProfile } = {}) {
  if (!rawInstallationYear || !shipment) {
    throw new CarbonCoreError(REASON_CODE.MISSING_CALCULATION_CONTEXT, 'installationYear 與 shipment 皆為必填');
  }

  const evaluatedAt = new Date().toISOString();
  const checks = [];
  const reasonCodes = [];
  const { shipmentId, caseId, installationId, reportingYear, quantityTonnes, quantityUnit, factorSetId } = shipment;
  const installationYear = validateInstallationYear(rawInstallationYear);
  const inputHash = sha256Hex({ installationYear: rawInstallationYear, shipment, policyProfile: policyProfile || null });

  function blocked(reasonCode, message, decision = GATE_DECISION.BLOCKED) {
    checks.push(makeCheck('shipment_self_check', 'fail', message));
    reasonCodes.push(reasonCode);
    return {
      shipment: null,
      gateResult: {
        shipmentId,
        decision,
        reasonCodes,
        checks,
        policyProfileId: policyProfile ? policyProfile.policyProfileId : null,
        evaluatedAt,
        inputHash,
      },
    };
  }

  // 0) case context — installation/year 要跟 shipment 綁定的一致
  if (installationId !== installationYear.installationId || reportingYear !== installationYear.reportingYear) {
    return blocked(REASON_CODE.CASE_CONTEXT_MISMATCH, `shipment 綁定的 installationId/reportingYear 跟 installationYear 本身不一致（${installationId}/${reportingYear} vs ${installationYear.installationId}/${installationYear.reportingYear}）`);
  }
  checks.push(makeCheck('case_context', 'pass', 'installation/year 綁定一致'));

  // 1) 供應商是否已確認這份年度資料
  if (installationYear.verificationStatus !== VERIFICATION_STATUS.CONFIRMED) {
    return blocked(REASON_CODE.EVIDENCE_MISSING, 'installationYear.verificationStatus 尚未是 confirmed，供應商還沒確認這份年度資料。', GATE_DECISION.NEEDS_EVIDENCE);
  }
  checks.push(makeCheck('installation_year_confirmed', 'pass', '供應商已確認年度資料'));

  // 2) 證據涵蓋期間
  const coverage = checkEvidenceCoverage(installationYear);
  if (!coverage.covered) {
    return blocked(REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE, coverage.message, GATE_DECISION.NEEDS_EVIDENCE);
  }
  checks.push(makeCheck('evidence_coverage', 'pass', '證據涵蓋整個曆年'));

  // 3) 數量與單位
  if (typeof quantityTonnes !== 'number' || !Number.isFinite(quantityTonnes) || quantityTonnes <= 0) {
    return blocked(REASON_CODE.ZERO_OR_NEGATIVE_QUANTITY, `quantityTonnes 必須是正數，收到 ${JSON.stringify(quantityTonnes)}`);
  }
  if (quantityUnit !== undefined && quantityUnit !== 'tonne') {
    return blocked(REASON_CODE.UNKNOWN_UNIT, `quantityUnit 須為 tonne，收到 ${JSON.stringify(quantityUnit)}`);
  }
  checks.push(makeCheck('quantity_valid', 'pass', `quantityTonnes=${quantityTonnes}`));

  // 4) Factor 允許清單（只有帶 policyProfile 才查；完整 Factor Registry 驗證是 Phase 3 Policy Gate 的責任）
  if (policyProfile && Array.isArray(policyProfile.allowedFactorSets)) {
    if (factorSetId && !policyProfile.allowedFactorSets.includes(factorSetId)) {
      return blocked(REASON_CODE.FACTOR_NOT_ALLOWED, `factorSetId ${factorSetId} 不在 PolicyProfile.allowedFactorSets [${policyProfile.allowedFactorSets.join(', ')}]`);
    }
    checks.push(makeCheck('factor_allowed', 'pass', `factorSetId ${factorSetId} 在允許清單內`));
  } else {
    checks.push(makeCheck('factor_allowed', 'skipped', '未帶 policyProfile，跳過係數允許清單檢查'));
  }

  // 5) 計算分攤排放
  const intensityScaled = toScaled(installationYear.verifiedIntensity);
  const quantityScaled = toScaled(quantityTonnes);
  const allocatedEmissionsScaled = mulScaled(intensityScaled, quantityScaled);
  checks.push(makeCheck('allocation_computed', 'pass', `allocatedEmissions=${fromScaled(allocatedEmissionsScaled)}`));

  reasonCodes.push(REASON_CODE.GATE_OK);
  return {
    shipment: {
      shipmentId,
      caseId,
      installationId,
      reportingYear,
      quantityTonnes,
      allocatedEmissions: fromScaled(allocatedEmissionsScaled),
      allocatedEmissionsScaled,
      allocationStatus: CASE_STATUS.READY_FOR_VERIFIER,
      factorSetId: factorSetId || null,
      policyProfileId: policyProfile ? policyProfile.policyProfileId : null,
    },
    gateResult: {
      shipmentId,
      decision: GATE_DECISION.GATE_OK,
      reasonCodes,
      checks,
      policyProfileId: policyProfile ? policyProfile.policyProfileId : null,
      evaluatedAt,
      inputHash,
    },
  };
}

// ---------------------------------------------------------------------------
// reconcileAllocationLedger（跨批次：累積數量與重複分配）
// ---------------------------------------------------------------------------

/**
 * 檢查累積數量與重複分配（規格 p.10）。拒絕條件：超出年度產量、重複 shipmentId。
 *
 * 這個函式**不重新驗證**每批出貨自身是否合法（那是 allocateShipment 的責任），
 * 只檢查「把 allocateShipment 已經算好的批次放在一起看」時的帳本一致性——依序
 * 處理陣列，超出上限的那一批（以及之後的批次）被降級為 BLOCKED。
 *
 * @param {object} params
 * @param {object} params.installationYear - 已 validate 過的 InstallationYear
 * @param {Array<{shipment: object|null, gateResult: object}>} params.allocations - allocateShipment() 的結果陣列
 */
function reconcileAllocationLedger({ installationYear: rawInstallationYear, allocations } = {}) {
  const installationYear = validateInstallationYear(rawInstallationYear);
  const productionScaled = toScaled(installationYear.productionTonnes);

  const seenShipmentIds = new Set();
  let runningTotalScaled = 0;
  const reconciled = [];

  for (const entry of allocations || []) {
    const { shipment, gateResult } = entry;

    // 上一階段（allocateShipment）已經擋掉的，原樣保留，不進帳本累計。
    if (!shipment || gateResult.decision !== GATE_DECISION.GATE_OK) {
      reconciled.push(entry);
      continue;
    }

    if (seenShipmentIds.has(shipment.shipmentId)) {
      reconciled.push({
        shipment: null,
        gateResult: {
          ...gateResult,
          decision: GATE_DECISION.BLOCKED,
          reasonCodes: [REASON_CODE.DUPLICATE_SHIPMENT_ID],
          checks: [...gateResult.checks, makeCheck('ledger_duplicate_check', 'fail', `shipmentId ${shipment.shipmentId} 重複出現於同一份帳本`)],
        },
      });
      continue;
    }
    seenShipmentIds.add(shipment.shipmentId);

    const quantityScaled = toScaled(shipment.quantityTonnes);
    const nextTotalScaled = addScaled(runningTotalScaled, quantityScaled);

    if (nextTotalScaled > productionScaled) {
      reconciled.push({
        shipment: { ...shipment, allocationStatus: CASE_STATUS.BLOCKED, allocatedEmissions: null, allocatedEmissionsScaled: null },
        gateResult: {
          ...gateResult,
          decision: GATE_DECISION.BLOCKED,
          reasonCodes: [REASON_CODE.ALLOCATION_EXCEEDS_PRODUCTION],
          checks: [
            ...gateResult.checks,
            makeCheck(
              'ledger_total_check',
              'fail',
              `累計分配 ${fromScaled(nextTotalScaled)} tonnes 超過年度可用產量 ${installationYear.productionTonnes} tonnes`
            ),
          ],
        },
      });
      continue;
    }

    runningTotalScaled = nextTotalScaled;
    reconciled.push({
      shipment,
      gateResult: { ...gateResult, checks: [...gateResult.checks, makeCheck('ledger_total_check', 'pass', `累計 ${fromScaled(runningTotalScaled)}/${installationYear.productionTonnes} tonnes`)] },
    });
  }

  return reconciled;
}

/**
 * 便利函式：對一整份 fixture（installationYear + 多筆 shipments）依序跑
 * allocateShipment，再統一送進 reconcileAllocationLedger。
 */
function allocateAllShipments({ installationYear, shipments, policyProfile } = {}) {
  const allocations = (shipments || []).map((shipment) => allocateShipment({ installationYear, shipment, policyProfile }));
  return reconcileAllocationLedger({ installationYear, allocations });
}

// ---------------------------------------------------------------------------
// buildCalculationReceipt
// ---------------------------------------------------------------------------

/**
 * 輸入 Hash、方法／factor 版本、結果、時間（規格 p.10）。
 * 拒絕條件：缺 policy／factor／context。
 */
function buildCalculationReceipt({ installationYear: rawInstallationYear, factorSet, policyProfile } = {}) {
  if (!factorSet || !factorSet.factorSetId) {
    throw new CarbonCoreError(REASON_CODE.MISSING_CALCULATION_CONTEXT, 'buildCalculationReceipt 缺少 factorSet');
  }
  if (!policyProfile || !policyProfile.policyProfileId) {
    throw new CarbonCoreError(REASON_CODE.MISSING_CALCULATION_CONTEXT, 'buildCalculationReceipt 缺少 policyProfile');
  }
  const installationYear = validateInstallationYear(rawInstallationYear);
  const { totalEmissionsScaled, totalEmissions } = calculateAnnualEmissions(installationYear);

  const inputHash = sha256Hex({ installationYear, factorSetId: factorSet.factorSetId, policyProfileId: policyProfile.policyProfileId });

  return {
    inputHash,
    installationId: installationYear.installationId,
    reportingYear: installationYear.reportingYear,
    policyProfileId: policyProfile.policyProfileId,
    factorSetId: factorSet.factorSetId,
    result: { totalEmissionsScaled, totalEmissions },
    computedAt: new Date().toISOString(),
  };
}

module.exports = {
  validateInstallationYear,
  calculateAnnualEmissions,
  calculateIntensity,
  allocateShipment,
  reconcileAllocationLedger,
  allocateAllShipments,
  buildCalculationReceipt,
  checkEvidenceCoverage,
  CarbonCoreError,
};
