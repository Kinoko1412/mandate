'use strict';

/**
 * tests/timestamp/rfc3161.integration.smoke.js — 對真實 DigiCert TSA 端點的端到端測試。
 *
 * 依賴外部網路服務(timestamp.digicert.com),**不放進預設 `npm test`**(這個 repo 沒有
 * `npm test` 聚合腳本,是逐一 `npm run smoke:*`——這支比照 `circuits/workers-compat-check/`
 * 的角色,手動執行或排進獨立 CI job,不是常態跑的單元測試)。
 * 只在 Node 環境跑(`node tests/timestamp/rfc3161.integration.smoke.js`)。
 */

const assert = require('assert');
const { requestTimestamp, verifyTimestamp } = require('../../services/timestamp');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

async function main() {
  const payload = `mandate-rfc3161-smoke-${Date.now()}`;

  let issued;
  await test('DigiCert:成功取得時戳', async () => {
    issued = await requestTimestamp(payload);
    assert.strictEqual(issued.status, 'ok', `預期 status=ok,實際=${issued.status}(${issued.error || issued.httpStatus || ''})`);
    assert.ok(issued.tsToken, 'tsToken 不應為空');
    assert.strictEqual(issued.tsaUrl, 'http://timestamp.digicert.com');
  });

  await test('DigiCert:時戳權杖驗證通過(正確 payload)', async () => {
    const result = await verifyTimestamp({ tsToken: issued.tsToken, payload });
    assert.strictEqual(result.valid, true, `預期驗證通過,reasonCodes=${JSON.stringify(result.reasonCodes)}`);
    assert.ok(result.genTime, 'genTime 應該有值');
  });

  await test('竄改 payload 應驗證失敗', async () => {
    const result = await verifyTimestamp({ tsToken: issued.tsToken, payload: payload + '-tampered' });
    assert.strictEqual(result.valid, false, '竄改後的 payload 不應該通過驗證');
  });

  await test('Sectigo(備援):成功取得時戳', async () => {
    const sectigoIssued = await requestTimestamp(payload, { tsaProfileId: 'sectigo' });
    assert.strictEqual(sectigoIssued.status, 'ok', `預期 status=ok,實際=${sectigoIssued.status}`);
    const result = await verifyTimestamp({ tsToken: sectigoIssued.tsToken, payload });
    assert.strictEqual(result.valid, true, 'Sectigo 簽發的權杖應驗證通過');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('未預期的錯誤:', err);
  process.exitCode = 1;
});
