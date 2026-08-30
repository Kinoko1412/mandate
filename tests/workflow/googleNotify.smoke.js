'use strict';

const assert = require('assert');
const { handleFetchRequest } = require('../../server/apiFetch');
const workflowStore = require('../../server/workflowStore');
const googleTokens = require('../../server/googleTokens');

const CASE_ID = 'CASE-2026-001';
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
  return { status: response.status, body: await response.json() };
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
  assert.strictEqual(response.body.code, code, JSON.stringify(response.body));
}

async function main() {
  await api('POST', '/api/workflow/reset', 'Supplier', {});
  googleTokens.reset();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  await check('draft: 案件有缺件時可草擬通知，不需要 Google 已連接', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/draft`, 'Supplier', {});
    assert.strictEqual(response.status, 200);
    assert.ok(response.body.missingLabels.length > 0);
    assert.ok(response.body.email.subject.includes(CASE_ID));
    assert.ok(response.body.calendarReminder.startIso);
  });

  await check('draft: 非 Supplier 無法草擬（requireCase 的角色檢查擋下）', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/draft`, 'Verifier', {});
    assert.strictEqual(response.status, 403);
    expectStableError(response, 'ROLE_FORBIDDEN');
  });

  await check('status: 尚未連接時回報 connected:false', async () => {
    const response = await api('GET', '/api/notify/google/status', 'Supplier');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.connected, false);
  });

  await check('authorize: 未設定 GOOGLE_CLIENT_ID/SECRET 時誠實回報未設定，不是內部錯誤', async () => {
    const response = await api('GET', '/api/oauth/google/authorize', 'Supplier');
    expectStableError(response, 'GOOGLE_OAUTH_NOT_CONFIGURED');
  });

  await check('authorize: 只有 Supplier 能連接 Google 帳號', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    const response = await api('GET', '/api/oauth/google/authorize', 'Verifier');
    expectStableError(response, 'ROLE_FORBIDDEN');
  });

  await check('authorize: 設定完成後回傳導向 Google 同意畫面的網址', async () => {
    const response = await api('GET', '/api/oauth/google/authorize', 'Supplier');
    assert.strictEqual(response.status, 200);
    assert.ok(response.body.authorizeUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
    assert.ok(response.body.authorizeUrl.includes('gmail.send'));
    assert.ok(response.body.authorizeUrl.includes('calendar.events'));
  });

  await check('email: 尚未連接 Google 時明確拒絕，不是內部錯誤', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/email`, 'Supplier', {
      confirm: true,
      to: 'someone@example.com',
      subject: 'test',
      bodyText: 'test',
    });
    assert.strictEqual(response.status, 409);
    expectStableError(response, 'GOOGLE_NOT_CONNECTED');
  });

  await check('email: confirm 不是 true 時拒絕，即使已連接', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/email`, 'Supplier', {
      to: 'someone@example.com',
      subject: 'test',
      bodyText: 'test',
    });
    assert.strictEqual(response.status, 400);
    expectStableError(response, 'HUMAN_CONFIRMATION_REQUIRED');
  });

  await check('email: 收件人格式不正確時拒絕', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/email`, 'Supplier', {
      confirm: true,
      to: 'not-an-email',
      subject: 'test',
      bodyText: 'test',
    });
    assert.strictEqual(response.status, 400);
    expectStableError(response, 'INVALID_NOTIFICATION_PAYLOAD');
  });

  // 接下來的測試要真的走過「已連接 → 呼叫 Gmail/Calendar」這條路徑，但不能真的打
  // Google 的伺服器——注入一把假的、還沒過期的 access token，並暫時替換 global.fetch
  // 回傳固定的假回應。測完務必還原，避免污染其他測試檔案（這個檔案本身也是全域狀態）。
  const originalFetch = global.fetch;
  googleTokens.setTokens({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    scope: 'gmail.send calendar.events',
    connectedBy: 'demo-supplier-001',
  });

  await check('status: 已連接時回報 connected:true 且不外洩 access/refresh token', async () => {
    const response = await api('GET', '/api/notify/google/status', 'Supplier');
    assert.strictEqual(response.body.connected, true);
    assert.strictEqual(response.body.hasRefreshToken, true);
    assert.ok(!JSON.stringify(response.body).includes('fake-access-token'));
    assert.ok(!JSON.stringify(response.body).includes('fake-refresh-token'));
  });

  await check('email: 已連接且 confirm:true 時真的呼叫 Gmail send API（fetch 已 mock）', async () => {
    let calledUrl = null;
    let calledAuth = null;
    global.fetch = async (url, init) => {
      calledUrl = String(url);
      calledAuth = init && init.headers && init.headers.Authorization;
      return {
        ok: true,
        json: async () => ({ id: 'msg-123', threadId: 'thread-123' }),
      };
    };
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/email`, 'Supplier', {
      confirm: true,
      to: 'someone@example.com',
      subject: '缺件通知',
      bodyText: '請補齊文件',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.sent, true);
    assert.strictEqual(response.body.messageId, 'msg-123');
    assert.ok(calledUrl.includes('gmail.googleapis.com'));
    assert.strictEqual(calledAuth, 'Bearer fake-access-token');
  });

  await check('email: Gmail API 回錯時穩定映射成 GMAIL_SEND_FAILED、502', async () => {
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/email`, 'Supplier', {
      confirm: true,
      to: 'someone@example.com',
      subject: 'x',
      bodyText: 'x',
    });
    assert.strictEqual(response.status, 502);
    expectStableError(response, 'GMAIL_SEND_FAILED');
  });

  await check('calendar: 已連接且 confirm:true 時真的呼叫 Calendar events API（fetch 已 mock）', async () => {
    let calledUrl = null;
    global.fetch = async (url) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ id: 'evt-123', htmlLink: 'https://calendar.google.com/evt-123' }) };
    };
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/calendar`, 'Supplier', {
      confirm: true,
      summary: '補件提醒',
      description: 'desc',
      startIso: new Date(Date.now() + 86400000).toISOString(),
      endIso: new Date(Date.now() + 86400000 + 1800000).toISOString(),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.created, true);
    assert.strictEqual(response.body.eventId, 'evt-123');
    assert.ok(calledUrl.includes('calendar/v3/calendars/primary/events'));
  });

  await check('calendar: 過期時間格式不合法時拒絕', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/calendar`, 'Supplier', {
      confirm: true,
      summary: 'x',
      startIso: 'not-a-date',
      endIso: 'not-a-date',
    });
    assert.strictEqual(response.status, 400);
    expectStableError(response, 'INVALID_NOTIFICATION_PAYLOAD');
  });

  await check('disconnect: 清除連線並嘗試撤銷 token（fetch 已 mock）', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    const response = await api('POST', '/api/notify/google/disconnect', 'Supplier', {});
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.connected, false);
    const status = await api('GET', '/api/notify/google/status', 'Supplier');
    assert.strictEqual(status.body.connected, false);
  });

  await check('email: 中斷連接後再送出應回到 GOOGLE_NOT_CONNECTED', async () => {
    const response = await api('POST', `/api/cases/${CASE_ID}/notify/email`, 'Supplier', {
      confirm: true,
      to: 'someone@example.com',
      subject: 'x',
      bodyText: 'x',
    });
    assert.strictEqual(response.status, 409);
    expectStableError(response, 'GOOGLE_NOT_CONNECTED');
  });

  global.fetch = originalFetch;
  googleTokens.reset();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  await check('audit: Google 相關動作全部留下稽核紀錄', async () => {
    const events = workflowStore.listAudit(CASE_ID);
    const actions = events.map((event) => event.action);
    ['GOOGLE_NOTIFY_DRAFT', 'GOOGLE_EMAIL_SEND', 'GOOGLE_CALENDAR_CREATE'].forEach((action) => {
      assert.ok(actions.includes(action), `audit 應包含 ${action}，實際：${actions.join(', ')}`);
    });
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
