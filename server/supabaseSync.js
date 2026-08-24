'use strict';

/**
 * Optional Supabase persistence for audit log / approvals / AI conversation history,
 * plus read-back for the "雲端稽核" UI panel. PostgREST over fetch only (no SDK — keeps
 * zero npm deps). Writes are fire-and-forget: the in-memory store.js state is always the
 * source of truth for the running Demo, so a failed/slow write never blocks a caller.
 */

const crypto = require('crypto');

// Lazy, not module-scope: Cloudflare Workers disallow crypto.randomUUID() (and other
// async/random I/O) at global scope — it must run inside a request handler. The first
// call happens whenever the first request touches supabaseSync, well after module init.
let _bootId = null;
function getBootId() {
  if (!_bootId) _bootId = crypto.randomUUID();
  return _bootId;
}

function isConfigured() {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_URL.trim() &&
      process.env.SUPABASE_SERVICE_KEY &&
      process.env.SUPABASE_SERVICE_KEY.trim()
  );
}

function baseUrl() {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
}

function serviceKey() {
  return (process.env.SUPABASE_SERVICE_KEY || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cloudflare Workers can tear down a request's execution context as soon as the
// response is sent — an un-awaited fire-and-forget fetch() can get cut off mid-flight
// if the response returns first (this bit us: fast tool calls with no LLM roundtrip
// returned before the Supabase write finished, so nothing landed). Track every
// in-flight write here; worker/index.js hands the drained promise to `ctx.waitUntil()`
// so Cloudflare keeps the isolate alive until writes actually finish. On local Node
// (server/index.js has no waitUntil concept) this tracking is simply unused — pending
// promises keep running on the event loop regardless, same as before.
const pending = new Set();

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

function waitForPending() {
  return Promise.allSettled(Array.from(pending));
}

// One retry after a short delay: a cold connection to Supabase can transiently 401
// (observed: "JWT issued at future") or 5xx, on both writes and reads. Used by
// everything below so the "雲端稽核" panel doesn't flake on a click during a demo.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    await sleep(400);
    return fn();
  }
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      apikey: serviceKey(),
      Authorization: `Bearer ${serviceKey()}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const err = new Error(`Supabase 回應不是 JSON：HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.message || `Supabase HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

// Best-effort: failures are swallowed (after one retry) and only logged — callers never
// wait on this or see it throw, since a missing audit row must never block the Demo.
// The work itself is still tracked (see `pending` above) so Workers can be told to keep
// the isolate alive until it's actually done, even though callers don't await this.
function postRow(table, row, { onConflict } = {}) {
  if (!isConfigured()) return;
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const work = (async () => {
    try {
      await withRetry(() =>
        requestJson(`/rest/v1/${table}${qs}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: onConflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
          },
          body: JSON.stringify(row),
        })
      );
    } catch (e) {
      console.warn(`[supabaseSync] ${table} insert failed after retry:`, e && e.message ? e.message : e);
    }
  })();
  track(work);
}

function syncAuditEvent(event) {
  if (!event || !isConfigured()) return;
  postRow('audit_log', {
    boot_id: getBootId(),
    audit_event_id: event.auditEventId || event.eventId || null,
    ts: event.ts || null,
    org_id: event.orgId || null,
    principal_id: event.principalId || null,
    actor_id: event.actorId || null,
    actor_type: event.actorType || null,
    agent_id: event.agentId || null,
    mandate_id: event.mandateId || null,
    tool_id: event.toolId || null,
    tool_name: event.toolName || null,
    decision: event.decision || null,
    policy_id: event.policyId || null,
    reason: event.reason || null,
    reasoning_summary: event.reasoningSummary || null,
    event_kind: event.eventKind || 'TOOL_DECISION',
    correlation_id: event.correlationId || null,
    approval_id: event.approvalId || null,
    args_digest: event.argsDigest || null,
    input_hash: event.inputHash || null,
    input_redacted: event.inputRedacted || null,
  });
}

function syncApproval(approval) {
  if (!approval || !isConfigured()) return;
  postRow(
    'approvals',
    {
      boot_id: getBootId(),
      approval_id: approval.approvalId,
      mandate_id: approval.mandateId || null,
      type: approval.type || null,
      status: approval.status || null,
      requested_by: approval.requestedBy || null,
      approver_id: approval.approverId || null,
      created_at: approval.createdAt || null,
      decided_at: approval.decidedAt || null,
      consumed_at: approval.consumedAt || null,
      policy_id: approval.policyId || null,
      payload: approval.payload || null,
    },
    { onConflict: 'boot_id,approval_id' }
  );
}

// Day 5：全面 LLM Evidence Agent 測試（services/agent/llmExtract.js）的 prompt/response
// 稽核紀錄，跟既有 audit_log/approvals/ai_messages 同一套 fire-and-forget 模式——失敗只
// warn，不影響 Evidence Agent 分析本身。SUPABASE_URL 沒設就完全不啟用（isConfigured() 擋掉）。
//
// 表格需要使用者自己在 Supabase SQL editor 建立（這裡沒有 migration 機制，跟現有三張表
// 一樣是手動建的），schema 建議：
//   create table evidence_llm_prompts (
//     id bigint generated always as identity primary key,
//     boot_id text not null,
//     ts timestamptz not null default now(),
//     filename text,
//     evidence_type text,
//     model text,
//     system_prompt text,
//     user_prompt text,
//     response_content text,
//     usage jsonb,
//     duration_ms integer
//   );
// 表不存在時 postRow() 會 retry 後 warn 並吞掉錯誤，不會讓 Evidence Agent 分析中斷。
function syncEvidenceLlmPrompt(entry) {
  if (!entry || !isConfigured()) return;
  postRow('evidence_llm_prompts', {
    boot_id: getBootId(),
    ts: new Date().toISOString(),
    filename: entry.filename || null,
    evidence_type: entry.evidenceType || null,
    model: entry.model || null,
    system_prompt: entry.systemPrompt || null,
    user_prompt: entry.userPrompt || null,
    response_content: entry.responseContent || null,
    usage: entry.usage || null,
    duration_ms: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
  });
}

function syncMessage(sessionId, message) {
  if (!message || !isConfigured()) return;
  postRow('ai_messages', {
    boot_id: getBootId(),
    session_id: sessionId || 'default',
    role: message.role || null,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    ts: new Date(message.ts || Date.now()).toISOString(),
  });
}

// Reads are on-demand from the cloud-audit UI panel, so callers get the real error
// (after one retry) instead of a swallowed one.
//
// No boot_id filter by default: on a long-running local process one boot_id covers the
// whole session, but each Cloudflare Workers isolate has its own module state, and two
// requests seconds apart can land on different isolates with different boot_ids. Scoping
// this query to "the current isolate's boot_id" made the panel show 0 rows right after a
// real write. Global "latest N" makes the panel reliably show real data on Workers too.
async function fetchAuditLog({ bootId, limit = 50 } = {}) {
  const qs = new URLSearchParams({
    select:
      'id,boot_id,audit_event_id,ts,tool_name,decision,policy_id,actor_type,event_kind,reasoning_summary,entry_hash',
    order: 'id.desc',
    limit: String(limit),
  });
  if (bootId) qs.set('boot_id', `eq.${bootId}`);
  return withRetry(() => requestJson(`/rest/v1/audit_log?${qs.toString()}`));
}

async function verifyAuditChain(bootId) {
  const id = bootId || getBootId();
  return withRetry(() =>
    requestJson('/rest/v1/rpc/mandate_verify_audit_chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_boot_id: id }),
    })
  );
}

module.exports = {
  isConfigured,
  syncAuditEvent,
  syncApproval,
  syncEvidenceLlmPrompt,
  syncMessage,
  fetchAuditLog,
  verifyAuditChain,
  waitForPending,
};

// Lazy getter so `supabaseSync.BOOT_ID` still works as a plain property read at call
// sites, without forcing crypto.randomUUID() to run at module-load (global scope).
Object.defineProperty(module.exports, 'BOOT_ID', { get: getBootId });
