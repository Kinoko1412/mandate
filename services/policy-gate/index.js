'use strict';

/**
 * services/policy-gate — Day 3 trust engine：把 Factor Registry 跟 Proof 驗證的結果
 * 合併成一份 GateResult（canonical 形狀見 schema-v1.json `GateResult`）。
 *
 * 判斷順序（對齊規格 p.11 Gate Check 表的精神：缺件優先於方法/證明問題——一個案件
 * 缺證據時，回報「缺證據」比回報「Proof 驗證失敗」對使用者更有意義，兩者不是同一層次
 * 的問題）：
 *   1. evidenceReady === false → NEEDS_EVIDENCE
 *   2. factorResult 或 proofResult 任一沒通過 → BLOCKED
 *   3. 兩者都通過 → GATE_OK
 *
 * 這一層**不**是 workflowApi 既有的「Supplier 上傳證據齊全與否」檢查（那個仍然是
 * workflowApi.evidenceReadiness() 的責任，Day 3 沒有動它）；這裡的 evidenceReady 對應
 * 的是 carbon-core 年度資料層級的「證據涵蓋期間是否完整」（呼應 fixtures/missing_period.json
 * 的情境），由呼叫端（trustAdapter）依 carbon-core 的計算結果決定要不要標 false。
 */

const { GATE_DECISION, REASON_CODE } = require('../../packages/contracts/enums');

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

/**
 * @param {object} params
 * @param {string} params.policyProfileId
 * @param {{ok: boolean, checks: object[], reasonCodes: string[]}} params.factorResult
 * @param {{ok: boolean, checks: object[], reasonCodes: string[]}} params.proofResult
 * @param {boolean} [params.evidenceReady] - 預設 true
 * @param {string} params.inputHash - GateResult.inputHash 為必填欄位，即使 BLOCKED 也要帶
 * @param {Date} [params.now]
 */
function evaluateGate({
  policyProfileId,
  factorResult,
  proofResult,
  evidenceReady = true,
  inputHash,
  now,
}) {
  const evaluatedAt = (now instanceof Date ? now : new Date()).toISOString();
  const checks = [
    ...(factorResult ? factorResult.checks : []),
    ...(proofResult ? proofResult.checks : []),
  ];

  if (!evidenceReady) {
    checks.push(makeCheck('gate_evidence_gate', 'fail', '年度資料證據涵蓋期間不完整，Gate 判定 NEEDS_EVIDENCE。'));
    return {
      decision: GATE_DECISION.NEEDS_EVIDENCE,
      reasonCodes: [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE],
      checks,
      policyProfileId: policyProfileId || null,
      evaluatedAt,
      inputHash: inputHash || null,
    };
  }
  checks.push(makeCheck('gate_evidence_gate', 'pass', '年度資料證據涵蓋期間完整'));

  const factorOk = Boolean(factorResult && factorResult.ok);
  const proofOk = Boolean(proofResult && proofResult.ok);

  if (!factorOk || !proofOk) {
    const reasonCodes = [
      ...new Set([
        ...(factorOk ? [] : (factorResult && factorResult.reasonCodes) || []),
        ...(proofOk ? [] : (proofResult && proofResult.reasonCodes) || []),
      ]),
    ];
    return {
      decision: GATE_DECISION.BLOCKED,
      reasonCodes: reasonCodes.length ? reasonCodes : ['TRUST_SERVICE_FAILED'],
      checks,
      policyProfileId: policyProfileId || null,
      evaluatedAt,
      inputHash: inputHash || null,
    };
  }

  checks.push(makeCheck('gate_decision', 'pass', 'Factor Registry 與 Proof 皆通過'));
  return {
    decision: GATE_DECISION.GATE_OK,
    reasonCodes: [REASON_CODE.GATE_OK],
    checks,
    policyProfileId: policyProfileId || null,
    evaluatedAt,
    inputHash: inputHash || null,
  };
}

module.exports = {
  evaluateGate,
};
