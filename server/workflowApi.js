'use strict';

const workflowStore = require('./workflowStore');
const {
  WorkflowAdapterError,
  buildCaseCarbon,
  stableError,
} = require('./carbonAdapter');
const trustAdapter = require('./trustAdapter');

const MAX_EVIDENCE_BYTES = 512 * 1024;
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

function maskCase(caseRecord, actor, detail = false) {
  const carbon = workflowStore.getCarbon(caseRecord.caseId);
  const evidence = workflowStore.listEvidence(caseRecord.caseId);
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

function audit(actor, action, targetType, targetId, result, reasonCode, caseId) {
  return workflowStore.appendAudit({
    actorId: actor.actorId,
    role: actor.role,
    action,
    targetType,
    targetId,
    result,
    reasonCode,
    caseId,
  });
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
  return { filename, metadata };
}

async function createEvidence(actor, body) {
  const scope = requireCase(actor, body.caseId, 'Supplier');
  if (scope.error) return scope.error;
  try {
    const { filename, metadata } = validateEvidenceInput(body);
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
      demoOnly: true,
    });
    audit(actor, 'EVIDENCE_UPLOAD', 'evidence', evidence.evidenceId, 'ALLOW', null, body.caseId);
    return ok(201, { evidence: supplierEvidence(evidence) });
  } catch (error) {
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

async function handleWorkflowApi(method, pathname, body = {}, context = {}) {
  const isWorkflowRoute =
    pathname === '/api/cases' ||
    pathname.startsWith('/api/cases/') ||
    pathname === '/api/evidence' ||
    pathname.startsWith('/api/evidence/') ||
    pathname.startsWith('/api/importer/') ||
    pathname.startsWith('/api/verifier/') ||
    pathname.startsWith('/api/vault/') ||
    pathname.startsWith('/api/workflow/');
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

  const confirmMatch = pathname.match(/^\/api\/evidence\/([^/]+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    return confirmEvidence(actor, decodeURIComponent(confirmMatch[1]), body);
  }

  const submitMatch = pathname.match(/^\/api\/cases\/([^/]+)\/submit$/);
  if (method === 'POST' && submitMatch) {
    return submitCase(actor, decodeURIComponent(submitMatch[1]));
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

module.exports = {
  ALLOWED_MEDIA_TYPES,
  MAX_EVIDENCE_BYTES,
  handleWorkflowApi,
};
