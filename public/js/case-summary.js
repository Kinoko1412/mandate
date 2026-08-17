/**
 * 案件交接摘要 — read-only rollup view (GET /api/cases) so a reviewer
 * taking over a case can see current status + timeline at a glance.
 * Presentation only: never calls a tool, never writes audit.
 */

const STATUS_LABEL = {
  NEEDS_ATTENTION: "需要留意（近期被拒收）",
  PENDING_REVIEW: "待人審",
  REVOKED: "分享已撤銷",
  CLEAR: "無待辦",
  UNTOUCHED: "尚未開始",
};

const STATUS_TONE = {
  NEEDS_ATTENTION: "tone-deny",
  PENDING_REVIEW: "tone-pending",
  REVOKED: "tone-neutral",
  CLEAR: "tone-pass",
  UNTOUCHED: "tone-neutral",
};

const CONFIDENCE_TIER_LABEL = { high: "信心高", medium: "信心中", low: "信心低" };

let apiFn = null;
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

function initCaseSummary({ api }) {
  apiFn = api;
  $("btn-case-sort")?.addEventListener("click", () => {
    sortMode = sortMode === "confidence" ? "recency" : "confidence";
    const btn = $("btn-case-sort");
    if (btn) {
      btn.textContent =
        sortMode === "confidence" ? "切換排序：依信心分數（低到高）" : "切換排序：依最近異動時間";
    }
    renderCaseList();
  });
}

function renderTimeline(timeline) {
  if (!timeline || !timeline.length) {
    return '<p class="case-empty">這家供應商還沒有稽核紀錄。</p>';
  }
  return `<ol class="case-timeline">${timeline
    .map(
      (ev) => `
      <li>
        <div class="case-timeline-row1">
          <span class="case-timeline-ts">${escapeHtml(formatTs(ev.ts))}</span>
          <span class="case-timeline-actor">${escapeHtml(ev.actorType || "—")}</span>
        </div>
        <div class="case-timeline-summary">${escapeHtml(ev.reasoningSummary || ev.decision || "—")}</div>
        <div class="case-timeline-meta">${escapeHtml(ev.toolName || "—")} · ${escapeHtml(ev.policyId || "—")}</div>
      </li>`
    )
    .join("")}</ol>`;
}

function lastTimelineTs(c) {
  if (!c.timeline || !c.timeline.length) return 0;
  return Date.parse(c.timeline[c.timeline.length - 1].ts || 0) || 0;
}

function sortedCases() {
  const copy = [...cases];
  if (sortMode === "recency") {
    return copy.sort((a, b) => lastTimelineTs(b) - lastTimelineTs(a));
  }
  // confidence ascending — lowest confidence (needs review most) first;
  // cases with no score yet (no staged data) sink to the bottom, they're
  // not "low confidence data", they're just untouched.
  return copy.sort((a, b) => {
    const sa = a.confidenceScore == null ? Infinity : a.confidenceScore;
    const sb = b.confidenceScore == null ? Infinity : b.confidenceScore;
    if (sa !== sb) return sa - sb;
    return STATUS_PRIORITY_ORDER.indexOf(a.status) - STATUS_PRIORITY_ORDER.indexOf(b.status);
  });
}

const STATUS_PRIORITY_ORDER = ["NEEDS_ATTENTION", "PENDING_REVIEW", "REVOKED", "CLEAR", "UNTOUCHED"];

function confidenceBadge(c) {
  if (c.confidenceScore == null) return "";
  const label = CONFIDENCE_TIER_LABEL[c.confidenceTier] || c.confidenceTier;
  const tone = c.confidenceTier === "high" ? "tone-pass" : c.confidenceTier === "low" ? "tone-deny" : "tone-pending";
  return `<span class="result-decision-badge ${tone}" title="信心分數僅供參考排序，不影響是否需要人審">${escapeHtml(label)} ${c.confidenceScore}</span>`;
}

function renderCaseList() {
  const list = $("case-summary-list");
  if (!list) return;
  if (!cases.length) {
    list.innerHTML = '<li class="feed-empty">尚無供應商案件</li>';
    return;
  }
  list.innerHTML = sortedCases()
    .map((c) => {
      const tone = STATUS_TONE[c.status] || "tone-neutral";
      const label = STATUS_LABEL[c.status] || c.status;
      return `
      <li class="case-item" data-supplier="${escapeHtml(c.supplierId)}">
        <div class="case-item-head">
          <span class="case-item-name">${escapeHtml(c.orgName || c.supplierId)}</span>
          <span class="case-item-badges">${confidenceBadge(c)}<span class="result-decision-badge ${tone}">${escapeHtml(label)}</span></span>
        </div>
        <div class="case-item-sub">
          ${c.pendingApproval ? "有待核准申請 · " : ""}${c.qualityTier ? `品質：${escapeHtml(c.qualityTier)} · ` : ""}${c.timeline.length} 筆紀錄
        </div>
        <div class="case-item-body" hidden>${renderTimeline(c.timeline)}</div>
      </li>`;
    })
    .join("");

  list.querySelectorAll(".case-item").forEach((li) => {
    li.addEventListener("click", () => {
      const body = li.querySelector(".case-item-body");
      if (body) body.hidden = !body.hidden;
    });
  });
}

async function openCaseSummary() {
  const modal = $("case-summary-modal");
  if (!modal || !apiFn) return;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  const list = $("case-summary-list");
  if (list) list.innerHTML = '<li class="feed-empty">載入中…</li>';
  try {
    const data = await apiFn("/cases");
    cases = Array.isArray(data?.cases) ? data.cases : [];
  } catch {
    cases = [];
  }
  renderCaseList();
}

function closeCaseSummary() {
  const modal = $("case-summary-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function handleCaseSummaryEscape() {
  const modal = $("case-summary-modal");
  if (modal && !modal.hidden) {
    closeCaseSummary();
    return true;
  }
  return false;
}

export { initCaseSummary, openCaseSummary, closeCaseSummary, handleCaseSummaryEscape };
