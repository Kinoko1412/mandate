'use strict';

const normalFixture = require('../fixtures/normal.json');
const { buildCaseCarbon, unavailableAdapters } = require('./carbonAdapter');

const DEMO_CASE_ID = 'CASE-2026-001';
const READY_DISCLAIMER =
  '具備送交查驗準備條件，不代表正式查驗完成。';
const SERVICE_NAMES = new Set(['agent', 'proof', 'gate']);
const SERVICE_STATUSES = new Set(['available', 'unavailable', 'error']);
const SERVICE_VERIFICATIONS = new Set(['verified', 'not_verified', 'failed']);
const CASE_STATUSES = new Set([
  'DRAFT',
  'READY_FOR_VERIFIER',
  'NEEDS_EVIDENCE',
  'METHOD_REVIEW',
  'VERIFIER_REQUIRED',
  'BLOCKED',
  'ARCHIVED',
]);
const READINESS_STATUSES = new Set(['verified', 'not_verified', 'failed']);

const DEMO_ACTORS = Object.freeze({
  Supplier: Object.freeze({
    actorId: 'demo-supplier-001',
    orgId: 'ORG-TW-STEEL-SUPPLIER',
    role: 'Supplier',
    demoOnly: true,
  }),
  Importer: Object.freeze({
    actorId: 'demo-importer-001',
    orgId: 'ORG-EU-IMPORTER-DEMO',
    role: 'Importer',
    demoOnly: true,
  }),
  Verifier: Object.freeze({
    actorId: 'demo-verifier-001',
    orgId: 'ORG-CBAM-VERIFIER-DEMO',
    role: 'Verifier',
    demoOnly: true,
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createInitialState() {
  const carbon = buildCaseCarbon();
  return {
    cases: [
      {
        ...clone(normalFixture.case),
        status: 'DRAFT',
        readiness: 'not_verified',
        readyDisclaimer: READY_DISCLAIMER,
        demoOnly: true,
      },
    ],
    installationYears: [clone(normalFixture.installationYear)],
    carbonByCase: new Map([[DEMO_CASE_ID, carbon]]),
    evidence: [],
    grants: [],
    findings: [],
    audit: [],
    services: unavailableAdapters(),
    sequences: {
      evidence: 0,
      grant: 0,
      finding: 0,
      audit: 0,
    },
  };
}

let state = createInitialState();

function nowIso() {
  return new Date().toISOString();
}

function reset() {
  state = createInitialState();
  return getCase(DEMO_CASE_ID);
}

function getCase(caseId) {
  const item = state.cases.find((candidate) => candidate.caseId === caseId);
  return item ? clone(item) : null;
}

function listCases() {
  return clone(state.cases);
}

function setCaseWorkflow(caseId, patch) {
  const item = state.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) return null;
  const allowed = new Set(['status', 'readiness', 'submittedAt']);
  if (!patch || typeof patch !== 'object' || Object.keys(patch).some((key) => !allowed.has(key))) {
    throw new TypeError('Invalid case workflow patch.');
  }
  if (patch.status !== undefined && !CASE_STATUSES.has(patch.status)) {
    throw new TypeError('Invalid case workflow status.');
  }
  if (patch.readiness !== undefined && !READINESS_STATUSES.has(patch.readiness)) {
    throw new TypeError('Invalid case readiness status.');
  }
  if (
    patch.submittedAt !== undefined &&
    patch.submittedAt !== null &&
    (typeof patch.submittedAt !== 'string' || Number.isNaN(Date.parse(patch.submittedAt)))
  ) {
    throw new TypeError('Invalid case submittedAt.');
  }
  Object.assign(item, patch);
  return clone(item);
}

function getInstallationYear(caseId) {
  if (caseId !== DEMO_CASE_ID) return null;
  return state.installationYears[0] ? clone(state.installationYears[0]) : null;
}

function getCarbon(caseId) {
  const carbon = state.carbonByCase.get(caseId);
  return carbon ? clone(carbon) : null;
}

function setCarbon(caseId, carbon) {
  if (!getCase(caseId) || !carbon || typeof carbon !== 'object') {
    throw new TypeError('Invalid case carbon value.');
  }
  state.carbonByCase.set(caseId, clone(carbon));
  return getCarbon(caseId);
}

function listEvidence(caseId) {
  return clone(state.evidence.filter((item) => item.caseId === caseId));
}

function getEvidence(evidenceId) {
  const item = state.evidence.find((candidate) => candidate.evidenceId === evidenceId);
  return item ? clone(item) : null;
}

function addEvidence(record) {
  state.sequences.evidence += 1;
  const evidence = {
    ...record,
    evidenceId: `EV-UPLOAD-${String(state.sequences.evidence).padStart(2, '0')}`,
    version: 1,
    uploadedAt: nowIso(),
  };
  state.evidence.push(evidence);
  return clone(evidence);
}

function confirmEvidence(evidenceId, actorId) {
  const item = state.evidence.find((candidate) => candidate.evidenceId === evidenceId);
  if (!item) return null;
  item.humanConfirmed = true;
  item.confirmedAt = nowIso();
  item.confirmedBy = actorId;
  return clone(item);
}

function addGrant(record) {
  state.sequences.grant += 1;
  const grant = {
    ...record,
    grantId: `grant_${String(state.sequences.grant).padStart(4, '0')}`,
    createdAt: nowIso(),
    revokedAt: null,
    consumedAt: null,
  };
  state.grants.push(grant);
  return clone(grant);
}

function getGrant(grantId) {
  const item = state.grants.find((candidate) => candidate.grantId === grantId);
  return item ? clone(item) : null;
}

function getGrantByTokenHash(tokenHash) {
  const item = state.grants.find((candidate) => candidate.tokenHash === tokenHash);
  return item ? clone(item) : null;
}

function revokeGrant(grantId) {
  const item = state.grants.find((candidate) => candidate.grantId === grantId);
  if (!item) return null;
  if (!item.revokedAt) item.revokedAt = nowIso();
  return clone(item);
}

function consumeGrant(grantId, actorId, mode) {
  const item = state.grants.find((candidate) => candidate.grantId === grantId);
  if (!item || item.revokedAt || item.consumedAt || Date.parse(item.expiresAt) <= Date.now()) {
    return null;
  }
  item.consumedAt = nowIso();
  item.consumedBy = actorId;
  item.consumedMode = mode;
  return clone(item);
}

function addFinding(record) {
  state.sequences.finding += 1;
  const finding = {
    ...record,
    findingId: `finding_${String(state.sequences.finding).padStart(4, '0')}`,
    createdAt: nowIso(),
  };
  state.findings.push(finding);
  return clone(finding);
}

function listFindings(caseId) {
  return clone(state.findings.filter((item) => item.caseId === caseId));
}

function appendAudit(partial) {
  state.sequences.audit += 1;
  const event = {
    auditEventId: `wf_aud_${String(state.sequences.audit).padStart(4, '0')}`,
    timestamp: partial.timestamp || nowIso(),
    caseId: partial.caseId || DEMO_CASE_ID,
    actorId: partial.actorId,
    role: partial.role,
    action: partial.action,
    targetType: partial.targetType || null,
    targetId: partial.targetId || null,
    result: partial.result,
    reasonCode: partial.reasonCode || null,
    demoOnly: true,
  };
  state.audit.push(event);
  return clone(event);
}

function listAudit(caseId) {
  return clone(state.audit.filter((item) => item.caseId === caseId));
}

function validateServicePatch(name, patch) {
  if (!SERVICE_NAMES.has(name) || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Invalid trust service.');
  }
  const allowed = new Set([
    'status',
    'verification',
    'checks',
    'reasonCodes',
    'inputHash',
  ]);
  if (Object.keys(patch).some((key) => !allowed.has(key))) {
    throw new TypeError('Invalid trust service patch.');
  }
  if (patch.status !== undefined && !SERVICE_STATUSES.has(patch.status)) {
    throw new TypeError('Invalid trust service status.');
  }
  if (
    patch.verification !== undefined &&
    !SERVICE_VERIFICATIONS.has(patch.verification)
  ) {
    throw new TypeError('Invalid trust service verification.');
  }
  if (
    patch.status === 'available' &&
    patch.verification !== undefined &&
    patch.verification === 'not_verified'
  ) {
    throw new TypeError('Available trust service must be verified or failed.');
  }
  if (patch.verification === 'verified' && patch.status !== undefined && patch.status !== 'available') {
    throw new TypeError('Verified trust service must be available.');
  }
  if (patch.checks !== undefined && !Array.isArray(patch.checks)) {
    throw new TypeError('Invalid trust service checks.');
  }
  if (
    patch.reasonCodes !== undefined &&
    (!Array.isArray(patch.reasonCodes) ||
      patch.reasonCodes.some((code) => !/^[A-Z][A-Z0-9_]*$/.test(code)))
  ) {
    throw new TypeError('Invalid trust service reason codes.');
  }
  if (
    patch.inputHash !== undefined &&
    (typeof patch.inputHash !== 'string' || !patch.inputHash.trim())
  ) {
    throw new TypeError('Invalid trust service input hash.');
  }
}

function setServiceStatus(name, patch) {
  validateServicePatch(name, patch);
  const current = state.services[name];
  const next = { ...current, ...clone(patch), demoOnly: true };
  if (next.verification === 'verified' && next.status !== 'available') {
    throw new TypeError('Verified trust service must be available.');
  }
  state.services[name] = next;
  return clone(next);
}

function setTrustServices(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('Invalid trust service result.');
  }
  const names = Object.keys(result);
  if (!names.length || names.some((name) => !SERVICE_NAMES.has(name))) {
    throw new TypeError('Invalid trust service result names.');
  }
  names.forEach((name) => validateServicePatch(name, result[name]));
  names.forEach((name) => setServiceStatus(name, result[name]));
  return getServices();
}

function getServices() {
  return clone(state.services);
}

module.exports = {
  DEMO_ACTORS,
  DEMO_CASE_ID,
  READY_DISCLAIMER,
  addEvidence,
  addFinding,
  addGrant,
  appendAudit,
  confirmEvidence,
  consumeGrant,
  getCarbon,
  getCase,
  getEvidence,
  getGrant,
  getGrantByTokenHash,
  getInstallationYear,
  getServices,
  listAudit,
  listCases,
  listEvidence,
  listFindings,
  nowIso,
  reset,
  revokeGrant,
  setCarbon,
  setCaseWorkflow,
  setServiceStatus,
  setTrustServices,
};
