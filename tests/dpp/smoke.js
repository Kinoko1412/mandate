'use strict';

/**
 * tests/dpp/smoke.js — GS1/DPP 分層揭露最小示意（services/dpp + server/workflowApi.js
 * handleDppApi）。跟其他測試套件同一種風格。
 */

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const workflowStore = require('../../server/workflowStore');

const CASE_ID = 'CASE-2026-001';
let passed = 0;
let failed = 0;

async function api(path, extraHeaders = {}) {
  const request = new Request(`http://dpp.test${path}`, { method: 'GET', headers: extraHeaders });
  const response = await handleFetchRequest(request);
  assert.ok(response, `API route ${path} should be handled`);
  return { status: response.status, body: await response.json() };
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

  await check('customs: 看得到完整比較資訊（等同既有 Importer 摘要深度）', async () => {
    const { status, body } = await api(`/api/dpp/cases/${CASE_ID}?role=customs`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.disclosureLevel, 'customs');
    assert.ok(body.comparison && typeof body.comparison.actualIntensity === 'number');
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
