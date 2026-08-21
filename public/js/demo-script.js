/**
 * Demo：AI Agent 三幕（無 Key 時降級按鈕三幕）
 */

import { icon } from "./icons.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「跳過此步」（第 20 節）：Demo 卡在某個 sleep 節奏時，評審／合規人員可以
 * 手動推進，不用整個劇本重置重來。只讓「純節奏用」的等待可被跳過——
 * 輪詢等待人審 approval 出現的迴圈維持原樣，跳過那個沒有意義。
 */
let skipCurrent = null;

function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      skipCurrent = null;
      resolve();
    }, ms);
    skipCurrent = () => {
      clearTimeout(timer);
      skipCurrent = null;
      resolve();
    };
  });
}

function skipCurrentStep() {
  skipCurrent?.();
}

async function runButtonFallback(ctx) {
  const {
    resetDemo,
    callTool,
    revokeShare,
    decideApproval,
    softRefresh,
    selectSupplier,
    getState,
    showError,
  } = ctx;

  await resetDemo();
  await interruptibleSleep(400);

  selectSupplier((o) => o.dataset.verified === "0");
  await interruptibleSleep(300);
  await callTool("request_emissions");
  await interruptibleSleep(300);
  await callTool("fetch_supplier_response");
  await interruptibleSleep(300);
  await callTool("ingest_pcf_payload");
  await interruptibleSleep(900);

  selectSupplier((o) => o.dataset.verified === "1");
  await interruptibleSleep(300);
  await callTool("request_emissions");
  await interruptibleSleep(300);
  await callTool("fetch_supplier_response");
  await interruptibleSleep(300);
  await callTool("ingest_pcf_payload");
  await interruptibleSleep(600);
  await callTool("submit_cbam_draft");
  await interruptibleSleep(700);

  let tries = 0;
  while (!getState().pendingId && tries < 10) {
    await softRefresh();
    await sleep(250);
    tries++;
  }
  if (getState().pendingId) {
    await decideApproval("approve");
    await interruptibleSleep(800);
  } else {
    showError("自動演示：請手動按「確認寫入草稿」");
  }

  await interruptibleSleep(1500);

  await revokeShare();
  await interruptibleSleep(700);
  await callTool("submit_cbam_draft");
  await softRefresh();
}

async function runAgentActs(ctx) {
  const {
    api,
    appendChat,
    recordAgentSteps,
    resetDemo,
    decideApproval,
    revokeShare,
    softRefresh,
    selectSupplier,
    getState,
    showError,
  } = ctx;

  await resetDemo();
  await interruptibleSleep(400);

  const act1 = await api("/agent/chat", {
    method: "POST",
    body: JSON.stringify({
      message:
        "請向無證零件行（supplier_unverified_01）索取碳數據，取回回覆後做品質檢查入庫。",
      maxSteps: 8,
      sessionId: "demo",
    }),
    timeoutMs: 45000,
  });
  appendChat("user", "【幕一】向無證零件行索取並品質檢查");
  appendChat("assistant", act1.reply || "（無回覆）");
  recordAgentSteps?.(act1);
  await softRefresh();
  await interruptibleSleep(1200);

  const act2 = await api("/agent/chat", {
    method: "POST",
    body: JSON.stringify({
      message:
        "請向青禾精密（supplier_green_01）索取碳數據，取回回覆、通過品質檢查後，申請寫入 CBAM 申報草稿。",
      maxSteps: 8,
      sessionId: "demo",
    }),
    timeoutMs: 45000,
  });
  appendChat("user", "【幕二】青禾完整數據 → 申請寫入草稿");
  appendChat("assistant", act2.reply || "（無回覆）");
  recordAgentSteps?.(act2);
  await softRefresh();

  let tries = 0;
  while (!getState().pendingId && tries < 15) {
    await softRefresh();
    await sleep(300);
    tries++;
  }
  if (getState().pendingId) {
    await decideApproval("approve");
    await interruptibleSleep(800);
  } else if (act2.pendingApproval?.approvalId) {
    await api(`/approvals/${act2.pendingApproval.approvalId}/approve`, {
      method: "POST",
      body: "{}",
    });
    await softRefresh();
  } else {
    showError("幕二：請手動按「確認寫入草稿」");
  }

  await interruptibleSleep(1500);

  selectSupplier((o) => o.dataset.verified === "1");
  await revokeShare();
  await interruptibleSleep(600);

  const act3 = await api("/agent/chat", {
    method: "POST",
    body: JSON.stringify({
      message:
        "青禾精密（supplier_green_01）的數據分享已撤銷，請再試一次申請寫入申報草稿。",
      maxSteps: 3,
      sessionId: "demo",
    }),
    timeoutMs: 45000,
  });
  appendChat("user", "【幕三】撤銷後再申請寫入");
  appendChat("assistant", act3.reply || "（無回覆）");
  recordAgentSteps?.(act3);
  await softRefresh();
}

export async function runDemoScript(ctx) {
  const { api, refreshAgentStatus, showError } = ctx;
  const btn = document.getElementById("btn-demo");
  const skipBtn = document.getElementById("btn-demo-skip");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon("hourglass", "micon-sm micon-spin")}AI 演示執行中…`;
  }
  if (skipBtn) {
    skipBtn.hidden = false;
    skipBtn.onclick = skipCurrentStep;
  }

  try {
    showError("");
    let st = { configured: false };
    try {
      st = await api("/agent/status");
    } catch {
      /* fallback */
    }

    if (st.configured) {
      await runAgentActs(ctx);
    } else {
      showError("未設定 API Key，改用按鈕備援三幕。");
      await runButtonFallback(ctx);
    }
    await refreshAgentStatus?.();
  } catch (e) {
    showError(`演示中斷：${e.message || e}（可改用手動備援按鈕）`);
    try {
      await runButtonFallback(ctx);
    } catch (e2) {
      showError(`備援演示也失敗：${e2.message || e2}`);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "AI 自動演三幕";
    }
    if (skipBtn) {
      skipBtn.hidden = true;
      skipBtn.onclick = null;
    }
    skipCurrent = null;
  }
}
