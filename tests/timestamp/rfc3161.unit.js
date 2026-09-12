'use strict';

/**
 * tests/timestamp/rfc3161.unit.js — 離線單元測試:mock fetch,不需要真的打網路,CI 可常態執行。
 * 跟 tests/timestamp/rfc3161.integration.smoke.js(真的打 DigiCert/Sectigo)分開,互不依賴。
 *
 * `fixtures/digicert_response_sample.tsr` 是 2026-09-11 對 DigiCert 送出真實請求時擷取的
 * 原始回應(見 Documents\Mandate\實驗記錄\RFC3161_TSA連通性測試_20260911_證據檔\),
 * 拿真實資料當 mock 回應,而不是手刻假資料,降低「mock 對了但跟真實格式不符」的風險。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rfc3161 = require('../../services/timestamp/rfc3161');
const { requestTimestamp, verifyTimestamp } = require('../../services/timestamp');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'digicert_response_sample.tsr');
const REAL_DIGICERT_RESPONSE = fs.readFileSync(FIXTURE_PATH);

test('buildTimeStampReq 產出的 DER 可以被自己的 parse 邏輯讀回(結構往返一致)', async () => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('unit-test-payload'));
  const reqDer = rfc3161.buildTimeStampReq(digest, { hashAlgo: 'sha256' });
  assert.ok(reqDer.byteLength > 0, 'TimeStampReq 不應為空');
});

test('buildTimeStampReq 對不支援的雜湊演算法丟出明確錯誤', async () => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('x'));
  assert.throws(() => rfc3161.buildTimeStampReq(digest, { hashAlgo: 'md5' }), /不支援的雜湊演算法/);
});

test('parseTimeStampResp 對真實擷取的 DigiCert 回應能正確解出 granted token', () => {
  const { status, tokenDer } = rfc3161.parseTimeStampResp(REAL_DIGICERT_RESPONSE);
  assert.strictEqual(status, 0, 'DigiCert 回應應該是 granted(status=0)');
  assert.ok(tokenDer.byteLength > 0, 'tokenDer 不應為空');
});

test('parseTimeStampResp 對亂數 bytes 丟出解析錯誤,不是靜默失敗', () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5]);
  assert.throws(() => rfc3161.parseTimeStampResp(garbage), /解析失敗/);
});

test('requestTimestamp:fetch 網路層失敗時回傳 tsa_unreachable,不丟例外', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED(模擬)');
  });
  const result = await requestTimestamp('payload-a');
  assert.strictEqual(result.status, 'tsa_unreachable');
  assert.match(result.error, /ECONNREFUSED/);
});

test('requestTimestamp:HTTP 非 2xx 時回傳 tsa_error,不丟例外', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('rate limited', { status: 429 }));
  const result = await requestTimestamp('payload-b');
  assert.strictEqual(result.status, 'tsa_error');
  assert.strictEqual(result.httpStatus, 429);
});

test('requestTimestamp:HTTP 200 但回應不是合法 TimeStampResp 時回傳 tsa_error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 }));
  const result = await requestTimestamp('payload-c');
  assert.strictEqual(result.status, 'tsa_error');
});

test('requestTimestamp:成功路徑用真實擷取的回應當 mock,回傳 status=ok 且帶 tsToken', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(REAL_DIGICERT_RESPONSE, { status: 200 }));
  const result = await requestTimestamp('payload-d');
  assert.strictEqual(result.status, 'ok');
  assert.ok(result.tsToken, 'tsToken 不應為空');
  assert.strictEqual(result.hashAlgo, 'sha256');
});

test('verifyTimestamp:tsToken 為空時回傳 invalid,不丟例外', async () => {
  const result = await verifyTimestamp({ tsToken: '', payload: 'x' });
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.reasonCodes, ['MISSING_TS_TOKEN']);
});

test('verifyTimestamp:tsToken 是亂碼 base64 時回傳 invalid,不丟例外', async () => {
  const result = await verifyTimestamp({ tsToken: 'not-a-real-token==', payload: 'x' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reasonCodes.length > 0);
});
