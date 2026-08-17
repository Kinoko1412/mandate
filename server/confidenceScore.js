'use strict';

/**
 * 信心分數（confidence score）——僅供排序／提示 UI 使用；絕不能用於略過
 * POL-HITL-010 或任何 policy.js 判斷，送審與否永遠由 policy.js 決定。這是
 * 純確定性加權（不依賴 LLM），staging/case-summary/approval 顯示用的
 * 展示層metadata，policy.js 完全不讀這個分數。
 */

const { getMissingLevel2 } = require('./pcfCheck');
const { verifySupplierCredentialChain } = require('./vleiCheck');

const DENY_POLICY_IDS = new Set(['POL-CARB-001', 'POL-CARB-002']);

function scoreStagedPayload(payload, supplier, auditEvents) {
  let score = 0;

  score += payload && payload.qualityTier === 'COMPLETE' ? 40 : 15;

  if (payload && payload.verificationStatus === 'verified' && payload.verificationReportId) {
    score += 20;
  }

  const missingL2 = getMissingLevel2(payload || {});
  score -= missingL2.length * 5;

  const chain = verifySupplierCredentialChain(supplier);
  if (chain.chainStatus === 'VALID') {
    score += 20;
  } else if (chain.chainStatus === 'NO_VLEI') {
    score += supplier && supplier.credentialValid ? 10 : 0;
  } else {
    score -= 30;
  }

  const supplierId = payload && payload.supplierId;
  if (supplierId && Array.isArray(auditEvents)) {
    const priorDenials = auditEvents.filter(
      (ev) =>
        ev.inputRedacted &&
        ev.inputRedacted.supplierId === supplierId &&
        DENY_POLICY_IDS.has(ev.policyId)
    ).length;
    score -= Math.min(priorDenials, 4) * 5;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { score, tier };
}

module.exports = { scoreStagedPayload };
