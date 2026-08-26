'use strict';

const { validateCanonical } = require('../packages/contracts/validator');
const { analyzeEvidence, EvidenceAgentError, containsInjection, normalizeEntry, SAFE_SOURCE_FILE } = require('../services/agent');
const { analyzeEvidenceWithLlm } = require('../services/agent/analyzeLlm');
const { classifyAndExtractWithLlm, LlmExtractError } = require('../services/agent/llmExtract');
const workflowStore = require('./workflowStore');
const supabaseSync = require('./supabaseSync');

class AgentAdapterError extends Error {
  constructor(code, message, details = null, retryable = false) {
    super(message);
    this.name = 'AgentAdapterError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

function buildCaseSnapshot(caseId) {
  const caseRecord = workflowStore.getCase(caseId);
  const installationYear = workflowStore.getInstallationYear(caseId);
  const caseContext = workflowStore.getCaseContext(caseId);
  const evidence = workflowStore.listEvidence(caseId);
  if (!caseRecord || !installationYear || !caseContext || !caseContext.policyProfile) {
    throw new AgentAdapterError(
      'AGENT_SNAPSHOT_UNAVAILABLE',
      '案件缺少 Evidence Agent 所需的內部快照。',
      { caseId }
    );
  }
  return {
    caseRecord,
    installationYear,
    policyProfile: caseContext.policyProfile,
    evidence,
    timestamp: caseRecord.createdAt,
  };
}

function validateReport(report) {
  const result = validateCanonical('RiskReport', report);
  if (!result.valid) {
    throw new AgentAdapterError(
      'AGENT_CONTRACT_INVALID',
      'Evidence Agent 回傳不符合 canonical RiskReport。',
      { entityName: 'RiskReport', errors: result.errors }
    );
  }
  return report;
}

function analyzeCase(caseId) {
  return validateReport(analyzeEvidence(buildCaseSnapshot(caseId)));
}

/**
 * 全面 LLM 版本（隊長 8/25 裁示：先測全面 LLM，規則引擎當備案）。任何失敗或不可用
 * （呼叫失敗／逾時／額度用完／回應格式錯誤／canonical 驗證不過）都視為失敗，整案自動退回
 * 規則引擎 analyzeCase()——不做部分成功的混合結果。回傳多一個 `usedFallback` 欄位讓呼叫端
 * 知道這次是不是真的用了 LLM，還是退回規則引擎；RiskReport 本體形狀跟 analyzeCase() 完全
 * 一樣，一律通過同一個 validateReport()（canonical RiskReport 驗證）。
 */
async function analyzeCaseWithLlm(caseId) {
  const snapshot = buildCaseSnapshot(caseId);
  try {
    const report = await analyzeEvidenceWithLlm(snapshot, {
      persistPromptResponse: (entry) => supabaseSync.syncEvidenceLlmPrompt(entry),
    });
    return { report: validateReport(report), usedFallback: false, fallbackReason: null };
  } catch (err) {
    const fallbackReason =
      err instanceof LlmExtractError || err instanceof EvidenceAgentError
        ? err.message
        : `LLM 分析發生未預期錯誤：${err && err.message ? err.message : String(err)}`;
    console.warn('[agentAdapter] LLM Evidence Agent 失敗，退回規則引擎：', fallbackReason);
    const report = analyzeCase(caseId);
    return { report, usedFallback: true, fallbackReason };
  }
}

/**
 * 單一檔案的即時抽取預覽（給上傳當下的聊天式介面用，2026-08-26 隊長裁示落地：拿掉「先選
 * 文件類型下拉選單」，改成 AI 直接從內容／使用者說明判斷是哪一種必要文件）——跟
 * analyzeCaseWithLlm 共用同一套 containsInjection + normalizeEntry 安全管線，但只處理一份
 * 「還沒送出」的文件：不讀 workflowStore、不寫入任何東西，純粹回傳候選欄位讓使用者確認後
 * 再走既有 createEvidence。
 *
 * 刻意不退回規則引擎（parseTextEntries）：那套只認得固定 `field=x;value=y;...` 格式，
 * 套在使用者真的貼上的自然語言內容上會靜默回傳空陣列——看起來像「AI 回覆了，但什麼都沒
 * 抓到」，比誠實回報「LLM 現在用不了，請改用手動輸入」更容易誤導人。失敗就是失敗。
 */
/**
 * 對話歷史（chatHistory）是使用者送來的，不能無條件信任——跟現在這一輪的 text／userNote
 * 一樣，每一則歷史訊息的 content 都要過同一道 containsInjection 白名單，角色也只能是
 * user／assistant。任何一則不合格就整批拒絕，不悄悄濾掉部分訊息（濾掉會讓對話脈絡跳段，
 * 使用者搞不懂 AI 是不是漏看了什麼；拒絕整批、請前端重新開始這輪，行為比較好預期）。
 */
function sanitizeChatHistory(chatHistory) {
  if (!Array.isArray(chatHistory) || !chatHistory.length) return [];
  const sanitized = [];
  for (const turn of chatHistory.slice(-12)) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) {
      throw new AgentAdapterError('INVALID_CHAT_HISTORY', '對話歷史格式不正確。', null);
    }
    const content = typeof turn.content === 'string' ? turn.content.trim().slice(0, 500) : '';
    if (!content) continue;
    if (containsInjection(content)) {
      throw new AgentAdapterError(
        'PROMPT_INJECTION_DETECTED',
        '對話歷史內容疑似含指令注入，已拒絕送入 Evidence Agent。',
        null
      );
    }
    sanitized.push({ role: turn.role, content });
  }
  return sanitized;
}

async function previewExtraction({ filename, mediaType, text, imageBase64, userNote, caseContext, chatHistory }) {
  if (!SAFE_SOURCE_FILE.test(filename)) {
    throw new AgentAdapterError('INVALID_FILENAME', 'filename 必須是 1–128 字元的安全檔名。', null);
  }
  if (typeof text === 'string' && containsInjection(text)) {
    throw new AgentAdapterError(
      'PROMPT_INJECTION_DETECTED',
      '文件內容疑似含指令注入，已拒絕送入 Evidence Agent。',
      null
    );
  }
  if (typeof userNote === 'string' && containsInjection(userNote)) {
    throw new AgentAdapterError(
      'PROMPT_INJECTION_DETECTED',
      '輸入的說明文字疑似含指令注入，已拒絕送入 Evidence Agent。',
      null
    );
  }
  const sanitizedHistory = sanitizeChatHistory(chatHistory);
  let documentType;
  let documentTypeConfidence;
  let rawEntries;
  let chatReply;
  let modelVersion;
  try {
    const result = await classifyAndExtractWithLlm({
      documentText: text,
      imageBase64,
      imageMediaType: imageBase64 ? mediaType : undefined,
      filename,
      userNote,
      caseContext,
      chatHistory: sanitizedHistory,
      persistPromptResponse: (entry) => supabaseSync.syncEvidenceLlmPrompt(entry),
    });
    documentType = result.documentType;
    documentTypeConfidence = result.documentTypeConfidence;
    rawEntries = result.rawEntries;
    chatReply = result.chatReply;
    modelVersion = result.modelVersion;
  } catch (err) {
    throw new AgentAdapterError(
      'AGENT_ANALYSIS_FAILED',
      err instanceof LlmExtractError ? err.message : 'Evidence Agent 預覽抽取暫時無法使用。',
      null,
      true
    );
  }
  const entries = [];
  let unsafeDropped = 0;
  if (documentType) {
    for (const raw of Array.isArray(rawEntries) ? rawEntries.slice(0, 12) : []) {
      const normalized = normalizeEntry(raw, { filename, type: documentType, humanConfirmed: false });
      if (normalized.entry) entries.push(normalized.entry);
      else unsafeDropped += 1;
    }
  }
  return { documentType, documentTypeConfidence, entries, chatReply, modelVersion, unsafeDropped };
}

function stableAgentError(error) {
  if (error instanceof AgentAdapterError || error instanceof EvidenceAgentError) {
    return {
      code: error.code,
      message: error.message,
      retryable: Boolean(error.retryable),
      details: error.details || null,
    };
  }
  return {
    code: 'AGENT_ANALYSIS_FAILED',
    message: 'Evidence Agent 暫時無法完成分析。',
    retryable: false,
    details: null,
  };
}

module.exports = {
  AgentAdapterError,
  analyzeCase,
  analyzeCaseWithLlm,
  previewExtraction,
  buildCaseSnapshot,
  stableAgentError,
  validateReport,
};
