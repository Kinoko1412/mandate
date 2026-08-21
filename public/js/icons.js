/**
 * 共用圖示系統 — 內嵌 SVG（不依賴外部字型／CDN，Workers 環境也能離線用）。
 * 一律搭配色塊／文字一起出現，不單靠顏色表達成功／失敗（呼應 UI 總覽第 9 點）。
 */

const PATHS = {
  check: '<path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  hourglass:
    '<path d="M6 3h12M6 21h12M7 3c0 4.5 3 6.5 5 8-2 1.5-5 3.5-5 8M17 3c0 4.5-3 6.5-5 8 2 1.5 5 3.5 5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:
    '<path d="M12 3.5l9.5 16.5H2.5L12 3.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.05" fill="currentColor" stroke="none"/>',
  shield:
    '<path d="M12 3l7 3v5.2c0 4.9-3 8.6-7 9.8-4-1.2-7-4.9-7-9.8V6l7-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  link: '<path d="M9.5 14.5l5-5M8.2 15.8a3.6 3.6 0 0 1 0-5.1l2-2a3.6 3.6 0 0 1 5.1 5.1l-1 1M15.8 8.2a3.6 3.6 0 0 1 0 5.1l-2 2a3.6 3.6 0 0 1-5.1-5.1l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.2M12 8.3v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  map: '<path d="M9 4L3 6.2v13.6L9 17.6l6 2.2 6-2.2V4.4L15 6.6 9 4.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 4.4v13.2M15 6.6v13.2" stroke="currentColor" stroke-width="1.6"/>',
  film: '<rect x="3" y="4.5" width="18" height="15" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.5v15M16 4.5v15M3 9.5h5M16 9.5h5M3 14.5h5M16 14.5h5" stroke="currentColor" stroke-width="1.4"/>',
  book: '<path d="M4 5.2c2.4-1 5-1 8 0v14c-3-1-5.6-1-8 0V5.2zM20 5.2c-2.4-1-5-1-8 0v14c3-1 5.6-1 8 0V5.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  gauge:
    '<path d="M4 16a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 16l3.2-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1.1" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  sun: '<circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  robot:
    '<rect x="5" y="9" width="14" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 9V6M9 5.2h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="9.3" cy="14" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.7" cy="14" r="1.15" fill="currentColor" stroke="none"/><path d="M2.6 12.5v3M21.4 12.5v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  "user-check":
    '<circle cx="10" cy="8.3" r="3.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4 20c0-3.6 2.7-6 6-6 1.4 0 2.7.4 3.7 1.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M15.5 16.5l2 2 3.2-3.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  search:
    '<circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.3 15.3L20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  "wifi-off":
    '<path d="M3 8.5c2.4-2 5.6-3.2 9-3.2M8.3 12.6c1.1-.7 2.4-1.1 3.7-1.1 1 0 2 .2 2.9.6M12 17.2v.1M2 2l20 20M17.4 9.5c1.3.7 2.5 1.6 3.6 2.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  flask:
    '<path d="M9 3h6M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 15h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 3-6.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M3 4v4.5h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.5l3 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  users:
    '<circle cx="8.5" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M15.5 5.3a3 3 0 0 1 0 5.8M19 19c0-2.7-1.8-4.7-4.2-5.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  "search-off":
    '<circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M14.5 14.5L20 20M2 2l20 20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.3 2.3-2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  "chevron-down": '<path d="M5 8.5l7 7 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};

/** @param {keyof typeof PATHS} name */
export function icon(name, cls = "") {
  const p = PATHS[name] || PATHS.info;
  return `<svg class="micon ${cls}" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">${p}</svg>`;
}

const TONE_ICON = { pass: "check", deny: "x", pending: "hourglass", neutral: "info" };

/** Small colored icon-in-circle badge for result cards / event blocks. */
export function toneIcon(tone, size = "md") {
  const name = TONE_ICON[tone] || "info";
  return `<span class="tone-icon tone-icon-${tone || "neutral"} tone-icon-${size}">${icon(name)}</span>`;
}

/**
 * AGENT／HUMAN／SYSTEM 角色小頭像——跟通過/拒收等「判斷結果」色故意用
 * 不同色相家族（紫 vs 綠），避免使用者把「誰做的」跟「結果好壞」搞混。
 */
export function roleAvatar(actorType) {
  const t = String(actorType || "").toUpperCase();
  if (t === "HUMAN") {
    return `<span class="role-avatar role-avatar-human" title="HUMAN">${icon("user-check", "micon-sm")}</span>`;
  }
  if (t === "SYSTEM") {
    return `<span class="role-avatar role-avatar-system" title="SYSTEM">${icon("shield", "micon-sm")}</span>`;
  }
  return `<span class="role-avatar role-avatar-agent" title="AGENT">${icon("robot", "micon-sm")}</span>`;
}

/**
 * 空狀態：圖示＋邀請語氣標題＋一句說明＋（可選）行動按鈕，取代「目前沒有
 * 資料」這種道歉式文字。ctaId 只是渲染一個 button 供呼叫端另外綁定事件。
 */
export function emptyState({ iconName = "info", headline, body, context, ctaId, ctaLabel }) {
  const cta = ctaId && ctaLabel
    ? `<button type="button" class="btn btn-sm btn-ghost" id="${ctaId}">${ctaLabel}</button>`
    : "";
  return `
    <div class="empty-state">
      ${icon(iconName, "micon-lg")}
      <p class="empty-headline">${headline}</p>
      <p class="empty-body">${body}</p>
      ${cta}
      ${context ? `<p class="empty-context">${context}</p>` : ""}
    </div>`;
}

const GAUGE_TONE = { high: "pass", medium: "pending", low: "deny" };

/**
 * Semi-circle confidence gauge (0–100). Pure SVG, arc animates via
 * stroke-dashoffset transition defined in icons.css — draws itself on
 * insert without any JS timer.
 */
export function confidenceGauge(score, tier, label, inline = false) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const tone = GAUGE_TONE[tier] || "pending";
  const r = 26;
  const circumference = Math.PI * r; // half circle
  const offset = circumference * (1 - s / 100);
  return `
    <div class="gauge gauge-${tone}${inline ? " gauge-inline" : ""}" role="img" aria-label="信心分數 ${s} 分，${label || tier || ""}">
      <svg viewBox="0 0 64 36" width="72" height="42">
        <path d="M6 34a26 26 0 0 1 52 0" fill="none" stroke="var(--neutral-bg)" stroke-width="6" stroke-linecap="round"/>
        <path class="gauge-arc" d="M6 34a26 26 0 0 1 52 0" fill="none" stroke="currentColor" stroke-width="6"
          stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
      </svg>
      <div class="gauge-value">
        <strong>${s}</strong>
        <span>${label || ""}</span>
      </div>
    </div>`;
}
