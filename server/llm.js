'use strict';

/**
 * Two fixed-role LLM agents — CarbonDataAgent and AuthAgent. Both propose
 * only; neither ever grants authority. This is a deliberate, dated
 * deviation from DECISIONS.md §7's "V1 不做：多 Agent 編排" exclusion —
 * see mandate/CLAUDE.md's "本分支對 DECISIONS.md §7 的偏離" note for the
 * scope and reasoning (user's own personal-fork experiment, not a team
 * decision on main). The other §7 exclusion, "讓 LLM 自行決定權限", is
 * NOT touched: AuthAgent's allowed-tool set is the empty set, so it is
 * structurally incapable of proposing an executable tool call, and every
 * tool proposal from either agent still passes through server/policy.js
 * before anything executes.
 */

const CARBON_ALLOWED_TOOLS = new Set([
  'request_emissions',
  'fetch_supplier_response',
  'ingest_pcf_payload',
  'submit_cbam_draft',
]);

// Deliberately empty: AuthAgent is a read-only Q&A persona. It can never
// have a tool proposal pass the whitelist below, by construction.
const AUTH_ALLOWED_TOOLS = new Set();

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

function status() {
  return {
    configured: isConfigured(),
    demoReady: isConfigured(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    carbonModel: process.env.OPENAI_MODEL_CARBON || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    authModel: process.env.OPENAI_MODEL_AUTH || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  };
}

function buildCarbonSystemPrompt(ctx) {
  const suppliers = (ctx.suppliers || [])
    .map(
      (s) =>
        `- ${s.supplierId}｜${s.orgName}｜${s.credentialValid ? '常提供完整碳數據' : '常只回噸數'}｜分享撤銷:${s.shareRevoked ? '是' : '否'}`
    )
    .join('\n');
  const staging = (ctx.staging || [])
    .map(
      (p) =>
        `- ${p.supplierId}｜tCO2e=${p.tCO2e}｜tier=${p.qualityTier || '—'}｜method=${p.method || '—'}`
    )
    .join('\n');
  const requests = (ctx.emissionsRequests || []).join(', ') || '（無）';
  return `你是 Mandate 的「碳數據助理」（CarbonDataAgent），代表「${ctx.orgName || '艾克美工業・貿易合規'}」處理碳數據索取／品質檢查／申報流程。你**只看得到**供應商與碳數據相關資訊，看不到公司整體授權狀態或稽核紀錄——那是另一個「授權與稽核助理」的職責，不要假裝知道。你沒有權限自己決定能不能執行——你只能提議工具，真正放行由公司政策引擎決定。

標準流程（索取供應商數據時必須依序）：
1. request_emissions — 向供應商發出請求
2. fetch_supplier_response — 取回供應商回覆的 PCF（不可自己編造欄位）
3. ingest_pcf_payload — 用 fetch 回傳的完整 payload 做品質檢查入庫
4. submit_cbam_draft — 申請寫入 CBAM 草稿（一定會等人類核准）

你可以用的工具（只能從中選，或都不選）：
- request_emissions：向供應商發出排放資料請求。args: { "supplierId": "..." }
- fetch_supplier_response：取回供應商已回覆的 PCF（須先 request）。args: { "supplierId": "..." }
- ingest_pcf_payload：匯入 PCF；必須用 fetch 得到的完整欄位。args: { ...完整 PCF 物件 }
- submit_cbam_draft：提交已 staging 的 CBAM 草稿。args: { "supplierId": "..." }

供應商對照：supplier_unverified_01=無證零件行；supplier_green_01=青禾精密。

禁止：提議 commit_cbam_draft、revoke、export、或任何未列出的工具。不可假裝已提交 CBAM 或已核准。若使用者問的是授權狀態、稽核紀錄這類問題，回覆說明那不是你的職責範圍即可，tool 設 null。
若政策拒收，用白話解釋「缺什麼、若硬交會怎樣」，不要只重複 policyId。

已索取過的供應商：${requests}
供應商清單：
${suppliers || '（無）'}
Staging：
${staging || '（空）'}

回覆必須是單一 JSON 物件（不要 markdown），格式：
{
  "reply": "用人話繁體中文簡短說明你想做什麼、為什麼",
  "tool": "request_emissions" | "fetch_supplier_response" | "ingest_pcf_payload" | "submit_cbam_draft" | null,
  "args": { }
}
若只是打招呼、解釋規則、或任務已完成，tool 設為 null。`;
}

function buildAuthSystemPrompt(ctx) {
  const mandate = ctx.mandate || {};
  const recentAudit = (ctx.recentAudit || [])
    .map((e) => `- ${e.toolName || '—'}｜${e.decision || '—'}｜${e.policyId || '—'}`)
    .join('\n');
  return `你是 Mandate 的「授權與稽核助理」（AuthAgent）。你**只看得到**目前的授權（mandate）狀態、允許工具清單、最近幾筆稽核決策的工具名稱／決策結果／policyId——你**看不到**任何供應商名稱或碳數據內容，那是另一個「碳數據助理」的職責，不要猜測或編造。

你沒有任何工具可以提議——你的角色是純問答：解釋目前授權狀態、允許/禁止哪些工具、或某筆稽核決策為什麼是那個結果。**你永遠不能提議執行任何動作**（tool 必須永遠是 null）。

目前授權狀態：${mandate.status || 'UNKNOWN'}
授權到期時間：${mandate.expiresAt || '—'}
允許工具：${(ctx.allowedTools || []).join(', ') || '（無）'}
最近稽核紀錄（僅工具/決策/規則，不含供應商細節）：
${recentAudit || '（無）'}

回覆必須是單一 JSON 物件（不要 markdown），格式：
{
  "reply": "用人話繁體中文簡短回答",
  "tool": null,
  "args": {}
}
若使用者問的是碳數據、供應商索取這類問題，回覆說明那不是你的職責範圍即可，tool 依然是 null。`;
}

async function callModel({ systemPrompt, message, history, model }) {
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.OPENAI_API_KEY.trim();

  const messages = [{ role: 'system', content: systemPrompt }];

  if (Array.isArray(history) && history.length) {
    for (const h of history.slice(-16)) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: String(h.content || '').slice(0, 3000) });
      }
    }
  }

  messages.push({ role: 'user', content: String(message || '').slice(0, 4000) });

  const body = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`LLM 回應不是 JSON：HTTP ${res.status}`);
  }
  if (!res.ok) {
    const errMsg = data?.error?.message || data?.message || `LLM HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { reply: content, tool: null, args: {} };
  }

  return {
    reply: parsed.reply || '（沒有文字說明）',
    tool: parsed.tool || null,
    args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
    model: data?.model || model,
    usage: data?.usage || null,
  };
}

function unconfiguredReply(persona) {
  return {
    configured: false,
    reply:
      persona === 'auth'
        ? '尚未設定 OPENAI_API_KEY。'
        : '尚未設定 OPENAI_API_KEY。本地：在 mandate/.env 填入後重啟；線上（Cloudflare）：執行 npx wrangler secret put OPENAI_API_KEY 後再 deploy。亦可直接用「AI 自動演三幕」的按鈕備援（不需 Key）。',
    tool: null,
    args: {},
  };
}

async function proposeCarbon({ message, context, history }) {
  if (!isConfigured()) return unconfiguredReply('carbon');
  const model = process.env.OPENAI_MODEL_CARBON || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const raw = await callModel({
    systemPrompt: buildCarbonSystemPrompt(context || {}),
    message,
    history,
    model,
  });
  if (raw.tool && !CARBON_ALLOWED_TOOLS.has(raw.tool)) {
    return {
      configured: true,
      reply: `${raw.reply || ''}（模型提議了不允許的工具「${raw.tool}」，已忽略。權限不由模型決定。）`.trim(),
      tool: null,
      args: {},
      modelRejectedTool: raw.tool,
    };
  }
  return { configured: true, ...raw };
}

async function proposeAuth({ message, context, history }) {
  if (!isConfigured()) return unconfiguredReply('auth');
  const model = process.env.OPENAI_MODEL_AUTH || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const raw = await callModel({
    systemPrompt: buildAuthSystemPrompt(context || {}),
    message,
    history,
    model,
  });
  // Structural guarantee, not a prompt request: AUTH_ALLOWED_TOOLS is empty,
  // so this always strips any tool the model might still try to propose.
  if (raw.tool && !AUTH_ALLOWED_TOOLS.has(raw.tool)) {
    return {
      configured: true,
      reply: raw.reply || '',
      tool: null,
      args: {},
      modelRejectedTool: raw.tool,
    };
  }
  return { configured: true, ...raw };
}

module.exports = {
  isConfigured,
  status,
  proposeCarbon,
  proposeAuth,
  CARBON_ALLOWED_TOOLS,
  AUTH_ALLOWED_TOOLS,
};
