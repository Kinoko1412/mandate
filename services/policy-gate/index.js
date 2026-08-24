'use strict';

/**
 * services/policy-gate — Day 3 trust engine：把 Policy Registry、Factor Registry、
 * 逐批 Proof 驗證與證據涵蓋期間四者的結果合併成一份 GateResult（canonical 形狀見
 * schema-v1.json `GateResult`）。
 *
 * 判斷順序逐字對齊規格 p.13「Final Mapping：硬失敗→BLOCKED；缺件→NEEDS_EVIDENCE；
 * 方法→METHOD_REVIEW」：
 *   1. 授權／政策／係數／Proof 任一硬失敗 → BLOCKED
 *   2. 證據缺件或涵蓋期間不完整 → NEEDS_EVIDENCE
 *   3. 全部通過 → GATE_OK
 *
 * 證據涵蓋期間由本檔的 `evaluateEvidenceCoverage()` 依「**實際上傳的 EvidenceItem
 * metadata**」計算（不是由呼叫端寫死布林值）——這正是規格 p.8 missing_period fixture
 * 「電費只涵蓋 1–6 月 → NEEDS_EVIDENCE／EVIDENCE_PERIOD_INCOMPLETE」要測的東西。
 *
 * 這一層跟 workflowApi 既有的「Supplier 是否上傳齊 4 份並人工確認」不同層次：那個仍然是
 * workflowApi.evidenceReadiness() 的責任（Day 2 契約，Day 3 沒有動它）；這裡多做的是
 * 「這些文件宣稱涵蓋的期間，加起來有沒有蓋滿整個申報曆年」。
 */

const { GATE_DECISION, REASON_CODE } = require('../../packages/contracts/enums');

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

function dayMs(dateStr, boundary) {
  if (typeof dateStr !== 'string' || !dateStr.trim()) return NaN;
  const normalized = dateStr.includes('T')
    ? dateStr
    : `${dateStr}${boundary === 'end' ? 'T23:59:59Z' : 'T00:00:00Z'}`;
  return Date.parse(normalized);
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 把多段期間合併成不重疊的聯集（已排序）。 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // 相鄰兩段只差 1 天以內視為連續（日界線用 23:59:59 收尾，中間會差 1 秒）
    if (last && interval.start <= last.end + 24 * 60 * 60 * 1000) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** 回傳 [rangeStart, rangeEnd] 之中沒有被 merged 覆蓋到的缺口。 */
function findGaps(merged, rangeStart, rangeEnd) {
  const gaps = [];
  let cursor = rangeStart;
  for (const interval of merged) {
    if (interval.end < cursor) continue;
    if (interval.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(interval.start - 1, rangeEnd) });
    }
    cursor = Math.max(cursor, interval.end + 1);
    if (cursor > rangeEnd) break;
  }
  if (cursor <= rangeEnd) gaps.push({ start: cursor, end: rangeEnd });
  return gaps.filter((gap) => gap.end >= gap.start);
}

/**
 * 依實際 EvidenceItem metadata 判斷「requiredEvidence 每一類是否都有人工確認過的文件、
 * 且各類文件宣稱涵蓋的期間聯集有蓋滿整個申報曆年」。
 *
 * @param {object} params
 * @param {object} params.installationYear - 含 reportingYear（與選填 evidenceCoverage）
 * @param {Array<object>} params.evidence - EvidenceItem 陣列（type/coveredFrom/coveredTo/humanConfirmed）
 * @param {string[]} params.requiredEvidence - 權威 PolicyProfile 的 requiredEvidence
 * @returns {{ok: boolean, checks: object[], reasonCodes: string[], missingTypes: string[], incompleteTypes: object[]}}
 */
function evaluateEvidenceCoverage({ installationYear, evidence, requiredEvidence } = {}) {
  const checks = [];
  const reasonCodes = [];
  const items = Array.isArray(evidence) ? evidence : [];
  const required = Array.isArray(requiredEvidence) ? requiredEvidence : [];
  const reportingYear = installationYear && installationYear.reportingYear;

  if (!Number.isInteger(reportingYear)) {
    checks.push(makeCheck('evidence_coverage', 'fail', '缺少 reportingYear，無法判斷證據涵蓋期間。'));
    return {
      ok: false,
      checks,
      reasonCodes: [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE],
      missingTypes: [...required],
      incompleteTypes: [],
    };
  }

  const yearStart = Date.parse(`${reportingYear}-01-01T00:00:00Z`);
  const yearEnd = Date.parse(`${reportingYear}-12-31T23:59:59Z`);
  const missingTypes = [];
  const incompleteTypes = [];

  for (const type of required) {
    const confirmed = items.filter((item) => item && item.type === type && item.humanConfirmed !== false);
    if (!confirmed.length) {
      missingTypes.push(type);
      continue;
    }
    const merged = mergeIntervals(
      confirmed.map((item) => ({ start: dayMs(item.coveredFrom, 'start'), end: dayMs(item.coveredTo, 'end') }))
    );
    if (!merged.length) {
      incompleteTypes.push({ type, missingPeriods: [{ from: isoDay(yearStart), to: isoDay(yearEnd) }] });
      continue;
    }
    const gaps = findGaps(merged, yearStart, yearEnd);
    if (gaps.length) {
      incompleteTypes.push({
        type,
        missingPeriods: gaps.map((gap) => ({ from: isoDay(gap.start), to: isoDay(gap.end) })),
      });
    }
  }

  if (missingTypes.length) {
    checks.push(makeCheck('evidence_required_types', 'fail', `缺少必備證據類型：${missingTypes.join('、')}。`));
    reasonCodes.push(REASON_CODE.EVIDENCE_MISSING);
  } else {
    checks.push(makeCheck('evidence_required_types', 'pass', `requiredEvidence ${required.length} 類皆有人工確認文件`));
  }

  if (incompleteTypes.length) {
    checks.push(
      makeCheck(
        'evidence_period_coverage',
        'fail',
        incompleteTypes
          .map(
            (entry) =>
              `${entry.type} 未涵蓋 ${reportingYear} 全年，缺 ${entry.missingPeriods
                .map((period) => `${period.from}~${period.to}`)
                .join('、')}`
          )
          .join('；')
      )
    );
    reasonCodes.push(REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE);
  } else if (!missingTypes.length) {
    checks.push(makeCheck('evidence_period_coverage', 'pass', `所有必備證據涵蓋 ${reportingYear} 全年`));
  }

  // 年度資料自己宣告的 evidenceCoverage 也要跟實際文件一致：宣稱蓋滿全年、實際文件只有
  // 半年，或反過來宣稱不足，都算涵蓋期間不完整。
  const declared = installationYear && installationYear.evidenceCoverage;
  if (declared && declared.periodStart && declared.periodEnd) {
    const declaredStart = dayMs(declared.periodStart, 'start');
    const declaredEnd = dayMs(declared.periodEnd, 'end');
    if (!Number.isFinite(declaredStart) || !Number.isFinite(declaredEnd) || declaredStart > yearStart || declaredEnd < yearEnd) {
      checks.push(
        makeCheck(
          'evidence_declared_coverage',
          'fail',
          `InstallationYear.evidenceCoverage 只宣告 ${declared.periodStart}~${declared.periodEnd}，未涵蓋整個 ${reportingYear} 曆年。`
        )
      );
      if (!reasonCodes.includes(REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE)) {
        reasonCodes.push(REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE);
      }
    } else {
      checks.push(makeCheck('evidence_declared_coverage', 'pass', 'InstallationYear.evidenceCoverage 宣告涵蓋整個曆年'));
    }
  } else {
    checks.push(makeCheck('evidence_declared_coverage', 'skipped', 'InstallationYear 未宣告 evidenceCoverage'));
  }

  return {
    ok: reasonCodes.length === 0,
    checks,
    reasonCodes,
    missingTypes,
    incompleteTypes,
  };
}

function collect(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result.flatMap(collect);
  return Array.isArray(result.checks) ? result.checks : [];
}

function failureCodes(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result.flatMap(failureCodes);
  return result.ok ? [] : (result.reasonCodes || []);
}

function allOk(result) {
  if (!result) return true;
  if (Array.isArray(result)) return result.every(allOk);
  return Boolean(result.ok);
}

/**
 * @param {object} params
 * @param {string} params.policyProfileId
 * @param {object} [params.policyResult] - services/policy-registry 的 resolvePolicyProfile 結果
 * @param {object} [params.factorResult] - services/factor-registry 的 resolveFactorSet 結果
 * @param {object|object[]} [params.proofResult] - services/proof 的 verifyProofEnvelope 結果（可為逐批陣列）
 * @param {object[]} [params.proofResults] - 逐批 Proof 驗證結果（等同 proofResult 傳陣列）
 * @param {object} [params.evidenceResult] - evaluateEvidenceCoverage() 結果
 * @param {boolean} [params.evidenceReady] - 舊介面：沒有 evidenceResult 時的布林旗標
 * @param {string} params.inputHash - GateResult.inputHash 為必填欄位，即使 BLOCKED 也要帶
 * @param {string} [params.shipmentId]
 * @param {Date} [params.now]
 */
function evaluateGate({
  policyProfileId,
  policyResult,
  factorResult,
  proofResult,
  proofResults,
  evidenceResult,
  evidenceReady = true,
  inputHash,
  shipmentId,
  now,
}) {
  const evaluatedAt = (now instanceof Date ? now : new Date()).toISOString();
  const proofs = proofResults || proofResult;
  const checks = [...collect(policyResult), ...collect(factorResult), ...collect(proofs), ...collect(evidenceResult)];

  const base = {
    checks,
    policyProfileId: policyProfileId || null,
    evaluatedAt,
    inputHash: inputHash || null,
    ...(shipmentId ? { shipmentId } : {}),
  };

  // 1. 硬失敗（授權／政策／係數／Proof）→ BLOCKED
  const hardFailures = [
    ...failureCodes(policyResult),
    ...failureCodes(factorResult),
    ...failureCodes(proofs),
  ];
  if (hardFailures.length || !allOk(policyResult) || !allOk(factorResult) || !allOk(proofs)) {
    const reasonCodes = [...new Set(hardFailures)];
    checks.push(makeCheck('gate_decision', 'fail', '政策／係數／Proof 檢查未全數通過，Gate 判定 BLOCKED。'));
    return {
      ...base,
      decision: GATE_DECISION.BLOCKED,
      reasonCodes: reasonCodes.length ? reasonCodes : ['TRUST_SERVICE_FAILED'],
    };
  }

  // 2. 缺件／期間不完整 → NEEDS_EVIDENCE
  const evidenceOk = evidenceResult ? Boolean(evidenceResult.ok) : evidenceReady !== false;
  if (!evidenceOk) {
    const reasonCodes =
      evidenceResult && Array.isArray(evidenceResult.reasonCodes) && evidenceResult.reasonCodes.length
        ? [...new Set(evidenceResult.reasonCodes)]
        : [REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE];
    checks.push(makeCheck('gate_evidence_gate', 'fail', '證據缺件或涵蓋期間不完整，Gate 判定 NEEDS_EVIDENCE。'));
    return {
      ...base,
      decision: GATE_DECISION.NEEDS_EVIDENCE,
      reasonCodes,
    };
  }
  if (!evidenceResult) {
    checks.push(makeCheck('gate_evidence_gate', 'pass', '年度資料證據涵蓋期間完整'));
  }

  checks.push(makeCheck('gate_decision', 'pass', 'Policy Registry、Factor Registry、逐批 Proof 與證據涵蓋皆通過'));
  return {
    ...base,
    decision: GATE_DECISION.GATE_OK,
    reasonCodes: [REASON_CODE.GATE_OK],
  };
}

module.exports = {
  evaluateEvidenceCoverage,
  evaluateGate,
};
