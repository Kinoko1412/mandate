/**
 * Policy Engine Console — transparent evaluation for judges
 */

import { emptyState, icon } from "./icons.js";

const TOOL_OPTIONS = [
  { value: "request_emissions", label: "① 索取 request_emissions" },
  { value: "fetch_supplier_response", label: "② 取回 fetch_supplier_response" },
  { value: "ingest_pcf_payload", label: "③ 品質檢查 ingest_pcf_payload" },
  { value: "submit_cbam_draft", label: "④ 申請寫入 submit_cbam_draft" },
  { value: "commit_cbam_draft", label: "commit_cbam_draft（Human/System）" },
];

const ACTOR_OPTIONS = [
  { value: "AGENT", label: "Agent（AI 助理）" },
  { value: "HUMAN", label: "Human（合規主管）" },
  { value: "SYSTEM", label: "System（核准後自動）" },
];

const PRESETS = [
  {
    id: "act1",
    label: "幕一：拒收噸數",
    toolName: "ingest_pcf_payload",
    actorType: "AGENT",
    supplierId: "supplier_unverified_01",
    input: { supplierId: "supplier_unverified_01", tCO2e: 8.1 },
  },
  {
    id: "act2",
    label: "幕二：申請寫入",
    toolName: "submit_cbam_draft",
    actorType: "AGENT",
    supplierId: "supplier_green_01",
    input: { supplierId: "supplier_green_01" },
    hint: "須先對青禾完成 ①→③ 入庫；否則 step 4 會擋下。",
  },
  {
    id: "act3",
    label: "幕三：撤銷後取回",
    toolName: "fetch_supplier_response",
    actorType: "AGENT",
    supplierId: "supplier_green_01",
    input: { supplierId: "supplier_green_01" },
    hint: "須先在詳細控制按「撤銷分享」；否則可能 ALLOW。",
  },
  {
    id: "agent-commit",
    label: "Agent 禁 commit",
    toolName: "commit_cbam_draft",
    actorType: "AGENT",
    supplierId: "supplier_green_01",
    input: { supplierId: "supplier_green_01" },
  },
];

let apiFn = null;
let gotoDetailFn = null;
let suppliers = [];
let policies = [];
const STEP_CHIPS = [0, 1, 2, 3, 4, 5, 6];
let stepFilters = new Set(); // 空集合 = 全部步驟
let searchKw = "";

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

function decisionClass(decision) {
  if (!decision) return "";
  if (decision === "ALLOW") return "ALLOW";
  if (decision === "PENDING_HUMAN") return "PENDING_HUMAN";
  return "DENY_POLICY";
}

function traceStatusClass(status) {
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  if (status === "pending") return "pending";
  return "skipped";
}

function highlight(text, kw) {
  const s = String(text ?? "");
  if (!kw) return escapeHtml(s);
  const idx = s.toLowerCase().indexOf(kw.toLowerCase());
  if (idx === -1) return escapeHtml(s);
  return (
    escapeHtml(s.slice(0, idx)) +
    `<mark class="policy-hl">${escapeHtml(s.slice(idx, idx + kw.length))}</mark>` +
    escapeHtml(s.slice(idx + kw.length))
  );
}

function renderStepChips() {
  const wrap = $("policy-step-chips");
  if (!wrap) return;
  wrap.innerHTML = STEP_CHIPS.map((step) => {
    const active = step === 0 ? stepFilters.size === 0 : stepFilters.has(step);
    const label = step === 0 ? "全部" : `步驟 ${step}`;
    return `<button type="button" class="policy-chip${active ? " active" : ""}" data-step="${step}">${label}</button>`;
  }).join("");
  wrap.querySelectorAll(".policy-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const step = Number(chip.dataset.step);
      if (step === 0) {
        stepFilters.clear();
      } else {
        if (stepFilters.has(step)) stepFilters.delete(step);
        else stepFilters.add(step);
      }
      renderStepChips();
      renderCatalog();
    });
  });
}

function renderCatalog() {
  const ul = $("policy-catalog");
  const noResult = $("policy-no-result");
  const count = $("policy-search-count");
  if (!ul) return;
  const kw = searchKw.trim();
  const filtered = policies.filter((p) => {
    const stepOk = stepFilters.size === 0 || stepFilters.has(p.evalStep);
    const kwOk =
      !kw ||
      `${p.policyId} ${p.title} ${p.summary || ""}`.toLowerCase().includes(kw.toLowerCase());
    return stepOk && kwOk;
  });
  if (count) count.textContent = `顯示 ${filtered.length} / 共 ${policies.length} 筆`;
  if (!filtered.length) {
    ul.innerHTML = "";
    ul.hidden = true;
    if (noResult) {
      noResult.hidden = false;
      noResult.innerHTML = emptyState({
        iconName: "search-off",
        headline: "找不到符合的規則，換個關鍵字試試",
        body: "",
      });
    }
    return;
  }
  ul.hidden = false;
  if (noResult) noResult.hidden = true;
  ul.innerHTML = filtered
    .map(
      (p) => `
    <li data-policy-id="${escapeHtml(p.policyId)}" title="${escapeHtml(p.summary || "")}">
      <div class="pid">${highlight(p.policyId, kw)} · step ${p.evalStep || "—"}</div>
      <div class="ptitle">${highlight(p.title, kw)}</div>
    </li>`
    )
    .join("");
}

function renderPipeline(trace) {
  const ul = $("policy-pipeline");
  if (!ul) return;
  if (!trace || !trace.length) {
    ul.innerHTML = '<li class="feed-empty">執行模擬後顯示六步管線</li>';
    return;
  }
  // 依序逐格顯示（每格間隔 90ms），讓「短路管線」的敘事看起來像真的在跑，
  // 而不是六步一次全部瞬間出現。
  ul.innerHTML = trace
    .map((t, i) => {
      const cls = traceStatusClass(t.status);
      const glyph =
        t.status === "pass"
          ? "✓"
          : t.status === "fail"
            ? "✗"
            : t.status === "pending"
              ? "!"
              : "—";
      return `
      <li class="${cls} pipeline-reveal" style="animation-delay:${i * 90}ms">
        <span class="pipeline-step-num" aria-hidden="true">${glyph}</span>
        <div class="pipeline-body">
          <div class="pipeline-title">${t.step}. ${escapeHtml(t.title)}</div>
          ${t.detail ? `<div class="pipeline-detail">${escapeHtml(t.detail)}</div>` : ""}
          ${t.policyId && t.status !== "pass" ? `<div class="pipeline-pid">${escapeHtml(t.policyId)}</div>` : ""}
        </div>
      </li>`;
    })
    .join("");
}

function renderResult(data, hint) {
  const box = $("policy-result");
  if (!box) return;
  if (!data) {
    box.className = "policy-result empty";
    box.innerHTML = emptyState({
      iconName: "flask",
      headline: "選好條件，看規則怎麼判",
      body: "選工具、角色、供應商後按執行模擬，六步管線會即時顯示判定過程",
      context: "不會寫入 audit",
      ctaId: "policy-empty-try",
      ctaLabel: "用範例快速試試",
    });
    box.querySelector("#policy-empty-try")?.addEventListener("click", () => runPolicyPreset("act1"));
    renderPipeline(null);
    return;
  }
  box.className = "policy-result";
  const badgeCls = decisionClass(data.decision);
  box.innerHTML = `
    <span class="policy-decision-badge ${badgeCls}">${escapeHtml(data.decision)}</span>
    <p class="policy-plain">${escapeHtml(data.plainReason || data.reason || "")}</p>
    <p class="pipeline-pid">policyId：${escapeHtml(data.policyId || "—")}</p>
    ${hint ? `<p class="pipeline-detail">${escapeHtml(hint)}</p>` : ""}
  `;
  renderPipeline(data.trace);
}

function renderContext(snap) {
  const dl = $("policy-context");
  if (!dl || !snap) return;
  const reqList = (snap.emissionsRequests || []).join(", ") || "（無）";
  const revList = (snap.revokedShares || []).join(", ") || "（無）";
  const stagingList = (snap.stagingSuppliers || []).join(", ") || "（無）";
  dl.innerHTML = `
    <dt>Mandate</dt>
    <dd>${escapeHtml(snap.mandateStatus || "—")} · 到期 ${escapeHtml((snap.mandateExpiresAt || "—").slice(0, 10))}</dd>
    <dt>角色 / 工具</dt>
    <dd>${escapeHtml(snap.actorType || "—")} → ${escapeHtml(snap.toolName || "—")}</dd>
    <dt>供應商</dt>
    <dd>${escapeHtml(snap.supplierId || "—")}</dd>
    <dt>已索取</dt>
    <dd>${snap.hasEmissionsRequest ? "是" : "否"} · ${escapeHtml(reqList)}</dd>
    <dt>分享撤銷</dt>
    <dd>${snap.shareRevoked ? "是" : "否"} · ${escapeHtml(revList)}</dd>
    <dt>暫存 Staging</dt>
    <dd>${snap.hasStaging ? "有可用資料" : "無"} · ${escapeHtml(stagingList)}</dd>
  `;
}

function fillSimulator({ toolName, actorType, supplierId, input }) {
  const toolSel = $("policy-sim-tool");
  const actorSel = $("policy-sim-actor");
  const supSel = $("policy-sim-supplier");
  if (toolSel && toolName) toolSel.value = toolName;
  if (actorSel && actorType) actorSel.value = actorType;
  if (supSel && supplierId) supSel.value = supplierId;
  if (input && $("policy-sim-input")) {
    $("policy-sim-input").value = JSON.stringify(input, null, 2);
  }
}

async function runSimulate(presetHint) {
  if (!apiFn) return;
  const toolName = $("policy-sim-tool")?.value;
  const actorType = $("policy-sim-actor")?.value || "AGENT";
  const supplierId = $("policy-sim-supplier")?.value || "";
  if (!toolName) {
    renderResult(null);
    $("policy-result").innerHTML =
      '<span class="policy-decision-badge DENY_POLICY">請選工具</span><p class="policy-plain">模擬器尚未載入完成，或尚未選擇工具。</p>';
    return;
  }
  let input = {};
  const rawInput = ($("policy-sim-input")?.value || "").trim();
  if (rawInput) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      renderResult(null);
      $("policy-result").innerHTML =
        '<span class="policy-decision-badge DENY_POLICY">JSON 錯誤</span><p class="policy-plain">input 欄位不是合法 JSON。</p>';
      return;
    }
  } else if (supplierId) {
    input = { supplierId };
  }

  const btn = $("policy-sim-run");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "模擬中…";
  }
  try {
    const data = await apiFn("/policy/simulate", {
      method: "POST",
      body: JSON.stringify({ toolName, actorType, input }),
    });
    renderResult(data, presetHint);
    renderContext(data.contextSnapshot);
    const hit = data.policyId && $("policy-catalog")?.querySelector(`[data-policy-id="${data.policyId}"]`);
    $("policy-catalog")?.querySelectorAll("li").forEach((li) => li.classList.remove("active"));
    hit?.classList.add("active");
    hit?.scrollIntoView({ block: "nearest" });
  } catch (e) {
    renderResult(null);
    $("policy-result").innerHTML = `<span class="policy-decision-badge DENY_POLICY">模擬失敗</span><p class="policy-plain">${escapeHtml(e.message)}</p>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "執行模擬";
    }
  }
}

export function runPolicyPreset(presetId) {
  const preset = PRESETS.find((x) => x.id === presetId);
  if (!preset) return;
  fillSimulator(preset);
  runSimulate(preset.hint || "");
}

function renderPresets() {
  const wrap = $("policy-presets");
  if (!wrap) return;
  wrap.innerHTML = PRESETS.map(
    (p) =>
      `<button type="button" class="btn btn-sm btn-ghost" data-preset="${p.id}">${escapeHtml(p.label)}</button>`
  ).join("");
  wrap.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS.find((x) => x.id === btn.dataset.preset);
      if (!preset) return;
      fillSimulator(preset);
      runSimulate(preset.hint || "");
    });
  });
}

function renderSimulatorOptions() {
  const toolSel = $("policy-sim-tool");
  const actorSel = $("policy-sim-actor");
  const supSel = $("policy-sim-supplier");
  if (toolSel) {
    toolSel.innerHTML = TOOL_OPTIONS.map(
      (o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
    ).join("");
  }
  if (actorSel) {
    actorSel.innerHTML = ACTOR_OPTIONS.map(
      (o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
    ).join("");
  }
  if (supSel) {
    supSel.innerHTML =
      '<option value="">— 選供應商 —</option>' +
      suppliers
        .map(
          (s) =>
            `<option value="${escapeHtml(s.supplierId)}">${escapeHtml(s.orgName || s.supplierId)}</option>`
        )
        .join("");
  }
}

function renderQuickstart() {
  const box = $("policy-quickstart");
  if (!box) return;
  try {
    box.hidden = localStorage.getItem("mandate-policy-guide-v1") === "1";
  } catch {
    box.hidden = false;
  }
}

function bindPolicyConsole() {
  $("policy-search")?.addEventListener("input", (ev) => {
    searchKw = ev.target.value || "";
    renderCatalog();
  });
  $("policy-sim-run")?.addEventListener("click", () => runSimulate());
  $("policy-goto-audit")?.addEventListener("click", () => {
    gotoDetailFn?.();
    requestAnimationFrame(() => {
      $("panel-audit")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

export async function refreshPolicyConsole() {
  if (!apiFn) return;
  try {
    const [polRes, supRes] = await Promise.all([
      apiFn("/policies"),
      apiFn("/suppliers").catch(() => ({ suppliers: [] })),
    ]);
    policies = polRes.policies || [];
    suppliers = supRes.suppliers || [];
    renderCatalog();
    renderSimulatorOptions();
  } catch {
    /* non-fatal */
  }
}

export function initPolicyConsole({ api, setViewDetail }) {
  apiFn = api;
  gotoDetailFn = setViewDetail;
  const searchIcon = $("policy-search-icon");
  if (searchIcon) searchIcon.innerHTML = icon("search", "micon-sm");
  renderStepChips();
  renderSimulatorOptions();
  renderPresets();
  renderQuickstart();
  renderResult(null);
  bindPolicyConsole();
  refreshPolicyConsole();
}

export function setViewPolicy() {
  refreshPolicyConsole();
  renderQuickstart();
}
