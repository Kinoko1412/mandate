'use strict';

/**
 * services/factor-registry — Day 3 trust engine：查 FactorSet 是不是「官方允許清單」
 * 裡目前仍然有效的一份係數表，並比對案件夾帶的 FactorSet 快照跟 registry 記錄一致。
 *
 * 對照規格 p.13「Factor Registry：issuer、purpose、version、effective period、sourceHash」
 * → 失敗 code `FACTOR_NOT_ALLOWED` / `FACTOR_EXPIRED`。
 *
 * 跟 carbon-core 的分工邊界（呼應 services/carbon-core/index.js 檔頭註解）：
 * carbon-core 只驗「這個 factorSetId 有沒有在 policyProfile.allowedFactorSets 清單裡」，
 * 不驗清單本身的權威性、也不管這份係數表現在是不是已經失效/被撤銷——那正是這裡要做的事。
 * 這是刻意的兩層設計：electronic factorSetHash 只防中途調包，這個 registry 才管「這份表
 * 本身還算不算數、是不是我們認得的那一版」。
 *
 * 目前是寫死在程式碼裡的 Demo 清單（不是真的資料庫、也不是官方治理清單），只收錄黑客松
 * Demo 情境需要的 factorSetId，包含刻意造出來的 revoked／expired 版本供攻擊測試使用。
 */

const crypto = require('crypto');
const { REASON_CODE, FACTOR_PURPOSE } = require('../../packages/contracts/enums');

/**
 * Registry 記錄的權威欄位。案件送進來的 FactorSet 快照必須逐項相符，否則視為
 * 自編／調包的係數表。
 */
const AUTHORITATIVE_FIELDS = Object.freeze(['issuer', 'purpose', 'version', 'sourceHash']);

const FACTOR_REGISTRY = Object.freeze([
  Object.freeze({
    factorSetId: 'CBAM-DEMO-2026-v1',
    issuer: 'demo-authority',
    purpose: FACTOR_PURPOSE.CBAM_ACTUAL,
    version: '1',
    sourceHash: 'sha256:demo-factorset-v1',
    status: 'active',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    revokedAt: null,
    demoOnly: true,
  }),
  Object.freeze({
    factorSetId: 'CBAM-DEMO-2026-REVOKED-v1',
    issuer: 'demo-authority',
    purpose: FACTOR_PURPOSE.CBAM_ACTUAL,
    version: '1',
    sourceHash: 'sha256:demo-factorset-revoked-v1',
    status: 'revoked',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    revokedAt: '2026-06-30T00:00:00Z',
    demoOnly: true,
  }),
  Object.freeze({
    factorSetId: 'CBAM-DEMO-2026-EXPIRED-v1',
    issuer: 'demo-authority',
    purpose: FACTOR_PURPOSE.CBAM_ACTUAL,
    version: '1',
    sourceHash: 'sha256:demo-factorset-expired-v1',
    status: 'expired',
    effectiveFrom: '2024-01-01',
    effectiveTo: '2025-12-31',
    revokedAt: null,
    demoOnly: true,
  }),
]);

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Registry 記錄的不可變摘要，供 ProofEnvelope 的 `factorSetHash` public input 綁定用：
 * proof 綁的是「registry 認可的那一版係數表」，不是呼叫端自己夾帶的版本。
 */
function factorSetSnapshotHash(record) {
  if (!record) return null;
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      stableStringify({
        factorSetId: record.factorSetId,
        issuer: record.issuer,
        purpose: record.purpose,
        version: record.version,
        sourceHash: record.sourceHash,
        status: record.status,
        effectiveFrom: record.effectiveFrom,
        effectiveTo: record.effectiveTo,
      })
    )
    .digest('hex')}`;
}

function getFactorSetRecord(factorSetId) {
  return FACTOR_REGISTRY.find((entry) => entry.factorSetId === factorSetId) || null;
}

/**
 * @param {string} factorSetId
 * @param {object} context
 * @param {object} [context.policyProfile] - 權威 PolicyProfile（allowedFactorSets 來源）
 * @param {object} [context.factorSet] - 案件夾帶的 FactorSet 快照；有帶才做欄位逐項比對
 * @param {Date} [context.now]
 */
function resolveFactorSet(factorSetId, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const policyProfile = context.policyProfile;
  const declared = context.factorSet;
  const checks = [];
  const reasonCodes = [];

  function fail(reasonCode, detail) {
    checks.push(makeCheck('factor_registry_check', 'fail', detail));
    reasonCodes.push(reasonCode);
    return { ok: false, record: null, factorSetHash: null, checks, reasonCodes };
  }

  if (typeof factorSetId !== 'string' || !factorSetId.trim()) {
    return fail(REASON_CODE.FACTOR_NOT_ALLOWED, 'factorSetId 缺失。');
  }

  if (
    policyProfile &&
    Array.isArray(policyProfile.allowedFactorSets) &&
    !policyProfile.allowedFactorSets.includes(factorSetId)
  ) {
    return fail(
      REASON_CODE.FACTOR_NOT_ALLOWED,
      `factorSetId ${factorSetId} 不在 PolicyProfile.allowedFactorSets [${policyProfile.allowedFactorSets.join(', ')}]。`
    );
  }
  checks.push(makeCheck('policy_allowlist', 'pass', 'factorSetId 在 PolicyProfile.allowedFactorSets 內'));

  const record = getFactorSetRecord(factorSetId);
  if (!record) {
    return fail(REASON_CODE.FACTOR_NOT_ALLOWED, `factorSetId ${factorSetId} 不在 Factor Registry 內，視為未經核准。`);
  }
  checks.push(makeCheck('registry_lookup', 'pass', `Factor Registry 找到 ${factorSetId}`));

  // issuer / purpose / version / sourceHash 逐項比對（規格 p.13）——攔「自編一份同名
  // 係數表」或「偷改 version/sourceHash」這類調包。
  if (declared && typeof declared === 'object') {
    const mismatched = AUTHORITATIVE_FIELDS.filter((field) => declared[field] !== record[field]);
    if (mismatched.length) {
      return fail(
        REASON_CODE.FACTOR_NOT_ALLOWED,
        `案件夾帶的 FactorSet 與 Factor Registry 記錄不一致：${mismatched
          .map((field) => `${field}（宣稱 ${JSON.stringify(declared[field])}，registry ${JSON.stringify(record[field])}）`)
          .join('；')}`
      );
    }
    checks.push(
      makeCheck('issuer_purpose_version_sourcehash', 'pass', 'issuer／purpose／version／sourceHash 與 registry 一致')
    );
  } else {
    checks.push(
      makeCheck('issuer_purpose_version_sourcehash', 'skipped', '呼叫端未提供 FactorSet 快照，略過逐欄位比對')
    );
  }

  if (record.status === 'revoked') {
    return fail(
      REASON_CODE.AUTHORIZATION_REVOKED,
      `factorSetId ${factorSetId} 已被發行機關撤銷${record.revokedAt ? `（${record.revokedAt}）` : ''}。`
    );
  }
  if (record.status === 'expired') {
    return fail(REASON_CODE.FACTOR_EXPIRED, `factorSetId ${factorSetId} 已標記為 expired。`);
  }

  const nowMs = now.getTime();
  if (record.effectiveFrom && nowMs < Date.parse(`${record.effectiveFrom}T00:00:00Z`)) {
    return fail(
      REASON_CODE.FACTOR_EXPIRED,
      `factorSetId ${factorSetId} 尚未生效（effectiveFrom ${record.effectiveFrom}）。`
    );
  }
  if (record.effectiveTo && nowMs > Date.parse(`${record.effectiveTo}T23:59:59Z`)) {
    return fail(REASON_CODE.FACTOR_EXPIRED, `factorSetId ${factorSetId} 已於 ${record.effectiveTo} 後失效。`);
  }
  checks.push(makeCheck('validity_window', 'pass', `${record.status}，有效期間內`));

  return {
    ok: true,
    record,
    factorSetHash: factorSetSnapshotHash(record),
    checks,
    reasonCodes: [],
  };
}

module.exports = {
  AUTHORITATIVE_FIELDS,
  FACTOR_REGISTRY,
  factorSetSnapshotHash,
  getFactorSetRecord,
  resolveFactorSet,
};
