/**
 * Mandate carbon workbench — /api/*
 */

import { renderDashboard } from "./dashboard.js";
import {
  initOnboarding,
  maybeAutoOpenOnboarding,
  openOnboarding,
  handleOnboardingEscape,
} from "./onboarding.js";
import {
  initResultSheet,
  presentActionResult,
  buildSheetFromTool,
  renderInbox,
  renderDashInboxBanner,
  updateStepButtons,
  clearInbox,
  handleResultSheetEscape,
} from "./result-sheet.js";
import {
  initTour,
  maybeStartTourAfterOnboard,
  startTour,
  startFullTour,
  notifyDemoStarted,
  onDemoComplete,
  handleTourEscape,
  openHelpMenu,
  isWaitingForDemoClick,
  isTourActive,
} from "./tour.js";
import { initPolicyConsole, setViewPolicy, refreshPolicyConsole, runPolicyPreset } from "./policy-console.js";
import {
  initPolicyGuide,
  maybeAutoOpenPolicyGuide,
  openPolicyGuide,
  handlePolicyGuideEscape,
} from "./policy-guide.js";
import {
  initCaseSummary,
  openCaseSummary,
  closeCaseSummary,
  handleCaseSummaryEscape,
} from "./case-summary.js";

const API = "/api";

const STATUS_LABEL = {
  ACTIVE: "授權有效",
  active: "授權有效",
  REVOKED: "授權已收回",
  revoked: "授權已收回",
  EXPIRED: "授權已過期",
  expired: "授權已過期",
};

const TOOL_LABEL = {
  request_emissions: "向供應商索取碳數據",
  fetch_supplier_response: "取回供應商回覆",
  ingest_pcf_payload: "收進品質檢查（PCF）",
  submit_cbam_draft: "申請寫入申報草稿",
  commit_cbam_draft: "正式寫入草稿（AI 不能碰）",
  revoke_data_share: "撤銷數據使用權",
  export_client_draft: "匯出給客戶的回覆",
  export_audit: "匯出稽核紀錄",
  export_sensitive: "匯出敏感資料",
  change_mandate: "擅自改授權",
  revoke_mandate: "收回 AI 授權",
  revoke_supplier_credential: "撤銷供應商法人憑證（vLEI）",
};

const CONFIDENCE_TIER_LABEL = { high: "信心高", medium: "信心中", low: "信心低" };

const DECISION_LABEL = {
  ALLOW: "通過，可以繼續",
  DENY_REVOKED: "擋下：授權或分享權已失效",
  DENY_EXPIRED: "擋下：授權已過期",
  DENY_POLICY: "擋下：超出允許範圍",
  DENY_CONSTRAINT: "擋下：碳數據品質不合格",
  PENDING_HUMAN: "暫停：要等人核准",
};

const state = {
  session: null,
  suppliers: [],
  audit: [],
  pendingId: null,
  events: [],
  lastFetchedPayload: {},
  lastStagedSupplier: null,
  inboxItems: [],
  agentConfigured: false,
  currentView: "dashboard",
};

function $(id) {
  return document.getElementById(id);
}

function toolLabel(id) {
  return TOOL_LABEL[id] || id;
}

function decisionLabel(code) {
  return DECISION_LABEL[code] || code || "—";
}

function displayReason(evOrDecision, policyId, reason) {
  if (evOrDecision && typeof evOrDecision === "object" && evOrDecision.plainReason) {
    return evOrDecision.plainReason;
  }
  const decision =
    typeof evOrDecision === "object" ? evOrDecision.decision : evOrDecision;
  const pid =
    typeof evOrDecision === "object" ? evOrDecision.policyId : policyId;
  const rsn =
    typeof evOrDecision === "object" ? evOrDecision.reason : reason;
  return plainReason(decision, pid, rsn);
}

function plainReason(decision, policyId, reason) {
  if (policyId === "POL-CARB-001") {
    return "這筆回覆只有漂亮噸數（或缺方法／邊界／期間／單位），不能當可稽核碳數據，已拒收。";
  }
  if (policyId === "POL-CARB-002") {
    if (/查驗|verified|report/i.test(reason || "")) {
      return "標示「已查驗」但沒有查驗報告編號，不能對外宣稱已驗證，已拒收。";
    }
    return "進階欄位不完整：可暫存內部使用，但對外申報前建議補齊。";
  }
  if (policyId === "POL-REQ-001") {
    return "尚未向這家供應商索取碳數據，不能直接取回覆。請先執行「索取」。";
  }
  if (policyId === "POL-HITL-010" || (decision === "PENDING_HUMAN" && /cbam|submit/i.test(reason || ""))) {
    return "要把碳數據寫進 CBAM／客戶回覆草稿，屬於高風險對外動作，必須合規主管確認。";
  }
  if (decision === "PENDING_HUMAN") {
    return "高風險動作已暫停，等待人類確認。";
  }
  if (policyId === "POL-REV-010") {
    return "這家供應商的數據分享權已撤銷，AI 不得再使用這批數字。";
  }
  if (policyId === "POL-AUTH-001" || decision === "DENY_REVOKED") {
    return "授權已被收回，AI 不能再代表公司做事。";
  }
  if (policyId === "POL-AUTH-002" || decision === "DENY_EXPIRED") {
    return "授權期限已過，必須重新發授權。";
  }
  if (policyId === "POL-HITL-002" || policyId === "POL-HITL-010-COMMIT") {
    return "合規主管已確認，這筆碳數據可寫入申報草稿。";
  }
  if (policyId === "POL-ALLOW-000" || decision === "ALLOW") {
    if (/ingest|staging|品質/i.test(reason || "")) {
      return "品質欄位齊全，已進入暫存區，可進一步申請寫入申報。";
    }
    if (/request|索取/i.test(reason || "")) {
      return "已向供應商發出碳數據請求，可接著取回對方回覆。";
    }
    if (/fetch|回覆/i.test(reason || "")) {
      return "已取得供應商回覆的碳數據，可進行品質檢查。";
    }
    return "檢查都過了，可以執行這一步。";
  }
  if (reason) return reason;
  return decisionLabel(decision);
}

function showError(msg) {
  const el = $("error-banner");
  if (!msg) {
    el.classList.remove("visible");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.add("visible");
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      data?.error || data?.message || data?.reason || `HTTP ${res.status}`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTs(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return String(ts);
  }
}

function pickMandate(session) {
  return session?.mandate || session || {};
}

function statusOf(mandate) {
  return mandate?.status || sessionStatus() || "ACTIVE";
}

function sessionStatus() {
  return state.session?.mandate?.status || state.session?.permissions?.status;
}

function supplierDisplayName(id) {
  if (!id || id === "—") return "—";
  const s = state.suppliers.find((x) => (x.supplierId || x.id) === id);
  return s?.orgName || s?.displayName || id;
}

function selectedSupplierId() {
  return $("supplier-select")?.value || "";
}

function toolCtx(supplierId, body) {
  const sid = supplierId || selectedSupplierId();
  return {
    supplierId: sid,
    supplierName: supplierDisplayName(sid),
    body,
  };
}

function afterTool(toolId, data, body, options = {}) {
  if (!data) return;
  presentActionResult(state, {
    toolId,
    data,
    ctx: toolCtx(body?.supplierId || data?.result?.supplierId, body),
    ...options,
  });
}

function refreshResultUi() {
  renderInbox(state);
  updateStepButtons(state);
  renderDashInboxBanner(state);
}

function pushEvent(ev) {
  state.events.push({ ...ev, ts: ev.ts || new Date().toISOString() });
  renderEvents();
  renderPending();
}

function recordAgentSteps(data) {
  if (!Array.isArray(data?.steps)) return;
  for (const step of data.steps) {
    if (!step.tool || !step.toolResult) continue;
    const tr = step.toolResult;
    if (step.tool === "fetch_supplier_response" && tr.result?.payload) {
      state.lastFetchedPayload[tr.result.supplierId] = tr.result.payload;
    }
    if (step.tool === "ingest_pcf_payload" && tr.decision === "ALLOW") {
      state.lastStagedSupplier = tr.result?.supplierId;
    }
    pushEvent({
      toolName: tr.toolId || step.tool,
      decision: tr.decision,
      policyId: tr.policyId,
      reason: tr.reason || step.reply,
      plainReason: tr.plainReason,
      approvalId: tr.approval?.approvalId,
      payload: tr.approval?.payload,
      result: tr,
    });
    afterTool(tr.toolId || step.tool, {
      decision: tr.decision,
      policyId: tr.policyId,
      reason: tr.reason,
      plainReason: tr.plainReason,
      approval: tr.approval,
      result: tr.result,
    }, tr.result?.payload || tr.approval?.payload);
  }
}

function renderStatus() {
  const m = pickMandate(state.session);
  const st = statusOf(m);
  const badge = $("mandate-status");
  badge.dataset.status = st;
  badge.querySelector(".label").textContent = STATUS_LABEL[st] || st;

  const principalName =
    state.session?.principal?.displayName || "合規人員";
  const org =
    state.session?.org?.displayName || "艾克美工業・貿易合規";

  $("topbar-meta").innerHTML = `這個 AI 代表 <strong>${escapeHtml(
    org
  )}</strong> 向供應商要碳數據（由 <strong>${escapeHtml(
    principalName
  )}</strong> 授權）`;

  document.body.classList.toggle("mandate-revoked", /revoked/i.test(st));
}

function renderTools() {
  const m = pickMandate(state.session);
  const allowed =
    m?.allowedTools || state.session?.permissions?.allowedTools || [];
  const denied =
    m?.deniedTools || state.session?.permissions?.deniedTools || [];
  fillToolList($("allowed-tools"), allowed, true);
  fillToolList($("denied-tools"), denied, false);
}

function fillToolList(ul, tools, isAllow) {
  ul.innerHTML = "";
  if (!tools.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = isAllow ? "（沒有允許事項）" : "（沒有額外禁止）";
    ul.appendChild(li);
    return;
  }
  for (const t of tools) {
    const li = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.setAttribute("aria-hidden", "true");
    li.appendChild(mark);
    const label = document.createElement("span");
    label.className = "tool-human";
    label.textContent = toolLabel(t);
    li.appendChild(label);
    const code = document.createElement("code");
    code.className = "tool-code";
    code.textContent = t;
    li.appendChild(code);
    ul.appendChild(li);
  }
}

function renderSuppliers() {
  const sel = $("supplier-select");
  const list = state.suppliers.filter(
    (s) => (s.supplierId || s.id) !== "supplier_blocked_99"
  );
  sel.innerHTML = "";
  if (!list.length) {
    sel.innerHTML = '<option value="">— 無供應商 —</option>';
    return;
  }
  for (const s of list) {
    const id = s.supplierId || s.id;
    const name = s.orgName || s.displayName || id;
    const complete = Boolean(s.credentialValid);
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = complete
      ? `${name}（可提供完整碳數據）`
      : `${name}（常回「只有噸數」）`;
    opt.dataset.verified = complete ? "1" : "0";
    sel.appendChild(opt);
  }
  const incomplete = [...sel.options].find((o) => o.dataset.verified === "0");
  if (incomplete) sel.value = incomplete.value;
  renderVleiPanel();
}

const VLEI_STATUS_LABEL = {
  VALID: "鏈完整有效",
  ENTITY_REVOKED: "法人憑證已撤銷",
  ROLE_REVOKED: "角色憑證已撤銷",
  EXPIRED: "憑證已過期",
  BROKEN_LINK: "憑證鏈結構異常",
  NO_VLEI: "未使用 vLEI",
};

function renderVleiPanel() {
  const panel = $("vlei-panel");
  const chainEl = $("vlei-chain");
  const btn = $("btn-revoke-vlei");
  if (!panel || !chainEl) return;
  const sid = selectedSupplierId();
  const supplier = state.suppliers.find((s) => (s.supplierId || s.id) === sid);
  if (!supplier || !supplier.vlei) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const le = supplier.vlei.legalEntityCredential || {};
  const roles = supplier.vlei.roleCredentials || [];
  const statusLabel = VLEI_STATUS_LABEL[supplier.vleiChainStatus] || supplier.vleiChainStatus || "—";
  const leTone = le.status === "REVOKED" ? "tone-deny" : "tone-pass";
  const rolesHtml =
    roles
      .map((r) => {
        const tone = r.status === "REVOKED" ? "tone-deny" : "tone-pass";
        return `<div class="vlei-role-row"><span class="result-decision-badge ${tone}">${escapeHtml(r.role || r.type || "角色憑證")} · ${escapeHtml(r.status || "—")}</span></div>`;
      })
      .join("") || '<p class="case-empty">無角色憑證</p>';
  chainEl.innerHTML = `
    <div class="vlei-chain-row">GLEIF → QVI（${escapeHtml(le.issuer || "—")}）→
      <span class="result-decision-badge ${leTone}">法人憑證 ${escapeHtml(le.status || "—")}</span>
    </div>
    <div class="vlei-roles">${rolesHtml}</div>
    <p class="vlei-lei">LEI：${escapeHtml(supplier.vlei.lei || "—")} · 鏈狀態：${escapeHtml(statusLabel)}</p>
  `;
  if (btn) btn.disabled = le.status === "REVOKED";
}

async function revokeSupplierCredential() {
  const supplierId = selectedSupplierId();
  if (!supplierId) {
    showError("請先選供應商");
    return;
  }
  await callTool("revoke_supplier_credential", { supplierId, actorType: "HUMAN", asApprover: true });
  try {
    const suppliersData = await api("/suppliers");
    state.suppliers = normalizeList(suppliersData, "suppliers", "items", "data");
  } catch {
    /* keep stale list on failure */
  }
  renderVleiPanel();
}

function renderEvents() {
  const feed = $("event-feed");
  if (!feed) return;
  if (!state.events.length) {
    feed.innerHTML =
      '<p class="feed-empty">還沒有動作。跟 AI 說話，或按「AI 自動演三幕」。</p>';
    return;
  }
  feed.innerHTML = "";
  for (const ev of [...state.events].reverse()) {
    feed.appendChild(buildEventBlock(ev));
  }
}

function buildEventBlock(ev) {
  const decision = ev.decision || "—";
  const policyId = ev.policyId || "—";
  const reason = ev.reason || "";
  const tool = ev.toolName || "";
  const ts = ev.ts || "";

  const block = document.createElement("article");
  block.className = "event-block";
  block.dataset.decision = decision;

  const headline = document.createElement("div");
  headline.className = "event-headline";
  headline.textContent =
    ev.plainReason || plainReason(decision, policyId, reason);

  const meta = document.createElement("div");
  meta.className = "event-meta";
  meta.innerHTML = `<span>${escapeHtml(formatTs(ts))}</span>${
    tool ? `<span>${escapeHtml(toolLabel(tool))}</span>` : ""
  }`;

  const dec = document.createElement("div");
  dec.className = "decision";
  dec.textContent = decisionLabel(decision);

  const pol = document.createElement("div");
  pol.className = "policy";
  pol.textContent = `規則編號（評審對文件）：${policyId}`;

  block.appendChild(headline);
  block.appendChild(meta);
  block.appendChild(dec);
  block.appendChild(pol);
  return block;
}

function renderPending() {
  const panel = $("pending-panel");
  const approvals = state.session?.pendingApprovals || [];
  const list = Array.isArray(approvals) ? approvals : [];
  let pending = list.find((a) => /pending/i.test(a.status || ""));

  if (!pending && state.session && "pendingApprovals" in state.session) {
    /* prefer empty session over stale events */
  } else if (!pending) {
    const fromEvent = [...state.events]
      .reverse()
      .find(
        (e) =>
          /PENDING/i.test(e.decision || "") &&
          (e.approvalId || e.result?.approval?.approvalId)
      );
    if (fromEvent && !(Array.isArray(approvals) && "pendingApprovals" in (state.session || {}))) {
      pending = {
        approvalId:
          fromEvent.approvalId || fromEvent.result?.approval?.approvalId,
        policyId: fromEvent.policyId,
        decision: fromEvent.decision,
        payload: fromEvent.payload || fromEvent.result?.approval?.payload,
        status: "PENDING",
      };
    }
  }

  // If session has pendingApprovals key and empty, clear
  if (
    state.session &&
    "pendingApprovals" in state.session &&
    list.length === 0
  ) {
    pending = null;
  } else if (!pending && list.length === 0) {
    const fromEvent = [...state.events]
      .reverse()
      .find(
        (e) =>
          /PENDING/i.test(e.decision || "") &&
          (e.approvalId || e.result?.approval?.approvalId)
      );
    if (fromEvent) {
      pending = {
        approvalId:
          fromEvent.approvalId || fromEvent.result?.approval?.approvalId,
        policyId: fromEvent.policyId,
        decision: fromEvent.decision,
        payload: fromEvent.payload || fromEvent.result?.approval?.payload,
        status: "PENDING",
      };
    }
  }

  if (!pending) {
    panel.classList.remove("visible");
    state.pendingId = null;
    return;
  }

  const id = pending.approvalId || pending.id || null;
  state.pendingId = id;
  const payload = pending.payload || {};
  const supplier = supplierDisplayName(payload.supplierId || "—");
  const t = payload.tCO2e != null ? `${payload.tCO2e} ${payload.unit || "tCO2e"}` : "—";

  const confidenceLine =
    pending.confidenceScore != null
      ? `<p class="tech-foot">信心分數（僅供參考，不影響是否需要人審）：${escapeHtml(String(pending.confidenceScore))}／100（${escapeHtml(CONFIDENCE_TIER_LABEL[pending.confidenceTier] || pending.confidenceTier)}）</p>`
      : "";
  $("pending-body").innerHTML = `
    <p class="pending-plain">AI 想把 <strong>${escapeHtml(supplier)}</strong> 的碳數據（${escapeHtml(String(t))}）寫進申報／客戶回覆草稿。</p>
    <p class="pending-plain">結果：<strong>${escapeHtml(decisionLabel(pending.decision || "PENDING_HUMAN"))}</strong></p>
    <p class="tech-foot">規則 ${escapeHtml(pending.policyId || "POL-HITL-010")} · 單號 ${escapeHtml(id || "—")}</p>
    ${confidenceLine}
  `;
  panel.classList.add("visible");
}

function renderAudit() {
  const ul = $("audit-list");
  const items = state.audit;
  if (!items.length) {
    ul.innerHTML = '<li class="feed-empty">尚無紀錄</li>';
    return;
  }
  ul.innerHTML = "";
  const sorted = [...items].sort((a, b) => {
    const ta = Date.parse(a.ts || 0) || 0;
    const tb = Date.parse(b.ts || 0) || 0;
    return tb - ta;
  });
  for (const ev of sorted) {
    const li = document.createElement("li");
    li.className = "audit-item";
    const decision = ev.decision || "—";
    const policyId = ev.policyId || "—";
    const tool = ev.toolName || "—";
    li.innerHTML = `
      <div class="row1"><span>${escapeHtml(formatTs(ev.ts))}</span></div>
      <div class="audit-plain">${escapeHtml(displayReason({ decision, policyId, reason: ev.reason, plainReason: ev.plainReason }, policyId, ev.reason || ""))}</div>
      <div class="row2">
        <span class="tool">${escapeHtml(toolLabel(tool))}</span>
        <span class="dec">${escapeHtml(decisionLabel(decision))}</span>
      </div>
      <div class="audit-detail">規則 ${escapeHtml(String(policyId))} · 授權 ${escapeHtml(String(ev.mandateId || "—"))}</div>
    `;
    li.addEventListener("click", () => li.classList.toggle("open"));
    ul.appendChild(li);
  }
}

function normalizeList(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}

async function softRefresh() {
  try {
    const [session, audit] = await Promise.all([
      api("/session"),
      api("/audit").catch(() => ({ events: state.audit })),
    ]);
    state.session = session;
    state.audit = normalizeList(audit, "events", "audit", "items");
    renderStatus();
    renderTools();
    renderAudit();
    renderPending();
    dashboardRender();
    if (state.currentView === "policy") refreshPolicyConsole();
  } catch {
    /* keep */
  }
}

async function refreshAll() {
  showError("");
  try {
    const [session, audit, suppliers] = await Promise.all([
      api("/session"),
      api("/audit").catch(() => ({ events: [] })),
      api("/suppliers").catch(() => ({ suppliers: [] })),
    ]);
    state.session = session;
    state.audit = normalizeList(audit, "events", "audit", "items");
    state.suppliers = normalizeList(suppliers, "suppliers", "items", "data");
    renderStatus();
    renderTools();
    renderSuppliers();
    renderEvents();
    renderAudit();
    renderPending();
    dashboardRender();
    refreshResultUi();
    if (state.currentView === "policy") refreshPolicyConsole();
  } catch (e) {
    showError(`無法連線 API：${e.message}（請用 http://127.0.0.1:3847/ 開啟）`);
  }
}

async function manualIngest() {
  const supplierId = selectedSupplierId();
  if (!supplierId) {
    showError("請先選供應商");
    return;
  }
  let payload = state.lastFetchedPayload[supplierId];
  if (!payload) {
    const fetchData = await callTool("fetch_supplier_response");
    if (!fetchData || fetchData.decision !== "ALLOW") return;
    payload =
      fetchData.result?.payload || state.lastFetchedPayload[supplierId];
  }
  if (!payload) {
    showError("請先 ① 索取 → ② 取回回覆");
    return;
  }
  await callTool("ingest_pcf_payload", payload);
}

async function callTool(toolId, bodyOverride) {
  showError("");
  try {
    let body = bodyOverride;
    if (!body) {
      const supplierId = selectedSupplierId();
      if (!supplierId) {
        showError("請先選供應商");
        return;
      }
      if (toolId === "ingest_pcf_payload") {
        return manualIngest();
      } else if (toolId === "fetch_supplier_response") {
        body = { supplierId };
      } else {
        body = { supplierId };
      }
    }

    if (toolId === "fetch_supplier_response") {
      const sid = body.supplierId || selectedSupplierId();
      const existing = state.lastFetchedPayload[sid];
      if (existing) {
        const dup = {
          decision: "ALLOW",
          policyId: "POL-ALLOW-000",
          plainReason: "已取回過這家供應商的回覆。",
          result: { payload: existing, supplierId: sid },
        };
        presentActionResult(state, {
          sheet: buildSheetFromTool("fetch_supplier_response", dup, toolCtx(sid, existing)),
          showModal: true,
          addInbox: false,
          flashInbox: true,
        });
        return dup;
      }
    }

    const data = await api(`/tools/${toolId}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (toolId === "fetch_supplier_response" && data.result?.payload) {
      const sid = body.supplierId || selectedSupplierId();
      state.lastFetchedPayload[sid] = data.result.payload;
    }
    if (toolId === "ingest_pcf_payload" && data.decision === "ALLOW") {
      state.lastStagedSupplier = body.supplierId || selectedSupplierId();
    }
    pushEvent({
      toolName: toolId,
      decision: data.decision,
      policyId: data.policyId,
      reason: data.reason,
      plainReason: data.plainReason,
      approvalId: data.approval?.approvalId,
      payload: data.approval?.payload || body,
      result: data,
    });
    await softRefresh();
    dashboardRender();
    afterTool(toolId, data, body);
    return data;
  } catch (e) {
    const data = e.data || {};
    if (data.decision || data.policyId) {
      pushEvent({
        toolName: toolId,
        decision: data.decision,
        policyId: data.policyId,
        reason: data.reason || e.message,
        plainReason: data.plainReason,
        result: data,
      });
      await softRefresh();
      dashboardRender();
      afterTool(toolId, data, bodyOverride);
      return data;
    }
    showError(`${toolLabel(toolId)} 失敗：${e.message}`);
  }
}

async function revokeShare() {
  const supplierId = selectedSupplierId();
  if (!supplierId) {
    showError("請先選供應商");
    return;
  }
  showError("");
  try {
    const data = await api("/share/revoke", {
      method: "POST",
      body: JSON.stringify({ supplierId, reason: "供應商撤回分享（Demo）" }),
    });
    pushEvent({
      toolName: "revoke_data_share",
      decision: data.decision || "ALLOW",
      policyId: data.policyId || "POL-REV-010",
      reason: "已撤銷該供應商碳數據使用權",
      result: data,
    });
    document.body.classList.add("flash-revoke");
    setTimeout(() => document.body.classList.remove("flash-revoke"), 1200);
    delete state.lastFetchedPayload[supplierId];
    await softRefresh();
    dashboardRender();
    afterTool("revoke_data_share", data, { supplierId });
  } catch (e) {
    const data = e.data || {};
    if (data.decision) {
      pushEvent({
        toolName: "revoke_data_share",
        decision: data.decision,
        policyId: data.policyId,
        reason: data.reason || e.message,
      });
      await softRefresh();
      dashboardRender();
      afterTool("revoke_data_share", data, { supplierId });
    } else {
      showError(`撤銷分享失敗：${e.message}`);
    }
  }
}

async function revokeMandate() {
  showError("");
  try {
    const data = await api("/mandate/revoke", { method: "POST", body: "{}" });
    document.body.classList.add("flash-revoke");
    setTimeout(() => document.body.classList.remove("flash-revoke"), 1200);
    pushEvent({
      toolName: "revoke_mandate",
      decision: data.decision || "DENY_REVOKED",
      policyId: data.policyId || "POL-AUTH-001",
      reason: "人類收回 AI 授權",
      result: data,
    });
    await softRefresh();
    dashboardRender();
    afterTool("revoke_mandate", {
      decision: "DENY_REVOKED",
      policyId: "POL-AUTH-001",
      plainReason: "AI 授權已收回。",
      result: data,
    });
  } catch (e) {
    showError(`收回授權失敗：${e.message}`);
  }
}

async function resetDemo() {
  showError("");
  try {
    await api("/reset", { method: "POST", body: "{}" });
    state.events = [];
    state.pendingId = null;
    state.lastFetchedPayload = {};
    state.lastStagedSupplier = null;
    clearInbox(state);
    const log = $("chat-log");
    if (log) log.innerHTML = "";
    document.body.classList.remove("mandate-revoked", "flash-revoke");
    await refreshAll();
    presentActionResult(state, {
      toolId: "reset",
      data: { decision: "ALLOW", policyId: "—", plainReason: "Demo 已重置。" },
      addInbox: false,
      showModal: true,
    });
  } catch (e) {
    showError(`重置失敗：${e.message}`);
  }
}

async function decideApproval(action) {
  if (!state.pendingId) {
    showError("沒有待核准項目");
    return;
  }
  showError("");
  try {
    const data = await api(`/approvals/${state.pendingId}/${action}`, {
      method: "POST",
      body: "{}",
    });
    pushEvent({
      toolName: `approval_${action}`,
      decision: data?.decision || (action === "approve" ? "ALLOW" : "DENY_POLICY"),
      policyId: data?.policyId || "POL-HITL-002",
      reason:
        action === "approve"
          ? "合規主管確認寫入申報草稿"
          : "合規主管拒絕寫入",
      approvalId: state.pendingId,
      result: data,
    });
    state.pendingId = null;
    const exportBtn = $("btn-export-draft");
    if (action === "approve" && exportBtn) {
      exportBtn.hidden = false;
    }
    await softRefresh();
  } catch (e) {
    showError(`核准操作失敗：${e.message}`);
  }
}

function appendChat(role, text) {
  const log = $("chat-log");
  if (!log) return;
  const div = document.createElement("div");
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function refreshAgentStatus() {
  const el = $("agent-status");
  try {
    const st = await api("/agent/status");
    state.agentConfigured = Boolean(st.configured);
    const label = state.agentConfigured
      ? `語言模型已就緒（${st.model}）`
        : "尚未設定 API Key（Cloudflare：wrangler secret put OPENAI_API_KEY）";
    if (el) {
      el.className = state.agentConfigured ? "agent-status ok" : "agent-status warn";
      el.textContent = label + "。模型只能提議，放行由政策引擎決定。";
    }
    dashboardRender();
  } catch {
    state.agentConfigured = false;
    if (el) {
      el.className = "agent-status warn";
      el.textContent = "無法讀取語言模型狀態。";
    }
  }
}

async function sendDashChat() {
  const input = $("dash-chat-input");
  const message = (input?.value || "").trim();
  if (!message) return;
  input.value = "";
  $("chat-input").value = message;
  await sendChat();
  dashboardRender();
}

async function sendChat() {
  const input = $("chat-input");
  const btn = $("btn-chat-send");
  const dashBtn = $("dash-chat-send");
  const message = (input?.value || "").trim();
  if (!message) return;
  showError("");
  appendChat("user", message);
  input.value = "";
  if (btn) btn.disabled = true;
  if (dashBtn) {
    dashBtn.disabled = true;
    dashBtn.textContent = "處理中…";
  }
  try {
    const data = await api("/agent/chat", {
      method: "POST",
      body: JSON.stringify({ message, maxSteps: 8 }),
    });
    if (!data.configured) {
      showError(data.reply || "未設定 API Key");
      appendChat("assistant", data.reply || "未設定 API Key");
      return;
    }
    let reply = data.reply || "（無回覆）";
    if (Array.isArray(data.steps)) {
      recordAgentSteps(data);
    }
    appendChat("assistant", reply);
    await softRefresh();
  } catch (e) {
    const detail = e.data?.detail || e.message;
    appendChat("assistant", `呼叫失敗：${detail}`);
    showError(`AI 對話失敗：${detail}`);
  } finally {
    if (btn) btn.disabled = false;
    if (dashBtn) {
      dashBtn.disabled = false;
      dashBtn.textContent = "送出";
    }
  }
}

function dashboardRender() {
  renderDashboard({
    session: state.session,
    audit: state.audit,
    agentConfigured: state.agentConfigured,
    $,
    decisionLabel,
  });
}

function setView(view) {
  state.currentView = view;
  const dash = view === "dashboard";
  const policy = view === "policy";
  const detail = view === "detail";
  $("view-dashboard").hidden = !dash;
  $("view-detail").hidden = !detail;
  $("view-policy").hidden = !policy;
  $("tab-dashboard")?.classList.toggle("active", dash);
  $("tab-detail")?.classList.toggle("active", detail);
  $("tab-policy")?.classList.toggle("active", policy);
  if (policy) {
    setViewPolicy();
    maybeAutoOpenPolicyGuide();
  }
  if (detail) {
    loadCloudAudit();
  }
}

function setViewDashboard() {
  setView("dashboard");
}

function setViewDetail() {
  setView("detail");
}

function setViewPolicyTab() {
  setView("policy");
}

function openSupplierModal() {
  const modal = $("supplier-modal");
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  $("supplier-json")?.focus();
}

function closeSupplierModal() {
  const modal = $("supplier-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

const SUPPLIER_TEMPLATES = {
  bad: { supplierId: "my_factory", tCO2e: 8.1 },
  good: {
    supplierId: "my_factory",
    tCO2e: 12.4,
    unit: "tCO2e",
    method: "ISO14067",
    boundary: "cradle-to-gate",
    period: "2025-01-01/2025-12-31",
    cnCode: "73181500",
    emissionPerUnit: 0.042,
    verificationStatus: "in_progress",
  },
};

async function checkSupplierPcf() {
  const raw = ($("supplier-json")?.value || "").trim();
  if (!raw) {
    showError("請貼上 JSON");
    return;
  }
  showError("");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    showError("JSON 格式錯誤");
    return;
  }
  try {
    const data = await api("/check/pcf", {
      method: "POST",
      body: JSON.stringify({ payload }),
    });
    const box = $("check-result");
    box.hidden = false;
    const status = data.pass ? "pass" : "fail";
    box.className = `check-result ${status}`;
    let html = `<p><strong>${escapeHtml(data.plainReason || "")}</strong></p>`;
    if (data.missingFields?.length) {
      html += `<p>缺欄：${escapeHtml(data.missingFields.join("、"))}</p>`;
    }
    if (data.warnings?.length) {
      html += `<ul>${data.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
    }
    if (data.supplementLetter) {
      html += `<pre class="supplement-letter">${escapeHtml(data.supplementLetter)}</pre>`;
    }
    html += `<p class="disclaimer">${escapeHtml(data.disclaimer || "")}</p>`;
    box.innerHTML = html;
    presentActionResult(state, {
      toolId: "check_pcf",
      data,
      ctx: { body: payload },
    });
  } catch (e) {
    showError(`檢查失敗：${e.message}`);
  }
}

async function exportClientDraft() {
  const supplierId =
    state.lastStagedSupplier || selectedSupplierId() || "supplier_green_01";
  try {
    const data = await api(`/export/client-draft/${encodeURIComponent(supplierId)}`);
    const text = data.result?.content || data.content || "";
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showError("");
      appendChat("assistant", "已複製「給客戶的回覆草稿」到剪貼簿。");
    } else {
      window.prompt("給客戶的回覆草稿", text);
    }
  } catch (e) {
    showError(`匯出失敗：${e.message}`);
  }
}

let cloudAuditListOpen = false;

function setCloudAuditBadge(state, text) {
  const badge = $("cloud-audit-badge");
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = text;
}

async function loadCloudAudit() {
  const list = $("cloud-audit-list");
  setCloudAuditBadge("loading", "☁ 檢查雲端持久化中…");
  try {
    const data = await api("/audit/cloud");
    if (!data.configured) {
      setCloudAuditBadge("off", "☁ 未接 Supabase（僅本機記憶體，重啟即消失）");
      if (list) list.hidden = true;
      return;
    }
    if (data.error) {
      setCloudAuditBadge("error", `☁ 讀取失敗：${data.error}`);
      if (list) list.hidden = true;
      return;
    }
    const chainText = data.chainIntact
      ? `雜湊鏈完整`
      : `⚠ 雜湊鏈異常（${data.brokenCount} 筆對不上，可能被竄改）`;
    setCloudAuditBadge(
      data.chainIntact ? "ok" : "broken",
      `☁ 已同步 Supabase・${data.count} 筆・${chainText}`
    );
    if (list) {
      list.innerHTML = (data.events || [])
        .map((ev) => {
          const hash = (ev.entry_hash || "").slice(0, 12);
          const meta = `${escapeHtml(formatTs(ev.ts))} · ${escapeHtml(ev.tool_name || "—")} · ${escapeHtml(ev.decision || "—")} · ${escapeHtml(hash)}…`;
          const summary = ev.reasoning_summary
            ? `<div class="cloud-audit-reason">${escapeHtml(ev.reasoning_summary)}</div>`
            : "";
          return `<li>${meta}${summary}</li>`;
        })
        .join("");
      list.hidden = !cloudAuditListOpen;
    }
  } catch (e) {
    setCloudAuditBadge("error", `☁ 讀取失敗：${e.message}`);
    if (list) list.hidden = true;
  }
}

async function exportAuditLog() {
  try {
    const data = await api("/export/audit");
    const text = data.result?.content || data.content || "";
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showError("");
    } else {
      window.prompt("稽核紀錄", text);
    }
  } catch (e) {
    showError(`匯出失敗：${e.message}`);
  }
}

function bind() {
  $("tab-dashboard")?.addEventListener("click", setViewDashboard);
  $("tab-detail")?.addEventListener("click", setViewDetail);
  $("tab-policy")?.addEventListener("click", setViewPolicyTab);
  $("goto-detail")?.addEventListener("click", setViewDetail);
  $("tab-supplier")?.addEventListener("click", openSupplierModal);
  $("dash-open-supplier")?.addEventListener("click", openSupplierModal);
  $("tip-dismiss")?.addEventListener("click", () => {
    $("tip-bar").hidden = true;
  });
  $("btn-onboard-help")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openHelpMenu({
      onFullTour: () => startFullTour({ force: true }),
      onDemoTour: () => startTour({ force: true }),
      onWizard: () => openOnboarding(),
      onPolicyGuide: () => openPolicyGuide(),
    });
  });
  $("supplier-modal-close")?.addEventListener("click", closeSupplierModal);
  $("btn-supplier-cancel")?.addEventListener("click", closeSupplierModal);
  $("supplier-modal")?.addEventListener("click", (ev) => {
    if (ev.target.id === "supplier-modal") closeSupplierModal();
  });
  $("btn-case-summary")?.addEventListener("click", openCaseSummary);
  $("case-summary-close")?.addEventListener("click", closeCaseSummary);
  $("case-summary-modal")?.addEventListener("click", (ev) => {
    if (ev.target.id === "case-summary-modal") closeCaseSummary();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (handlePolicyGuideEscape()) return;
      if (handleOnboardingEscape()) return;
      if (handleResultSheetEscape()) return;
      if (handleTourEscape()) return;
      if (handleCaseSummaryEscape()) return;
      if (!$("supplier-modal")?.hidden) closeSupplierModal();
    }
  });
  $("btn-request")?.addEventListener("click", () => callTool("request_emissions"));
  $("btn-fetch")?.addEventListener("click", () => callTool("fetch_supplier_response"));
  $("supplier-select")?.addEventListener("change", () => {
    refreshResultUi();
    renderVleiPanel();
  });
  $("btn-revoke-vlei")?.addEventListener("click", revokeSupplierCredential);
  $("btn-ingest")?.addEventListener("click", manualIngest);
  $("btn-submit")?.addEventListener("click", () => callTool("submit_cbam_draft"));
  $("btn-revoke-share")?.addEventListener("click", revokeShare);
  $("btn-revoke")?.addEventListener("click", revokeMandate);
  $("btn-reset")?.addEventListener("click", resetDemo);
  $("btn-pact-preview")?.addEventListener("click", () => {
    const sid = selectedSupplierId();
    if (!sid) {
      showError("請先在上方選一家供應商");
      return;
    }
    window.open(`${API}/pcf/${encodeURIComponent(sid)}/pact`, "_blank");
  });
  $("dash-btn-reset-hero")?.addEventListener("click", resetDemo);
  $("dash-next-body")?.addEventListener("click", (ev) => {
    if (ev.target?.id === "dash-btn-reset") resetDemo();
  });
  $("btn-approve")?.addEventListener("click", () => decideApproval("approve"));
  $("btn-deny")?.addEventListener("click", () => decideApproval("deny"));
  $("dash-btn-approve")?.addEventListener("click", () => decideApproval("approve"));
  $("dash-btn-deny")?.addEventListener("click", () => decideApproval("deny"));
  $("btn-chat-send")?.addEventListener("click", sendChat);
  $("dash-chat-send")?.addEventListener("click", sendDashChat);
  $("chat-input")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendChat();
    }
  });
  $("dash-chat-input")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendDashChat();
    }
  });
  $("btn-export-draft")?.addEventListener("click", exportClientDraft);
  $("btn-export-audit")?.addEventListener("click", exportAuditLog);
  $("btn-cloud-audit-refresh")?.addEventListener("click", loadCloudAudit);
  $("cloud-audit-badge")?.addEventListener("click", () => {
    cloudAuditListOpen = !cloudAuditListOpen;
    const list = $("cloud-audit-list");
    if (list) list.hidden = !cloudAuditListOpen || !list.innerHTML;
  });
  $("btn-check-pcf")?.addEventListener("click", checkSupplierPcf);
  $("tpl-bad")?.addEventListener("click", () => {
    $("supplier-json").value = JSON.stringify(SUPPLIER_TEMPLATES.bad, null, 2);
  });
  $("tpl-good")?.addEventListener("click", () => {
    $("supplier-json").value = JSON.stringify(SUPPLIER_TEMPLATES.good, null, 2);
  });
  $("btn-demo").addEventListener("click", async () => {
    if (isWaitingForDemoClick()) {
      notifyDemoStarted();
    }
    const { runDemoScript } = await import("./demo-script.js");
    try {
      await runDemoScript({
        api,
        recordAgentSteps,
        appendChat,
        callTool,
        revokeShare,
        decideApproval,
        softRefresh,
        resetDemo,
        refreshAgentStatus,
        getState: () => state,
        selectSupplier: (pred) => {
          const sel = $("supplier-select");
          const opt = [...sel.options].find(pred);
          if (opt) sel.value = opt.value;
        },
        showError,
      });
    } finally {
      if (isTourActive()) {
        onDemoComplete();
      }
    }
  });
}

bind();
initOnboarding();
initResultSheet({
  getState: () => state,
  selectedSupplierId,
  setViewDetail,
});
initPolicyConsole({ api, setViewDetail });
initPolicyGuide({ runPreset: runPolicyPreset });
initCaseSummary({ api });
initTour({
  setViewDashboard,
  setViewDetail,
  setViewPolicy: setViewPolicyTab,
  openSupplierModal,
  closeSupplierModal,
});

const urlView = new URLSearchParams(window.location.search).get("view");
if (urlView === "policy") {
  setView("policy");
} else if (urlView === "detail") {
  setView("detail");
} else {
  setView("dashboard");
}
refreshAll()
  .then(() => refreshAgentStatus())
  .then(() => {
    maybeAutoOpenOnboarding(maybeStartTourAfterOnboard);
  });

export {
  api,
  callTool,
  revokeShare,
  revokeMandate,
  decideApproval,
  softRefresh,
  resetDemo,
  refreshAll,
  state,
};
