/**
 * 動作結果彈窗 + 持久收件箱
 */

import { icon, toneIcon } from "./icons.js";

const PCF_REQUIRED = ["tCO2e", "unit", "method", "boundary", "period", "supplierId"];

const FIELD_LABELS = {
  tCO2e: "排放量",
  unit: "單位",
  method: "計算方法",
  boundary: "系統邊界",
  period: "報告期間",
  supplierId: "供應商 ID",
  product: "產品",
  cnCode: "CN 碼",
  emissionPerUnit: "單位排放",
  verificationStatus: "查驗狀態",
  verificationReportId: "查驗報告編號",
  notes: "備註",
  qualityTier: "品質等級",
  stagedAt: "暫存時間",
  requestId: "請求編號",
  approvalId: "核准編號",
};

const PCF_DISPLAY_ORDER = [
  "tCO2e",
  "unit",
  "method",
  "boundary",
  "period",
  "product",
  "cnCode",
  "emissionPerUnit",
  "verificationStatus",
  "verificationReportId",
  "supplierId",
  "notes",
];

const KIND_LABEL = {
  reply: "回覆",
  quality: "檢查",
  pending: "待核",
  request: "請求",
  revoke: "撤銷",
  reset: "重置",
  check: "自查",
  mandate: "授權",
};

let callbacks = {};

function $(id) {
  return document.getElementById(id);
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
      hour12: false,
    });
  } catch {
    return String(ts);
  }
}

function getMissingL1(payload) {
  if (!payload || typeof payload !== "object") return PCF_REQUIRED.slice();
  return PCF_REQUIRED.filter((k) => {
    const v = payload[k];
    if (v == null) return true;
    if (typeof v === "string" && v.trim() === "") return true;
    if (k === "tCO2e" && !Number.isFinite(Number(v))) return true;
    return false;
  });
}

function toneFromDecision(decision) {
  if (decision === "ALLOW") return "pass";
  if (decision === "PENDING_HUMAN") return "pending";
  if (String(decision || "").startsWith("DENY")) return "deny";
  return "neutral";
}

function decisionBadgeText(decision) {
  if (decision === "ALLOW") return "通過";
  if (decision === "PENDING_HUMAN") return "待核准";
  if (decision === "DENY_CONSTRAINT") return "拒收";
  if (decision === "DENY_POLICY") return "政策擋下";
  if (decision === "DENY_REVOKED") return "授權失效";
  return decision || "—";
}

function buildPcfRows(payload, markMissing = false) {
  if (!payload) return [];
  const missing = markMissing ? new Set(getMissingL1(payload)) : new Set();
  const keys = new Set([...PCF_DISPLAY_ORDER, ...Object.keys(payload)]);
  const ordered = [...PCF_DISPLAY_ORDER.filter((k) => keys.has(k))];
  for (const k of keys) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  return ordered
    .filter((k) => payload[k] !== undefined || missing.has(k))
    .map((k) => {
      const hasVal =
        payload[k] != null &&
        !(typeof payload[k] === "string" && payload[k].trim() === "");
      return {
        label: FIELD_LABELS[k] || k,
        value: hasVal ? String(payload[k]) : "—",
        status: missing.has(k) ? "missing" : hasVal ? "ok" : undefined,
      };
    });
}

function row(label, value, status) {
  return { label, value: value != null ? String(value) : "—", status };
}

function summarizePayload(payload) {
  if (!payload) return "";
  const parts = [
    payload.tCO2e != null ? `${payload.tCO2e} ${payload.unit || "tCO2e"}` : null,
    payload.method || null,
  ].filter(Boolean);
  return parts.join(" · ") || "已收到回覆";
}

export function buildSheetFromTool(toolId, data, ctx = {}) {
  const supplierId = ctx.supplierId || data?.result?.supplierId || "";
  const supplierName = ctx.supplierName || supplierId;
  const decision = data?.decision || "ALLOW";
  const policyId = data?.policyId || "—";
  const result = data?.result || {};
  const approval = data?.approval || {};
  const body = ctx.body || {};
  const tone = toneFromDecision(decision);
  const ts = new Date().toISOString();

  const base = {
    supplierId,
    supplierName,
    decision,
    policyId,
    tone,
    ts,
    plainReason: data?.plainReason || data?.reason || "",
  };

  switch (toolId) {
    case "request_emissions":
      return {
        ...base,
        kind: "request",
        id: `request:${supplierId}`,
        title: "已向供應商發出請求",
        subtitle: supplierName,
        rows: [
          row("供應商", supplierName),
          row("請求編號", result.requestId || "—"),
          row("時間", formatTs(ts)),
        ],
        summary: result.message || "已向供應商發出碳數據請求。",
        nextStep: "下一步：按 ② 取回回覆",
      };

    case "fetch_supplier_response": {
      const payload = result.payload || body;
      const denied = decision !== "ALLOW";
      return {
        ...base,
        kind: "reply",
        id: `reply:${supplierId}`,
        title: denied ? "無法取回供應商回覆" : "供應商回覆已到",
        subtitle: supplierName,
        rows: denied ? [] : buildPcfRows(payload, false),
        summary:
          data.plainReason ||
          result.message ||
          (denied
            ? "這次取回被政策擋下。"
            : `已收到 ${supplierName} 的 PCF 回覆（fixture 假資料，模擬廠商寄來）。`),
        nextStep: denied ? "" : "下一步：按 ③ 品質檢查",
        payload: denied ? null : payload,
      };
    }

    case "ingest_pcf_payload": {
      const payload = body || result;
      const denied = decision !== "ALLOW";
      return {
        ...base,
        kind: "quality",
        id: `quality:${supplierId}`,
        title: denied ? "品質檢查拒收" : "品質檢查通過",
        subtitle: supplierName,
        rows: denied
          ? buildPcfRows(payload, true)
          : [
              row("品質等級", result.qualityTier || "—"),
              row("暫存時間", formatTs(result.stagedAt || ts)),
              ...(result.warnings?.length
                ? result.warnings.map((w, i) => row(`提醒 ${i + 1}`, w, "warn"))
                : []),
              ...buildPcfRows(payload, false).slice(0, 6),
            ],
        summary:
          data.plainReason ||
          (denied
            ? "這批數據不符合入庫標準，不能進暫存區。"
            : "已通過品質閘，寫入暫存區。"),
        nextStep: denied
          ? "請補齊缺欄或換一家供應商"
          : "下一步：按 ④ 申請寫入",
        payload,
      };
    }

    case "submit_cbam_draft": {
      const ap = approval.payload || {};
      return {
        ...base,
        kind: "pending",
        id: `pending:${supplierId}`,
        title: "申請寫入 CBAM 草稿",
        subtitle: supplierName,
        rows: [
          row("核准編號", approval.approvalId || "—"),
          row("排放量", ap.tCO2e != null ? `${ap.tCO2e} ${ap.unit || ""}` : "—"),
          row("方法", ap.method),
          row("邊界", ap.boundary),
          row("期間", ap.period),
        ],
        summary:
          data.plainReason ||
          "高風險動作已暫停，必須合規主管在橫幅按「確認寫入草稿」。",
        nextStep: "請在上方橫幅按「確認寫入草稿」或「不同意」",
      };
    }

    case "revoke_data_share":
      return {
        ...base,
        kind: "revoke",
        id: `revoke:${supplierId}`,
        title: "分享已撤銷",
        subtitle: supplierName,
        rows: [
          row("供應商", supplierName),
          row("影響", "AI 不得再使用這批數字寫 CBAM／客戶回覆"),
          row("取消待核", result.cancelled ?? "—"),
        ],
        summary: "這家供應商的數據分享權已撤銷。",
        nextStep: "若要再用，須重新索取並取得同意",
      };

    case "revoke_supplier_credential":
      return {
        ...base,
        kind: "revoke",
        id: `revoke-vlei:${supplierId}`,
        title: result.revoked ? "法人憑證已撤銷" : "此供應商無 vLEI 憑證可撤銷",
        subtitle: supplierName,
        rows: [
          row("供應商", supplierName),
          row("連鎖撤銷角色憑證數", result.cascadedRoles ?? "—"),
        ],
        summary: result.message || "已撤銷法人憑證，其下角色憑證同步失效。",
        nextStep: "在重新取得有效憑證前，這家供應商的碳數據將被拒收（POL-CRED-001）",
        tone: result.revoked ? "deny" : "neutral",
      };

    case "revoke_mandate":
      return {
        ...base,
        kind: "mandate",
        id: "mandate:global",
        title: "AI 授權已收回",
        subtitle: "全站",
        rows: [row("狀態", "授權失效"), row("影響", "AI 不能再代表公司操作")],
        summary: "合規主管已收回 AI 代理授權。",
        nextStep: "請重置 Demo 或重新發授權",
        tone: "deny",
      };

    case "reset":
      return {
        ...base,
        kind: "reset",
        id: "reset:global",
        title: "Demo 已重置",
        subtitle: "",
        rows: [row("狀態", "已清空"), row("收件箱", "已清除")],
        summary: "所有 Demo 狀態、收件箱與對話已重置。",
        nextStep: "可從 ① 索取重新開始",
        tone: "neutral",
      };

    case "check_pcf": {
      const payload = ctx.body || {};
      const denied = !data.pass;
      return {
        ...base,
        kind: "check",
        id: `check:${payload.supplierId || "self"}`,
        title: denied ? "自查：尚不能交" : "自查：可以交",
        subtitle: payload.supplierId || "供應商自查",
        rows: denied
          ? buildPcfRows(payload, true)
          : buildPcfRows(payload, false),
        summary: data.plainReason || "",
        nextStep: denied ? "請補齊缺欄後再試" : "可作為內部參考（不寫入正式流程）",
        tone: denied ? "deny" : "pass",
        decision: denied ? "DENY_CONSTRAINT" : "ALLOW",
        policyId: data.policyId || "—",
      };
    }

    default:
      return {
        ...base,
        kind: "neutral",
        id: `tool:${toolId}:${supplierId}`,
        title: toolId,
        subtitle: supplierName,
        rows: [row("決策", decision), row("規則", policyId)],
        summary: data.plainReason || data.reason || "",
        nextStep: "",
      };
  }
}

function renderSheetTable(rows) {
  if (!rows?.length) return "<p class=\"result-summary\">（無詳細欄位）</p>";
  const body = rows
    .map((r) => {
      const statusHtml = r.status
        ? `<span class="result-status ${r.status}">${r.status === "missing" ? "缺" : r.status === "warn" ? "!" : "✓"}</span>`
        : "";
      return `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}${statusHtml}</td></tr>`;
    })
    .join("");
  return `<table class="result-table"><tbody>${body}</tbody></table>`;
}

export function showResultSheet(sheet) {
  const overlay = $("result-sheet");
  if (!overlay || !sheet) return;
  const tone = sheet.tone || "neutral";

  $("result-sheet-title").textContent = sheet.title || "動作結果";
  $("result-sheet-sub").textContent = sheet.subtitle || "";
  const badge = $("result-sheet-badge");
  if (badge) {
    badge.textContent = decisionBadgeText(sheet.decision);
    badge.className = `result-decision-badge tone-${tone}`;
  }
  const iconSlot = $("result-sheet-icon");
  if (iconSlot) iconSlot.innerHTML = toneIcon(tone);
  $("result-sheet-content").innerHTML = `
    ${renderSheetTable(sheet.rows)}
    <p class="result-summary">${escapeHtml(sheet.summary || "")}</p>
    ${sheet.nextStep ? `<p class="result-next">${escapeHtml(sheet.nextStep)}</p>` : ""}
    <p class="result-policy">policyId：${escapeHtml(sheet.policyId || "—")}</p>
  `;

  const dialog = overlay.querySelector(".result-sheet-dialog");
  if (dialog) {
    dialog.classList.remove("anim-shake");
    dialog.dataset.tone = tone;
    if (tone === "deny") {
      void dialog.offsetWidth;
      dialog.classList.add("anim-shake");
    }
  }

  overlay.hidden = false;
  document.body.classList.add("result-sheet-open");
  $("result-sheet-close")?.focus();
}

export function closeResultSheet() {
  const overlay = $("result-sheet");
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove("result-sheet-open");
}

export function handleResultSheetEscape() {
  const overlay = $("result-sheet");
  if (overlay && !overlay.hidden) {
    closeResultSheet();
    return true;
  }
  return false;
}

function addInboxItem(appState, sheet) {
  if (!appState.inboxItems) appState.inboxItems = [];
  const item = { ...sheet, ts: sheet.ts || new Date().toISOString() };
  const idx = appState.inboxItems.findIndex((i) => i.id === item.id);
  if (idx >= 0) appState.inboxItems[idx] = item;
  else appState.inboxItems.unshift(item);
  if (appState.inboxItems.length > 24) {
    appState.inboxItems.length = 24;
  }
}

function flashInboxItem(sheetId) {
  const el = document.querySelector(`.inbox-item[data-id="${sheetId}"]`);
  if (!el) return;
  el.classList.remove("inbox-flash");
  void el.offsetWidth;
  el.classList.add("inbox-flash");
}

export function renderInbox(appState) {
  const list = $("action-inbox-list");
  const empty = $("action-inbox-empty");
  const count = $("action-inbox-count");
  const items = appState.inboxItems || [];

  if (count) count.textContent = items.length ? `${items.length} 筆` : "";

  if (!list) return;

  if (!items.length) {
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;
  list.innerHTML = items
    .map((item) => {
      const kind = KIND_LABEL[item.kind] || item.kind;
      const meta =
        item.kind === "reply" && item.payload
          ? summarizePayload(item.payload)
          : item.summary?.slice(0, 48) || "";
      return `
        <article class="inbox-item tone-${item.tone || "neutral"}" data-id="${escapeHtml(item.id)}">
          <span class="inbox-item-icon">${escapeHtml(kind)}</span>
          <div class="inbox-item-body">
            <p class="inbox-item-title">${escapeHtml(item.title)} · ${escapeHtml(item.supplierName || "")}</p>
            <p class="inbox-item-meta">${escapeHtml(formatTs(item.ts))} — ${escapeHtml(meta)}</p>
          </div>
          <button type="button" class="inbox-item-reopen" data-inbox-id="${escapeHtml(item.id)}">詳細事項</button>
        </article>
      `;
    })
    .join("");

  list.querySelectorAll(".inbox-item-reopen").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.inboxId;
      const item = items.find((i) => i.id === id);
      if (item) showResultSheet(item);
    });
  });
}

let lastBannerId = null;

export function renderDashInboxBanner(appState) {
  const banner = $("dash-inbox-banner");
  const text = $("dash-inbox-text");
  const latest = appState.inboxItems?.[0];
  if (!banner || !text) return;

  if (!latest) {
    banner.hidden = true;
    lastBannerId = null;
    return;
  }

  const meta =
    latest.kind === "reply" && latest.payload
      ? summarizePayload(latest.payload)
      : latest.title;
  text.textContent = `最新收到：${latest.supplierName || ""} — ${meta}`;
  const wasHidden = banner.hidden;
  banner.hidden = false;
  if (wasHidden || latest.id !== lastBannerId) {
    banner.classList.remove("anim-banner-in");
    void banner.offsetWidth;
    banner.classList.add("anim-banner-in");
  }
  lastBannerId = latest.id;
}

export function clearInbox(appState) {
  if (appState.inboxItems) appState.inboxItems.length = 0;
  renderInbox(appState);
  renderDashInboxBanner(appState);
}

/**
 * 只改小圓圈節點內容（數字 ↔ 打勾），不改按鈕文字本身——避免完成狀態把
 * 「① 索取」變成「① 已索取 ✓」這種變寬文字，擠得後面按鈕跟著位移
 * （之前手動操作時真的因此誤點過相鄰按鈕，是本次改版明確要修的項目）。
 */
export function updateStepButtons(appState) {
  const supplierId = callbacks.selectedSupplierId?.() || "";
  const pipeline = appState.session?.supplierPipeline || [];
  const p = pipeline.find((x) => x.supplierId === supplierId);
  const fetched = !!(supplierId && appState.lastFetchedPayload?.[supplierId]);

  const setBtn = (id, num, done) => {
    const btn = $(id);
    const node = $(`${id}-node`);
    if (!btn || !node) return;
    const wasDone = btn.classList.contains("is-done");
    btn.classList.toggle("is-done", !!done);
    node.innerHTML = done ? icon("check", "micon-sm") : String(num);
    if (done && !wasDone) {
      node.classList.remove("anim-pop-in");
      void node.offsetWidth;
      node.classList.add("anim-pop-in");
    }
  };

  setBtn("btn-request", 1, p?.requested);
  setBtn("btn-fetch", 2, fetched);
  setBtn("btn-ingest", 3, p?.staged);
  setBtn("btn-submit", 4, p?.pendingApproval);
}

/**
 * @param {object} appState
 * @param {{ toolId?: string, data?: object, ctx?: object, sheet?: object, showModal?: boolean, addInbox?: boolean, flashInbox?: boolean }} options
 */
export function presentActionResult(appState, options = {}) {
  const sheet =
    options.sheet ||
    buildSheetFromTool(options.toolId, options.data, options.ctx || {});

  if (options.addInbox !== false) {
    addInboxItem(appState, sheet);
  }

  renderInbox(appState);
  updateStepButtons(appState);
  renderDashInboxBanner(appState);

  if (options.showModal !== false) {
    showResultSheet(sheet);
  } else if (options.flashInbox) {
    flashInboxItem(sheet.id);
  }

  return sheet;
}

export function initResultSheet(cbs = {}) {
  callbacks = cbs;
  $("result-sheet-close")?.addEventListener("click", closeResultSheet);
  $("result-sheet-dismiss")?.addEventListener("click", closeResultSheet);
  $("result-sheet")?.addEventListener("click", (ev) => {
    if (ev.target.id === "result-sheet") closeResultSheet();
  });
  $("dash-inbox-open")?.addEventListener("click", () => {
    const latest = cbs.getState?.()?.inboxItems?.[0];
    callbacks.setViewDetail?.();
    if (latest) showResultSheet(latest);
  });
  $("action-inbox-list")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".inbox-item-reopen");
    if (!btn) return;
    const id = btn.dataset.inboxId;
    const item = cbs.getState?.()?.inboxItems?.find((i) => i.id === id);
    if (item) showResultSheet(item);
  });
}
