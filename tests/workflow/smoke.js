'use strict';

const assert = require('assert');
const crypto = require('crypto');
const normalFixture = require('../../fixtures/normal.json');
const { handleFetchRequest } = require('../../server/apiFetch');
const workflowStore = require('../../server/workflowStore');
const trustAdapter = require('../../server/trustAdapter');

const CASE_ID = 'CASE-2026-001';
const VERIFIER_ID = 'demo-verifier-001';
let failed = 0;

async function api(method, path, role, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (role) headers['x-demo-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://workflow.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleFetchRequest(request);
  assert.ok(response, `API route ${path} should be handled`);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.stack || error.message}`);
  }
}

function expectStableError(response, code) {
  assert.strictEqual(response.body.code, code);
  assert.strictEqual(typeof response.body.message, 'string');
  assert.strictEqual(typeof response.body.retryable, 'boolean');
  assert.ok(Object.prototype.hasOwnProperty.call(response.body, 'details'));
  const serialized = JSON.stringify(response.body);
  assert.ok(!serialized.includes('stack'));
  assert.ok(!serialized.includes('contentBase64'));
}

function contentBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function expectedHash(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

async function uploadEvidence(type, filename, text) {
  return api('POST', '/api/evidence', 'Supplier', {
    caseId: CASE_ID,
    filename,
    mediaType: 'application/pdf',
    contentBase64: contentBase64(text),
    metadata: {
      type,
      coveredFrom: '2026-01-01',
      coveredTo: '2026-12-31',
      source: `demo-${type}`,
    },
  });
}

async function createGrant(evidenceId, lifetimeMs = 60_000) {
  return api('POST', '/api/vault/grants', 'Supplier', {
    caseId: CASE_ID,
    evidenceIds: [evidenceId],
    subject: VERIFIER_ID,
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
  });
}

async function main() {
  await check('reset: Demo workflow 可重跑且初始不是 READY', async () => {
    const response = await api('POST', '/api/workflow/reset', 'Supplier', {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.case.status, 'DRAFT');
    assert.strictEqual(response.body.case.readiness, 'not_verified');
  });

  await check('reset: 僅 Supplier 可重置 Demo workflow', async () => {
    const response = await api('POST', '/api/workflow/reset', 'Importer', {});
    assert.strictEqual(response.status, 403);
    expectStableError(response, 'ROLE_FORBIDDEN');
  });

  await check('submit: 缺件失敗後 server 案件狀態同步為 NEEDS_EVIDENCE', async () => {
    const submit = await api('POST', `/api/cases/${CASE_ID}/submit`, 'Supplier', {});
    assert.strictEqual(submit.status, 422);
    expectStableError(submit, 'EVIDENCE_MISSING');
    const detail = await api('GET', `/api/cases/${CASE_ID}`, 'Supplier');
    assert.strictEqual(detail.body.case.status, 'NEEDS_EVIDENCE');
    await api('POST', '/api/workflow/reset', 'Supplier', {});
  });

  await check('store: service setter 驗證名稱、狀態與 verification 且不暴露 root state', async () => {
    assert.strictEqual(workflowStore.getState, undefined);
    assert.throws(
      () => workflowStore.setServiceStatus('registry', { status: 'available' }),
      TypeError
    );
    assert.throws(
      () => workflowStore.setServiceStatus('proof', { status: 'ready' }),
      TypeError
    );
    assert.throws(
      () => workflowStore.setServiceStatus('gate', { verification: 'trusted' }),
      TypeError
    );
    assert.throws(
      () => workflowStore.setTrustServices({
        proof: { status: 'available', verification: 'verified' },
        attacker: { status: 'available', verification: 'verified' },
      }),
      TypeError
    );
  });

  await check('trust adapter: available 明確拒絕 not_verified', async () => {
    assert.throws(
      () => trustAdapter.validateResult({
        proof: {
          status: 'available',
          verification: 'not_verified',
          checks: [],
          reasonCodes: [],
        },
        gate: {
          status: 'unavailable',
          verification: 'not_verified',
          checks: [],
          reasonCodes: ['GATE_SERVICE_UNAVAILABLE'],
        },
      }),
      /Available trust adapter service must be verified or failed/
    );
  });

  await check('auth: 未指定 Demo role 會由 server 拒絕', async () => {
    const response = await api('GET', '/api/cases');
    assert.strictEqual(response.status, 401);
    expectStableError(response, 'DEMO_ROLE_REQUIRED');
    assert.strictEqual(response.body.details.demoOnly, true);
  });

  await check('apiFetch: Node Request 相容物支援 demoRole query whitelist', async () => {
    const response = await api('GET', '/api/cases?demoRole=Supplier');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.actor.role, 'Supplier');
    assert.strictEqual(response.body.actor.demoOnly, true);
    assert.strictEqual(response.body.cases.length, 1);
  });

  await check('apiFetch: 無效 JSON 也回穩定且不含輸入內容的錯誤', async () => {
    const response = await handleFetchRequest(
      new Request('http://workflow.test/api/evidence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-demo-role': 'Supplier',
        },
        body: '{"contentBase64":"secret-content"',
      })
    );
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    expectStableError({ body }, 'INVALID_JSON');
    assert.ok(!JSON.stringify(body).includes('secret-content'));
  });

  const uploads = [];
  const uploadSpecs = [
    ['electricity_bill', 'secret-electricity.pdf', 'electricity demo evidence'],
    ['fuel_ledger', 'secret-fuel.pdf', 'fuel demo evidence'],
    ['production_report', 'secret-production.pdf', 'production demo evidence'],
    ['precursor_list', 'secret-precursor.pdf', 'precursor demo evidence'],
  ];

  await check('evidence: Supplier 上傳 4 份文件並取得正確 SHA-256', async () => {
    for (const [type, filename, text] of uploadSpecs) {
      const response = await uploadEvidence(type, filename, text);
      assert.strictEqual(response.status, 201);
      assert.strictEqual(response.body.evidence.fileHash, expectedHash(text));
      assert.match(response.body.evidence.fileHash, /^sha256:[0-9a-f]{64}$/);
      assert.ok(!Object.prototype.hasOwnProperty.call(response.body.evidence, 'contentBase64'));
      uploads.push(response.body.evidence);
    }
    assert.strictEqual(new Set(uploads.map((item) => item.fileHash)).size, 4);
  });

  await check('evidence: 同名文件不可靜默覆寫', async () => {
    const response = await uploadEvidence(
      'electricity_bill',
      'secret-electricity.pdf',
      'replacement'
    );
    assert.strictEqual(response.status, 409);
    expectStableError(response, 'EVIDENCE_ALREADY_EXISTS');
  });

  await check('evidence: 類型與大小限制在 server-side 執行', async () => {
    const wrongType = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename: 'malware.exe',
      mediaType: 'application/x-msdownload',
      contentBase64: contentBase64('not executable'),
      metadata: {
        type: 'fuel_ledger',
        coveredFrom: '2026-01-01',
        coveredTo: '2026-12-31',
        source: 'demo',
      },
    });
    assert.strictEqual(wrongType.status, 400);
    expectStableError(wrongType, 'MEDIA_TYPE_NOT_ALLOWED');

    const oversized = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename: 'oversized.pdf',
      mediaType: 'application/pdf',
      contentBase64: Buffer.alloc(512 * 1024 + 1, 1).toString('base64'),
      metadata: {
        type: 'fuel_ledger',
        coveredFrom: '2026-01-01',
        coveredTo: '2026-12-31',
        source: 'demo',
      },
    });
    assert.strictEqual(oversized.status, 400);
    expectStableError(oversized, 'EVIDENCE_TOO_LARGE');
  });

  await check('mask: Importer detail 不含 vaultRef、token、內容或完整檔名', async () => {
    const response = await api('GET', `/api/cases/${CASE_ID}`, 'Importer');
    assert.strictEqual(response.status, 200);
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      'vaultRef',
      'contentBase64',
      'secret-electricity.pdf',
      'secret-fuel.pdf',
      'secret-production.pdf',
      'secret-precursor.pdf',
      '"token"',
      'calculationReceipt',
      'totalEmissionsScaled',
      'sourceHash',
    ]) {
      assert.ok(!serialized.includes(forbidden), `Importer response leaked ${forbidden}`);
    }
  });

  await check('auth: Importer 不可確認 Supplier 證據', async () => {
    const response = await api(
      'POST',
      `/api/evidence/${uploads[0].evidenceId}/confirm`,
      'Importer',
      { confirmed: true }
    );
    assert.strictEqual(response.status, 404);
    expectStableError(response, 'EVIDENCE_NOT_FOUND');
  });

  await check('supplier: 4 份證據人工確認後提交', async () => {
    for (const evidence of uploads) {
      const response = await api(
        'POST',
        `/api/evidence/${evidence.evidenceId}/confirm`,
        'Supplier',
        { confirmed: true }
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.evidence.humanConfirmed, true);
    }
    const submit = await api('POST', `/api/cases/${CASE_ID}/submit`, 'Supplier', {});
    assert.strictEqual(submit.status, 200);
    assert.strictEqual(submit.body.case.carbon.annual.emissions, 360);
    assert.deepStrictEqual(
      submit.body.case.carbon.shipments.map((shipment) => shipment.allocatedEmissions),
      [180, 108]
    );
    assert.deepStrictEqual(
      submit.body.case.carbon.shipments.map((shipment) => shipment.allocationStatus),
      ['METHOD_REVIEW', 'METHOD_REVIEW']
    );
    assert.ok(!JSON.stringify(submit.body).includes('READY_FOR_VERIFIER'));
  });

  await check('fallback: Agent/Proof/Gate unavailable 不會誤標 READY', async () => {
    const response = await api('GET', `/api/cases/${CASE_ID}`, 'Supplier');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.case.status, 'METHOD_REVIEW');
    assert.strictEqual(response.body.case.readiness, 'not_verified');
    for (const adapter of Object.values(response.body.case.services)) {
      assert.strictEqual(adapter.status, 'unavailable');
      assert.strictEqual(adapter.verification, 'not_verified');
    }
    assert.notStrictEqual(response.body.case.status, 'READY_FOR_VERIFIER');
    assert.match(response.body.case.readyDisclaimer, /不代表正式查驗完成/);
  });

  await check('revalidate: 僅 Supplier 可觸發 server-side trust 重驗', async () => {
    const response = await api('POST', '/api/workflow/revalidate', 'Importer', {});
    assert.strictEqual(response.status, 403);
    expectStableError(response, 'ROLE_FORBIDDEN');
  });

  await check('revalidate: Agent unavailable 但 mock Proof+Gate verified 可 READY', async () => {
    trustAdapter.setEvaluatorForTests(async ({ inputHash }) => ({
      proof: {
        status: 'available',
        verification: 'verified',
        checks: [{ name: 'proof-contract', status: 'pass' }],
        reasonCodes: [],
        inputHash,
      },
      gate: {
        status: 'available',
        verification: 'verified',
        checks: [{ name: 'policy-profile', status: 'pass' }],
        reasonCodes: [],
        inputHash,
      },
    }));
    const response = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.case.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(response.body.case.readiness, 'verified');
    assert.strictEqual(response.body.case.services.agent.status, 'unavailable');
    assert.strictEqual(response.body.case.services.proof.verification, 'verified');
    assert.strictEqual(response.body.case.services.gate.verification, 'verified');
    assert.match(response.body.case.readyDisclaimer, /不代表正式查驗完成/);
  });

  await check('revalidate: adapter hard failure 維持 BLOCKED 與穩定 reason code', async () => {
    trustAdapter.setEvaluatorForTests(async () => {
      throw new Error('internal adapter detail must not escape');
    });
    const response = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.case.status, 'BLOCKED');
    assert.strictEqual(response.body.case.readiness, 'failed');
    assert.deepStrictEqual(response.body.readiness.reasonCodes, ['TRUST_ADAPTER_FAILURE']);
    assert.ok(!JSON.stringify(response.body).includes('internal adapter detail'));
  });

  await check('revalidate: default adapter 回 unavailable 且不會 READY', async () => {
    trustAdapter.resetEvaluatorForTests();
    const response = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.case.status, 'METHOD_REVIEW');
    assert.strictEqual(response.body.case.readiness, 'not_verified');
    assert.deepStrictEqual(response.body.readiness.reasonCodes, ['SERVICE_UNAVAILABLE']);
  });

  await check('carbon adapter API: 未知單位回穩定 UNKNOWN_UNIT', async () => {
    const response = await api(
      'POST',
      '/api/workflow/carbon/preview',
      'Supplier',
      {
        caseId: CASE_ID,
        installationYear: {
          ...normalFixture.installationYear,
          productionUnit: 'kg',
        },
      }
    );
    assert.strictEqual(response.status, 422);
    expectStableError(response, 'UNKNOWN_UNIT');
  });

  await check('carbon adapter API: preview 標示不落地與 client supplied input', async () => {
    const response = await api(
      'POST',
      '/api/workflow/carbon/preview',
      'Supplier',
      {
        caseId: CASE_ID,
        installationYear: normalFixture.installationYear,
        shipments: normalFixture.shipments,
      }
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.previewOnly, true);
    assert.strictEqual(response.body.clientSuppliedInput, true);
  });

  await check('carbon adapter API: 重算強度不一致回 422 INTENSITY_MISMATCH', async () => {
    const response = await api(
      'POST',
      '/api/workflow/carbon/preview',
      'Supplier',
      {
        caseId: CASE_ID,
        installationYear: {
          ...normalFixture.installationYear,
          verifiedIntensity: 0.1,
        },
        shipments: normalFixture.shipments,
      }
    );
    assert.strictEqual(response.status, 422);
    expectStableError(response, 'INTENSITY_MISMATCH');
  });

  await check('carbon adapter API: 超額分攤回穩定 reason code', async () => {
    const shipments = normalFixture.shipments.map((shipment, index) => ({
      ...shipment,
      quantityTonnes: index === 0 ? 150 : 60,
    }));
    const response = await api(
      'POST',
      '/api/workflow/carbon/preview',
      'Supplier',
      {
        caseId: CASE_ID,
        installationYear: normalFixture.installationYear,
        shipments,
      }
    );
    assert.strictEqual(response.status, 422);
    expectStableError(response, 'ALLOCATION_EXCEEDS_PRODUCTION');
  });

  await check('importer summary: actual/default 為 Demo 且沒有底稿', async () => {
    const response = await api(
      'GET',
      `/api/importer/cases/${CASE_ID}/summary`,
      'Importer'
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.comparison.actualIntensity, 1.8);
    assert.strictEqual(response.body.comparison.demoOnly, true);
    assert.deepStrictEqual(
      response.body.case.shipments.map((shipment) => shipment.allocationStatus),
      ['METHOD_REVIEW', 'METHOD_REVIEW']
    );
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes('contentBase64'));
    assert.ok(!serialized.includes('vaultRef'));
    assert.ok(!serialized.includes('secret-electricity.pdf'));
    assert.ok(!serialized.includes('calculationReceipt'));
    assert.ok(!serialized.includes('totalEmissionsScaled'));
    assert.ok(!serialized.includes('sourceHash'));
    assert.ok(!serialized.includes('READY_FOR_VERIFIER'));
  });

  await check('verifier: annual receipt 僅揭露 inputHash 與 methodVersion', async () => {
    const response = await api('GET', `/api/cases/${CASE_ID}`, 'Verifier');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(
      Object.keys(response.body.case.annualSummary.calculationReceipt).sort(),
      ['inputHash', 'methodVersion']
    );
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes('totalEmissionsScaled'));
    assert.ok(!serialized.includes('sourceHash'));
    assert.ok(!serialized.includes('READY_FOR_VERIFIER'));
  });

  await check('verifier: Evidence Index 可見 metadata 但不含原始內容', async () => {
    const response = await api(
      'GET',
      `/api/verifier/cases/${CASE_ID}/evidence`,
      'Verifier'
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.evidenceIndex.length, 4);
    assert.ok(response.body.evidenceIndex[0].filename);
    assert.ok(!JSON.stringify(response.body).includes('contentBase64'));
  });

  let oneTimeGrant;
  await check('vault: Grant 綁定 Verifier subject、短效且 token 只回一次', async () => {
    const response = await createGrant(uploads[0].evidenceId);
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.grant.subjectActorId, VERIFIER_ID);
    assert.strictEqual(response.body.grant.oneTime, true);
    assert.strictEqual(typeof response.body.token, 'string');
    assert.ok(!JSON.stringify(response.body.grant).includes('tokenHash'));
    oneTimeGrant = response.body;
  });

  await check('vault: Importer 即使拿到 token 仍因角色被拒且不洩漏 metadata', async () => {
    const response = await api(
      'GET',
      `/api/vault/items/${uploads[0].evidenceId}`,
      'Importer',
      undefined,
      { 'x-vault-token': oneTimeGrant.token }
    );
    assert.strictEqual(response.status, 403);
    expectStableError(response, 'GRANT_INVALID');
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes('secret-electricity.pdf'));
    assert.ok(!serialized.includes(oneTimeGrant.token));
  });

  await check('vault: Verifier 可開啟一次；重用於 download 被拒', async () => {
    const opened = await api(
      'GET',
      `/api/vault/items/${uploads[0].evidenceId}`,
      'Verifier',
      undefined,
      { 'x-vault-token': oneTimeGrant.token }
    );
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(
      Buffer.from(opened.body.evidence.contentBase64, 'base64').toString('utf8'),
      uploadSpecs[0][2]
    );
    const reused = await api(
      'GET',
      `/api/vault/items/${uploads[0].evidenceId}/download`,
      'Verifier',
      undefined,
      { 'x-vault-token': oneTimeGrant.token }
    );
    assert.strictEqual(reused.status, 403);
    expectStableError(reused, 'GRANT_INVALID');
  });

  await check('vault: 撤銷 Grant 後拒絕開啟', async () => {
    const created = await createGrant(uploads[1].evidenceId);
    const revoked = await api(
      'POST',
      `/api/vault/grants/${created.body.grant.grantId}/revoke`,
      'Supplier',
      {}
    );
    assert.strictEqual(revoked.status, 200);
    const opened = await api(
      'GET',
      `/api/vault/items/${uploads[1].evidenceId}`,
      'Verifier',
      undefined,
      { 'x-vault-token': created.body.token }
    );
    assert.strictEqual(opened.status, 403);
    expectStableError(opened, 'GRANT_REVOKED');
  });

  await check('vault: download 成功同樣消耗一次性 Grant', async () => {
    const created = await createGrant(uploads[3].evidenceId);
    assert.strictEqual(created.status, 201);
    const downloaded = await api(
      'GET',
      `/api/vault/items/${uploads[3].evidenceId}/download`,
      'Verifier',
      undefined,
      { 'x-vault-token': created.body.token }
    );
    assert.strictEqual(downloaded.status, 200);
    assert.strictEqual(downloaded.body.access.mode, 'download');
    assert.strictEqual(downloaded.body.access.oneTime, true);
  });

  await check('vault: 過期 Grant 被拒且不洩漏 metadata', async () => {
    const created = await createGrant(uploads[2].evidenceId, 40);
    assert.strictEqual(created.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const opened = await api(
      'GET',
      `/api/vault/items/${uploads[2].evidenceId}`,
      'Verifier',
      undefined,
      { 'x-vault-token': created.body.token }
    );
    assert.strictEqual(opened.status, 403);
    expectStableError(opened, 'GRANT_EXPIRED');
    assert.ok(!JSON.stringify(opened.body).includes('secret-production.pdf'));
  });

  await check('verifier: 可新增結構化 finding', async () => {
    const response = await api(
      'POST',
      `/api/verifier/cases/${CASE_ID}/findings`,
      'Verifier',
      { summary: '請補充來源說明。', severity: 'warning' }
    );
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.finding.severity, 'warning');
  });

  await check('audit: open/download/deny/revoke/finding 全留痕且無 token/content', async () => {
    const response = await api('GET', `/api/cases/${CASE_ID}/audit`, 'Supplier');
    assert.strictEqual(response.status, 200);
    const actions = response.body.events.map((event) => `${event.action}:${event.result}`);
    for (const expected of [
      'VAULT_OPEN:ALLOW',
      'VAULT_OPEN:DENY',
      'VAULT_DOWNLOAD:ALLOW',
      'VAULT_DOWNLOAD:DENY',
      'VAULT_GRANT_REVOKE:ALLOW',
      'VERIFIER_FINDING_CREATE:ALLOW',
    ]) {
      assert.ok(actions.includes(expected), `missing audit ${expected}`);
    }
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes(oneTimeGrant.token));
    assert.ok(!serialized.includes('contentBase64'));
    assert.ok(!serialized.includes('secret-electricity.pdf'));
  });
}

main()
  .then(() => {
    console.log('');
    if (failed > 0) {
      console.log(`RESULT: ${failed} failed`);
      process.exit(1);
    }
    console.log('RESULT: all PASS');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
  });
