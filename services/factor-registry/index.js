'use strict';

/**
 * services/factor-registry — Day 3 trust engine：查 FactorSet 是不是「官方允許清單」
 * 裡目前仍然有效的一份係數表。
 *
 * 跟 carbon-core 的分工邊界（呼應 services/carbon-core/index.js 檔頭註解）：
 * carbon-core 只驗「這個 factorSetId 有沒有在 policyProfile.allowedFactorSets 清單裡」，
 * 不驗清單本身的權威性、也不管這份係數表現在是不是已經失效/被撤銷——那正是這裡要做的事。
 * 這是刻意的兩層設計（跟 vault 記憶裡「hash 防篡改 vs 內容權威性是兩個獨立問題」同一個
 * 原則）：electronic factorSetHash 只防中途調包，這個 registry 才管「這份表本身還算不算數」。
 *
 * 目前是寫死在程式碼裡的 Demo 清單（不是真的資料庫），只收錄黑客松 Demo 情境需要的
 * factorSetId，包含刻意造出來的 revoked／expired 版本供攻擊測試使用。
 */

const { REASON_CODE } = require('../../packages/contracts/enums');

const FACTOR_REGISTRY = Object.freeze([
  Object.freeze({
    factorSetId: 'CBAM-DEMO-2026-v1',
    issuer: 'demo-authority',
    status: 'active',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  }),
  Object.freeze({
    factorSetId: 'CBAM-DEMO-2026-REVOKED-v1',
    issuer: 'demo-authority',
    status: 'revoked',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  }),
  Object.freeze({
    factorSetId: 'CBAM-DEMO-2026-EXPIRED-v1',
    issuer: 'demo-authority',
    status: 'expired',
    effectiveFrom: '2024-01-01',
    effectiveTo: '2025-12-31',
  }),
]);

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

/**
 * @param {string} factorSetId
 * @param {object} context - { policyProfile, now }
 */
function resolveFactorSet(factorSetId, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const policyProfile = context.policyProfile;
  const checks = [];
  const reasonCodes = [];

  function fail(reasonCode, detail) {
    checks.push(makeCheck('factor_registry_check', 'fail', detail));
    reasonCodes.push(reasonCode);
    return { ok: false, record: null, checks, reasonCodes };
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

  const record = FACTOR_REGISTRY.find((entry) => entry.factorSetId === factorSetId);
  if (!record) {
    return fail(REASON_CODE.FACTOR_NOT_ALLOWED, `factorSetId ${factorSetId} 不在 Factor Registry 內，視為未經核准。`);
  }
  checks.push(makeCheck('registry_lookup', 'pass', `Factor Registry 找到 ${factorSetId}`));

  if (record.status === 'revoked') {
    return fail(REASON_CODE.AUTHORIZATION_REVOKED, `factorSetId ${factorSetId} 已被發行機關撤銷。`);
  }
  if (record.status === 'expired') {
    return fail(REASON_CODE.FACTOR_EXPIRED, `factorSetId ${factorSetId} 已標記為 expired。`);
  }

  const nowMs = now.getTime();
  if (record.effectiveFrom && nowMs < Date.parse(`${record.effectiveFrom}T00:00:00Z`)) {
    return fail(REASON_CODE.FACTOR_EXPIRED, `factorSetId ${factorSetId} 尚未生效（effectiveFrom ${record.effectiveFrom}）。`);
  }
  if (record.effectiveTo && nowMs > Date.parse(`${record.effectiveTo}T23:59:59Z`)) {
    return fail(REASON_CODE.FACTOR_EXPIRED, `factorSetId ${factorSetId} 已於 ${record.effectiveTo} 後失效。`);
  }
  checks.push(makeCheck('validity_window', 'pass', `${record.status}，有效期間內`));

  return { ok: true, record, checks, reasonCodes: [] };
}

module.exports = {
  FACTOR_REGISTRY,
  resolveFactorSet,
};
