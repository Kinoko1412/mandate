'use strict';

const { evaluate, evaluateWithTrace } = require('./policy');

const NOW = '2026-07-20T12:00:00+08:00';
const FUTURE = '2026-12-31T23:59:59+08:00';

const principal = {
  principalId: 'user_compliance_01',
  orgId: 'org_acme',
};

const agent = {
  agentId: 'agent_mandate_v1',
  allowedTools: [
    'request_emissions',
    'fetch_supplier_response',
    'ingest_pcf_payload',
    'submit_cbam_draft',
  ],
};

const agentActor = {
  actorId: 'agent_mandate_v1',
  actorType: 'AGENT',
  onBehalfOf: 'user_compliance_01',
};

function baseMandate(overrides) {
  return Object.assign(
    {
      mandateId: 'mandate_acme_compliance_01_v1',
      orgId: 'org_acme',
      principalId: 'user_compliance_01',
      agentId: 'agent_mandate_v1',
      status: 'ACTIVE',
      issuedAt: '2026-07-20T00:00:00+08:00',
      expiresAt: FUTURE,
      allowedTools: [
        'request_emissions',
        'fetch_supplier_response',
        'ingest_pcf_payload',
        'submit_cbam_draft',
      ],
      deniedTools: ['commit_cbam_draft', 'export_sensitive', 'change_mandate'],
      deniedSuppliers: ['supplier_blocked_99'],
      constraints: {
        requirePcfQualityGate: true,
        credentialTypes: ['CarbonPCF', 'ESGAttestation'],
      },
    },
    overrides || {}
  );
}

const greenPayload = {
  supplierId: 'supplier_green_01',
  tCO2e: 12.4,
  unit: 'tCO2e',
  method: 'ISO14067',
  boundary: 'cradle-to-gate',
  period: '2025-01-01/2025-12-31',
  cnCode: '73181500',
  emissionPerUnit: 0.042,
  verificationStatus: 'verified',
  verificationReportId: 'VER-2025-GREEN-001',
};

const incompletePayload = {
  supplierId: 'supplier_unverified_01',
  tCO2e: 8.1,
};

const fakeVerifiedNoReport = {
  ...greenPayload,
  verificationReportId: '',
};

function run(label, expectedDecision, expectedPolicyId, ctx) {
  const out = evaluate(ctx);
  const ok = out.decision === expectedDecision && out.policyId === expectedPolicyId;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(
    `${mark}  ${label}  → ${out.decision}/${out.policyId}` +
      (ok ? '' : `  (expected ${expectedDecision}/${expectedPolicyId})`)
  );
  return ok;
}

let failed = 0;

function check(label, expectedDecision, expectedPolicyId, ctx) {
  if (!run(label, expectedDecision, expectedPolicyId, ctx)) failed += 1;
}

const stagingGreen = new Map([['supplier_green_01', { ...greenPayload }]]);
const revokedGreen = new Set(['supplier_green_01']);
const requestsGreen = new Set(['supplier_green_01']);

check('1 ingest incomplete', 'DENY_CONSTRAINT', 'POL-CARB-001', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'ingest_pcf_payload',
  input: incompletePayload,
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
});

check('2 ingest green complete', 'ALLOW', 'POL-ALLOW-000', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'ingest_pcf_payload',
  input: greenPayload,
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
});

check('3 submit_cbam_draft HITL', 'PENDING_HUMAN', 'POL-HITL-010', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'submit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: new Set(),
  emissionsRequests: requestsGreen,
});

check('4 agent commit_cbam_draft', 'DENY_POLICY', 'POL-GATE-000', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'commit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: new Set(),
  emissionsRequests: requestsGreen,
});

check('5 submit after share revoke', 'DENY_POLICY', 'POL-REV-010', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'submit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: revokedGreen,
  emissionsRequests: requestsGreen,
});

check('6 mandate revoked', 'DENY_REVOKED', 'POL-AUTH-001', {
  mandate: baseMandate({ status: 'REVOKED' }),
  actor: agentActor,
  principal,
  agent,
  toolName: 'request_emissions',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
});

check('7 fetch without request', 'DENY_CONSTRAINT', 'POL-REQ-001', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'fetch_supplier_response',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
});

check('8 fetch with request', 'ALLOW', 'POL-ALLOW-000', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'fetch_supplier_response',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: requestsGreen,
});

check('9 verified without report', 'DENY_CONSTRAINT', 'POL-CARB-002', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'ingest_pcf_payload',
  input: fakeVerifiedNoReport,
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
});

const sysActor = {
  actorId: 'system',
  actorType: 'SYSTEM',
  onBehalfOf: 'user_compliance_01',
};

check('10 commit after share revoke', 'DENY_POLICY', 'POL-REV-010', {
  mandate: baseMandate(),
  actor: sysActor,
  principal,
  agent,
  toolName: 'commit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: revokedGreen,
  emissionsRequests: requestsGreen,
  approval: {
    status: 'APPROVED',
    consumedAt: null,
    mandateId: 'mandate_acme_compliance_01_v1',
    type: 'CBAM',
    payload: { supplierId: 'supplier_green_01' },
  },
});

check('11 export after share revoke', 'DENY_POLICY', 'POL-REV-010', {
  mandate: baseMandate(),
  actor: { actorId: 'user_approver_01', actorType: 'HUMAN', onBehalfOf: 'user_compliance_01' },
  principal,
  agent,
  toolName: 'export_client_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: revokedGreen,
  emissionsRequests: requestsGreen,
});

const stagingRevoked = new Map([
  [
    'supplier_green_01',
    { ...greenPayload, revoked: true },
  ],
]);

check('12 submit staged revoked flag', 'DENY_CONSTRAINT', 'POL-CARB-001', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'submit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingRevoked,
  revokedShares: new Set(),
  emissionsRequests: requestsGreen,
});

const vleiDemoSupplierRevoked = {
  supplierId: 'supplier_vlei_demo_01',
  orgName: 'vLEI 示範供應商',
  vlei: {
    lei: '5299000VLEID0DEMO089',
    legalEntityCredential: { credentialId: 'vc_le_vleidemo01', status: 'REVOKED', expiresAt: FUTURE },
    roleCredentials: [
      { credentialId: 'vc_ecr_vleidemo01_carbon', issuerCredentialId: 'vc_le_vleidemo01', status: 'REVOKED', expiresAt: FUTURE },
    ],
  },
};

check('13 ingest after vLEI legal entity revoked', 'DENY_CONSTRAINT', 'POL-CRED-001', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'ingest_pcf_payload',
  input: { ...greenPayload, supplierId: 'supplier_vlei_demo_01' },
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
  getSupplier: (id) => (id === 'supplier_vlei_demo_01' ? vleiDemoSupplierRevoked : null),
});

check('14 ingest green (no vlei check regression)', 'ALLOW', 'POL-ALLOW-000', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'ingest_pcf_payload',
  input: greenPayload,
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
  getSupplier: () => ({ supplierId: 'supplier_green_01', orgName: '青禾零件股份有限公司' }),
});

function traceCheck(label, expectedStep, expectedPolicyId, ctx) {
  const out = evaluateWithTrace(ctx);
  const failStep = out.trace.find((t) => t.status === 'fail' || t.status === 'pending');
  const stepOk = failStep && failStep.step === expectedStep;
  const policyOk = out.policyId === expectedPolicyId;
  const ok = stepOk && policyOk;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(
    `${mark}  trace ${label}  → step ${failStep ? failStep.step : '?'}/${out.policyId}` +
      (ok ? '' : `  (expected step ${expectedStep}/${expectedPolicyId})`)
  );
  if (!ok) failed += 1;
}

traceCheck('T1 ingest incomplete step4', 4, 'POL-CARB-001', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'ingest_pcf_payload',
  input: incompletePayload,
  now: NOW,
  staging: new Map(),
  revokedShares: new Set(),
  emissionsRequests: new Set(),
});

traceCheck('T2 agent commit step2', 2, 'POL-GATE-000', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'commit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: new Set(),
  emissionsRequests: requestsGreen,
});

traceCheck('T3 fetch after revoke step4', 4, 'POL-REV-010', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'fetch_supplier_response',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: new Map(),
  revokedShares: revokedGreen,
  emissionsRequests: requestsGreen,
});

traceCheck('T4 submit HITL step5', 5, 'POL-HITL-010', {
  mandate: baseMandate(),
  actor: agentActor,
  principal,
  agent,
  toolName: 'submit_cbam_draft',
  input: { supplierId: 'supplier_green_01' },
  now: NOW,
  staging: stagingGreen,
  revokedShares: new Set(),
  emissionsRequests: requestsGreen,
});

console.log('');
if (failed > 0) {
  console.log(`RESULT: ${failed} failed`);
  process.exit(1);
}
console.log('RESULT: all PASS');
process.exit(0);
