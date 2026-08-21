'use strict';

/**
 * Case handoff summary — read-only rollup of an existing supplier's audit
 * trail so a new reviewer can get up to speed without replaying every
 * audit-log entry. Pure aggregation of `session.supplierPipeline` +
 * `AuditEvent.reasoningSummary` (both already exist); adds no new entity,
 * no new policyId, and never calls policy.evaluate().
 */

const store = require('./store');

const STATUS_PRIORITY = {
  NEEDS_ATTENTION: 0,
  PENDING_REVIEW: 1,
  REVOKED: 2,
  CLEAR: 3,
  UNTOUCHED: 4,
};

function deriveStatus(pipelineEntry) {
  if (pipelineEntry.shareRevoked) return 'REVOKED';
  if (pipelineEntry.pendingApproval) return 'PENDING_REVIEW';
  if (pipelineEntry.ingestRejected) return 'NEEDS_ATTENTION';
  if (pipelineEntry.staged || pipelineEntry.committedDraft) return 'CLEAR';
  return 'UNTOUCHED';
}

function buildTimeline(supplierId, auditEvents, limit) {
  return auditEvents
    .filter((ev) => ev.inputRedacted && ev.inputRedacted.supplierId === supplierId)
    .sort((a, b) => (Date.parse(a.ts || 0) || 0) - (Date.parse(b.ts || 0) || 0))
    .slice(-(limit || 20))
    .map((ev) => ({
      ts: ev.ts,
      actorType: ev.actorType,
      toolName: ev.toolName,
      decision: ev.decision,
      policyId: ev.policyId,
      reasoningSummary: ev.reasoningSummary,
      uncertainPoints: ev.uncertainPoints || [],
    }));
}

function buildCases() {
  const session = store.getSession();
  const auditEvents = store.getAudit();
  const stagingBySupplier = new Map(session.staging.map((s) => [s.supplierId, s]));
  return session.supplierPipeline
    .map((p) => {
      const staged = stagingBySupplier.get(p.supplierId);
      return {
        ...p,
        status: deriveStatus(p),
        confidenceScore: staged ? staged.confidenceScore : null,
        confidenceTier: staged ? staged.confidenceTier : null,
        timeline: buildTimeline(p.supplierId, auditEvents),
      };
    })
    .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
}

function buildCase(supplierId) {
  return buildCases().find((c) => c.supplierId === supplierId) || null;
}

module.exports = { buildCases, buildCase, deriveStatus, STATUS_PRIORITY };
