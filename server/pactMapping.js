'use strict';

/**
 * Maps a Mandate PCF payload to a PACT Technical Specifications V3 `ProductFootprint`
 * (WBCSD Pathfinder Framework — github.com/wbcsd/data-exchange-protocol, spec/v3/openapi.yaml).
 *
 * Read-only / additive: this does not touch pcfCheck.js's required fields
 * (tCO2e/unit/method/boundary/period/supplierId) or any policy evaluation — it only
 * reshapes an already-gated payload for display/export. The V1 quality gate is
 * unaffected either way.
 *
 * Honesty over completeness: fields with a clean 1:1 source in Mandate's data model are
 * populated; fields PACT requires but Mandate doesn't currently capture are left `null`
 * and listed in `pactGaps` instead of being invented. Fabricating plausible-looking
 * numbers for fields we don't actually track would contradict the product's own thesis
 * (reject data that only looks complete) — the gap list is more honest than optimistic
 * defaults would be, and is worth more to a reviewer who knows the spec.
 */

const crypto = require('crypto');

// PACT's crossSectoralStandards enum happens to use the same string Mandate already
// stores in `method` for ISO 14067 — no translation needed for that one value.
const CROSS_SECTORAL_STANDARDS = new Set(['ISO14067', 'ISO14083', 'ISO14040-44', 'GHGP-Product', 'PEF']);

function splitPeriod(period) {
  if (typeof period !== 'string' || !period.includes('/')) return { start: null, end: null };
  const [start, end] = period.split('/');
  return {
    start: start ? `${start.trim()}T00:00:00Z` : null,
    end: end ? `${end.trim()}T00:00:00Z` : null,
  };
}

function toProductFootprint(payload, supplier) {
  if (!payload) return null;

  const { start, end } = splitPeriod(payload.period);
  const tco2e = Number(payload.tCO2e);
  const hasTco2e = Number.isFinite(tco2e);
  const companyName = (supplier && supplier.orgName) || payload.supplierId || null;
  const productName = payload.product || payload.supplierId || null;

  const commentParts = [];
  if (payload.boundary) {
    commentParts.push(`系統邊界（Mandate 內部欄位，非 PACT 標準欄位）：${payload.boundary}`);
  }
  if (payload.verificationStatus) {
    commentParts.push(
      `查驗狀態：${payload.verificationStatus}${
        payload.verificationReportId ? `（報告編號 ${payload.verificationReportId}）` : ''
      }`
    );
  }

  const crossSectoralStandards =
    payload.method && CROSS_SECTORAL_STANDARDS.has(payload.method) ? [payload.method] : [];

  const productFootprint = {
    id: crypto.randomUUID(),
    specVersion: '3.0.0',
    created: new Date().toISOString(),
    status: 'Active',
    companyName,
    companyIds: supplier && supplier.vlei && supplier.vlei.lei
      ? [`urn:lei:${supplier.vlei.lei}`]
      : payload.supplierId
        ? [`urn:mandate:supplier:${payload.supplierId}`]
        : [],
    productDescription: productName,
    productIds: payload.supplierId ? [`urn:mandate:product:${payload.supplierId}`] : [],
    ...(payload.cnCode
      ? { productClassifications: [`urn:pact:productclassification:cncode:${payload.cnCode}`] }
      : {}),
    productNameCompany: productName,
    comment: commentParts.length ? commentParts.join('；') : undefined,
    pcf: {
      declaredUnitOfMeasurement: null,
      declaredUnitAmount: null,
      productMassPerDeclaredUnit: null,
      referencePeriodStart: start,
      referencePeriodEnd: end,
      pcfExcludingBiogenicUptake: hasTco2e ? tco2e : null,
      pcfIncludingBiogenicUptake: hasTco2e ? tco2e : null,
      fossilGhgEmissions: hasTco2e ? tco2e : null,
      fossilCarbonContent: null,
      ipccCharacterizationFactors: [],
      crossSectoralStandards,
      exemptedEmissionsPercent: null,
    },
    mandateExtension: {
      note: '以下為 Mandate 內部品質閘資料，非 PACT 官方 DataModelExtension 包裝格式',
      supplierId: payload.supplierId || null,
      qualityTier: payload.qualityTier || null,
      emissionPerUnit: payload.emissionPerUnit != null ? payload.emissionPerUnit : null,
    },
  };

  const pactGaps = [
    {
      field: 'declaredUnitOfMeasurement / declaredUnitAmount / productMassPerDeclaredUnit',
      reason:
        'Mandate 目前只記「這批貨總共排多少 tCO2e」，沒有另外要求供應商回報「每宣告單位（如每公斤、每件）的產品數量」——PACT 要求兩者分開申報，我們的資料模型還沒有這個欄位。',
    },
    {
      field: 'pcfExcludingBiogenicUptake vs. pcfIncludingBiogenicUptake',
      reason:
        'Mandate 的 tCO2e 是單一總數，沒有拆分生質碳吸收（biogenic uptake）前後的差異；此欄位暫以同一數值填入兩個 PACT 欄位，非真正各自獨立計算。',
    },
    {
      field: 'fossilCarbonContent',
      reason: 'PACT 要求申報產品中的化石碳含量（質量），Mandate 目前不收集這項數據。',
    },
    {
      field: 'ipccCharacterizationFactors',
      reason: 'PACT 要求標明計算時採用的 IPCC 評估報告版本（如 AR5/AR6），Mandate 目前不記錄這項方法學細節。',
    },
    {
      field: 'exemptedEmissionsPercent',
      reason: 'PACT 要求申報排除在 PCF 之外的排放百分比，Mandate 目前不要求供應商揭露這項資訊。',
    },
  ].filter(Boolean);

  return { productFootprint, pactGaps };
}

module.exports = { toProductFootprint };
