/**
 * 互動聚光導覽 — 完整介面 + Demo 三幕解說
 */

const STORAGE_DEMO = "mandate-tour-v1";
const STORAGE_FULL = "mandate-full-tour-v1";

const EXPLAIN_COPY = {
  act1: {
    badge: "幕一",
    title: "假漂亮噸數被拒收",
    body: "無證零件行只交噸數、缺方法／邊界／期間。系統<strong>預期拒收</strong>，不是卡住——這就是信任閘門的第一道防線。",
  },
  act2: {
    badge: "幕二",
    title: "寫入草稿前必須你點頭",
    body: "青禾數據品質合格後，AI 只能「申請寫入」；必須你在待核准橫幅按確認，才真正 commit。",
  },
  act3: {
    badge: "幕三",
    title: "撤銷後不能再申報",
    body: "供應商分享一撤，AI 不得再拿這批數字寫 CBAM／客戶回覆——即使還記得舊噸數也一樣擋。",
  },
  step: {
    badge: "正常步驟",
    title: "這一步通過了",
    body: "索取、取回等中間步驟放行，代表流程有照規則走，可繼續下一步。",
  },
  deny: {
    badge: "政策擋下",
    title: "這一步被擋",
    body: "政策引擎判定不可執行。右欄或詳細控制可看完整 policyId。",
  },
};

const ACT_ORDER = { act1: 1, act2: 2, act3: 3, step: 4, deny: 5 };

const FULL_STEPS = [
  {
    badge: "提示列",
    title: "這不是算碳儀表板",
    body: "頂部這條提示：<strong>Mandate 只管數字夠不夠格</strong>寫進 CBAM／客戶回覆，不是幫你算碳足跡或做 ESG 儀表板。",
    target: () => $("tip-bar"),
    padding: 4,
    beforeShow: () => {
      goDashboard();
      const tip = $("tip-bar");
      if (tip) tip.hidden = false;
    },
  },
  {
    badge: "頂欄",
    title: "這個 AI 代表誰？",
    body: "左側文字：AI 代表<strong>艾克美工業・貿易合規</strong>向供應商要碳數據。右側「授權有效」：合規主管已授權，過期或收回後 AI 不得再動。",
    target: () => $("topbar-meta"),
    padding: 8,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "頂欄",
    title: "三種畫面怎麼切？",
    body: "<strong>主控版</strong>：日常操作與下一步建議。<strong>詳細控制</strong>：手動逐步、完整對話、含 policyId 的稽核。<strong>政策引擎</strong>：評審專用透明後台（六步管線＋模擬）。<strong>供應商自查</strong>：小廠貼 JSON 自測，不寫入正式流程。",
    target: () => document.querySelector(".mode-tabs"),
    padding: 6,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "主控版",
    title: "供應商進度：①→②→③→④",
    body: "每張卡是一家供應商。<strong>①索取</strong> → <strong>②取回</strong> → <strong>③品質檢查</strong> → <strong>④申請寫入</strong>。圓點停在第幾步，就代表現在卡在哪。",
    target: () => $("pipeline-grid"),
    padding: 8,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "主控版",
    title: "狀態摘要",
    body: "這行小字彙總：幾家待核准、幾家進行中、授權是否有效。不用自己猜「現在整體狀況如何」。",
    target: () => $("dash-meta"),
    padding: 6,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "主控版",
    title: "跟 AI 操作",
    body: "<strong>AI 自動演三幕</strong>：30 秒演示信任邊界（拒收假數據 → 等你核准 → 撤銷後不能用）。下方輸入框：用自然語言下指令，例如「向無證零件行索取並做品質檢查」。",
    target: () => document.querySelector(".dash-actions-row"),
    padding: 8,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "主控版",
    title: "下一步建議",
    body: "系統依各供應商 pipeline 狀態，告訴你<strong>現在優先該做什麼</strong>。不確定時先看這裡，再決定要不要手動或叫 AI。",
    target: () => $("dash-next"),
    padding: 8,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "主控版",
    title: "最近動作（白話版）",
    body: "每一個 ALLOW／DENY／PENDING 都會以<strong>人話</strong>出現在這裡。跑完三幕 Demo 後，還可以逐條聚光解說。要看 policyId 請切詳細控制。",
    target: () => $("recent-feed") || document.querySelector(".dash-side"),
    padding: 6,
    beforeShow: () => goDashboard(),
  },
  {
    badge: "詳細控制",
    title: "手動備援與評審對照",
    body: "AI 卡住、評審要對文件、或你想逐步確認時用這裡。<strong>手動按鈕須依序 ①→②→③→④</strong>，跳步會被擋。下方可撤銷分享、收回授權、重置 Demo。",
    target: () => $("panel-auth"),
    padding: 8,
    beforeShow: () => goDetail(),
  },
  {
    badge: "詳細控制",
    title: "Agent 完整對話",
    body: "主控版指令的<strong>完整紀錄</strong>都在這。若有「待合規主管確認」，橫幅會出現——<strong>必須你按確認</strong>，AI 才能寫入 CBAM 草稿（人機協作閘門）。",
    target: () => $("agent-chat"),
    padding: 8,
    beforeShow: () => goDetail(),
  },
  {
    badge: "詳細控制",
    title: "稽核紀錄（含 policyId）",
    body: "每一步決策的<strong>政策代碼</strong>都在這，可匯出給評審或內控。主控版「最近動作」是白話摘要，這裡是正式追溯。",
    target: () => $("panel-audit"),
    padding: 8,
    beforeShow: () => goDetail(),
  },
  {
    badge: "政策引擎",
    title: "評審專用：透明判斷後台",
    body: "切到<strong>政策引擎</strong>分頁：可看到六步管線（status → deny → allow → constraints → HITL → ALLOW）、政策目錄 POL-*，以及<strong>不寫 audit 的模擬器</strong>。",
    target: () => $("tab-policy"),
    padding: 6,
    beforeShow: () => goPolicy(),
  },
  {
    badge: "政策引擎",
    title: "一鍵重現三幕 policy 判斷",
    body: "左欄預設情境按鈕：<strong>幕一拒收</strong>、<strong>幕二 HITL</strong>、<strong>幕三撤銷</strong>、<strong>Agent 禁 commit</strong>。按下去立刻看第幾步、哪條 POL-* 擋下。",
    target: () => $("policy-presets"),
    padding: 8,
    beforeShow: () => goPolicy(),
  },
  {
    badge: "供應商自查",
    title: "小廠自查入口",
    body: "被客戶催交碳數據的小廠：點這裡或主控版的「供應商自查」，<strong>貼 JSON 看缺什麼欄位</strong>，不會寫入正式申報。",
    target: () => $("tab-supplier"),
    padding: 8,
    beforeShow: () => {
      goDashboard();
      closeSupplier();
    },
  },
  {
    badge: "供應商自查",
    title: "貼 JSON，看能不能交",
    body: "可一鍵載入「只有噸數」或「完整資料」範本，再按<strong>檢查能不能交</strong>。缺方法／邊界／期間會被標出——和幕一拒收是同一套規則。",
    target: () => document.querySelector("#supplier-modal .modal-dialog"),
    padding: 10,
    modalStep: true,
    beforeShow: () => {
      goDashboard();
      openSupplier();
    },
    afterHide: () => closeSupplier(),
  },
  {
    badge: "下一步",
    title: "建議：跑一遍三幕 Demo",
    body: "介面導覽到此。按<strong>「開始三幕解說」</strong>會聚光這顆按鈕、自動演示，並逐條解釋右邊最近動作。也可按「完成」先自己探索。",
    target: () => $("btn-demo"),
    padding: 10,
    beforeShow: () => {
      goDashboard();
      closeSupplier();
    },
    primaryLabel: "開始三幕解說",
    finishLabel: "完成",
    isLast: true,
  },
];

let callbacks = {};
let tourKind = null;
let active = false;
let fullStepIndex = 0;
let phase = null;
let explainItems = [];
let explainIndex = 0;
let waitingForDemo = false;
let resizeHandler = null;

function $(id) {
  return document.getElementById(id);
}

function goDashboard() {
  callbacks.setViewDashboard?.();
}

function goDetail() {
  callbacks.setViewDetail?.();
}

function goPolicy() {
  callbacks.setViewPolicy?.();
}

function openSupplier() {
  callbacks.openSupplierModal?.();
}

function closeSupplier() {
  callbacks.closeSupplierModal?.();
}

function hasSeenDemoTour() {
  try {
    return localStorage.getItem(STORAGE_DEMO) === "1";
  } catch {
    return false;
  }
}

function markDemoTourSeen() {
  try {
    localStorage.setItem(STORAGE_DEMO, "1");
  } catch {
    /* ignore */
  }
}

function hasSeenFullTour() {
  try {
    return localStorage.getItem(STORAGE_FULL) === "1";
  } catch {
    return false;
  }
}

function markFullTourSeen() {
  try {
    localStorage.setItem(STORAGE_FULL, "1");
  } catch {
    /* ignore */
  }
}

function isTourOpen() {
  const overlay = $("tour-overlay");
  return active && overlay && !overlay.hidden;
}

function getExplainCopy(act, plainText) {
  const base = EXPLAIN_COPY[act] || EXPLAIN_COPY.deny;
  if (act === "deny" && plainText) {
    return { ...base, body: plainText };
  }
  return base;
}

function resetTooltipPosition() {
  const tooltip = $("tour-tooltip");
  if (!tooltip) return;
  tooltip.style.top = "";
  tooltip.style.left = "";
  tooltip.style.bottom = "";
  tooltip.style.right = "";
  tooltip.style.transform = "";
}

function positionHole(targetEl, padding = 8) {
  const hole = $("tour-hole");
  if (!hole || !targetEl) return;
  const rect = targetEl.getBoundingClientRect();
  const top = Math.max(8, rect.top - padding);
  const left = Math.max(8, rect.left - padding);
  const width = rect.width + padding * 2;
  const height = rect.height + padding * 2;
  hole.style.top = `${top}px`;
  hole.style.left = `${left}px`;
  hole.style.width = `${width}px`;
  hole.style.height = `${height}px`;
  hole.hidden = false;

  if (document.body.classList.contains("tour-modal-step")) return;

  const tooltip = $("tour-tooltip");
  if (!tooltip) return;
  resetTooltipPosition();
  const tRect = tooltip.getBoundingClientRect();
  let tipTop = top + height + 12;
  let tipLeft = left;
  if (tipTop + tRect.height > window.innerHeight - 12) {
    tipTop = Math.max(12, top - tRect.height - 12);
  }
  if (tipLeft + tRect.width > window.innerWidth - 12) {
    tipLeft = window.innerWidth - tRect.width - 12;
  }
  tooltip.style.top = `${tipTop}px`;
  tooltip.style.left = `${Math.max(12, tipLeft)}px`;
}

function centerTooltip() {
  const tooltip = $("tour-tooltip");
  if (!tooltip) return;
  resetTooltipPosition();
  tooltip.style.top = "50%";
  tooltip.style.left = "50%";
  tooltip.style.transform = "translate(-50%, -50%)";
}

function hideHole() {
  const hole = $("tour-hole");
  if (hole) hole.hidden = true;
}

function setTooltip({ badge, title, body, stepLabel, primaryLabel, finishLabel, showSkip, showPrimary }) {
  $("tour-badge").textContent = badge || "";
  $("tour-title").textContent = title || "";
  $("tour-body").innerHTML = body || "";
  $("tour-step-label").textContent = stepLabel || "";
  const primary = $("tour-primary");
  const skip = $("tour-skip");
  if (primary) {
    primary.hidden = !showPrimary;
    primary.textContent = primaryLabel || "下一步";
  }
  if (skip) {
    skip.hidden = !showSkip;
    skip.textContent = finishLabel || "稍後再說";
  }
}

function clearItemHighlights() {
  document.querySelectorAll(".recent-item.tour-active").forEach((el) => {
    el.classList.remove("tour-active");
  });
}

function bindResize(targetEl, padding) {
  unbindResize();
  resizeHandler = () => {
    if (targetEl && targetEl.isConnected) positionHole(targetEl, padding);
  };
  window.addEventListener("resize", resizeHandler);
  window.addEventListener("scroll", resizeHandler, true);
}

function unbindResize() {
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
    window.removeEventListener("scroll", resizeHandler, true);
    resizeHandler = null;
  }
}

function showOverlay() {
  const overlay = $("tour-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  const tooltip = $("tour-tooltip");
  if (tooltip) tooltip.hidden = false;
  document.body.classList.add("tour-open");
  active = true;
}

function hideOverlay() {
  const overlay = $("tour-overlay");
  if (overlay) overlay.hidden = true;
  const tooltip = $("tour-tooltip");
  if (tooltip) tooltip.hidden = true;
  document.body.classList.remove("tour-open", "tour-modal-step");
  resetTooltipPosition();
  active = false;
  tourKind = null;
  phase = null;
  fullStepIndex = 0;
  waitingForDemo = false;
  explainItems = [];
  explainIndex = 0;
  clearItemHighlights();
  unbindResize();
  hideHole();
  $("btn-demo")?.classList.remove("tour-pulse");
  closeSupplier();
}

function collectExplainItems() {
  const items = [...document.querySelectorAll("#recent-feed .recent-item")];
  return items.sort((a, b) => {
    const oa = ACT_ORDER[a.dataset.tourAct] || 99;
    const ob = ACT_ORDER[b.dataset.tourAct] || 99;
    return oa - ob;
  });
}

function renderFullStep() {
  tourKind = "full";
  phase = "fullStep";
  const step = FULL_STEPS[fullStepIndex];
  if (!step) {
    finishFullTour();
    return;
  }

  showOverlay();
  document.body.classList.toggle("tour-modal-step", !!step.modalStep);
  if (!step.modalStep) resetTooltipPosition();
  step.beforeShow?.();
  const el = step.target?.();
  const padding = step.padding ?? 8;

  setTooltip({
    badge: step.badge,
    title: step.title,
    body: step.body,
    stepLabel: `${fullStepIndex + 1} / ${FULL_STEPS.length}`,
    showSkip: true,
    showPrimary: true,
    primaryLabel: step.primaryLabel || "下一步",
    finishLabel: step.finishLabel,
  });

  if (el) {
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    positionHole(el, padding);
    bindResize(el, padding);
  } else {
    hideHole();
    centerTooltip();
  }

  if (step.isLast && el?.id === "btn-demo") {
    el.classList.add("tour-pulse");
  } else {
    $("btn-demo")?.classList.remove("tour-pulse");
  }
}

function renderPressDemo() {
  tourKind = "demo";
  phase = "pressDemo";
  waitingForDemo = true;
  const btn = $("btn-demo");
  if (!btn) return;
  goDashboard();
  closeSupplier();
  setTooltip({
    badge: "三幕解說",
    title: "請按「AI 自動演三幕」",
    body:
      "畫面已暗下來，<strong>請親自點這顆按鈕</strong>。系統會自動演示：<br>① 拒收假漂亮噸數 → ② 等你核准才寫草稿 → ③ 撤銷後不能用。",
    stepLabel: "1 / 4",
    showSkip: true,
    showPrimary: false,
  });
  showOverlay();
  btn.classList.add("tour-pulse");
  positionHole(btn, 10);
  bindResize(btn, 10);
}

function renderDemoRunning() {
  phase = "demoRunning";
  waitingForDemo = false;
  $("btn-demo")?.classList.remove("tour-pulse");
  hideHole();
  setTooltip({
    badge: "演示中",
    title: "三幕演示進行中…",
    body: "約 30 秒，請稍候。完成後會帶你看右邊「最近動作」並逐條解釋。",
    stepLabel: "2 / 4",
    showSkip: false,
    showPrimary: false,
  });
  centerTooltip();
}

function renderFocusFeed() {
  phase = "focusFeed";
  goDashboard();
  const feed = $("recent-feed") || document.querySelector(".dash-side");
  const tooltip = $("tour-tooltip");
  if (tooltip) tooltip.style.transform = "";
  setTooltip({
    badge: "三幕解說",
    title: "看這裡：最近動作",
    body: "Demo 的每一個決策都會出現在這裡。接下來會<strong>由舊到新</strong>逐條解釋（幕一 → 幕二 → 幕三）。",
    stepLabel: "3 / 4",
    showSkip: true,
    showPrimary: true,
    primaryLabel: "開始解說",
  });
  if (feed) {
    positionHole(feed, 6);
    bindResize(feed, 6);
  }
}

function renderExplainItem() {
  phase = "explainItem";
  const item = explainItems[explainIndex];
  const tooltip = $("tour-tooltip");
  if (tooltip) tooltip.style.transform = "";
  clearItemHighlights();

  if (!item) {
    finishDemoTour();
    return;
  }

  item.classList.add("tour-active");
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });

  const act = item.dataset.tourAct || "deny";
  const plain = item.querySelector(".recent-plain")?.textContent?.trim() || "";
  const copy = getExplainCopy(act, plain);

  const isLast = explainIndex >= explainItems.length - 1;
  setTooltip({
    badge: copy.badge,
    title: copy.title,
    body: copy.body,
    stepLabel: `${explainIndex + 1} / ${explainItems.length} 條紀錄`,
    showSkip: true,
    showPrimary: true,
    primaryLabel: isLast ? "完成導覽" : "下一條",
  });
  positionHole(item, 6);
  bindResize(item, 6);
}

export function isTourActive() {
  return active;
}

export function startFullTour(options = {}) {
  if (!options.force && hasSeenFullTour()) return;
  fullStepIndex = 0;
  explainItems = [];
  explainIndex = 0;
  renderFullStep();
}

export function startTour(options = {}) {
  if (!options.force && hasSeenDemoTour()) return;
  fullStepIndex = 0;
  explainItems = [];
  explainIndex = 0;
  renderPressDemo();
}

export function maybeStartTourAfterOnboard() {
  if (hasSeenFullTour()) return;
  setTimeout(() => startFullTour(), 300);
}

export function notifyDemoStarted() {
  if (!waitingForDemo && phase !== "pressDemo") return;
  renderDemoRunning();
}

export function onDemoComplete() {
  if (!active || tourKind !== "demo") return;
  explainItems = collectExplainItems();
  explainIndex = 0;
  renderFocusFeed();
}

export function isWaitingForDemoClick() {
  return waitingForDemo && phase === "pressDemo";
}

function advanceFullTour() {
  const current = FULL_STEPS[fullStepIndex];
  if (current?.isLast) {
    markFullTourSeen();
    current.afterHide?.();
    tourKind = "demo";
    fullStepIndex = 0;
    explainItems = [];
    explainIndex = 0;
    renderPressDemo();
    return;
  }
  current?.afterHide?.();
  fullStepIndex += 1;
  if (fullStepIndex >= FULL_STEPS.length) {
    finishFullTour();
    return;
  }
  renderFullStep();
}

function advanceTour() {
  if (tourKind === "full" && phase === "fullStep") {
    advanceFullTour();
    return;
  }
  if (phase === "focusFeed") {
    explainIndex = 0;
    if (!explainItems.length) {
      explainItems = collectExplainItems();
    }
    if (!explainItems.length) {
      setTooltip({
        badge: "提示",
        title: "尚無紀錄可解說",
        body: "請確認 Demo 已跑完，或到「詳細控制」看完整 audit。",
        stepLabel: "",
        showSkip: false,
        showPrimary: true,
        primaryLabel: "完成",
      });
      phase = "done";
      hideHole();
      return;
    }
    renderExplainItem();
    return;
  }
  if (phase === "explainItem") {
    explainIndex += 1;
    if (explainIndex >= explainItems.length) {
      finishDemoTour();
      return;
    }
    renderExplainItem();
    return;
  }
  if (phase === "done") {
    finishDemoTour();
  }
}

function skipTour() {
  if (tourKind === "full") {
    FULL_STEPS[fullStepIndex]?.afterHide?.();
    markFullTourSeen();
  } else {
    markDemoTourSeen();
  }
  hideOverlay();
}

function finishFullTour() {
  FULL_STEPS[fullStepIndex]?.afterHide?.();
  markFullTourSeen();
  hideOverlay();
}

function finishDemoTour() {
  markDemoTourSeen();
  hideOverlay();
}

export function handleTourEscape() {
  if (!isTourOpen()) return false;
  if (phase === "demoRunning") return true;
  skipTour();
  return true;
}

export function initTour(cbs = {}) {
  callbacks = cbs;
  $("tour-primary")?.addEventListener("click", advanceTour);
  $("tour-skip")?.addEventListener("click", skipTour);
}

export function openHelpMenu({ onFullTour, onDemoTour, onWizard, onPolicyGuide, onShowTip, onSimOffline }) {
  const menu = $("help-menu");
  const trigger = $("btn-onboard-help");
  if (!menu) {
    onFullTour?.();
    return;
  }
  const wasOpen = !menu.hidden;
  menu.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  if (wasOpen) return;
  menu.hidden = false;
  trigger?.setAttribute("aria-expanded", "true");
  const close = () => {
    menu.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
  };
  const onDocClick = (ev) => {
    if (!menu.contains(ev.target) && !ev.target.closest("#btn-onboard-help")) {
      close();
    }
  };
  setTimeout(() => document.addEventListener("click", onDocClick), 0);

  const bindOnce = (id, handler) => {
    $(id)?.addEventListener(
      "click",
      (ev) => {
        ev.stopPropagation();
        close();
        handler?.();
      },
      { once: true }
    );
  };

  bindOnce("help-menu-full-tour", onFullTour);
  bindOnce("help-menu-tour", onDemoTour);
  bindOnce("help-menu-wizard", onWizard);
  bindOnce("help-menu-policy", onPolicyGuide);
  bindOnce("help-menu-tip", onShowTip);
  bindOnce("help-menu-sim-offline", onSimOffline);
}
