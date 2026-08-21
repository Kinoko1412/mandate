'use strict';

const crypto = require('crypto');
const { session, suppliers, pcfPayloads } = require('./fixtures/bundle');
const supabaseSync = require('./supabaseSync');
const { verifySupplierCredentialChain } = require('./vleiCheck');
const { scoreStagedPayload } = require('./confidenceScore');

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function argsDigest(input) {
  const raw = JSON.stringify(input == null ? {} : input);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function createInitialState() {
  const sessionData = session;
  const suppliersData = suppliers;
  const pcfData = pcfPayloads;

  return {
    org: deepClone(sessionData.org),
    principal: deepClone(sessionData.principal),
    approver: deepClone(sessionData.approver),
    agent: deepClone(sessionData.agent),
    mandate: deepClone(sessionData.mandate),
    suppliers: deepClone(suppliersData),
    pcfPayloads: deepClone(pcfData),
    staging: new Map(),
    cbamDrafts: [],
    revokedShares: new Set(),
    emissionsRequests: new Set(),
    approvals: [],
    audit: [],
    lastEventId: 0,
    lastApprovalSeq: 0,
    lastDraftSeq: 0,
  };
}

let state = createInitialState();

function nowIso() {
  return new Date().toISOString();
}

function getSupplier(supplierId) {
  return state.suppliers.find((s) => s.supplierId === supplierId) || null;
}

function listSuppliers() {
  return state.suppliers.map((s) => {
    const chain = verifySupplierCredentialChain(s);
    return {
      supplierId: s.supplierId,
      orgName: s.orgName,
      credentialValid: supplierHasValidCredential(s),
      credentials: s.credentials,
      shareRevoked: state.revokedShares.has(s.supplierId),
      vlei: s.vlei ? deepClone(s.vlei) : null,
      vleiChainStatus: chain.chainStatus,
    };
  });
}

function supplierHasValidCredential(supplier) {
  if (!supplier || !Array.isArray(supplier.credentials) || supplier.credentials.length === 0) {
    return false;
  }
  const nowMs = Date.now();
  return supplier.credentials.some(
    (c) => c.signatureValid === true && c.expiresAt && new Date(c.expiresAt).getTime() > nowMs
  );
}

function getPcfPayload(supplierId) {
  const found = state.pcfPayloads.find((p) => p.supplierId === supplierId);
  return found ? deepClone(found) : null;
}

function stagePayload(payload) {
  if (!payload || !payload.supplierId) return null;
  const { enrichPayloadWithQualityTier } = require('./pcfCheck');
  const enriched = enrichPayloadWithQualityTier(deepClone(payload));
  const confidence = scoreStagedPayload(enriched, getSupplier(payload.supplierId), state.audit);
  const entry = {
    ...enriched,
    confidenceScore: confidence.score,
    confidenceTier: confidence.tier,
    stagedAt: nowIso(),
  };
  state.staging.set(payload.supplierId, entry);
  return deepClone(entry);
}

function recordEmissionsRequest(supplierId) {
  if (!supplierId) return false;
  state.emissionsRequests.add(supplierId);
  return true;
}

function hasEmissionsRequest(supplierId) {
  return state.emissionsRequests.has(supplierId);
}

function listEmissionsRequests() {
  return Array.from(state.emissionsRequests);
}

function listStaging() {
  return Array.from(state.staging.values()).map((e) => deepClone(e));
}

function isShareRevoked(supplierId) {
  return state.revokedShares.has(supplierId);
}

function revokeShare(supplierId, reason) {
  if (!supplierId) return { revoked: false, cancelled: 0 };
  const ts = nowIso();
  state.revokedShares.add(supplierId);
  if (state.staging.has(supplierId)) {
    const staged = state.staging.get(supplierId);
    staged.revoked = true;
    staged.revokedAt = ts;
    staged.revokeReason = reason || 'Data share revoked';
  }

  let cancelled = 0;
  for (const a of state.approvals) {
    if (
      a.mandateId === state.mandate.mandateId &&
      a.status === 'PENDING' &&
      a.payload &&
      a.payload.supplierId === supplierId
    ) {
      a.status = 'CANCELLED';
      a.decidedAt = ts;
      cancelled += 1;
      appendAudit({
        principalId: state.principal.principalId,
        actorId: state.approver.principalId,
        actorType: 'HUMAN',
        toolName: 'revoke_data_share',
        decision: 'ALLOW',
        policyId: 'POL-REV-010',
        reason: 'Pending approval cancelled on data share revoke.',
        reasoningSummary: '這筆待核准申請所屬的供應商資料分享已被撤銷，申請跟著自動作廢，不會再被合規主管核准。',
        approvalId: a.approvalId,
      });
    }
  }
  return { revoked: true, supplierId, cancelled, revokedShares: Array.from(state.revokedShares) };
}

function recordCbamDraft(draft) {
  state.lastDraftSeq += 1;
  const entry = {
    draftId: `cbam_${String(state.lastDraftSeq).padStart(4, '0')}`,
    ...deepClone(draft),
    createdAt: nowIso(),
  };
  state.cbamDrafts.push(entry);
  return deepClone(entry);
}

function appendAudit(partial) {
  state.lastEventId += 1;
  const eventId = `aud_${String(state.lastEventId).padStart(4, '0')}`;
  const event = {
    auditEventId: eventId,
    eventId,
    ts: partial.ts || nowIso(),
    orgId: partial.orgId != null ? partial.orgId : state.org.orgId,
    principalId: partial.principalId,
    actorId: partial.actorId,
    actorType: partial.actorType,
    agentId: partial.agentId != null ? partial.agentId : state.agent.agentId,
    mandateId: partial.mandateId != null ? partial.mandateId : state.mandate.mandateId,
    toolId: partial.toolId || partial.toolName,
    toolName: partial.toolName,
    decision: partial.decision,
    policyId: partial.policyId,
    reason: partial.reason || null,
    correlationId: partial.correlationId || null,
    approvalId: partial.approvalId != null ? partial.approvalId : null,
    argsDigest: partial.argsDigest || null,
    inputHash: partial.inputHash || (partial.argsDigest ? `sha256:${partial.argsDigest}` : null),
    inputRedacted: partial.inputRedacted || null,
    reasoningSummary: partial.reasoningSummary || null,
    uncertainPoints: partial.uncertainPoints || null,
    eventKind: partial.eventKind || 'TOOL_DECISION',
  };
  state.audit.push(event);
  supabaseSync.syncAuditEvent(event);
  if (event.approvalId) {
    const approval = getApproval(event.approvalId);
    if (approval) supabaseSync.syncApproval(approval);
  }
  return event;
}

function createApproval({ type, requestedBy, policyId, payload }) {
  state.lastApprovalSeq += 1;
  const approvalId = `appr_${String(state.lastApprovalSeq).padStart(4, '0')}`;
  const stagedForSupplier = payload && payload.supplierId ? state.staging.get(payload.supplierId) : null;
  const approval = {
    approvalId,
    mandateId: state.mandate.mandateId,
    type: type || 'CBAM',
    status: 'PENDING',
    requestedBy,
    approverId: null,
    createdAt: nowIso(),
    decidedAt: null,
    consumedAt: null,
    policyId,
    payload: payload || {},
    confidenceScore: stagedForSupplier ? stagedForSupplier.confidenceScore : null,
    confidenceTier: stagedForSupplier ? stagedForSupplier.confidenceTier : null,
  };
  state.approvals.push(approval);
  return approval;
}

function getApproval(approvalId) {
  return state.approvals.find((a) => a.approvalId === approvalId) || null;
}

function consumeApproval(approvalId, at) {
  const a = getApproval(approvalId);
  if (!a) return null;
  a.consumedAt = at || nowIso();
  return a;
}

function revokeMandate(reason) {
  const ts = nowIso();
  state.mandate.status = 'REVOKED';
  state.mandate.revokedAt = ts;
  state.mandate.revokeReason = reason || 'Demo revoke';

  let cancelled = 0;
  for (const a of state.approvals) {
    if (a.mandateId === state.mandate.mandateId && a.status === 'PENDING') {
      a.status = 'CANCELLED';
      a.decidedAt = ts;
      cancelled += 1;
      appendAudit({
        principalId: state.principal.principalId,
        actorId: state.approver.principalId,
        actorType: 'HUMAN',
        toolName: 'revoke_mandate',
        decision: 'ALLOW',
        policyId: 'POL-REV-001',
        reason: 'Pending approval cancelled on mandate revoke.',
        reasoningSummary: '整個 Mandate 授權已被收回，這筆待核准申請跟著自動作廢，不會再被合規主管核准。',
        approvalId: a.approvalId,
      });
    }
  }
  return { mandate: state.mandate, cancelled };
}

function simulateExpiry() {
  state.mandate.expiresAt = '2020-01-01T00:00:00+08:00';
  state.mandate.status = 'EXPIRED';
  return state.mandate;
}

function reset() {
  state = createInitialState();
  return getSession();
}

function buildSupplierPipeline() {
  const pendingBySupplier = new Map();
  for (const a of state.approvals) {
    if (a.status === 'PENDING' && a.payload && a.payload.supplierId) {
      pendingBySupplier.set(a.payload.supplierId, a.approvalId);
    }
  }
  const lastAuditBySupplier = new Map();
  for (let i = state.audit.length - 1; i >= 0; i -= 1) {
    const ev = state.audit[i];
    const sid = ev.inputRedacted && ev.inputRedacted.supplierId;
    if (sid && !lastAuditBySupplier.has(sid)) {
      lastAuditBySupplier.set(sid, {
        decision: ev.decision,
        policyId: ev.policyId,
        toolName: ev.toolName,
      });
    }
  }

  return state.suppliers
    .filter((s) => s.supplierId !== 'supplier_blocked_99')
    .map((s) => {
      const id = s.supplierId;
      const staged = state.staging.get(id);
      const lastDecision = lastAuditBySupplier.get(id) || null;
      const ingestRejected =
        !staged?.revoked &&
        !(staged && !staged.revoked) &&
        lastDecision?.toolName === 'ingest_pcf_payload' &&
        lastDecision?.decision &&
        lastDecision.decision !== 'ALLOW';
      const committedDraft = state.cbamDrafts.some(
        (d) => d.supplierId === id && d.status === 'COMMITTED'
      );
      return {
        supplierId: id,
        orgName: s.orgName,
        requested: state.emissionsRequests.has(id),
        staged: Boolean(staged && !staged.revoked),
        qualityTier: staged && !staged.revoked ? staged.qualityTier || null : null,
        shareRevoked: state.revokedShares.has(id),
        pendingApproval: pendingBySupplier.get(id) || null,
        lastDecision,
        ingestRejected,
        committedDraft,
      };
    });
}

function buildSessionSummary() {
  const llm = require('./llm');
  const pending = state.approvals.filter(
    (a) => a.mandateId === state.mandate.mandateId && a.status === 'PENDING'
  );
  const stagingActive = listStaging().filter((s) => !s.revoked);
  return {
    pendingCount: pending.length,
    stagingCount: stagingActive.length,
    agentConfigured: llm.isConfigured(),
    mandateStatus: state.mandate.status,
  };
}

function getSession() {
  const m = state.mandate;
  const pendingApprovals = state.approvals.filter(
    (a) => a.mandateId === m.mandateId && a.status === 'PENDING'
  );
  return {
    org: state.org,
    principal: state.principal,
    approver: state.approver,
    agent: state.agent,
    mandate: deepClone(m),
    permissions: {
      allowedTools: m.allowedTools.slice(),
      deniedTools: m.deniedTools.slice(),
      deniedSuppliers: m.deniedSuppliers.slice(),
      constraints: deepClone(m.constraints),
      status: m.status,
    },
    staging: listStaging(),
    revokedShares: Array.from(state.revokedShares),
    emissionsRequests: listEmissionsRequests(),
    pendingApprovals: deepClone(pendingApprovals),
    supplierPipeline: buildSupplierPipeline(),
    summary: buildSessionSummary(),
  };
}

function getAudit() {
  return state.audit.slice();
}

function getState() {
  return state;
}

module.exports = {
  argsDigest,
  getSupplier,
  listSuppliers,
  getPcfPayload,
  stagePayload,
  recordEmissionsRequest,
  hasEmissionsRequest,
  listEmissionsRequests,
  listStaging,
  isShareRevoked,
  revokeShare,
  recordCbamDraft,
  appendAudit,
  createApproval,
  getApproval,
  consumeApproval,
  revokeMandate,
  simulateExpiry,
  reset,
  getSession,
  getAudit,
  getState,
  nowIso,
};
