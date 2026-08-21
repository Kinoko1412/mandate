/**
 * 供應商總覽 — 一頁卡片牆列出所有供應商，依信心分數排序，設計給一天要看
 * 上百家供應商的合規人員快速掃過用（取代原本的「案件交接摘要」彈窗，
 * 同一份資料 `GET /api/cases`，換成更適合大量掃視的卡片版面）。
 * Presentation only: never calls a tool, never writes audit.
 */

import { roleAvatar, emptyState, icon } from "./icons.js";

const STATUS_TEXT_FALLBACK = {
  UNTOUCHED: "先向供應商索取碳數據。",
  REVOKED: "這家供應商的數據分享權已撤銷，不可再用於申報。",
  PENDING_REVIEW: "品質已過，等待你確認寫入申報草稿。",
  NEEDS_ATTENTION: "品質已拒收，需要補件或聯絡供應商。",
  CLEAR: "品質已過，可申請寫入草稿。",
};

const CONFIDENCE_TIER_LABEL = { high: "信心高", medium: "信心中", low: "信心低" };
const TIER_TONE = { high: "pass", medium: "pending", low: "deny" };

let apiFn = null;
let jumpToSupplierFn = null;
let cases = [];
let sortMode = "confidence"; // "confidence" | "recency"

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? "")
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

function lastTimelineEvent(c) {
  if (!c.timeline || !c.timeline.length) return null;
  return c.timeline[c.timeline.length - 1];
}

function lastTimelineTs(c) {
  const ev = lastTimelineEvent(c);
  return ev ? Date.parse(ev.ts || 0) || 0 : 0;
}

/**
 * 卡片底部那行「缺什麼／需要什麼」——直接沿用最近一筆稽核事件的白話
 * reasoningSummary（已經是「缺 N 個欄位：X、Y、Z」這種具體說法），沒有紀錄
 * 時才退回狀態層級的通用文字。
 */
function cardStatus(c) {
  const last = lastTimelineEvent(c);
  const text = last?.reasoningSummary || STATUS_TEXT_FALLBACK[c.status] || "—";
  let tone = "neutral";
  if (c.status === "NEEDS_ATTENTION") {
    // 拒收本身就是最急迫的狀態，就算還沒算出信心分數（例如根本沒進 staging）
    // 也要用紅色標出來，不能因為沒分數就退回中性灰、看起來像沒事。
    tone = TIER_TONE[c.confidenceTier] || "deny";
  } else if (c.status !== "REVOKED" && c.status !== "UNTOUCHED") {
    tone = TIER_TONE[c.confidenceTier] || "neutral";
  }
  return { text, tone };
}

/** 把偵測到的不確定片段用 `.mnd-unc` 底線標出來（第 16 節），只用在展開的時間軸裡。 */
function renderAnnotatedSummary(text, points) {
  let html = escapeHtml(text || "—");
  (points || []).forEach((p) => {
    const snippet = escapeHtml(p.snippet || "");
    if (!snippet || html.indexOf(snippet) === -1) return;
    const marker = `<span class="mnd-unc" tabindex="0" role="button" data-reason="${escapeHtml(p.reason || "")}">${snippet}</span>`;
    html = html.replace(snippet, marker);
  });
  return html;
}

function renderTimeline(timeline) {
  if (!timeline || !timeline.length) {
    return '<p class="case-empty">這家供應商還沒有稽核紀錄。</p>';
  }
  return `<ol class="case-timeline">${timeline
    .map((ev) => {
      const points = ev.uncertainPoints || [];
      const badge = points.length
        ? `<span class="unc-badge">${icon("alert", "micon-sm")}${points.length} 個不確定點</span>`
        : "";
      const panel = points.length
        ? `<div class="unc-reason-panel" hidden><p class="unc-reason-text"></p></div>`
        : "";
      return `
      <li>
        <div class="case-timeline-row1">
          <span class="case-timeline-ts">${escapeHtml(formatTs(ev.ts))}</span>
          <span class="case-timeline-actor">${roleAvatar(ev.actorType)}${escapeHtml(ev.actorType || "—")}</span>
        </div>
        <div class="case-timeline-summary">${renderAnnotatedSummary(ev.reasoningSummary || ev.decision || "—", points)}</div>
        ${badge}
        ${panel}
        <div class="case-timeline-meta">${escapeHtml(ev.toolName || "—")} · ${escapeHtml(ev.policyId || "—")}</div>
      </li>`;
    })
    .join("")}</ol>`;
}

function sortedCases() {
  const copy = [...cases];
  if (sortMode === "recency") {
    return copy.sort((a, b) => lastTimelineTs(b) - lastTimelineTs(a));
  }
  // confidence ascending — lowest confidence (needs review most) first;
  // cases with no score yet sink to the bottom, they're untouched, not low-confidence data.
  return copy.sort((a, b) => {
    const sa = a.confidenceScore == null ? Infinity : a.confidenceScore;
    const sb = b.confidenceScore == null ? Infinity : b.confidenceScore;
    return sa - sb;
  });
}

function cardHtml(c) {
  const { text, tone } = cardStatus(c);
  const mutedLabel = c.status === "UNTOUCHED" ? "尚未開始" : "尚無有效分數";
  const scoreHtml =
    c.confidenceScore == null
      ? `<div class="supplier-card-score muted">—</div><div class="supplier-card-tier muted">${mutedLabel}</div>`
      : `<div class="supplier-card-score">${c.confidenceScore}</div><div class="supplier-card-tier">${CONFIDENCE_TIER_LABEL[c.confidenceTier] || ""}</div>`;
  return `
    <div class="supplier-card tone-${tone}" data-supplier="${escapeHtml(c.supplierId)}" tabindex="0" role="button" aria-label="切換到 ${escapeHtml(c.orgName || c.supplierId)} 的詳細控制">
      <div class="supplier-card-head">${escapeHtml(c.orgName || c.supplierId)}</div>
      ${scoreHtml}
      <div class="supplier-card-status">${escapeHtml(text)}</div>
      <button type="button" class="supplier-card-history-toggle" data-supplier="${escapeHtml(c.supplierId)}">${icon("history", "micon-sm")}查看時間軸</button>
      <div class="supplier-card-timeline" hidden></div>
    </div>`;
}

function renderGrid() {
  const grid = $("suppliers-grid");
  if (!grid) return;
  if (!cases.length) {
    grid.innerHTML = emptyState({
      iconName: "users",
      headline: "還沒有供應商資料",
      body: "供應商開始有互動紀錄後，會出現在這裡",
    });
    return;
  }
  grid.innerHTML = sortedCases().map(cardHtml).join("");
}

function toggleUncReason(unc) {
  const li = unc.closest("li");
  const panel = li?.querySelector(".unc-reason-panel");
  const p = panel?.querySelector(".unc-reason-text");
  if (!panel || !p) return;
  const reason = unc.getAttribute("data-reason") || "";
  const wasShowingSame = !panel.hidden && p.dataset.reason === reason;
  p.textContent = reason;
  p.dataset.reason = reason;
  panel.hidden = wasShowingSame;
}

function toggleCardTimeline(card) {
  const supplierId = card.dataset.supplier;
  const body = card.querySelector(".supplier-card-timeline");
  if (!body) return;
  if (!body.hidden) {
    body.hidden = true;
    return;
  }
  const c = cases.find((x) => x.supplierId === supplierId);
  body.innerHTML = renderTimeline(c?.timeline);
  body.hidden = false;
}

function initSuppliersOverview({ api, jumpToSupplier }) {
  apiFn = api;
  jumpToSupplierFn = jumpToSupplier;

  $("btn-suppliers-sort")?.addEventListener("click", () => {
    sortMode = sortMode === "confidence" ? "recency" : "confidence";
    const btn = $("btn-suppliers-sort");
    if (btn) {
      btn.textContent =
        sortMode === "confidence" ? "切換排序：依信心分數（低到高）" : "切換排序：依最近異動時間";
    }
    renderGrid();
  });

  const grid = $("suppliers-grid");

  // capture 階段先攔 `.mnd-unc`（展開時間軸裡的不確定點底線字），避免冒泡
  // 到卡片本身的點擊（會被當成「跳去這家供應商」）或歷史紀錄切換鈕。
  grid?.addEventListener(
    "click",
    (ev) => {
      const unc = ev.target.closest(".mnd-unc");
      if (!unc) return;
      ev.stopPropagation();
      toggleUncReason(unc);
    },
    true
  );
  grid?.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const unc = ev.target.closest(".mnd-unc");
      if (!unc) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleUncReason(unc);
    },
    true
  );

  grid?.addEventListener("click", (ev) => {
    const toggleBtn = ev.target.closest(".supplier-card-history-toggle");
    if (toggleBtn) {
      ev.stopPropagation();
      toggleCardTimeline(toggleBtn.closest(".supplier-card"));
      return;
    }
    const card = ev.target.closest(".supplier-card");
    if (card) {
      jumpToSupplierFn?.(card.dataset.supplier);
    }
  });

  grid?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    if (ev.target.closest(".supplier-card-history-toggle")) return;
    const card = ev.target.closest(".supplier-card");
    if (!card) return;
    ev.preventDefault();
    jumpToSupplierFn?.(card.dataset.supplier);
  });
}

async function refreshSuppliersOverview() {
  const grid = $("suppliers-grid");
  if (!apiFn) return;
  if (grid && !cases.length) grid.innerHTML = '<p class="feed-empty">載入中…</p>';
  try {
    const data = await apiFn("/cases");
    cases = Array.isArray(data?.cases) ? data.cases : [];
  } catch {
    cases = [];
  }
  renderGrid();
}

export { initSuppliersOverview, refreshSuppliersOverview };
