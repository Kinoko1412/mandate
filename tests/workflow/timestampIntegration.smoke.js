'use strict';

/**
 * tests/workflow/timestampIntegration.smoke.js — 驗證 services/timestamp/ 真的接進
 * server/workflowApi.js 的 revalidateCase() 正式流程,對真實 DigiCert 網路送出請求。
 *
 * 跟 tests/trust/smoke.js、tests/workflow/smoke.js 分開(不放進同一支),理由跟
 * tests/trust/zk.smoke.js 分開的理由一樣：這支會真的連外部網路,不能混進預設離線
 * 測試套件,見 docs/trust/RFC3161_TIMESTAMP_PLAN.md 第7節、services/timestamp/*.md。
 *
 * 這支測試自己把 ENABLE_RFC3161_TIMESTAMP 打開(見 server/workflowApi.js 的
 * timestampGateResultIfEnabled()),其餘既有測試套件不設這個變數,預設關閉、不連網路。
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const workflowStore = require('../../server/workflowStore');
const trustAdapter = require('../../server/trustAdapter');

const CASE_ID = 'CASE-2026-001';
const FULL_YEAR = { coveredFrom: '2026-01-01', coveredTo: '2026-12-31' };
let failed = 0;

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

async function api(method, path, role, body) {
  const headers = {};
  if (role) headers['x-demo-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://timestamp-integration.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleFetchRequest(request);
  return { status: response.status, body: await response.json() };
}

function contentBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function submitCaseViaHttp() {
  await api('POST', '/api/workflow/reset', 'Supplier', {});
  const specs = [
    ['electricity_bill', 'elec.pdf', 'ts-integration-elec'],
    ['fuel_ledger', 'fuel.pdf', 'ts-integration-fuel'],
    ['production_report', 'prod.pdf', 'ts-integration-prod'],
    ['precursor_list', 'prec.pdf', 'ts-integration-precursor'],
  ];
  const uploaded = [];
  for (const [type, filename, text] of specs) {
    const response = await api('POST', '/api/evidence', 'Supplier', {
      caseId: CASE_ID,
      filename,
      mediaType: 'application/pdf',
      contentBase64: contentBase64(text),
      metadata: { type, coveredFrom: FULL_YEAR.coveredFrom, coveredTo: FULL_YEAR.coveredTo, source: 'demo' },
    });
    assert.strictEqual(response.status, 201);
    uploaded.push(response.body.evidence);
  }
  for (const evidence of uploaded) {
    const response = await api('POST', `/api/evidence/${evidence.evidenceId}/confirm`, 'Supplier', { confirmed: true });
    assert.strictEqual(response.status, 200);
  }
  const submit = await api('POST', `/api/cases/${CASE_ID}/submit`, 'Supplier', {});
  assert.strictEqual(submit.status, 200);
}

function latestAuditEvent(action) {
  const events = workflowStore.listAudit(CASE_ID).filter((event) => event.action === action);
  assert.ok(events.length > 0, `應該至少有一筆 ${action} 稽核紀錄`);
  return events[events.length - 1];
}

async function main() {
  trustAdapter.resetEvaluatorForTests();

  await check('關閉開關時(預設):revalidate 到 GATE_OK 但 timestampProof 是 null,不連網路', async () => {
    delete process.env.ENABLE_RFC3161_TIMESTAMP;
    await submitCaseViaHttp();
    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
    const event = latestAuditEvent('WORKFLOW_REVALIDATE');
    assert.strictEqual(event.timestampProof, null);
  });

  await check('開啟開關後:revalidate 到 GATE_OK 時真的對 DigiCert 取得時戳並寫進稽核紀錄', async () => {
    process.env.ENABLE_RFC3161_TIMESTAMP = 'true';
    await submitCaseViaHttp();
    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');

    const event = latestAuditEvent('WORKFLOW_REVALIDATE');
    assert.ok(event.timestampProof, 'timestampProof 不應為 null');
    assert.strictEqual(event.timestampProof.status, 'ok');
    assert.strictEqual(event.timestampProof.tsaUrl, 'http://timestamp.digicert.com');
    assert.ok(event.timestampProof.tsToken, 'tsToken 不應為空');

    // revalidate 的 HTTP 回應本體不應該包含 tsToken(那是內部稽核紀錄的欄位，
    // 不是要曝露給前端/使用者的東西——目前 API 契約沒有把它接出去，這裡順便確認
    // 沒有意外外洩)。
    const serialized = JSON.stringify(revalidate.body);
    assert.ok(!serialized.includes(event.timestampProof.tsToken), 'tsToken 不應出現在 revalidate 回應本體');
  });

  await check('關閉開關後(不留副作用):再次 revalidate 回到 null,不因為前一項測試打開過就一直連網路', async () => {
    delete process.env.ENABLE_RFC3161_TIMESTAMP;
    await submitCaseViaHttp();
    const revalidate = await api('POST', '/api/workflow/revalidate', 'Supplier', {});
    assert.strictEqual(revalidate.status, 200);
    const event = latestAuditEvent('WORKFLOW_REVALIDATE');
    assert.strictEqual(event.timestampProof, null);
  });

  console.log(failed ? `\n${failed} FAILED` : '\nRESULT: all PASS');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('未預期的錯誤:', err);
  process.exitCode = 1;
});
