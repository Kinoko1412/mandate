'use strict';

/**
 * services/notify/google.js — 純函式的 Google OAuth / Gmail / Calendar 呼叫層。
 *
 * 這裡完全不碰任何伺服器端狀態（token 存放在 server/googleTokens.js，route 層在
 * server/workflowApi.js）——只負責「怎麼組出正確的 HTTP 請求、怎麼把 Google 的錯誤
 * 包成穩定格式」，方便測試時單獨替換 global.fetch 做 mock。
 */

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// 刻意只要最小夠用的兩個 scope——寄信＋寫入行事曆，不要求讀信、不要求登入身份（身份已經
// 由 vLEI/WebAuthn 那條線處理，這裡的 OAuth 純粹是「借 Google 帳號的通知管道」）。
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

class GoogleNotifyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'GoogleNotifyError';
    this.code = code;
    this.details = details;
  }
}

function stableGoogleError(error) {
  if (error instanceof GoogleNotifyError) {
    return { code: error.code, message: error.message, retryable: false, details: error.details };
  }
  return {
    code: 'GOOGLE_NOTIFY_FAILED',
    message: 'Google 通知服務暫時無法完成。',
    retryable: false,
    details: null,
  };
}

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    // 每次都強制走一次同意畫面，確保每次連接都拿得到 refresh_token（不然只有第一次
    // 授權會給，之後重連會拿到空值，導致 access_token 過期後就再也刷新不了）。
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    throw new GoogleNotifyError('GOOGLE_TOKEN_EXCHANGE_FAILED', 'Google OAuth 換取 token 失敗。', body);
  }
  return body; // { access_token, refresh_token?, expires_in, scope, token_type }
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    throw new GoogleNotifyError(
      'GOOGLE_TOKEN_REFRESH_FAILED',
      'Google access token 刷新失敗，請重新連接。',
      body
    );
  }
  return body;
}

async function revokeToken(token) {
  if (!token) return;
  // Best-effort：撤銷失敗（例如 token 早就失效）不影響本地清除連線狀態。
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToBinary(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

function utf8ToBase64(str) {
  return btoa(bytesToBinary(utf8Bytes(str)));
}

function utf8ToBase64Url(str) {
  return utf8ToBase64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sendGmail({ accessToken, to, subject, bodyText }) {
  const headers = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${utf8ToBase64(subject)}?=`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ].join('\r\n');
  const raw = utf8ToBase64Url(`${headers}\r\n\r\n${bodyText}`);
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new GoogleNotifyError('GMAIL_SEND_FAILED', 'Gmail 寄送失敗。', body);
  }
  return body; // { id, threadId, labelIds }
}

async function createCalendarEvent({ accessToken, summary, description, startIso, endIso }) {
  const res = await fetch(CALENDAR_EVENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startIso },
      end: { dateTime: endIso },
      reminders: { useDefault: true },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new GoogleNotifyError('CALENDAR_EVENT_FAILED', 'Google Calendar 建立提醒失敗。', body);
  }
  return body; // { id, htmlLink, ... }
}

module.exports = {
  GoogleNotifyError,
  SCOPES,
  stableGoogleError,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
  sendGmail,
  createCalendarEvent,
};
