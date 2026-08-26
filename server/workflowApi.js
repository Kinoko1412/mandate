'use strict';

const workflowStore = require('./workflowStore');
const {
  WorkflowAdapterError,
  buildCaseCarbon,
  stableError,
} = require('./carbonAdapter');
const trustAdapter = require('./trustAdapter');
const agentAdapter = require('./agentAdapter');
const vaultKeys = require('./vaultKeys');
const { ROLES: DPP_ROLES, buildLayeredDisclosure } = require('../services/dpp');

const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_EVIDENCE_PER_CASE = 16;
const MAX_GRANT_MS = 5 * 60 * 1000;
const ALLOWED_MEDIA_TYPES = new Set([
  'application/pdf',
  'application/json',
  'text/plain',
  'image/png',
  'image/jpeg',
]);
const REQUIRED_EVIDENCE_TYPES = new Set([
  'electricity_bill',
  'fuel_ledger',
  'production_report',
  'precursor_list',
]);
// 即時預覽抽取只支援「真的能直接讀」的格式：圖片走 gpt-5-mini 的 image_url 直接讀圖，
// 文字/JSON 走純文字 prompt。application/pdf 目前在這個 demo 裡其實是貼了標籤的純文字
// 內容，不是真的二進位 PDF 解析——刻意不讓 preview 端點假裝支援，寧可明確拒絕、請使用者
// 改貼文字或改傳截圖，也不要看起來「有在讀 PDF」其實沒有。
const PREVIEW_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'text/plain', 'application/json']);

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function ok(status, body) {
  return { status, body };
}

function fail(status, code, message, details = null, retryable = false) {
  return {
    status,
    body: { code, message, retryable, details },
  };
}

function safeAdapterFailure(error) {
  const stable = stableError(error);
  const status =
    stable.code === 'UNKNOWN_UNIT' ||
    stable.code === 'ALLOCATION_EXCEEDS_PRODUCTION' ||
    stable.code === 'INTENSITY_MISMATCH' ||
    stable.code === 'CONTRACT_VALIDATION_FAILED'
      ? 422
      : 400;
  return fail(status, stable.code, stable.message, stable.details, stable.retryable);
}

function resolveActor(context = {}) {
  const requested = String(context.demoRole || '').trim().toLowerCase();
  const role = Object.keys(workflowStore.DEMO_ACTORS).find(
    (candidate) => candidate.toLowerCase() === requested
  );
  return role ? workflowStore.DEMO_ACTORS[role] : null;
}

function requireActor(context) {
  const actor = resolveActor(context);
  if (!actor) {
    return {
      error: fail(
        401,
        'DEMO_ROLE_REQUIRED',
        '請使用 x-demo-role header 或 demoRole query 選擇 Supplier、Importer 或 Verifier。',
        { demoOnly: true }
      ),
    };
  }
  return { actor };
}

function hasCaseScope(actor, caseRecord) {
  if (!actor || !caseRecord) return false;
  if (actor.role === 'Supplier') return actor.orgId === caseRecord.supplierOrgId;
  if (actor.role === 'Importer') return actor.orgId === caseRecord.importerOrgId;
  return actor.role === 'Verifier' && caseRecord.caseId === workflowStore.DEMO_CASE_ID;
}

function requireCase(actor, caseId, role) {
  const caseRecord = workflowStore.getCase(caseId);
  if (!caseRecord || !hasCaseScope(actor, caseRecord)) {
    return {
      error: fail(404, 'CASE_NOT_FOUND', '找不到可存取的案件。'),
    };
  }
  if (role && actor.role !== role) {
    return {
      error: fail(403, 'ROLE_FORBIDDEN', '目前角色無權執行此案件動作。'),
    };
  }
  return { caseRecord };
}

function evidenceMetadata(item, includeVerifierFields = false) {
  const result = {
    evidenceId: item.evidenceId,
    caseId: item.caseId,
    type: item.type,
    fileHash: item.fileHash,
    coveredFrom: item.coveredFrom,
    coveredTo: item.coveredTo,
    source: item.source,
    version: item.version,
    humanConfirmed: item.humanConfirmed,
    mediaType: item.mediaType,
    sizeBytes: item.sizeBytes,
    vaultEncrypted: !!item.vaultEncrypted,
  };
  if (includeVerifierFields) {
    result.filename = item.filename;
  }
  return result;
}

function supplierEvidence(item) {
  return {
    ...evidenceMetadata(item, true),
    vaultRef: item.vaultRef,
  };
}

function importerEvidence(item) {
  return {
    evidenceId: item.evidenceId,
    type: item.type,
    fileHash: item.fileHash,
    coveredFrom: item.coveredFrom,
    coveredTo: item.coveredTo,
    source: item.source,
    version: item.version,
    humanConfirmed: item.humanConfirmed,
  };
}

function trustServicesVerified() {
  const services = workflowStore.getServices();
  return ['proof', 'gate'].every(
    (name) => {
      const service = services[name];
      return service &&
        service.status === 'available' &&
        service.verification === 'verified';
    }
  );
}

function evidenceReadiness(caseId) {
  const evidence = workflowStore.listEvidence(caseId);
  const received = new Set(evidence.map((item) => item.type));
  return {
    missing: [...REQUIRED_EVIDENCE_TYPES].filter((type) => !received.has(type)),
    unconfirmed: evidence
      .filter((item) => !item.humanConfirmed)
      .map((item) => item.evidenceId),
  };
}

// 缺件類 reason code 對應規格 p.13 Final Mapping 的「缺件→NEEDS_EVIDENCE」，
// 跟授權／Proof／係數這類「硬失敗→BLOCKED」不同層次。
const EVIDENCE_REASON_CODES = new Set(['EVIDENCE_MISSING', 'EVIDENCE_PERIOD_INCOMPLETE']);

function calculateReadiness(caseId) {
  const evidence = evidenceReadiness(caseId);
  const services = workflowStore.getServices();
  const failed = ['proof', 'gate']
    .map((name) => services[name])
    .filter((service) => service.status === 'error' || service.verification === 'failed');
  if (failed.length) {
    const reasonCodes = [
      ...new Set(failed.flatMap((service) => service.reasonCodes || [])),
    ];
    if (reasonCodes.length && reasonCodes.every((code) => EVIDENCE_REASON_CODES.has(code))) {
      return {
        status: 'NEEDS_EVIDENCE',
        readiness: 'not_verified',
        reasonCodes,
        message: '證據缺件或涵蓋期間不完整，案件回到 NEEDS_EVIDENCE；補齊後可重驗。',
        services,
      };
    }
    return {
      status: 'BLOCKED',
      readiness: 'failed',
      reasonCodes: reasonCodes.length ? reasonCodes : ['TRUST_SERVICE_FAILED'],
      message: 'Proof 或 Gate 驗證失敗，案件維持 BLOCKED；請依 reason code 修正後重驗。',
      services,
    };
  }
  if (evidence.missing.length || evidence.unconfirmed.length) {
    return {
      status: 'NEEDS_EVIDENCE',
      readiness: 'not_verified',
      reasonCodes: ['EVIDENCE_MISSING'],
      message: '案件仍有缺件或尚未人工確認的證據。',
      services,
    };
  }
  if (trustServicesVerified()) {
    return {
      status: 'READY_FOR_VERIFIER',
      readiness: 'verified',
      reasonCodes: [],
      message: workflowStore.READY_DISCLAIMER,
      services,
    };
  }
  return {
    status: 'METHOD_REVIEW',
    readiness: 'not_verified',
    reasonCodes: ['SERVICE_UNAVAILABLE'],
    message: 'Proof 或 Gate 尚未驗證，因此案件維持 METHOD_REVIEW。',
    services,
  };
}

function applyReadiness(caseId, options = {}) {
  const readiness = calculateReadiness(caseId);
  const caseRecord = workflowStore.setCaseWorkflow(caseId, {
    status: readiness.status,
    readiness: readiness.readiness,
    ...(options.markSubmitted ? { submittedAt: workflowStore.nowIso() } : {}),
  });
  return { caseRecord, readiness };
}

function outwardStatus(status) {
  return status === 'READY_FOR_VERIFIER' && !trustServicesVerified()
    ? 'METHOD_REVIEW'
    : status;
}

function outwardShipments(shipments) {
  return shipments.map((shipment) => ({
    ...shipment,
    allocationStatus: outwardStatus(shipment.allocationStatus),
  }));
}

function importerAnnualSummary(annual) {
  return {
    emissions: annual.emissions,
    emissionsUnit: annual.emissionsUnit,
    intensity: annual.intensity,
    intensityUnit: annual.intensityUnit,
  };
}

function verifierAnnualSummary(annual) {
  const summary = importerAnnualSummary(annual);
  if (annual.calculationReceipt) {
    summary.calculationReceipt = {
      inputHash: annual.calculationReceipt.inputHash,
      methodVersion: annual.calculationReceipt.metadata.methodVersion,
    };
  }
  return summary;
}

function agentSafeSummary(report) {
  if (!report) return null;
  const reasonCodes = [...new Set(report.findings.map((finding) => finding.reasonCode))];
  return {
    reportId: report.reportId,
    modelVersion: report.modelVersion,
    timestamp: report.timestamp,
    reviewStatus: report.reviewStatus,
    counts: {
      findings: report.findings.length,
      missingEvidence: report.missingEvidence.length,
      discrepancies: report.discrepancies.length,
      openIssues: report.summary.openIssues.length,
    },
    reasonCodes,
    nextActions: reasonCodes.length
      ? ['請由供應商與查驗員依風險代碼完成確認或補件。']
      : ['可交由查驗員進行後續專業檢視。'],
  };
}

function maskCase(caseRecord, actor, detail = false) {
  const carbon = workflowStore.getCarbon(caseRecord.caseId);
  const evidence = workflowStore.listEvidence(caseRecord.caseId);
  const riskReport = workflowStore.getRiskReport(caseRecord.caseId);
  const base = {
    caseId: caseRecord.caseId,
    title: caseRecord.title,
    cnCode: caseRecord.cnCode,
    status: outwardStatus(caseRecord.status),
    createdAt: caseRecord.createdAt,
    policyProfileId: caseRecord.policyProfileId,
    readiness: caseRecord.readiness,
    readyDisclaimer: caseRecord.readyDisclaimer,
    demoOnly: true,
  };
  if (!detail) {
    return {
      ...base,
      evidenceCount: evidence.length,
      reportingYear: carbon.installationYear.reportingYear,
    };
  }
  if (actor.role === 'Supplier') {
    return {
      ...base,
      supplierOrgId: caseRecord.supplierOrgId,
      installationYear: workflowStore.getInstallationYear(caseRecord.caseId),
      carbon: {
        ...carbon,
        shipments: outwardShipments(carbon.shipments),
      },
      evidence: evidence.map(supplierEvidence),
      riskReport,
      riskReportDisclosure: riskReport
        ? {
            kind: 'DERIVED_ANALYSIS',
            vaultOriginal: false,
            readAuditSideEffect: false,
          }
        : null,
      services: workflowStore.getServices(),
    };
  }
  if (actor.role === 'Importer') {
    return {
      ...base,
      importerOrgId: caseRecord.importerOrgId,
      annualSummary: importerAnnualSummary(carbon.annual),
      shipments: outwardShipments(carbon.shipments),
      evidenceCompleteness: {
        required: [...REQUIRED_EVIDENCE_TYPES],
        received: [...new Set(evidence.map((item) => item.type))],
        confirmedCount: evidence.filter((item) => item.humanConfirmed).length,
      },
      evidence: evidence.map(importerEvidence),
      agentSummary: agentSafeSummary(riskReport),
      services: workflowStore.getServices(),
    };
  }
  return {
    ...base,
    installationYear: workflowStore.getInstallationYear(caseRecord.caseId),
    annualSummary: verifierAnnualSummary(carbon.annual),
    shipments: outwardShipments(carbon.shipments),
    evidenceIndex: evidence.map((item) => evidenceMetadata(item, true)),
    findings: workflowStore.listFindings(caseRecord.caseId),
    riskReport,
    riskReportDisclosure: riskReport
      ? {
          kind: 'DERIVED_ANALYSIS',
          vaultOriginal: false,
          readAuditSideEffect: false,
        }
      : null,
    services: workflowStore.getServices(),
  };
}

function decodeBase64(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new WorkflowAdapterError(
      'INVALID_BASE64',
      'contentBase64 必須是有效且非空的 Base64。',
      null
    );
  }
  const estimatedBytes = Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (estimatedBytes > MAX_EVIDENCE_BYTES) {
    throw new WorkflowAdapterError(
      'EVIDENCE_TOO_LARGE',
      `文件不得超過 ${MAX_EVIDENCE_BYTES} bytes。`,
      { maxBytes: MAX_EVIDENCE_BYTES }
    );
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new WorkflowAdapterError('INVALID_BASE64', 'contentBase64 無法解碼。', null);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getWebCrypto() {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || !webCrypto.subtle || !webCrypto.getRandomValues) {
    throw new WorkflowAdapterError(
      'CRYPTO_UNAVAILABLE',
      '安全雜湊服務目前不可用。',
      null,
      true
    );
  }
  return webCrypto;
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes) {
  const digest = await getWebCrypto().subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

async function sha256Text(text) {
  return sha256Bytes(new TextEncoder().encode(text));
}

function randomToken() {
  const bytes = new Uint8Array(24);
  getWebCrypto().getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function audit(actor, action, targetType, targetId, result, reasonCode, caseId, metadata = {}) {
  return workflowStore.appendAudit({
    actorId: actor.actorId,
    role: actor.role,
    action,
    targetType,
    targetId,
    result,
    reasonCode,
    caseId,
    ...metadata,
  });
}

/**
 * 2026-08-26 隊長裁示落地：預設走全面 LLM（`agentAdapter.analyzeCaseWithLlm`），LLM 呼叫
 * 失敗／逾時／額度用完／格式錯誤都在 adapter 內部自動退回規則引擎，這裡完全不用另外處理
 * fallback 邏輯——但要把 `usedFallback`/`fallbackReason` 老實記進 audit 跟回應本體，讓
 * 「這次到底是不是真的用了 LLM」在稽核紀錄跟畫面上都看得到，不是悄悄降級沒人知道。
 */
async function analyzeCase(actor, caseId) {
  const scope = requireCase(actor, caseId, 'Supplier');
  if (scope.error) return scope.error;
  try {
    const { report, usedFallback, fallbackReason } = await agentAdapter.analyzeCaseWithLlm(caseId);
    workflowStore.setRiskReport(caseId, report);
    const reasonCodes = [...new Set(report.findings.map((finding) => finding.reasonCode))];
    workflowStore.setServiceStatus('agent', {
      status: 'available',
      verification: 'not_verified',
      execution: 'executed',
      checks: [{ name: 'analysis_executed', status: 'pass' }],
      reasonCodes,
    });
    audit(
      actor,
      'EVIDENCE_AGENT_ANALYZE',
      'risk_report',
      report.reportId,
      'ALLOW',
      reasonCodes[0] || null,
      caseId,
      {
        reportId: report.reportId,
        modelVersion: report.modelVersion,
        counts: {
          entries: report.entries.length,
          findings: report.findings.length,
          missingEvidence: report.missingEvidence.length,
          discrepancies: report.discrepancies.length,
        },
        reasonCodes,
        usedFallback,
        ...(usedFallback ? { fallbackReason } : {}),
      }
    );
    return ok(200, {
      report,
      usedFallback,
      fallbackReason,
      service: workflowStore.getServices().agent,
      caseStatusUnchanged: scope.caseRecord.status,
      demoOnly: true,
    });
  } catch (error) {
    const stable = agentAdapter.stableAgentError(error);
    workflowStore.setServiceStatus('agent', {
      status: 'error',
      verification: 'failed',
      execution: 'failed',
      checks: [{ name: 'analysis_executed', status: 'fail' }],
      reasonCodes: [stable.code],
    });
    audit(
      actor,
      'EVIDENCE_AGENT_ANALYZE',
      'risk_report',
      null,
      'ERROR',
      stable.code,
      caseId,
      {
        counts: { entries: 0, findings: 0, missingEvidence: 0, discrepancies: 0 },
        reasonCodes: [stable.code],
      }
    );
    return fail(422, stable.code, stable.message, stable.details, stable.retryable);
  }
}

function validateEvidenceInput(body) {
  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  if (
    !filename ||
    filename.length > 128 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename === '.' ||
    filename === '..'
  ) {
    throw new WorkflowAdapterError(
      'INVALID_FILENAME',
      'filename 必須是 1–128 字元且不可包含路徑。',
      null
    );
  }
  if (!ALLOWED_MEDIA_TYPES.has(body.mediaType)) {
    throw new WorkflowAdapterError(
      'MEDIA_TYPE_NOT_ALLOWED',
      '此文件類型不在允許清單。',
      { allowedMediaTypes: [...ALLOWED_MEDIA_TYPES] }
    );
  }
  const metadata = body.metadata;
  if (!metadata || !REQUIRED_EVIDENCE_TYPES.has(metadata.type)) {
    throw new WorkflowAdapterError(
      'INVALID_EVIDENCE_METADATA',
      'metadata.type 必須是固定 Demo 證據類型。',
      { allowedTypes: [...REQUIRED_EVIDENCE_TYPES] }
    );
  }
  for (const field of ['coveredFrom', 'coveredTo', 'source']) {
    if (typeof metadata[field] !== 'string' || !metadata[field].trim()) {
      throw new WorkflowAdapterError(
        'INVALID_EVIDENCE_METADATA',
        `metadata.${field} 為必填字串。`,
        { field }
      );
    }
  }
  if (
    !isIsoDate(metadata.coveredFrom) ||
    !isIsoDate(metadata.coveredTo) ||
    metadata.coveredFrom > metadata.coveredTo
  ) {
    throw new WorkflowAdapterError(
      'INVALID_EVIDENCE_PERIOD',
      'coveredFrom/coveredTo 必須是有效 ISO date，且起日不得晚於迄日。',
      null
    );
  }
  return { filename, metadata };
}

/**
 * 上傳內容的 Vault 加密欄位是選填的——沒帶就是舊有明碼行為（Verifier 還沒註冊 Vault 裝置
 * 時，瀏覽器端會刻意不加密，直接送明碼），完全不影響既有測試/既有行為。帶了 vaultEncrypted:
 * true 就必須把另外三個欄位一起帶齊，不能只帶一半——半殘的加密紀錄比完全不加密更危險
 * （看起來像加密過、其實解不開或解出垃圾）。
 */
function validateVaultEncryptionFields(body) {
  if (body.vaultEncrypted !== true) {
    return { vaultEncrypted: false };
  }
  const ivOk = typeof body.vaultIvBase64 === 'string' && body.vaultIvBase64.trim();
  const ephemeralOk =
    body.vaultEphemeralPublicKeyJwk &&
    typeof body.vaultEphemeralPublicKeyJwk === 'object' &&
    !Array.isArray(body.vaultEphemeralPublicKeyJwk);
  const keyIdOk = typeof body.vaultKeyId === 'string' && body.vaultKeyId.trim();
  if (!ivOk || !ephemeralOk || !keyIdOk) {
    throw new WorkflowAdapterError(
      'INVALID_VAULT_ENCRYPTION_PAYLOAD',
      'vaultEncrypted 為 true 時，vaultIvBase64／vaultEphemeralPublicKeyJwk／vaultKeyId 都是必填。',
      null
    );
  }
  return {
    vaultEncrypted: true,
    vaultIvBase64: body.vaultIvBase64,
    vaultEphemeralPublicKeyJwk: body.vaultEphemeralPublicKeyJwk,
    vaultKeyId: body.vaultKeyId,
  };
}

async function createEvidence(actor, body) {
  const scope = requireCase(actor, body.caseId, 'Supplier');
  if (scope.error) return scope.error;
  try {
    const { filename, metadata } = validateEvidenceInput(body);
    if (workflowStore.listEvidence(body.caseId).length >= MAX_EVIDENCE_PER_CASE) {
      return fail(
        409,
        'CASE_EVIDENCE_LIMIT_REACHED',
        '此案件已達 Demo 證據份數上限。',
        { maxEvidencePerCase: MAX_EVIDENCE_PER_CASE }
      );
    }
    const duplicate = workflowStore
      .listEvidence(body.caseId)
      .find((item) => item.filename.toLowerCase() === filename.toLowerCase());
    if (duplicate) {
      return fail(
        409,
        'EVIDENCE_ALREADY_EXISTS',
        '同名文件已存在；Demo Vault 不會靜默覆寫。',
        { existingEvidenceId: duplicate.evidenceId }
      );
    }
    const bytes = decodeBase64(body.contentBase64);
    const hash = `sha256:${await sha256Bytes(bytes)}`;
    const vaultEncryption = validateVaultEncryptionFields(body);
    const evidence = workflowStore.addEvidence({
      caseId: body.caseId,
      type: metadata.type,
      fileHash: hash,
      coveredFrom: metadata.coveredFrom,
      coveredTo: metadata.coveredTo,
      source: metadata.source,
      humanConfirmed: false,
      vaultRef: `vault-demo://${body.caseId}/${hash.slice(7, 23)}`,
      filename,
      mediaType: body.mediaType,
      sizeBytes: bytes.byteLength,
      contentBase64: body.contentBase64,
      ...vaultEncryption,
      demoOnly: true,
    });
    audit(actor, 'EVIDENCE_UPLOAD', 'evidence', evidence.evidenceId, 'ALLOW', null, body.caseId);
    return ok(201, { evidence: supplierEvidence(evidence) });
  } catch (error) {
    return safeAdapterFailure(error);
  }
}

// 跟 public/js/case-workflow.js 的 REQUIRED_TYPE_LABELS 保持同一份對照——chatReply 要講
// 「電費單」而不是回顯英文代碼 electricity_bill，使用者才看得懂。
const REQUIRED_TYPE_LABELS_ZH = {
  electricity_bill: '電費單',
  fuel_ledger: '燃料紀錄',
  production_report: '產量表',
  precursor_list: '前驅物清單',
};

/**
 * 給聊天框「情境 B：這不是文件，是在問問題」用的真實案件現況——只取 workflowStore 裡已經有
 * 的資料組成一份摘要交給 LLM 當作 grounding，LLM 不會、也不需要自己編。抓不到案件或案件還
 * 沒有任何分析紀錄都不算錯，就回傳「還缺全部」「沒有分析紀錄」的誠實現況。
 */
function buildChatCaseContext(caseId) {
  const evidence = workflowStore.listEvidence(caseId) || [];
  const presentTypes = [...new Set(evidence.map((item) => item.type))].filter((type) =>
    REQUIRED_EVIDENCE_TYPES.has(type)
  );
  const missingTypes = [...REQUIRED_EVIDENCE_TYPES].filter((type) => !presentTypes.includes(type));
  const toLabel = (type) => REQUIRED_TYPE_LABELS_ZH[type] || type;
  const riskReport = workflowStore.getRiskReport(caseId);
  return {
    requiredLabels: [...REQUIRED_EVIDENCE_TYPES].map(toLabel),
    presentLabels: presentTypes.map(toLabel),
    missingLabels: missingTypes.map(toLabel),
    openIssues: riskReport && riskReport.summary ? riskReport.summary.openIssues : [],
  };
}

/**
 * 上傳當下的即時抽取預覽（聊天式介面用，2026-08-26 隊長裁示落地）——只回傳候選欄位給前端
 * 顯示成「AI 回覆」讓使用者確認，不寫入 workflowStore、不建立 evidence 紀錄。使用者確認
 * 後前端另外呼叫既有 createEvidence 才是真的送出；這裡單純是「先看一眼 AI 讀到什麼」。
 */
async function previewEvidence(actor, body) {
  const scope = requireCase(actor, body.caseId, 'Supplier');
  if (scope.error) return scope.error;
  try {
    const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
    if (!filename || filename.length > 128 || filename.includes('/') || filename.includes('\\')) {
      throw new WorkflowAdapterError('INVALID_FILENAME', 'filename 必須是 1–128 字元且不可包含路徑。', null);
    }
    const userNote = typeof body.userNote === 'string' ? body.userNote.trim().slice(0, 300) : '';
    if (!PREVIEW_MEDIA_TYPES.has(body.mediaType)) {
      throw new WorkflowAdapterError(
        'MEDIA_TYPE_NOT_SUPPORTED_FOR_PREVIEW',
        '即時預覽只支援 PNG/JPEG 圖片或純文字／JSON 內容；PDF 請改貼文字內容或改用截圖上傳。',
        { supportedMediaTypes: [...PREVIEW_MEDIA_TYPES] }
      );
    }
    const bytes = decodeBase64(body.contentBase64);
    const isImage = body.mediaType.startsWith('image/');
    const text = isImage ? undefined : new TextDecoder().decode(bytes);
    const caseContext = buildChatCaseContext(body.caseId);
    const { documentType, documentTypeConfidence, entries, chatReply, modelVersion, unsafeDropped } = await agentAdapter.previewExtraction({
      filename,
      mediaType: body.mediaType,
      text,
      imageBase64: isImage ? body.contentBase64 : undefined,
      userNote: userNote || undefined,
      caseContext,
      chatHistory: Array.isArray(body.chatHistory) ? body.chatHistory : undefined,
    });
    audit(actor, 'EVIDENCE_PREVIEW_EXTRACT', 'evidence', filename, 'ALLOW', null, body.caseId, {
      modelVersion,
      documentType,
      entryCount: entries.length,
      isChatReply: Boolean(chatReply),
    });
    return ok(200, { documentType, documentTypeConfidence, entries, chatReply, modelVersion, unsafeDropped, demoOnly: true });
  } catch (error) {
    if (error instanceof agentAdapter.AgentAdapterError) {
      const stable = agentAdapter.stableAgentError(error);
      audit(actor, 'EVIDENCE_PREVIEW_EXTRACT', 'evidence', body.filename || null, 'ERROR', stable.code, body.caseId);
      return fail(422, stable.code, stable.message, stable.details, stable.retryable);
    }
    return safeAdapterFailure(error);
  }
}

function confirmEvidence(actor, evidenceId, body) {
  const item = workflowStore.getEvidence(evidenceId);
  const caseId = item ? item.caseId : body.caseId;
  const scope = requireCase(actor, caseId, 'Supplier');
  if (scope.error || !item) return fail(404, 'EVIDENCE_NOT_FOUND', '找不到可確認的證據。');
  if (body.confirmed !== true) {
    return fail(400, 'HUMAN_CONFIRMATION_REQUIRED', 'confirmed 必須明確為 true。');
  }
  const confirmed = workflowStore.confirmEvidence(evidenceId, actor.actorId);
  audit(actor, 'EVIDENCE_HUMAN_CONFIRM', 'evidence', evidenceId, 'ALLOW', null, caseId);
  return ok(200, { evidence: supplierEvidence(confirmed) });
}

function submitCase(actor, caseId) {
  const scope = requireCase(actor, caseId, 'Supplier');
  if (scope.error) return scope.error;
  const { missing, unconfirmed } = evidenceReadiness(caseId);
  if (missing.length || unconfirmed.length) {
    workflowStore.setCaseWorkflow(caseId, {
      status: 'NEEDS_EVIDENCE',
      readiness: 'not_verified',
    });
    audit(actor, 'CASE_SUBMIT', 'case', caseId, 'DENY', 'EVIDENCE_MISSING', caseId);
    return fail(
      422,
      'EVIDENCE_MISSING',
      '案件仍有缺件或尚未人工確認的證據。',
      { missingTypes: missing, unconfirmedEvidenceIds: unconfirmed }
    );
  }
  try {
    const carbon = buildCaseCarbon();
    workflowStore.setCarbon(caseId, carbon);
    const evaluated = applyReadiness(caseId, { markSubmitted: true });
    const reasonCode = evaluated.readiness.reasonCodes[0] || null;
    audit(actor, 'CASE_SUBMIT', 'case', caseId, 'ALLOW', reasonCode, caseId);
    return ok(200, {
      case: maskCase(evaluated.caseRecord, actor, true),
      readiness: evaluated.readiness,
    });
  } catch (error) {
    audit(actor, 'CASE_SUBMIT', 'case', caseId, 'DENY', stableError(error).code, caseId);
    return safeAdapterFailure(error);
  }
}

async function revalidateCase(actor) {
  const caseId = workflowStore.DEMO_CASE_ID;
  const scope = requireCase(actor, caseId, 'Supplier');
  if (scope.error) return scope.error;
  const carbon = workflowStore.getCarbon(caseId);
  try {
    const result = await trustAdapter.evaluate({
      caseId,
      policyProfileId: scope.caseRecord.policyProfileId,
      inputHash:
        carbon &&
        carbon.annual &&
        carbon.annual.calculationReceipt &&
        carbon.annual.calculationReceipt.inputHash,
    });
    workflowStore.setTrustServices(result);
    const evaluated = applyReadiness(caseId);
    audit(
      actor,
      'WORKFLOW_REVALIDATE',
      'case',
      caseId,
      evaluated.readiness.status === 'BLOCKED' ? 'DENY' : 'ALLOW',
      evaluated.readiness.reasonCodes[0] || null,
      caseId
    );
    return ok(200, {
      case: maskCase(evaluated.caseRecord, actor, true),
      readiness: evaluated.readiness,
      demoOnly: true,
    });
  } catch {
    workflowStore.setTrustServices({
      proof: {
        status: 'error',
        verification: 'failed',
        checks: [],
        reasonCodes: ['TRUST_ADAPTER_FAILURE'],
      },
      gate: {
        status: 'error',
        verification: 'failed',
        checks: [],
        reasonCodes: ['TRUST_ADAPTER_FAILURE'],
      },
    });
    const evaluated = applyReadiness(caseId);
    audit(
      actor,
      'WORKFLOW_REVALIDATE',
      'case',
      caseId,
      'DENY',
      'TRUST_ADAPTER_FAILURE',
      caseId
    );
    return ok(200, {
      case: maskCase(evaluated.caseRecord, actor, true),
      readiness: evaluated.readiness,
      demoOnly: true,
    });
  }
}

async function createGrant(actor, body) {
  const scope = requireCase(actor, body.caseId, 'Supplier');
  if (scope.error) return scope.error;
  const verifier = workflowStore.DEMO_ACTORS.Verifier;
  const subject = typeof body.subject === 'string' ? body.subject : body.subject && body.subject.actorId;
  if (subject !== verifier.actorId) {
    return fail(422, 'INVALID_GRANT_SUBJECT', 'Grant subject 必須綁定固定 Demo Verifier。');
  }
  if (!Array.isArray(body.evidenceIds) || body.evidenceIds.length === 0) {
    return fail(400, 'EVIDENCE_IDS_REQUIRED', 'evidenceIds 至少需要一筆。');
  }
  const uniqueEvidenceIds = [...new Set(body.evidenceIds)];
  const valid = uniqueEvidenceIds.every((evidenceId) => {
    const item = workflowStore.getEvidence(evidenceId);
    return item && item.caseId === body.caseId;
  });
  if (!valid) {
    return fail(404, 'EVIDENCE_NOT_FOUND', 'Grant 內含無法存取的證據。');
  }
  const now = Date.now();
  const expiresAtMs = Date.parse(body.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs - now > MAX_GRANT_MS) {
    return fail(
      422,
      'INVALID_GRANT_EXPIRY',
      'Grant expiry 必須在現在之後且不超過 5 分鐘。',
      { maxLifetimeSeconds: MAX_GRANT_MS / 1000 }
    );
  }
  try {
    const token = randomToken();
    const tokenHash = await sha256Text(token);
    const grant = workflowStore.addGrant({
      caseId: body.caseId,
      evidenceIds: uniqueEvidenceIds,
      subjectActorId: verifier.actorId,
      subjectRole: verifier.role,
      expiresAt: new Date(expiresAtMs).toISOString(),
      tokenHash,
      createdBy: actor.actorId,
      demoOnly: true,
    });
    audit(actor, 'VAULT_GRANT_CREATE', 'grant', grant.grantId, 'ALLOW', null, body.caseId);
    return ok(201, {
      grant: {
        grantId: grant.grantId,
        caseId: grant.caseId,
        evidenceIds: grant.evidenceIds,
        subjectActorId: grant.subjectActorId,
        expiresAt: grant.expiresAt,
        oneTime: true,
        demoOnly: true,
      },
      token,
    });
  } catch (error) {
    return safeAdapterFailure(error);
  }
}

function revokeGrant(actor, grantId) {
  const grant = workflowStore.getGrant(grantId);
  const scope = requireCase(actor, grant && grant.caseId, 'Supplier');
  if (scope.error || !grant || grant.createdBy !== actor.actorId) {
    return fail(404, 'GRANT_NOT_FOUND', '找不到可撤銷的 Grant。');
  }
  const revokedGrant = workflowStore.revokeGrant(grantId);
  audit(actor, 'VAULT_GRANT_REVOKE', 'grant', grantId, 'ALLOW', null, grant.caseId);
  return ok(200, { grantId, revoked: true, revokedAt: revokedGrant.revokedAt });
}

/**
 * Vault 加密金鑰註冊/查詢（WebAuthn PRF 版）。跟 accessVault() 的 Grant/token 機制是不同層次：
 * 這裡管的是「Verifier 的 Vault 身份金鑰（公鑰/已包裝私鑰）長什麼樣子」，不判斷任何一次
 * 存取許不許可——存取許可完全還是由 createGrant/accessVault 的既有機制把關，這一層不重複
 * 判斷一次「這個人是不是 Verifier」，只負責金鑰資料本身的存取。
 *
 * GET 對任何已認證的 Demo 角色開放（Supplier 上傳前要讀公鑰去加密；Verifier 開底稿前要讀
 * 自己的已包裝私鑰去解密），POST 只有 Verifier 能呼叫。
 */
function getVaultKeyStatus(actor) {
  const record = vaultKeys.getVerifierKey();
  if (!record) {
    return ok(200, { registered: false, history: [] });
  }
  return ok(200, {
    registered: true,
    keyId: record.keyId,
    credentialId: record.credentialId,
    publicKeyJwk: record.publicKeyJwk,
    wrappedPrivateKeyBase64: record.wrappedPrivateKeyBase64,
    wrapIvBase64: record.wrapIvBase64,
    prfSaltBase64: record.prfSaltBase64,
    createdAt: record.createdAt,
    history: vaultKeys.listVerifierKeyHistory(),
    demoOnly: true,
  });
}

/** 解密舊底稿要用「當時那把」金鑰，不是永遠用最新一把——輪替之後舊金鑰還在保留期限內
 * 就查得到，超過 MAX_HISTORY 被淘汰的版本回 404，前端要把這個誠實顯示成「這把金鑰已經
 * 超過保留期限」，不是裝作解密失敗是別的原因。*/
function getVaultKeyByIdRoute(actor, keyId) {
  const record = vaultKeys.getVerifierKeyById(keyId);
  if (!record) {
    return fail(404, 'VAULT_KEY_VERSION_NOT_FOUND', '此金鑰版本已超過保留期限或不存在，無法解密。');
  }
  return ok(200, {
    registered: true,
    keyId: record.keyId,
    credentialId: record.credentialId,
    publicKeyJwk: record.publicKeyJwk,
    wrappedPrivateKeyBase64: record.wrappedPrivateKeyBase64,
    wrapIvBase64: record.wrapIvBase64,
    prfSaltBase64: record.prfSaltBase64,
    createdAt: record.createdAt,
    demoOnly: true,
  });
}

function registerVaultKey(actor, body) {
  if (actor.role !== 'Verifier') {
    return fail(403, 'ROLE_FORBIDDEN', '只有 Verifier 能註冊/輪替 Vault 裝置金鑰。');
  }
  try {
    const record = vaultKeys.addVerifierKey({
      credentialId: body.credentialId,
      publicKeyJwk: body.publicKeyJwk,
      wrappedPrivateKeyBase64: body.wrappedPrivateKeyBase64,
      wrapIvBase64: body.wrapIvBase64,
      prfSaltBase64: body.prfSaltBase64,
    });
    audit(actor, 'VAULT_KEY_REGISTER', 'vault_key', record.keyId, 'ALLOW', null, workflowStore.DEMO_CASE_ID);
    return ok(201, {
      registered: true,
      keyId: record.keyId,
      createdAt: record.createdAt,
      demoOnly: true,
    });
  } catch (error) {
    return fail(400, 'INVALID_VAULT_KEY_PAYLOAD', error.message || 'Vault 金鑰註冊資料不完整。');
  }
}

async function accessVault(actor, evidenceId, context, mode) {
  const action = mode === 'download' ? 'VAULT_DOWNLOAD' : 'VAULT_OPEN';
  const deny = (caseId, code) => {
    audit(actor, action, 'evidence', evidenceId, 'DENY', code, caseId || workflowStore.DEMO_CASE_ID);
    const messages = {
      GRANT_EXPIRED: 'Grant 已過期。',
      GRANT_REVOKED: 'Grant 已撤銷。',
      GRANT_INVALID: 'Grant 無效、已使用或不符合此底稿。',
    };
    return fail(403, code, messages[code] || 'Vault 授權無效或已失效。');
  };
  const item = workflowStore.getEvidence(evidenceId);
  if (actor.role !== 'Verifier' || !item) return deny(item && item.caseId, 'GRANT_INVALID');
  const scope = requireCase(actor, item.caseId, 'Verifier');
  if (scope.error) return deny(item.caseId, 'GRANT_INVALID');
  const token = context.vaultToken;
  if (typeof token !== 'string' || !token) return deny(item.caseId, 'GRANT_INVALID');

  let tokenHash;
  try {
    tokenHash = await sha256Text(token);
  } catch {
    return deny(item.caseId, 'GRANT_INVALID');
  }
  const grant = workflowStore.getGrantByTokenHash(tokenHash);
  if (
    !grant ||
    grant.caseId !== item.caseId ||
    grant.subjectActorId !== actor.actorId ||
    grant.subjectRole !== actor.role ||
    !grant.evidenceIds.includes(evidenceId)
  ) {
    return deny(item.caseId, 'GRANT_INVALID');
  }
  if (grant.revokedAt) return deny(item.caseId, 'GRANT_REVOKED');
  if (Date.parse(grant.expiresAt) <= Date.now()) return deny(item.caseId, 'GRANT_EXPIRED');
  if (grant.consumedAt) return deny(item.caseId, 'GRANT_INVALID');
  const consumedGrant = workflowStore.consumeGrant(grant.grantId, actor.actorId, mode);
  if (!consumedGrant) return deny(item.caseId, 'GRANT_INVALID');
  audit(actor, action, 'evidence', evidenceId, 'ALLOW', null, item.caseId);
  return ok(200, {
    evidence: {
      ...evidenceMetadata(item, true),
      contentBase64: item.contentBase64,
      ...(item.vaultEncrypted
        ? {
            vaultIvBase64: item.vaultIvBase64,
            vaultEphemeralPublicKeyJwk: item.vaultEphemeralPublicKeyJwk,
            vaultKeyId: item.vaultKeyId,
          }
        : {}),
    },
    access: {
      mode,
      oneTime: true,
      consumedAt: consumedGrant.consumedAt,
      demoOnly: true,
    },
  });
}

function addFinding(actor, caseId, body) {
  const scope = requireCase(actor, caseId, 'Verifier');
  if (scope.error) return scope.error;
  if (
    typeof body.summary !== 'string' ||
    !body.summary.trim() ||
    !['info', 'warning', 'blocking'].includes(body.severity)
  ) {
    return fail(
      400,
      'INVALID_FINDING',
      'finding 需要非空 summary 與 info、warning 或 blocking severity。'
    );
  }
  const finding = workflowStore.addFinding({
    caseId,
    summary: body.summary.trim(),
    severity: body.severity,
    status: body.status || 'open',
    createdBy: actor.actorId,
    demoOnly: true,
  });
  audit(actor, 'VERIFIER_FINDING_CREATE', 'finding', finding.findingId, 'ALLOW', null, caseId);
  return ok(201, { finding });
}

function runDemoAttack(actor, body) {
  const scope = requireCase(actor, workflowStore.DEMO_CASE_ID, 'Supplier');
  if (scope.error) return scope.error;
  const scenario = body && body.scenario;
  if (!trustAdapter.DEMO_ATTACK_SCENARIOS.includes(scenario)) {
    return fail(
      400,
      'DEMO_SCENARIO_INVALID',
      'scenario 必須是固定攻擊情境。',
      { allowedScenarios: trustAdapter.DEMO_ATTACK_SCENARIOS }
    );
  }
  try {
    const result = trustAdapter.runDemoAttackScenario(scenario);
    audit(
      actor,
      'DEMO_ATTACK_EVALUATE',
      'demo_scenario',
      scenario,
      result.decision === 'BLOCKED' ? 'DENY' : 'ERROR',
      result.reasonCodes[0] || null,
      workflowStore.DEMO_CASE_ID,
      { scenario, reasonCodes: result.reasonCodes }
    );
    return ok(200, result);
  } catch {
    return fail(
      503,
      'TRUST_ADAPTER_FAILURE',
      'Trust Engine 暫時無法執行攻擊情境。',
      null,
      true
    );
  }
}

function physicalRealityBoundary() {
  return ok(200, {
    scenario: 'consistent_documents_but_uncalibrated_meter',
    documentConsistencyVerified: true,
    commitmentVerified: true,
    gateScope: 'DATA_CONSISTENCY_ONLY',
    physicalRealityVerified: false,
    finding: '文件數字彼此一致，但現場儀表失效或未校正，資料一致性不能證明物理真實。',
    recommendedAction: 'ONSITE_VERIFICATION',
    nextStep: '轉交查驗員檢查校正紀錄，並安排實地查驗。',
    caseStatusUnchanged: true,
    gateUnchanged: true,
    demoOnly: true,
  });
}

async function handleWorkflowApi(method, pathname, body = {}, context = {}) {
  const isWorkflowRoute =
    pathname === '/api/cases' ||
    pathname.startsWith('/api/cases/') ||
    pathname === '/api/evidence' ||
    pathname.startsWith('/api/evidence/') ||
    pathname.startsWith('/api/importer/') ||
    pathname.startsWith('/api/verifier/') ||
    pathname.startsWith('/api/vault/') ||
    pathname.startsWith('/api/workflow/') ||
    pathname.startsWith('/api/demo/') ||
    pathname === '/api/agent/analyze';
  if (!isWorkflowRoute) return null;

  const actorResult = requireActor(context);
  if (actorResult.error) return actorResult.error;
  const actor = actorResult.actor;

  if (method === 'GET' && pathname === '/api/cases') {
    const cases = workflowStore
      .listCases()
      .filter((caseRecord) => hasCaseScope(actor, caseRecord))
      .map((caseRecord) => maskCase(caseRecord, actor, false));
    return ok(200, { actor, cases });
  }

  const caseDetailMatch = pathname.match(/^\/api\/cases\/([^/]+)$/);
  if (method === 'GET' && caseDetailMatch) {
    const caseId = decodeURIComponent(caseDetailMatch[1]);
    const scope = requireCase(actor, caseId);
    if (scope.error) return scope.error;
    return ok(200, { actor, case: maskCase(scope.caseRecord, actor, true) });
  }

  if (method === 'POST' && pathname === '/api/evidence') {
    return createEvidence(actor, body);
  }

  if (method === 'POST' && pathname === '/api/evidence/preview') {
    return previewEvidence(actor, body);
  }

  const confirmMatch = pathname.match(/^\/api\/evidence\/([^/]+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    return confirmEvidence(actor, decodeURIComponent(confirmMatch[1]), body);
  }

  const submitMatch = pathname.match(/^\/api\/cases\/([^/]+)\/submit$/);
  if (method === 'POST' && submitMatch) {
    return submitCase(actor, decodeURIComponent(submitMatch[1]));
  }

  const agentAnalyzeMatch = pathname.match(/^\/api\/cases\/([^/]+)\/agent\/analyze$/);
  if (method === 'POST' && agentAnalyzeMatch) {
    return analyzeCase(actor, decodeURIComponent(agentAnalyzeMatch[1]));
  }
  if (method === 'POST' && pathname === '/api/agent/analyze') {
    if (typeof body.caseId !== 'string' || !body.caseId.trim()) {
      return fail(400, 'CASE_ID_REQUIRED', 'caseId 為必填字串。');
    }
    return analyzeCase(actor, body.caseId);
  }

  const importerSummaryMatch = pathname.match(/^\/api\/importer\/cases\/([^/]+)\/summary$/);
  if (method === 'GET' && importerSummaryMatch) {
    const caseId = decodeURIComponent(importerSummaryMatch[1]);
    const scope = requireCase(actor, caseId, 'Importer');
    if (scope.error) return scope.error;
    const carbon = workflowStore.getCarbon(caseId);
    return ok(200, {
      case: maskCase(scope.caseRecord, actor, true),
      comparison: {
        actualIntensity: carbon.annual.intensity,
        defaultEstimateIntensity: 2.5,
        unit: carbon.annual.intensityUnit,
        label: 'Demo estimate，非官方預設值。',
        demoOnly: true,
      },
    });
  }

  const verifierIndexMatch = pathname.match(/^\/api\/verifier\/cases\/([^/]+)\/evidence$/);
  if (method === 'GET' && verifierIndexMatch) {
    const caseId = decodeURIComponent(verifierIndexMatch[1]);
    const scope = requireCase(actor, caseId, 'Verifier');
    if (scope.error) return scope.error;
    return ok(200, {
      caseId,
      evidenceIndex: workflowStore
        .listEvidence(caseId)
        .map((item) => evidenceMetadata(item, true)),
    });
  }

  const findingMatch = pathname.match(/^\/api\/verifier\/cases\/([^/]+)\/findings$/);
  if (method === 'POST' && findingMatch) {
    return addFinding(actor, decodeURIComponent(findingMatch[1]), body);
  }

  if (method === 'GET' && pathname === '/api/vault/keys/verifier') {
    return getVaultKeyStatus(actor);
  }

  if (method === 'POST' && pathname === '/api/vault/keys/verifier') {
    return registerVaultKey(actor, body);
  }

  const vaultKeyVersionMatch = pathname.match(/^\/api\/vault\/keys\/verifier\/([^/]+)$/);
  if (method === 'GET' && vaultKeyVersionMatch) {
    return getVaultKeyByIdRoute(actor, decodeURIComponent(vaultKeyVersionMatch[1]));
  }

  if (method === 'POST' && pathname === '/api/vault/grants') {
    return createGrant(actor, body);
  }

  const revokeMatch = pathname.match(/^\/api\/vault\/grants\/([^/]+)\/revoke$/);
  if (method === 'POST' && revokeMatch) {
    return revokeGrant(actor, decodeURIComponent(revokeMatch[1]));
  }

  const vaultItemMatch = pathname.match(/^\/api\/vault\/items\/([^/]+)(?:\/(download))?$/);
  if (method === 'GET' && vaultItemMatch) {
    return accessVault(
      actor,
      decodeURIComponent(vaultItemMatch[1]),
      context,
      vaultItemMatch[2] === 'download' ? 'download' : 'open'
    );
  }

  const auditMatch = pathname.match(/^\/api\/cases\/([^/]+)\/audit$/);
  if (method === 'GET' && auditMatch) {
    const caseId = decodeURIComponent(auditMatch[1]);
    const scope = requireCase(actor, caseId);
    if (scope.error) return scope.error;
    return ok(200, { events: workflowStore.listAudit(caseId) });
  }

  if (method === 'POST' && pathname === '/api/workflow/carbon/preview') {
    const scope = requireCase(actor, body.caseId, 'Supplier');
    if (scope.error) return scope.error;
    try {
      const carbon = buildCaseCarbon({
        installationYear: body.installationYear,
        shipments: body.shipments,
      });
      return ok(200, {
        carbon,
        previewOnly: true,
        clientSuppliedInput: true,
      });
    } catch (error) {
      return safeAdapterFailure(error);
    }
  }

  if (method === 'POST' && pathname === '/api/workflow/revalidate') {
    return revalidateCase(actor);
  }

  if (method === 'POST' && pathname === '/api/demo/attack') {
    return runDemoAttack(actor, body);
  }

  if (
    (method === 'GET' || method === 'POST') &&
    pathname === '/api/demo/physical-reality'
  ) {
    return physicalRealityBoundary();
  }

  if (method === 'POST' && pathname === '/api/workflow/reset') {
    const scope = requireCase(actor, workflowStore.DEMO_CASE_ID, 'Supplier');
    if (scope.error) return scope.error;
    const caseRecord = workflowStore.reset();
    audit(actor, 'WORKFLOW_RESET', 'case', caseRecord.caseId, 'ALLOW', null, caseRecord.caseId);
    return ok(200, {
      ok: true,
      case: maskCase(caseRecord, actor, true),
      demoOnly: true,
    });
  }

  return fail(404, 'API_NOT_FOUND', '找不到 workflow API。', { path: pathname });
}

/**
 * GS1/DPP 分層揭露最小示意（services/dpp，Day 5 背景待辦 2）。刻意獨立於
 * handleWorkflowApi() 之外、不經過它的 requireActor() 認證閘門——public/customer/customs
 * 是「產品護照的外部查詢者」這條軸線，跟案件參與者的 x-demo-role 是不同概念，這裡刻意
 * 示範「同一筆 Case 依角色回傳不同欄位子集」本身，不是要重做一套認證機制。純讀取，不影響
 * Gate/Policy、不產生稽核事件。呼叫端（server/apiFetch.js）要在 handleWorkflowApi() 之前
 * 呼叫這個函式。
 */
function handleDppApi(method, pathname, context = {}) {
  const dppMatch = pathname.match(/^\/api\/dpp\/cases\/([^/]+)$/);
  if (!(method === 'GET' && dppMatch)) return null;
  const caseId = decodeURIComponent(dppMatch[1]);
  const role = String(context.dppRole || 'public').trim().toLowerCase();
  if (!DPP_ROLES.includes(role)) {
    return fail(400, 'DPP_ROLE_INVALID', `role 必須是 ${DPP_ROLES.join('/')} 其中一種。`, { role });
  }
  const caseRecord = workflowStore.getCase(caseId);
  if (!caseRecord) {
    return fail(404, 'CASE_NOT_FOUND', '找不到這筆案件。', { caseId });
  }
  const carbon = workflowStore.getCarbon(caseId);
  return ok(200, buildLayeredDisclosure({ caseRecord, outwardStatus: outwardStatus(caseRecord.status), carbon, role }));
}

module.exports = {
  ALLOWED_MEDIA_TYPES,
  MAX_EVIDENCE_PER_CASE,
  MAX_EVIDENCE_BYTES,
  handleWorkflowApi,
  handleDppApi,
};
