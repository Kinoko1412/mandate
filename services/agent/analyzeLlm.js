'use strict';

/**
 * services/agent/analyzeLlm.js — 全面 LLM 版本的 Evidence Agent 分析管線。
 *
 * 跟 services/agent/index.js 的 analyzeEvidence()（規則引擎，`demo-rule-based-no-llm-v1`）
 * 結構幾乎一樣，唯一差別是「怎麼從文件文字抽出候選欄位」這一步換成呼叫 LLM
 * （services/agent/llmExtract.js），而不是正則表達式解析（parseTextEntries/parseJsonEntries）。
 *
 * 安全過濾／單位驗證／跨文件 heuristic／缺件偵測全部沿用 services/agent/index.js
 * 匯出的既有確定性函式，不重寫、不重複維護——這代表：
 *   - 「跨文件檢查搬到程式碼」這個前置工作事實上已經自動滿足：evaluateHeuristic() 本來
 *     就是純確定性程式碼，不是 LLM 做的，這裡直接沿用。
 *   - 「低信心值一律人工確認」也已經自動滿足：normalizeEntry() 的
 *     `eligibleForCalculation = confidence >= 0.8 && (!highImpact || humanConfirmed) && ...`
 *     邏輯完全沒變。
 *   - 「LLM 結果不能影響 Gate」也自動滿足：這個模組跟 analyzeEvidence() 一樣，只產生
 *     RiskReport，不呼叫、也不匯出任何 Gate／Policy 相關函式。
 *
 * 每份證據文件各自獨立呼叫一次 LLM（不共用歷史／context），任一份呼叫失敗就讓整個
 * analyzeEvidenceWithLlm() 拋出錯誤，由呼叫端（server/agentAdapter.js 的
 * analyzeCaseWithLlm）決定要不要整案退回規則引擎——這裡不做部分成功的混合結果，
 * 避免「一半文件是 LLM 抽的、一半是不存在的空結果」這種難以稽核的中間狀態。
 */

const crypto = require('crypto');
const {
  EvidenceAgentError,
  MAX_ENTRIES_PER_EVIDENCE,
  MAX_ENTRIES_PER_CASE,
  MAX_CITATIONS_PER_CASE,
  decodeEvidence,
  containsInjection,
  normalizeEntry,
  missingEvidenceFindings,
  evaluateHeuristic,
  DEMO_HEURISTICS,
  SAFE_SOURCE_FILE,
  SAFE_SOURCE_LABEL,
} = require('./index');
const { AGENT_REASON_CODE, AGENT_REVIEW_STATUS } = require('../../packages/contracts/enums');
const { extractEntriesWithLlm, PROMPT_VERSION: LLM_PROMPT_VERSION } = require('./llmExtract');

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 圖片證據直接讀圖交給 LLM（見 llmExtract.js 檔頭註解：實測 gpt-5-mini 支援 image_url，
 * 比原本的 OCR 中間層更準，也修掉 OCR 只能在 Node 跑、Workers 會壞掉的問題）；文字證據
 * 照舊 decode。回傳的形狀讓呼叫端決定要不要做「文字內容層級」的 injection 關鍵字掃描
 * （圖片沒有這個步驟——沒有解碼出來的文字可以掃，安全網落在下游 normalizeEntry() 那層，
 * 見本檔案開頭跟 llmExtract.js 的說明）。
 */
function decodeEvidenceForLlm(item) {
  if (item.mediaType && IMAGE_MEDIA_TYPES.has(item.mediaType)) {
    if (typeof item.contentBase64 !== 'string' || !item.contentBase64) {
      throw new EvidenceAgentError('EVIDENCE_CONTENT_UNAVAILABLE', 'Evidence Agent 無法讀取這份 Demo 證據。', {
        evidenceId: item.evidenceId,
      });
    }
    return { mode: 'image', imageBase64: item.contentBase64, imageMediaType: item.mediaType };
  }
  return { mode: 'text', text: decodeEvidence(item) };
}

/**
 * @param {object} snapshot - 跟 analyzeEvidence() 同一種 snapshot 形狀
 * @param {object} [options]
 * @param {Function} [options.persistPromptResponse] - 見 llmExtract.js
 * @returns {Promise<object>} RiskReport（跟 analyzeEvidence() 回傳同一種形狀）
 */
async function analyzeEvidenceWithLlm(snapshot, options = {}) {
  if (
    !snapshot ||
    !snapshot.caseRecord ||
    !snapshot.installationYear ||
    !snapshot.policyProfile ||
    !Array.isArray(snapshot.evidence)
  ) {
    throw new EvidenceAgentError('AGENT_SNAPSHOT_INVALID', 'Evidence Agent 案件快照不完整。');
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
  let modelVersion = 'llm-evidence-agent-v1:unconfigured';

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
    const decoded = decodeEvidenceForLlm(item);
    const safeSourceFile =
      typeof item.filename === 'string' && SAFE_SOURCE_FILE.test(item.filename) ? item.filename : item.evidenceId;

    // 跟規則引擎同一道防線：文字證據的 injection 關鍵字檢查一律在 LLM 呼叫**之前**執行，
    // 命中就整份丟棄，連內容都不會被送進 LLM prompt。圖片證據沒有解碼出來的文字可以掃
    // （直接讀圖，不再先 OCR），這一格改成 skip；已用合成測試圖驗證過圖片版的 injection
    // 抵抗力（模型本身會拒絕被圖片裡的指令文字誘導），且下游 normalizeEntry() 的白名單
    // 過濾對兩種模式一視同仁，是不受輸入模態影響的第二道防線。
    const contentInjectionHit = decoded.mode === 'text' && containsInjection(decoded.text);
    if (contentInjectionHit || containsInjection(item.filename) || containsInjection(item.source)) {
      addFinding(
        AGENT_REASON_CODE.PROMPT_INJECTION_DETECTED,
        'high',
        '文件含疑似指令注入內容；整份抽取資料已丟棄並等待人工安全檢視。'
      );
      addCitation({ reasonCode: AGENT_REASON_CODE.PROMPT_INJECTION_DETECTED, sourceFile: item.evidenceId, sourcePage: 1 }, true);
      openIssues.push('偵測到文件指令注入風險，尚待人工安全檢視。');
      nextActions.push('由授權人員檢視該證據來源；不要執行文件內的任何操作指令。');
      continue;
    }
    if (
      typeof item.filename !== 'string' ||
      !SAFE_SOURCE_FILE.test(item.filename) ||
      (typeof item.source === 'string' && !SAFE_SOURCE_LABEL.test(item.source))
    ) {
      addFinding(AGENT_REASON_CODE.UNSAFE_DOCUMENT_TEXT, 'warning', '文件含不符合字元或長度白名單的中繼資料；整份抽取資料已丟棄。');
      addCitation({ reasonCode: AGENT_REASON_CODE.UNSAFE_DOCUMENT_TEXT, sourceFile: item.evidenceId, sourcePage: 1 }, true);
      openIssues.push('一份文件的可控字串未通過安全白名單。');
      nextActions.push('請以允許的 ASCII 檔名與受控欄位重新上傳 Demo 證據。');
      continue;
    }

    // 每份文件各自獨立呼叫，不共用 context——這是隊長明確裁示的資料最小化設計。
    const { rawEntries, modelVersion: usedModelVersion } = await extractEntriesWithLlm({
      documentText: decoded.mode === 'text' ? decoded.text : undefined,
      imageBase64: decoded.mode === 'image' ? decoded.imageBase64 : undefined,
      imageMediaType: decoded.mode === 'image' ? decoded.imageMediaType : undefined,
      filename: safeSourceFile,
      evidenceType: item.type,
      persistPromptResponse: options.persistPromptResponse,
    });
    modelVersion = usedModelVersion;

    const parsed = Array.isArray(rawEntries) ? rawEntries : [];
    if (parsed.length > MAX_ENTRIES_PER_EVIDENCE) truncated = true;
    for (const raw of parsed.slice(0, MAX_ENTRIES_PER_EVIDENCE)) {
      if (entries.length >= MAX_ENTRIES_PER_CASE) {
        truncated = true;
        break;
      }
      // 沿用既有 normalizeEntry()——LLM 抽出來的東西一樣要通過同一套白名單，
      // 不因為換了抽取方式就少一道安全檢查。
      const normalized = normalizeEntry(raw, { ...item, filename: safeSourceFile });
      if (!normalized.entry) {
        if (normalized.unsafeText) {
          addFinding(
            AGENT_REASON_CODE.UNSAFE_DOCUMENT_TEXT,
            'warning',
            '一筆 LLM 抽取資料未通過字元或長度白名單，已丟棄且不回顯原文。'
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
        addFinding(AGENT_REASON_CODE.UNIT_AMBIGUOUS, 'warning', `欄位 ${entry.field} 的單位不在 Demo 允許清單，未納入計算。`);
        if (citationIndex !== null) summaryCitationIndexes.add(citationIndex);
        openIssues.push(`欄位 ${entry.field} 的單位需人工確認。`);
        nextActions.push(`請核對 ${entry.sourceFile} 第 ${entry.sourcePage} 頁；候選單位：${entry.candidateUnits.join(', ') || '尚未定義'}。`);
      }
      if (!entry.eligibleForCalculation) {
        const reason =
          entry.confidence < 0.8
            ? `LLM 抽取欄位 ${entry.field} 信心不足，未納入計算。`
            : normalized.unitAmbiguous
              ? `LLM 抽取欄位 ${entry.field} 單位不明，未納入計算。`
              : `數值欄位 ${entry.field} 尚未人工確認，未納入計算（LLM 版本一律要求人工確認高影響數值）。`;
        openIssues.push(reason);
        nextActions.push(`請人工核對 ${entry.sourceFile} 第 ${entry.sourcePage} 頁的 ${entry.field}。`);
      }
    }
  }

  for (const item of snapshot.evidence) {
    if (typeof item.coveredFrom !== 'string' || typeof item.coveredTo !== 'string' || item.coveredFrom > item.coveredTo) {
      addFinding(AGENT_REASON_CODE.INVALID_EVIDENCE_PERIOD, 'warning', '證據期間格式或先後順序無效；該期間不視為有效年度涵蓋。');
      openIssues.push('一份證據的涵蓋期間無效，需重新確認。');
      nextActions.push('請以 YYYY-MM-DD 格式修正 coveredFrom/coveredTo，且起日不得晚於迄日。');
    }
  }

  if (truncated) {
    addFinding(AGENT_REASON_CODE.EXTRACTION_TRUNCATED, 'warning', '抽取結果超過 Demo 安全上限，已截斷；未處理部分不得用於計算。');
    openIssues.push('抽取結果因安全上限被截斷。');
    nextActions.push('請拆分文件或縮小每次分析範圍後重新執行。');
  }

  const missingEvidence = missingEvidenceFindings(snapshot);
  for (const item of missingEvidence) {
    addFinding(
      item.coveredPeriod ? AGENT_REASON_CODE.EVIDENCE_PERIOD_INCOMPLETE : AGENT_REASON_CODE.EVIDENCE_MISSING,
      'warning',
      `${item.requiredEvidence} 的必要證據或期間尚未完整。`
    );
    openIssues.push(`${item.requiredEvidence} 尚有缺件或缺少期間。`);
    nextActions.push(item.requestedAction);
  }

  // 跨文件 heuristic：跟規則引擎完全同一套確定性程式碼（evaluateHeuristic），
  // 這正是「跨文件檢查搬到程式碼、不靠單一 LLM 呼叫同時看到全部文件」這件事的實作。
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
      if (Number.isInteger(result.discrepancy.leftCitation)) summaryCitationIndexes.add(result.discrepancy.leftCitation);
      if (Number.isInteger(result.discrepancy.rightCitation)) summaryCitationIndexes.add(result.discrepancy.rightCitation);
    }
  }
  for (const discrepancy of discrepancies) {
    addFinding(discrepancy.ruleId, discrepancy.severity, 'Demo 比率超出固定 heuristic 範圍；此結果僅表示風險與待確認事項。');
    openIssues.push(`${discrepancy.ruleId} 超出 Demo heuristic 範圍，需確認期間、單位與邊界。`);
    nextActions.push('由供應商與查驗人員核對相關原始表格及差異原因。');
  }

  const timestamp = snapshot.timestamp || snapshot.caseRecord.createdAt;
  const facts = [
    `已用 LLM（${modelVersion}）讀取 ${snapshot.evidence.length} 份合成 Demo 證據，每份文件各自獨立分析。`,
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
    modelVersion,
    promptVersion: LLM_PROMPT_VERSION,
    timestamp,
    reviewStatus: findings.length || openIssues.length ? AGENT_REVIEW_STATUS.HUMAN_REVIEW_REQUIRED : AGENT_REVIEW_STATUS.READY_FOR_HUMAN_REVIEW,
    reviewedBy: null,
    reviewedAt: null,
  };
  const reportId = `risk_${crypto.createHash('sha256').update(stableStringify(reportCore)).digest('hex').slice(0, 20)}`;
  return { reportId, ...reportCore, demoOnly: true };
}

module.exports = { analyzeEvidenceWithLlm };
