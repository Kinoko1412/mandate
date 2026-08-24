'use strict';

const { validateCanonical } = require('../packages/contracts/validator');
const { analyzeEvidence, EvidenceAgentError } = require('../services/agent');
const { analyzeEvidenceWithLlm } = require('../services/agent/analyzeLlm');
const { LlmExtractError } = require('../services/agent/llmExtract');
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
  buildCaseSnapshot,
  stableAgentError,
  validateReport,
};
