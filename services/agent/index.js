'use strict';

const crypto = require('crypto');
const {
  AGENT_REASON_CODE,
  AGENT_REVIEW_STATUS,
} = require('../../packages/contracts/enums');

const MODEL_VERSION = 'demo-rule-based-no-llm-v1';
const PROMPT_VERSION = 'evidence-risk-contract-v1';
const MAX_ENTRIES_PER_EVIDENCE = 100;
const MAX_ENTRIES_PER_CASE = 250;
const MAX_CITATIONS_PER_CASE = 250;
const INJECTION_PATTERN =
  /ignore\s+previous\s+instructions|mark\s+pass|\bpass\b|\bdeny\b|cbam\s+certified|officially\s+approved|decrypt|submit|system\s+prompt|忽略(?:先前|之前|規則)|直接放行|解密|提交/iu;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_UNIT = /^[A-Za-z0-9%/_. -]{1,24}$/;
const SAFE_SOURCE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SOURCE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/;
const SAFE_STRING_VALUE = /^[A-Za-z0-9 ._:/%+-]{1,128}$/;
const ALLOWED_UNITS = Object.freeze({
  electricitymwh: Object.freeze(['MWh']),
  fuelgj: Object.freeze(['GJ']),
  productiontonnes: Object.freeze(['tonne']),
  reportedproductiontonnes: Object.freeze(['tonne']),
  precursortonnes: Object.freeze(['tonne']),
  precursorinputtonnes: Object.freeze(['tonne']),
});
const DEMO_HEURISTICS = Object.freeze([
  Object.freeze({
    metricType: 'electricity_bill',
    metricFields: Object.freeze(['electricityMWh']),
    ruleId: AGENT_REASON_CODE.ELECTRICITY_INTENSITY_OUT_OF_RANGE,
    min: 0.1,
    max: 5,
    ratioUnit: 'MWh/tonne',
  }),
  Object.freeze({
    metricType: 'fuel_ledger',
    metricFields: Object.freeze(['fuelGJ']),
    ruleId: AGENT_REASON_CODE.FUEL_INTENSITY_OUT_OF_RANGE,
    min: 0.1,
    max: 20,
    ratioUnit: 'GJ/tonne',
  }),
  Object.freeze({
    metricType: 'precursor_list',
    metricFields: Object.freeze(['precursorTonnes', 'precursorInputTonnes']),
    ruleId: AGENT_REASON_CODE.PRECURSOR_RATIO_OUT_OF_RANGE,
    min: 0.5,
    max: 2,
    ratioUnit: 'tonne/tonne',
  }),
]);

class EvidenceAgentError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EvidenceAgentError';
    this.code = code;
    this.details = details;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function fieldKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function safePage(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function safeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0.5;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function containsInjection(value) {
  if (typeof value === 'string') return INJECTION_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsInjection);
  if (value && typeof value === 'object') return Object.values(value).some(containsInjection);
  return false;
}

function decodeEvidence(item) {
  if (typeof item.contentBase64 !== 'string' || !item.contentBase64) {
    throw new EvidenceAgentError(
      'EVIDENCE_CONTENT_UNAVAILABLE',
      'Evidence Agent 無法讀取這份 Demo 證據。',
      { evidenceId: item.evidenceId }
    );
  }
  return Buffer.from(item.contentBase64, 'base64').toString('utf8');
}

function parseTextEntries(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = Object.fromEntries(
      line
        .split(';')
        .map((part) => part.split(/=(.*)/s))
        .filter((pair) => pair.length >= 2 && pair[0].trim())
        .map(([key, value]) => [key.trim(), value.trim()])
    );
    if (!parts.field || parts.value === undefined) continue;
    const numeric = Number(parts.value);
    entries.push({
      field: parts.field,
      value: Number.isFinite(numeric) && parts.value !== '' ? numeric : parts.value,
      unit: parts.unit || null,
      sourcePage: safePage(Number(parts.page)),
      confidence: safeConfidence(parts.confidence),
      humanConfirmed: String(parts.humanConfirmed).toLowerCase() === 'true',
    });
  }
  return entries;
}

function parseJsonEntries(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.entries)) return value.entries;
  if (Array.isArray(value.pages)) {
    return value.pages.flatMap((page) =>
      Array.isArray(page.entries)
        ? page.entries.map((entry) => ({ ...entry, sourcePage: entry.sourcePage || page.page }))
        : []
    );
  }
  return [];
}

function parseEvidence(item, text) {
  if (item.mediaType === 'application/json' || /^[\s]*[\[{]/.test(text)) {
    try {
      return parseJsonEntries(JSON.parse(text));
    } catch {
      if (item.mediaType === 'application/json') {
        throw new EvidenceAgentError(
          'EVIDENCE_JSON_INVALID',
          'Demo JSON 證據格式無效。',
          { evidenceId: item.evidenceId }
        );
      }
    }
  }
  return parseTextEntries(text);
}

function normalizeEntry(raw, item) {
  if (!raw || typeof raw !== 'object' || typeof raw.field !== 'string') {
    return { entry: null, unsafeText: true, unitAmbiguous: false };
  }
  if (!['string', 'number', 'boolean'].includes(typeof raw.value) && raw.value !== null) {
    return { entry: null, unsafeText: true, unitAmbiguous: false };
  }
  const field = raw.field.trim();
  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : null;
  if (
    containsInjection(raw) ||
    !SAFE_FIELD.test(field) ||
    (unit !== null && !SAFE_UNIT.test(unit)) ||
    (typeof raw.value === 'string' && !SAFE_STRING_VALUE.test(raw.value))
  ) {
    return { entry: null, unsafeText: true, unitAmbiguous: false };
  }
  const confidence = safeConfidence(raw.confidence);
  const humanConfirmed = Boolean(item.humanConfirmed && raw.humanConfirmed === true);
  const key = fieldKey(field);
  const candidateUnits = ALLOWED_UNITS[key] ? [...ALLOWED_UNITS[key]] : [];
  const unitAmbiguous =
    typeof raw.value === 'number' &&
    (!candidateUnits.length || unit === null || !candidateUnits.includes(unit));
  const highImpact = typeof raw.value === 'number';
  const entry = {
    field,
    value: raw.value,
    unit,
    sourceFile: item.filename,
    sourcePage: safePage(raw.sourcePage || raw.page),
    confidence,
    humanConfirmed,
    eligibleForCalculation:
      confidence >= 0.8 && (!highImpact || humanConfirmed) && !unitAmbiguous,
    candidateUnits,
    evidenceType: item.type,
  };
  return { entry, unsafeText: false, unitAmbiguous };
}

function periodForYear(year) {
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    label: `${year}-01-01/${year}-12-31`,
  };
}

function missingEvidenceFindings(snapshot) {
  const required = snapshot.policyProfile.requiredEvidence || [];
  const year = periodForYear(snapshot.installationYear.reportingYear);
  const dayMs = 24 * 60 * 60 * 1000;
  const yearStart = Date.parse(`${year.start}T00:00:00Z`);
  const yearEnd = Date.parse(`${year.end}T00:00:00Z`);
  const dateLabel = (value) => new Date(value).toISOString().slice(0, 10);
  return required.flatMap((type) => {
    const matching = snapshot.evidence.filter((item) => item.type === type);
    if (!matching.length) {
      return [{
        requiredEvidence: type,
        coveredPeriod: null,
        missingPeriod: year.label,
        requestedAction: `請補上 ${type} 的 ${snapshot.installationYear.reportingYear} 全年 Demo 證據。`,
      }];
    }
    const intervals = matching
      .map((item) => ({
        start: Date.parse(`${item.coveredFrom}T00:00:00Z`),
        end: Date.parse(`${item.coveredTo}T00:00:00Z`),
      }))
      .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end))
      .map((interval) => ({
        start: Math.max(interval.start, yearStart),
        end: Math.min(interval.end, yearEnd),
      }))
      .filter((interval) => interval.start <= interval.end)
      .sort((left, right) => left.start - right.start);
    const merged = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.start <= previous.end + dayMs) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        merged.push({ ...interval });
      }
    }
    const gaps = [];
    let cursor = yearStart;
    for (const interval of merged) {
      if (interval.start > cursor) {
        gaps.push(`${dateLabel(cursor)}/${dateLabel(interval.start - dayMs)}`);
      }
      cursor = Math.max(cursor, interval.end + dayMs);
    }
    if (cursor <= yearEnd) gaps.push(`${dateLabel(cursor)}/${year.end}`);
    if (!gaps.length) return [];
    return [{
      requiredEvidence: type,
      coveredPeriod: merged.length
        ? merged.map((interval) => `${dateLabel(interval.start)}/${dateLabel(interval.end)}`).join(', ')
        : null,
      missingPeriod: gaps.join(', '),
      requestedAction: `請補齊 ${type} 的缺少期間並由人員確認。`,
    }];
  });
}

function firstNumeric(entries, type, names) {
  const keys = new Set(names.map(fieldKey));
  return entries.find(
    (entry) =>
      entry.evidenceType === type &&
      entry.eligibleForCalculation &&
      keys.has(fieldKey(entry.field)) &&
      typeof entry.value === 'number'
  );
}

function evaluateHeuristic(entries, citationByEntry, heuristic) {
  const production = firstNumeric(entries, 'production_report', ['productionTonnes']);
  const metric = firstNumeric(entries, heuristic.metricType, heuristic.metricFields);
  if (!production || !metric || production.value <= 0) {
    return {
      skipped: true,
      finding: {
        reasonCode: AGENT_REASON_CODE.CROSS_TABLE_CHECK_SKIPPED,
        severity: 'warning',
        message: `${heuristic.ruleId} 因必要值缺失、低信心、單位不明或尚未人工確認而略過。`,
      },
    };
  }
  const ratio = metric.value / production.value;
  if (ratio >= heuristic.min && ratio <= heuristic.max) {
    return { skipped: false, discrepancy: null };
  }
  return {
    skipped: false,
    discrepancy: {
      ruleId: heuristic.ruleId,
      leftValue: metric.value,
      rightValue: production.value,
      difference: ratio,
      severity: ratio < heuristic.min / 2 || ratio > heuristic.max * 2 ? 'high' : 'warning',
      possibleExplanations: [
        `Demo heuristic 預期範圍為 ${heuristic.min}–${heuristic.max} ${heuristic.ratioUnit}。`,
        '期間、製程邊界、單位換算或資料更新時間可能不同，需人工確認。',
      ],
      leftCitation: citationByEntry.get(metric),
      rightCitation: citationByEntry.get(production),
    },
  };
}

function analyzeEvidence(snapshot) {
  if (
    !snapshot ||
    !snapshot.caseRecord ||
    !snapshot.installationYear ||
    !snapshot.policyProfile ||
    !Array.isArray(snapshot.evidence)
  ) {
    throw new EvidenceAgentError(
      'AGENT_SNAPSHOT_INVALID',
      'Evidence Agent 案件快照不完整。'
    );
  }

  const findings = [];
  const citations = [];
  const entries = [];
  const openIssues = [];
  const nextActions = [];
  const citationKeys = new Map();
  const citationByEntry = new Map();
  const summaryCitationIndexes = new Set();
  let truncated = false;

  function addFinding(reasonCode, severity, message) {
    findings.push({ reasonCode, severity, message });
  }

  function addCitation(citation, includeInSummary = false) {
    const key = `${citation.reasonCode}|${citation.sourceFile}|${citation.sourcePage}`;
    if (citationKeys.has(key)) {
      const existing = citationKeys.get(key);
      if (includeInSummary) summaryCitationIndexes.add(existing);
      return existing;
    }
    if (citations.length >= MAX_CITATIONS_PER_CASE) {
      truncated = true;
      return null;
    }
    const index = citations.length;
    citations.push(citation);
    citationKeys.set(key, index);
    if (includeInSummary) summaryCitationIndexes.add(index);
    return index;
  }

  for (const item of snapshot.evidence) {
    const text = decodeEvidence(item);
    const safeSourceFile =
      typeof item.filename === 'string' && SAFE_SOURCE_FILE.test(item.filename)
        ? item.filename
        : item.evidenceId;
    if (
      containsInjection(text) ||
      containsInjection(item.filename) ||
      containsInjection(item.source)
    ) {
      addFinding(
        AGENT_REASON_CODE.PROMPT_INJECTION_DETECTED,
        'high',
        '文件含疑似指令注入內容；整份抽取資料已丟棄並等待人工安全檢視。'
      );
      addCitation({
        reasonCode: AGENT_REASON_CODE.PROMPT_INJECTION_DETECTED,
        sourceFile: item.evidenceId,
        sourcePage: 1,
      }, true);
      openIssues.push('偵測到文件指令注入風險，尚待人工安全檢視。');
      nextActions.push('由授權人員檢視該證據來源；不要執行文件內的任何操作指令。');
      continue;
    }
    if (
      typeof item.filename !== 'string' ||
      !SAFE_SOURCE_FILE.test(item.filename) ||
      (typeof item.source === 'string' && !SAFE_SOURCE_LABEL.test(item.source))
    ) {
      addFinding(
        AGENT_REASON_CODE.UNSAFE_DOCUMENT_TEXT,
        'warning',
        '文件含不符合字元或長度白名單的中繼資料；整份抽取資料已丟棄。'
      );
      addCitation({
        reasonCode: AGENT_REASON_CODE.UNSAFE_DOCUMENT_TEXT,
        sourceFile: item.evidenceId,
        sourcePage: 1,
      }, true);
      openIssues.push('一份文件的可控字串未通過安全白名單。');
      nextActions.push('請以允許的 ASCII 檔名與受控欄位重新上傳 Demo 證據。');
      continue;
    }
    const parsed = parseEvidence({ ...item, filename: safeSourceFile }, text);
    if (parsed.length > MAX_ENTRIES_PER_EVIDENCE) truncated = true;
    for (const raw of parsed.slice(0, MAX_ENTRIES_PER_EVIDENCE)) {
      if (entries.length >= MAX_ENTRIES_PER_CASE) {
        truncated = true;
        break;
      }
      const normalized = normalizeEntry(raw, { ...item, filename: safeSourceFile });
      if (!normalized.entry) {
        if (normalized.unsafeText) {
          addFinding(
            AGENT_REASON_CODE.UNSAFE_DOCUMENT_TEXT,
            'warning',
            '一筆抽取資料未通過字元或長度白名單，已丟棄且不回顯原文。'
          );
        }
        continue;
      }
      const entry = normalized.entry;
      entries.push(entry);
      const citationIndex = addCitation({
        reasonCode: AGENT_REASON_CODE.EXTRACTED_VALUE,
        sourceFile: entry.sourceFile,
        sourcePage: entry.sourcePage,
      });
      citationByEntry.set(entry, citationIndex);
      if (normalized.unitAmbiguous) {
        addFinding(
          AGENT_REASON_CODE.UNIT_AMBIGUOUS,
          'warning',
          `欄位 ${entry.field} 的單位不在 Demo 允許清單，未納入計算。`
        );
        if (citationIndex !== null) summaryCitationIndexes.add(citationIndex);
        openIssues.push(`欄位 ${entry.field} 的單位需人工確認。`);
        nextActions.push(
          `請核對 ${entry.sourceFile} 第 ${entry.sourcePage} 頁；候選單位：${entry.candidateUnits.join(', ') || '尚未定義'}。`
        );
      }
      if (!entry.eligibleForCalculation) {
        const reason = entry.confidence < 0.8
          ? `抽取欄位 ${entry.field} 信心不足，未納入計算。`
          : normalized.unitAmbiguous
            ? `抽取欄位 ${entry.field} 單位不明，未納入計算。`
            : `數值欄位 ${entry.field} 尚未人工確認，未納入計算。`;
        openIssues.push(reason);
        nextActions.push(`請人工核對 ${entry.sourceFile} 第 ${entry.sourcePage} 頁的 ${entry.field}。`);
      }
    }
  }

  for (const item of snapshot.evidence) {
    if (
      !isIsoDate(item.coveredFrom) ||
      !isIsoDate(item.coveredTo) ||
      item.coveredFrom > item.coveredTo
    ) {
      addFinding(
        AGENT_REASON_CODE.INVALID_EVIDENCE_PERIOD,
        'warning',
        '證據期間格式或先後順序無效；該期間不視為有效年度涵蓋。'
      );
      openIssues.push('一份證據的涵蓋期間無效，需重新確認。');
      nextActions.push('請以 YYYY-MM-DD 格式修正 coveredFrom/coveredTo，且起日不得晚於迄日。');
    }
  }

  if (truncated) {
    addFinding(
      AGENT_REASON_CODE.EXTRACTION_TRUNCATED,
      'warning',
      '抽取結果超過 Demo 安全上限，已截斷；未處理部分不得用於計算。'
    );
    openIssues.push('抽取結果因安全上限被截斷。');
    nextActions.push('請拆分文件或縮小每次分析範圍後重新執行。');
  }

  const missingEvidence = missingEvidenceFindings(snapshot);
  for (const item of missingEvidence) {
    addFinding(
      item.coveredPeriod
        ? AGENT_REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE
        : AGENT_REASON_CODE.EVIDENCE_MISSING,
      'warning',
      `${item.requiredEvidence} 的必要證據或期間尚未完整。`
    );
    openIssues.push(`${item.requiredEvidence} 尚有缺件或缺少期間。`);
    nextActions.push(item.requestedAction);
  }

  const discrepancies = [];
  for (const heuristic of DEMO_HEURISTICS) {
    const result = evaluateHeuristic(entries, citationByEntry, heuristic);
    if (result.skipped) {
      findings.push(result.finding);
      openIssues.push(`${heuristic.ruleId} 未執行完整勾稽。`);
      nextActions.push('請補齊具明確單位、足夠信心且已人工確認的活動量與產量。');
      continue;
    }
    if (result.discrepancy) {
      discrepancies.push(result.discrepancy);
      if (Number.isInteger(result.discrepancy.leftCitation)) {
        summaryCitationIndexes.add(result.discrepancy.leftCitation);
      }
      if (Number.isInteger(result.discrepancy.rightCitation)) {
        summaryCitationIndexes.add(result.discrepancy.rightCitation);
      }
    }
  }
  for (const discrepancy of discrepancies) {
    addFinding(
      discrepancy.ruleId,
      discrepancy.severity,
      'Demo 比率超出固定 heuristic 範圍；此結果僅表示風險與待確認事項。'
    );
    openIssues.push(`${discrepancy.ruleId} 超出 Demo heuristic 範圍，需確認期間、單位與邊界。`);
    nextActions.push('由供應商與查驗人員核對相關原始表格及差異原因。');
  }

  const timestamp = snapshot.timestamp || snapshot.caseRecord.createdAt;
  const facts = [
    `已讀取 ${snapshot.evidence.length} 份合成 Demo 證據。`,
    `已產生 ${entries.length} 筆具來源頁與信心值的結構化抽取。`,
    `分析範圍為 ${snapshot.installationYear.reportingYear} 年度證據準備，不代表正式查驗。`,
  ];
  const reportCore = {
    caseId: snapshot.caseRecord.caseId,
    entries,
    findings,
    missingEvidence,
    discrepancies,
    citations,
    summary: {
      facts,
      openIssues: [...new Set(openIssues)],
      nextActions: [...new Set(nextActions)],
      citations: [...summaryCitationIndexes].sort((left, right) => left - right),
    },
    modelVersion: MODEL_VERSION,
    promptVersion: PROMPT_VERSION,
    timestamp,
    reviewStatus:
      findings.length || openIssues.length
        ? AGENT_REVIEW_STATUS.HUMAN_REVIEW_REQUIRED
        : AGENT_REVIEW_STATUS.READY_FOR_HUMAN_REVIEW,
    reviewedBy: null,
    reviewedAt: null,
  };
  const reportId = `risk_${crypto
    .createHash('sha256')
    .update(stableStringify(reportCore))
    .digest('hex')
    .slice(0, 20)}`;
  return { reportId, ...reportCore, demoOnly: true };
}

module.exports = {
  EvidenceAgentError,
  MAX_CITATIONS_PER_CASE,
  MAX_ENTRIES_PER_CASE,
  MAX_ENTRIES_PER_EVIDENCE,
  MODEL_VERSION,
  PROMPT_VERSION,
  analyzeEvidence,
};
