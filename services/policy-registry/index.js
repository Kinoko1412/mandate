'use strict';

/**
 * services/policy-registry — Day 3 trust engine 的最小 Policy Registry。
 *
 * 對照規格 p.13「Policy Registry：cnCode、year、circuit、required fields」→ 失敗 code
 * `POLICY_NOT_APPLICABLE`，以及 p.6 模組表「Factor／Policy Registry：來源、用途、版本、
 * 生效日與允許清單 → resolved_policy」。
 *
 * 為什麼要獨立於案件夾帶的 PolicyProfile：規格 p.13 要求 Gate「必須是純／可重現：相同
 * snapshot ＋相同 registry version 得到相同結果」。如果 allowedFactorSets／requiredEvidence／
 * circuitId 直接吃呼叫端送來的 PolicyProfile，攻擊者只要在自己的 payload 裡多塞一個
 * factorSetId 就能自我授權。這裡的 registry 是**權威來源**，案件夾帶的 PolicyProfile 只被
 * 當作「宣稱值」拿來跟 registry 快照逐項比對；不一致就是 POLICY_NOT_APPLICABLE。
 *
 * 一樣是寫死在程式碼裡的 Demo 清單（不是官方 CBAM Policy 治理來源），含刻意造出來的
 * 攻擊用記錄（inactive、允許已撤銷／已過期係數表的政策），供 tests/trust 使用。
 */

const crypto = require('crypto');
const { REASON_CODE, EVIDENCE_TYPE } = require('../../packages/contracts/enums');

const DEMO_REQUIRED_EVIDENCE = Object.freeze([
  EVIDENCE_TYPE.ELECTRICITY_BILL,
  EVIDENCE_TYPE.FUEL_LEDGER,
  EVIDENCE_TYPE.PRODUCTION_REPORT,
  EVIDENCE_TYPE.PRECURSOR_LIST,
]);

/** 進入 immutable snapshot hash 與逐項比對的欄位。 */
const SNAPSHOT_FIELDS = Object.freeze([
  'policyProfileId',
  'cnCodes',
  'reportingYear',
  'allowedFactorSets',
  'requiredEvidence',
  'circuitId',
  'status',
  'version',
]);

const POLICY_REGISTRY = Object.freeze([
  Object.freeze({
    policyProfileId: 'CBAM-STEEL-2026-v1',
    issuer: 'demo-policy-authority',
    cnCodes: Object.freeze(['72085100']),
    reportingYear: 2026,
    allowedFactorSets: Object.freeze(['CBAM-DEMO-2026-v1']),
    requiredEvidence: DEMO_REQUIRED_EVIDENCE,
    circuitId: 'cbam-demo-qty-v1',
    status: 'active',
    version: '1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    demoOnly: true,
  }),
  // --- 以下為攻擊測試用的 Demo 記錄，不是正式治理清單 ---
  Object.freeze({
    policyProfileId: 'CBAM-STEEL-2026-REVOKEDFACTOR-v1',
    issuer: 'demo-policy-authority',
    cnCodes: Object.freeze(['72085100']),
    reportingYear: 2026,
    allowedFactorSets: Object.freeze(['CBAM-DEMO-2026-REVOKED-v1']),
    requiredEvidence: DEMO_REQUIRED_EVIDENCE,
    circuitId: 'cbam-demo-qty-v1',
    status: 'active',
    version: '1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    demoOnly: true,
  }),
  Object.freeze({
    policyProfileId: 'CBAM-STEEL-2026-EXPIREDFACTOR-v1',
    issuer: 'demo-policy-authority',
    cnCodes: Object.freeze(['72085100']),
    reportingYear: 2026,
    allowedFactorSets: Object.freeze(['CBAM-DEMO-2026-EXPIRED-v1']),
    requiredEvidence: DEMO_REQUIRED_EVIDENCE,
    circuitId: 'cbam-demo-qty-v1',
    status: 'active',
    version: '1',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    demoOnly: true,
  }),
  Object.freeze({
    policyProfileId: 'CBAM-STEEL-2025-RETIRED-v1',
    issuer: 'demo-policy-authority',
    cnCodes: Object.freeze(['72085100']),
    reportingYear: 2025,
    allowedFactorSets: Object.freeze(['CBAM-DEMO-2026-v1']),
    requiredEvidence: DEMO_REQUIRED_EVIDENCE,
    circuitId: 'cbam-demo-qty-v1',
    status: 'inactive',
    version: '1',
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-12-31',
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

function snapshotOf(record) {
  return SNAPSHOT_FIELDS.reduce((acc, field) => {
    const value = record ? record[field] : undefined;
    acc[field] = Array.isArray(value) ? [...value] : value === undefined ? null : value;
    return acc;
  }, {});
}

/** Registry 記錄的不可變摘要，供 ProofEnvelope 的 `policySnapshotHash` public input 綁定用。 */
function policySnapshotHash(record) {
  if (!record) return null;
  return `sha256:${crypto.createHash('sha256').update(stableStringify(snapshotOf(record))).digest('hex')}`;
}

function getPolicyRecord(policyProfileId) {
  return POLICY_REGISTRY.find((entry) => entry.policyProfileId === policyProfileId) || null;
}

/**
 * @param {string} policyProfileId
 * @param {object} context
 * @param {object} [context.caseRecord] - 案件快照（cnCode 來源）
 * @param {object} [context.installationYear] - 年度快照（reportingYear 來源）
 * @param {object} [context.declaredPolicyProfile] - 案件夾帶的 PolicyProfile 宣稱值
 * @param {Date} [context.now]
 */
function resolvePolicyProfile(policyProfileId, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const checks = [];
  const reasonCodes = [];

  function fail(reasonCode, detail) {
    checks.push(makeCheck('policy_registry_check', 'fail', detail));
    reasonCodes.push(reasonCode);
    return { ok: false, record: null, policySnapshotHash: null, checks, reasonCodes };
  }

  if (typeof policyProfileId !== 'string' || !policyProfileId.trim()) {
    return fail(REASON_CODE.POLICY_NOT_APPLICABLE, 'policyProfileId 缺失。');
  }

  const record = getPolicyRecord(policyProfileId);
  if (!record) {
    return fail(
      REASON_CODE.POLICY_NOT_APPLICABLE,
      `policyProfileId ${policyProfileId} 不在 Policy Registry 內，視為未經核准的政策版本。`
    );
  }
  checks.push(makeCheck('policy_lookup', 'pass', `Policy Registry 找到 ${policyProfileId}`));

  if (record.status !== 'active') {
    return fail(REASON_CODE.POLICY_NOT_APPLICABLE, `policyProfileId ${policyProfileId} 狀態為 ${record.status}，不可套用。`);
  }
  const nowMs = now.getTime();
  if (record.effectiveFrom && nowMs < Date.parse(`${record.effectiveFrom}T00:00:00Z`)) {
    return fail(
      REASON_CODE.POLICY_NOT_APPLICABLE,
      `policyProfileId ${policyProfileId} 尚未生效（effectiveFrom ${record.effectiveFrom}）。`
    );
  }
  if (record.effectiveTo && nowMs > Date.parse(`${record.effectiveTo}T23:59:59Z`)) {
    return fail(
      REASON_CODE.POLICY_NOT_APPLICABLE,
      `policyProfileId ${policyProfileId} 已於 ${record.effectiveTo} 後失效。`
    );
  }
  checks.push(makeCheck('policy_status_window', 'pass', `${record.status}，有效期間內`));

  if (!record.circuitId) {
    return fail(REASON_CODE.POLICY_NOT_APPLICABLE, `policyProfileId ${policyProfileId} 未設定 circuitId，無法綁定 Proof。`);
  }
  if (!Array.isArray(record.requiredEvidence) || record.requiredEvidence.length === 0) {
    return fail(REASON_CODE.POLICY_NOT_APPLICABLE, `policyProfileId ${policyProfileId} 未定義 requiredEvidence。`);
  }
  checks.push(makeCheck('policy_required_fields', 'pass', 'circuitId 與 requiredEvidence 齊備'));

  const caseRecord = context.caseRecord;
  if (caseRecord && caseRecord.cnCode !== undefined && !record.cnCodes.includes(caseRecord.cnCode)) {
    return fail(
      REASON_CODE.POLICY_NOT_APPLICABLE,
      `案件 CN code ${caseRecord.cnCode} 不在政策適用清單 [${record.cnCodes.join(', ')}]。`
    );
  }
  const installationYear = context.installationYear;
  if (
    installationYear &&
    installationYear.reportingYear !== undefined &&
    installationYear.reportingYear !== record.reportingYear
  ) {
    return fail(
      REASON_CODE.POLICY_NOT_APPLICABLE,
      `年度資料 reportingYear ${installationYear.reportingYear} 與政策 ${record.reportingYear} 不符。`
    );
  }
  checks.push(makeCheck('policy_case_scope', 'pass', 'CN code 與 reportingYear 皆在政策適用範圍'));

  // Immutable snapshot 比對：案件夾帶的 PolicyProfile 只要跟 registry 有一欄不同，
  // 就是被改過的政策快照（例如偷加一個 allowedFactorSets）。
  const declared = context.declaredPolicyProfile;
  if (declared && typeof declared === 'object') {
    const declaredSnapshot = snapshotOf(declared);
    const registrySnapshot = snapshotOf(record);
    const mismatched = SNAPSHOT_FIELDS.filter(
      (field) => stableStringify(declaredSnapshot[field]) !== stableStringify(registrySnapshot[field])
    );
    if (mismatched.length) {
      return fail(
        REASON_CODE.POLICY_NOT_APPLICABLE,
        `案件夾帶的 PolicyProfile 與 Policy Registry 不可變快照不一致：${mismatched.join('、')}。`
      );
    }
    checks.push(makeCheck('policy_snapshot_immutable', 'pass', '案件夾帶 PolicyProfile 與 registry 快照逐欄位一致'));
  } else {
    checks.push(makeCheck('policy_snapshot_immutable', 'skipped', '呼叫端未提供 PolicyProfile 快照，略過逐欄位比對'));
  }

  return {
    ok: true,
    record,
    policySnapshotHash: policySnapshotHash(record),
    checks,
    reasonCodes: [],
  };
}

module.exports = {
  POLICY_REGISTRY,
  SNAPSHOT_FIELDS,
  getPolicyRecord,
  policySnapshotHash,
  resolvePolicyProfile,
};
