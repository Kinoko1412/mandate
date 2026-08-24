'use strict';

const { validateCanonical } = require('../packages/contracts/validator');
const { analyzeEvidence, EvidenceAgentError } = require('../services/agent');
const workflowStore = require('./workflowStore');

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
  buildCaseSnapshot,
  stableAgentError,
  validateReport,
};
