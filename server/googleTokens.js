'use strict';

/**
 * server/googleTokens.js — Google OAuth 連線的伺服器端狀態（demoOnly，純記憶體）。
 *
 * 跟 vaultKeys.js 同一種限制：純記憶體、重啟即清空、只支援單一固定連線（這個 demo
 * 只有一個團隊 Google 帳號要連，不是多租戶）。Cloudflare Workers 跨 isolate 不保證共享
 * 記憶體是既有已知限制（見部署段落的說明），這裡沿用同一個假設：demo 操作全程走同一個
 * 瀏覽器分頁/連線時沒有問題，長時間閒置後 isolate 被回收就要重新連接。
 *
 * access_token 只存記憶體、有效期通常 1 小時，外洩風險本來就有時效；refresh_token 沒有
 * 過期時間，是這裡存的東西裡唯一真正敏感、值得在意「伺服器完整讀取」情境的欄位——但這正是
 * OAuth refresh token 該存的地方（跟 GOOGLE_CLIENT_SECRET 一樣是 server-side secret 等級），
 * 不會回傳給前端、不會出現在任何 API 回應裡（見 workflowApi.js 的 googleStatus()）。
 */

let record = null;
let pendingState = null; // { value, expiresAtMs } — 短效、單次使用，防 OAuth callback CSRF

function reset() {
  record = null;
  pendingState = null;
}

function getTokens() {
  return record ? { ...record } : null;
}

/** Google 只在第一次同意、或明確要求 prompt=consent 時才回傳 refresh_token——沒帶新的
 * 就沿用舊的那把，不能讓「這次剛好沒拿到」變成整組連線失效。 */
function setTokens({ accessToken, refreshToken, expiresAtMs, scope, connectedBy }) {
  record = {
    accessToken,
    refreshToken: refreshToken || (record && record.refreshToken) || null,
    expiresAtMs,
    scope,
    connectedAt: record && record.connectedAt ? record.connectedAt : new Date().toISOString(),
    connectedBy,
  };
  return { ...record };
}

function updateAccessToken({ accessToken, expiresAtMs }) {
  if (!record) return null;
  record = { ...record, accessToken, expiresAtMs };
  return { ...record };
}

function clear() {
  record = null;
}

function issuePendingState(value, ttlMs = 5 * 60 * 1000) {
  pendingState = { value, expiresAtMs: Date.now() + ttlMs };
}

/** 一次性：不管驗證成不成功都清掉，同一個 state 不能被重放。 */
function consumePendingState(value) {
  const valid =
    pendingState && pendingState.value === value && pendingState.expiresAtMs > Date.now();
  pendingState = null;
  return Boolean(valid);
}

module.exports = {
  reset,
  getTokens,
  setTokens,
  updateAccessToken,
  clear,
  issuePendingState,
  consumePendingState,
};
