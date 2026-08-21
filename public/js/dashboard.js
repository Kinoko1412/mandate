/**
 * 主控版渲染 — 資料來源：/api/session + /api/audit
 */

import { icon } from "./icons.js";

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

function isIngestRejected(p) {
  const d = p.lastDecision;
  return (
    !p.staged &&
    !p.shareRevoked &&
    d?.toolName === "ingest_pcf_payload" &&
    d?.decision &&
    d.decision !== "ALLOW"
  );
}

function isSupplierDeadEnd(p) {
  return p.shareRevoked || isIngestRejected(p);
}

function pipelineStatusText(p) {
  if (p.shareRevoked) return "分享已撤銷，不可再用於申報。";
  if (p.committedDraft) return "已成功寫入 CBAM 申報草稿。";
  if (p.pendingApproval) return "等待合規主管確認寫入申報草稿。";
  if (p.staged) {
    const tier = p.qualityTier === "PARTIAL" ? "（進階欄位未齊）" : "";
    return `已通過品質檢查，在暫存區${tier}。`;
  }
  const d = p.lastDecision;
  if (d?.toolName === "ingest_pcf_payload" && d.decision !== "ALLOW") {
    return "品質檢查已完成：這批數據不符合入庫標準（拒收）。";
  }
  if (p.requested) return "已索取，可取回回覆做品質檢查。";
  return "尚未索取碳數據。";
}

function lastDecisionText(p) {
  const d = p.lastDecision;
  if (!d) return "";
  if (d.decision === "DENY_CONSTRAINT" || d.decision === "DENY_POLICY") {
    if (d.toolName === "ingest_pcf_payload") return "上次：品質拒收（③ 已執行）";
    return "上次：品質或政策拒收";
  }
  if (d.decision === "ALLOW" && d.toolName === "ingest_pcf_payload") {
    return "上次：已入庫";
  }
  return `上次：${d.decision || "—"}`;
}

function nextStepForSupplier(p) {
  const name = p.orgName || p.supplierId;
  if (p.shareRevoked) {
    return { text: `${name}：分享已撤銷`, muted: true, deadEnd: true };
  }
  if (isIngestRejected(p)) {
    return { text: `${name}：品質已拒收，無法繼續`, muted: true, deadEnd: true };
  }
  if (p.committedDraft) {
    return { text: `${name}：已成功寫入申報草稿`, success: true };
  }
  if (p.pendingApproval) {
    return { text: `${name}：等待你確認寫入申報草稿`, primary: true };
  }
  if (p.staged) {
    return { text: `${name}：品質已過，可申請寫入草稿`, primary: true };
  }
  if (p.requested) {
    return { text: `${name}：可取回回覆並做品質檢查`, primary: true };
  }
  return { text: `${name}：先向供應商索取碳數據`, primary: true };
}

function buildNextStepList(pipeline) {
  const ordered = sortPipelineForDisplay(pipeline);
  const steps = ordered.map(nextStepForSupplier);
  let foundPrimary = false;
  return steps.map((s) => {
    if (s.muted || s.deadEnd || s.success || foundPrimary || !s.primary) {
      return { ...s, primary: false };
    }
    foundPrimary = true;
    return s;
  });
}

function sortPipelineForDisplay(pipeline) {
  return [...pipeline].sort((a, b) => pipelineSortScore(a) - pipelineSortScore(b));
}

function pipelineSortScore(p) {
  if (isSupplierDeadEnd(p)) return 3;
  if (p.pendingApproval || p.staged) return 0;
  if (p.requested && !isIngestRejected(p)) return 1;
  return 2;
}

function renderNextSteps(session, pending, summary, agentConfigured) {
  const pipeline = session.supplierPipeline || [];
  const steps = buildNextStepList(pipeline);
  const primary = steps.find((s) => s.primary);

  if (pending) {
    return {
      lead: "有一筆申請寫入草稿等你確認 — 請用上方橫幅按「確認」或「不同意」。",
      steps,
    };
  }
  if (summary.mandateStatus && summary.mandateStatus !== "ACTIVE") {
    return {
      lead: "授權已失效，AI 不能再代表公司操作。請在詳細控制重新設定或重置 Demo。",
      steps,
    };
  }
  if (!primary) {
    const allDead =
      pipeline.length > 0 && pipeline.every((p) => isSupplierDeadEnd(p));
    if (allDead) {
      return {
        lead: "兩家都已到終點（無證拒收、青禾撤銷）。要再看青禾成功路徑，請按「重置 Demo」。",
        steps,
        showReset: true,
      };
    }
    return {
      lead: agentConfigured
        ? "按「AI 自動演三幕」可一次跑完索取 → 檢查 → 申請；或選一家供應商用下方輸入框下指令。"
        : "尚未設定 API Key：可切換詳細控制用手動 ①②③④，或設定 .env 後重啟。",
      steps,
    };
  }
  return {
    lead: `目前優先：${primary.text.replace(/^[^:]+:\s*/, "")}`,
    steps,
  };
}

function renderNextPanel(session, summary, pending, agentConfigured, $) {
  const body = $("dash-next-body");
  if (!body) return;

  const { lead, steps, showReset } = renderNextSteps(session, pending, summary, agentConfigured);
  const staging = summary.stagingCount ?? 0;
  const pendingN = summary.pendingCount ?? 0;

  let listHtml = "";
  if (steps.length) {
    listHtml = `<ul class="dash-next-list">${steps
      .map(
        (s) =>
          `<li class="${s.primary ? "is-primary" : ""}${s.muted ? " is-muted" : ""}${s.success ? " is-success" : ""}">${escapeHtml(s.text)}</li>`
      )
      .join("")}</ul>`;
  }

  const resetBtn = showReset
    ? ' <button type="button" class="link-btn" id="dash-btn-reset">重置 Demo</button>'
    : "";

  body.innerHTML = `
    <p class="dash-next-lead">${escapeHtml(lead)}${resetBtn}</p>
    ${listHtml}
    <p class="dash-inline-stats">${staging} 暫存合格 · ${pendingN} 待核准 · ${activeCount(session)} 進行中</p>
  `;
}

function activeCount(session) {
  return (session.supplierPipeline || []).filter((p) => !p.shareRevoked).length;
}

function mapTourAct(ev) {
  const pid = ev.policyId || "";
  const dec = ev.decision || "";
  const tool = ev.toolName || "";
  if (pid === "POL-CARB-001" && dec !== "ALLOW") return "act1";
  if (pid === "POL-HITL-010" || tool === "submit_cbam_draft" || tool === "approval_approve") {
    return "act2";
  }
  if (pid === "POL-REV-010" || tool === "revoke_data_share") return "act3";
  if (dec === "ALLOW" || pid === "POL-ALLOW-000") return "step";
  if (/DENY/i.test(dec)) return "deny";
  return "step";
}

function stepDot(numeral, label, cls) {
  const mark = cls === "done" ? icon("check", "micon-sm") : cls === "blocked" ? icon("x", "micon-sm") : "";
  return `<span class="step-dot ${cls}">${mark}${numeral} ${label}</span>`;
}

function pipelineStepClass(p, step) {
  const d = p.lastDecision;
  if (step === 2) {
    if (p.staged || p.pendingApproval) return "done";
    if (d?.toolName === "fetch_supplier_response" && d.decision === "ALLOW") return "done";
    if (d?.toolName === "ingest_pcf_payload" || d?.toolName === "submit_cbam_draft") return "done";
    return p.requested ? "done" : "";
  }
  if (step === 3) {
    if (p.staged) return "done";
    if (p.shareRevoked) return "blocked";
    if (d?.toolName === "ingest_pcf_payload" && d.decision !== "ALLOW") return "blocked";
    return "";
  }
  if (step === 4) {
    if (p.pendingApproval || p.committedDraft) return "done";
    return "";
  }
  return p.requested ? "done" : "";
}

export function renderDashboard(ctx) {
  const { session, audit, agentConfigured, $, decisionLabel } = ctx;
  if (!session) return;

  const summary = session.summary || {};
  const meta = $("dash-meta");
  const pending = (session.pendingApprovals || [])[0];

  if (meta) {
    const st = summary.mandateStatus || session.mandate?.status || "ACTIVE";
    const mandateOk = st === "ACTIVE";
    const aiLabel = agentConfigured ? "AI 已就緒" : "AI 未設定 Key";
    const pendingLabel = pending
      ? '<span class="warn">1 待核准</span>'
      : `${summary.pendingCount ?? 0} 待核准`;
    meta.innerHTML = `${mandateOk ? "授權有效" : escapeHtml(st)} · ${aiLabel} · ${pendingLabel}`;
  }

  const banner = $("dash-pending-banner");
  const pendingText = $("dash-pending-text");
  if (banner && pendingText) {
    if (pending) {
      const sid = pending.payload?.supplierId;
      const sup = (session.supplierPipeline || []).find((x) => x.supplierId === sid);
      const name = sup?.orgName || sid || "供應商";
      pendingText.innerHTML = `AI 申請將 <strong>${escapeHtml(name)}</strong> 的碳數據寫入申報草稿，需要你確認。`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  renderNextPanel(session, summary, pending, agentConfigured, $);

  const grid = $("pipeline-grid");
  if (grid) {
    const pipeline = session.supplierPipeline || [];
    if (!pipeline.length) {
      grid.innerHTML = '<p class="feed-empty">無供應商</p>';
    } else {
      grid.innerHTML = "";
      for (const p of sortPipelineForDisplay(pipeline)) {
        const card = document.createElement("article");
        card.className = `pipeline-card${p.shareRevoked ? " revoked" : ""}`;
        card.innerHTML = `
          <h3 class="pipeline-name">${escapeHtml(p.orgName || p.supplierId)}</h3>
          <div class="pipeline-steps">
            ${stepDot("①", "索取", p.requested ? "done" : "")}
            ${stepDot("②", "取回", pipelineStepClass(p, 2))}
            ${stepDot("③", "檢查", pipelineStepClass(p, 3))}
            ${stepDot("④", "申請", pipelineStepClass(p, 4))}
          </div>
          <p class="pipeline-status">${escapeHtml(pipelineStatusText(p))}</p>
          <p class="recent-meta">${escapeHtml(lastDecisionText(p))}</p>
        `;
        grid.appendChild(card);
      }
    }
  }

  const feed = $("recent-feed");
  if (feed) {
    const items = (audit || []).slice(-3).reverse();
    if (!items.length) {
      feed.innerHTML = '<p class="feed-empty">尚無紀錄 — 按「AI 自動演三幕」開始</p>';
    } else {
      feed.innerHTML = "";
      for (const ev of items) {
        const div = document.createElement("div");
        div.className = "recent-item";
        div.dataset.decision = ev.decision || "";
        div.dataset.policyId = ev.policyId || "";
        div.dataset.toolName = ev.toolName || "";
        div.dataset.tourAct = mapTourAct(ev);
        div.innerHTML = `
          <p class="recent-plain">${escapeHtml(ev.plainReason || ev.reason || ev.decision || "—")}</p>
          <details class="recent-detail">
            <summary class="recent-meta">${escapeHtml(formatTs(ev.ts))} · ${escapeHtml(decisionLabel(ev.decision))}</summary>
            <p class="recent-meta"><code>${escapeHtml(ev.policyId || "—")}</code></p>
          </details>
        `;
        feed.appendChild(div);
      }
    }
  }
}
