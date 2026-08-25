'use strict';

/**
 * tests/dpp/smoke.js — GS1/DPP 分層揭露最小示意（services/dpp + server/workflowApi.js
 * handleDppApi）。跟其他測試套件同一種風格。
 *
 * Day 5 追加②之後，customs 層的 comparison 欄位是有條件的（案件要 READY_FOR_VERIFIER
 * 才給），所以這裡也測兩個分支：條件不成立時的占位訊息、條件成立時的真實比較數字——不是
 * 只測「政策存在」，是真的把案件推到兩種狀態各驗一次。
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const workflowStore = require('../../server/workflowStore');

const CASE_ID = 'CASE-2026-001';
const FULL_YEAR = { coveredFrom: '2026-01-01', coveredTo: '2026-12-31' };
let passed = 0;
let failed = 0;

async function api(path, method = 'GET', role, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (role) headers['x-demo-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://dpp.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleFetchRequest(request);
  assert.ok(response, `API route ${path} should be handled`);
  return { status: response.status, body: await response.json() };
}

function contentBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** 走真實 HTTP 把 Demo 案件推到 READY_FOR_VERIFIER，沿用 tests/trust/smoke.js 同一套模式。 */
async function submitCaseToReady() {
  await api('/api/workflow/reset', 'POST', 'Supplier', {});
  const specs = [
    ['electricity_bill', 'elec.pdf', 'dpp-smoke-elec'],
    ['fuel_ledger', 'fuel.pdf', 'dpp-smoke-fuel'],
    ['production_report', 'prod.pdf', 'dpp-smoke-prod'],
    ['precursor_list', 'prec.pdf', 'dpp-smoke-precursor'],
  ];
  const uploaded = [];
  for (const [type, filename, text] of specs) {
    const response = await api('/api/evidence', 'POST', 'Supplier', {
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
    const response = await api(`/api/evidence/${evidence.evidenceId}/confirm`, 'POST', 'Supplier', { confirmed: true });
    assert.strictEqual(response.status, 200);
  }
  const submit = await api(`/api/cases/${CASE_ID}/submit`, 'POST', 'Supplier', {});
  assert.strictEqual(submit.status, 200);
  const revalidate = await api('/api/workflow/revalidate', 'POST', 'Supplier', {});
  assert.strictEqual(revalidate.status, 200);
  assert.strictEqual(revalidate.body.case.status, 'READY_FOR_VERIFIER');
}

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.stack || error.message}`);
  }
}

async function main() {
  workflowStore.reset();

  await check('public: 不帶任何角色/認證資訊也能查（沒有 x-demo-role header）', async () => {
    const { status, body } = await api(`/api/dpp/cases/${CASE_ID}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.disclosureLevel, 'public');
    assert.ok('compliant' in body);
    assert.ok(!('carbonIntensity' in body), 'public 層不應該看到實際排放強度數字');
  });

  await check('customer: 多看到 carbonIntensity，但看不到 customs 層的 comparison/policyProfileId', async () => {
    const { status, body } = await api(`/api/dpp/cases/${CASE_ID}?role=customer`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.disclosureLevel, 'customer');
    assert.ok(typeof body.carbonIntensity.value === 'number');
    assert.ok(!('comparison' in body), 'customer 層不應該看到海關層級的 comparison');
    assert.ok(!('policyProfileId' in body), 'customer 層不應該看到 policyProfileId');
  });

  await check('customs（政策條件不成立）：案件還沒 READY_FOR_VERIFIER 之前，comparison 是明確占位訊息，不是提前洩漏數字', async () => {
    // main() 一開始的 workflowStore.reset() 讓案件停在 DRAFT，還沒推進到 READY_FOR_VERIFIER。
    const { status, body } = await api(`/api/dpp/cases/${CASE_ID}?role=customs`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.disclosureLevel, 'customs');
    assert.strictEqual(body.comparison.withheld, true, '條件不成立時應該是占位訊息，不是真數字');
    assert.strictEqual(typeof body.comparison.actualIntensity, 'undefined');
    assert.ok(body.policyProfileId, 'shipmentCount/policyProfileId 不受這個條件影響，還是要看得到');
  });

  await check('customs（政策條件成立）：案件推進到 READY_FOR_VERIFIER 之後，comparison 變成真的比較數字', async () => {
    await submitCaseToReady();
    const { status, body } = await api(`/api/dpp/cases/${CASE_ID}?role=customs`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'READY_FOR_VERIFIER');
    assert.strictEqual(body.comparison.withheld, undefined);
    assert.ok(typeof body.comparison.actualIntensity === 'number');
    assert.ok(body.policyProfileId);
  });

  await check('資料一致性：三層看到的 compliant/status 是同一個案件的同一個真相，不會互相矛盾', async () => {
    const [pub, customer, customs] = await Promise.all([
      api(`/api/dpp/cases/${CASE_ID}`),
      api(`/api/dpp/cases/${CASE_ID}?role=customer`),
      api(`/api/dpp/cases/${CASE_ID}?role=customs`),
    ]);
    assert.strictEqual(pub.body.status, customer.body.status);
    assert.strictEqual(customer.body.status, customs.body.status);
    assert.strictEqual(pub.body.compliant, customer.body.compliant);
  });

  await check('攻擊: role 帶不在白名單的值一律拒絕（不是悄悄退回 public）', async () => {
    const { status, body } = await api(`/api/dpp/cases/${CASE_ID}?role=admin`);
    assert.strictEqual(status, 400);
    assert.strictEqual(body.code, 'DPP_ROLE_INVALID');
  });

  await check('不存在的案件回 404，不洩漏任何案件資料形狀', async () => {
    const { status, body } = await api('/api/dpp/cases/CASE-DOES-NOT-EXIST');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.code, 'CASE_NOT_FOUND');
  });

  await check('這個端點不需要 x-demo-role，也不影響既有 /api/cases 仍然需要它', async () => {
    const request = new Request(`http://dpp.test/api/cases/${CASE_ID}`, { method: 'GET' });
    const response = await handleFetchRequest(request);
    assert.strictEqual(response.status, 401, '既有 workflow API 應該還是要求 x-demo-role');
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
