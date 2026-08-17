'use strict';

const llm = require('./llm');
const store = require('./store');
const agentSession = require('./agentSession');
const { invokeTool } = require('./toolRuntime');

const DEFAULT_MAX_STEPS = 8;

/**
 * Fixed-role information split (CarbonDataAgent / AuthAgent) — see
 * mandate/CLAUDE.md's "本分支對 DECISIONS.md §7 的偏離" note. Each context
 * builder only exposes the data that agent's role needs; neither can see
 * the other's domain. This split is program logic, not an LLM decision.
 */
function buildCarbonContext() {
  const session = store.getSession();
  return {
    orgName: session.org?.displayName,
    suppliers: store.listSuppliers(),
    staging: session.staging,
    emissionsRequests: session.emissionsRequests || [],
  };
}

function buildAuthContext() {
  const session = store.getSession();
  const audit = store.getAudit();
  return {
    orgName: session.org?.displayName,
    mandate: session.mandate,
    allowedTools: session.mandate?.allowedTools || [],
    // Deliberately omit inputRedacted.supplierId — AuthAgent explains
    // authorization/audit outcomes, not which supplier they concerned.
    recentAudit: audit.slice(-8).map((e) => ({
      toolName: e.toolName,
      decision: e.decision,
      policyId: e.policyId,
    })),
  };
}

function buildAgentActor(session) {
  return {
    actorId: 'agent_mandate_carbon_v1',
    actorType: 'AGENT',
    onBehalfOf: session.principal?.principalId,
  };
}

async function runAgentTurn({ message, sessionId = 'default', maxSteps = DEFAULT_MAX_STEPS }) {
  if (!String(message || '').trim()) {
    return { configured: llm.isConfigured(), error: 'message required' };
  }

  agentSession.appendMessage(sessionId, 'user', String(message).trim());

  if (!llm.isConfigured()) {
    const reply =
      '尚未設定 OPENAI_API_KEY。本地用 .env；Cloudflare 用 wrangler secret put OPENAI_API_KEY。或先用左邊按鈕操作。';
    agentSession.appendMessage(sessionId, 'assistant', reply);
    return { configured: false, reply, tool: null, steps: [] };
  }

  const history = agentSession.getHistory(sessionId);

  // AuthAgent answers this turn once, in parallel with CarbonDataAgent's
  // (possibly multi-step) tool-proposal loop below — fixed division of
  // labor, not dynamic orchestration. It can never propose a tool
  // (llm.js's AUTH_ALLOWED_TOOLS is the empty set), so it never touches
  // invokeTool()/policy.js; its only output is supplementary reply text.
  const authAgentPromise = llm
    .proposeAuth({ message, history, context: buildAuthContext() })
    .catch((e) => ({ configured: true, reply: '', error: e.message || String(e) }));

  const steps = [];
  let lastReply = '';
  let pendingApproval = null;
  let stopReason = null;
  let corrections = 0;
  let overrideMessage = null;
  const MAX_CORRECTIONS = 2;

  function isSupplierStagedUsable(session, supplierId) {
    if (!supplierId || !Array.isArray(session.staging)) return false;
    const entry = session.staging.find((s) => s.supplierId === supplierId);
    return !!(entry && !entry.revoked);
  }

  function isSupplierShareRevoked(session, supplierId) {
    if (!supplierId || !Array.isArray(session.revokedShares)) return false;
    return session.revokedShares.includes(supplierId);
  }

  function buildNoToolNudge() {
    const done = new Set(
      steps.filter((s) => s.tool && s.toolResult?.decision === 'ALLOW').map((s) => s.tool)
    );
    const STANDARD_SEQUENCE = ['request_emissions', 'fetch_supplier_response', 'ingest_pcf_payload', 'submit_cbam_draft'];
    const nextInSequence = STANDARD_SEQUENCE.find((t) => !done.has(t));
    const sequenceHint =
      done.size > 0
        ? `目前已成功完成：${Array.from(done).join('、')}。標準流程順序固定是 ${STANDARD_SEQUENCE.join(' → ')}，請照順序呼叫下一個還沒做過的步驟${
            nextInSequence ? `（也就是 ${nextInSequence}）` : ''
          }。`
        : '';
    return `你上一步沒有呼叫任何工具就打算結束，但使用者要求的任務通常需要連續呼叫多個工具才算走到最終結果（ALLOW／PENDING_HUMAN／DENY 其中之一）。${sequenceHint}除非真的已經沒有下一步可做，否則請不要只回文字，直接呼叫下一個必要的工具繼續執行。`;
  }

  for (let i = 0; i < maxSteps; i += 1) {
    const context = buildCarbonContext();
    let proposal;
    try {
      proposal = await llm.proposeCarbon({
        message: i === 0 ? message : overrideMessage || '繼續完成上一個任務（若已完成請 tool=null 並總結）。',
        history: history.concat(
          steps.flatMap((s) => [
            { role: 'assistant', content: JSON.stringify({ reply: s.reply, tool: s.tool, args: s.args }) },
            { role: 'user', content: `工具結果：${JSON.stringify(s.toolResult || {})}` },
          ])
        ),
        context,
      });
    } catch (e) {
      const session = store.getSession();
      const actor = buildAgentActor(session);
      store.appendAudit({
        principalId: session.principal?.principalId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        toolName: 'llm_propose',
        decision: 'ERROR',
        policyId: null,
        reason: e.message || String(e),
        reasoningSummary: `AI 呼叫語言模型時發生錯誤（可能逾時、額度用盡或服務異常），本輪沒有提議任何工具動作，未影響任何已核准的資料或草稿：${e.message || String(e)}`,
        eventKind: 'LLM_ERROR',
      });
      return {
        configured: true,
        error: e.message || String(e),
        steps,
        reply: lastReply,
      };
    }

    overrideMessage = null;
    lastReply = proposal.reply || '';
    const step = {
      step: i + 1,
      reply: proposal.reply,
      tool: proposal.tool,
      args: proposal.args || {},
      toolResult: null,
    };

    if (!proposal.tool) {
      steps.push(step);
      if (corrections < MAX_CORRECTIONS && steps.length < maxSteps) {
        corrections += 1;
        overrideMessage = buildNoToolNudge();
        continue;
      }
      stopReason = 'no_tool';
      break;
    }

    const cleanInput = { ...(proposal.args || {}) };
    if (cleanInput.tCO2e != null) cleanInput.tCO2e = Number(cleanInput.tCO2e);
    if (cleanInput.emissionPerUnit != null) {
      cleanInput.emissionPerUnit = Number(cleanInput.emissionPerUnit);
    }

    if (proposal.tool === 'submit_cbam_draft') {
      const sid = cleanInput.supplierId;
      const alreadyIngestedThisTurn = steps.some(
        (s) => s.tool === 'ingest_pcf_payload' && s.toolResult?.decision === 'ALLOW'
      );
      const session0 = store.getSession();
      const stagedNow = isSupplierStagedUsable(session0, sid);
      const shareRevoked = isSupplierShareRevoked(session0, sid);
      if (
        sid &&
        !stagedNow &&
        !shareRevoked &&
        !alreadyIngestedThisTurn &&
        corrections < MAX_CORRECTIONS &&
        steps.length < maxSteps
      ) {
        corrections += 1;
        step.toolResult = { skipped: true, reason: 'redirected_to_ingest_first' };
        steps.push(step);
        overrideMessage = `供應商 ${sid} 尚未通過品質檢查入庫（還沒有可用的暫存 PCF），不能跳過步驟直接申請寫入 CBAM 草稿。請先呼叫 ingest_pcf_payload（supplierId="${sid}"）完成品質檢查，通過後才呼叫 submit_cbam_draft。`;
        continue;
      }
    }

    if (proposal.tool === 'ingest_pcf_payload') {
      const sid = cleanInput.supplierId;
      const needsPayload =
        sid &&
        (cleanInput.tCO2e == null ||
          !cleanInput.method ||
          !cleanInput.boundary ||
          !cleanInput.period ||
          !cleanInput.unit);
      if (needsPayload) {
        const fixture = store.getPcfPayload(sid);
        if (fixture) {
          Object.assign(cleanInput, fixture, { supplierId: sid });
        }
      }
    }

    const session = store.getSession();
    const actor = buildAgentActor(session);
    const invoked = invokeTool(proposal.tool, cleanInput, actor, null);
    step.toolResult = { httpStatus: invoked.httpStatus, ...invoked.body };
    steps.push(step);

    if (invoked.body.decision === 'PENDING_HUMAN') {
      pendingApproval = invoked.body.approval;
      stopReason = 'pending_human';
      break;
    }
    if (invoked.body.decision !== 'ALLOW') {
      stopReason = 'denied';
      break;
    }
  }

  if (!stopReason && steps.length >= maxSteps) {
    stopReason = 'max_steps';
  }

  const authProposal = await authAgentPromise;
  const authReply = String(authProposal.reply || '').trim();
  // Only append AuthAgent's aside when it actually said something — most
  // turns are carbon-flow requests it has nothing to add to.
  const authAside = authReply ? `\n\n〔授權與稽核助理〕${authReply}` : '';

  const finalReply =
    lastReply +
    (stopReason === 'denied' && steps.length
      ? `\n\n（政策引擎已擋下：${steps[steps.length - 1].toolResult?.plainReason || ''}）`
      : '') +
    (stopReason === 'pending_human'
      ? '\n\n（已暫停：等待合規主管確認才能寫入申報草稿。）'
      : '') +
    authAside;

  agentSession.appendMessage(sessionId, 'assistant', finalReply);

  return {
    configured: true,
    reply: finalReply,
    steps,
    pendingApproval,
    stopReason,
    executed: steps.some((s) => s.tool),
    note: '模型只能提議；是否放行由 PolicyEngine 決定。CarbonDataAgent／AuthAgent 固定分工，皆不能自行放行。',
  };
}

const DEMO_MESSAGES = [
  '請向「無證零件行」（supplier_unverified_01）索取碳數據，取回回覆後做品質檢查並入庫。',
  '請向「青禾精密」（supplier_green_01）索取碳數據，取回回覆、通過品質檢查後，申請寫入 CBAM 申報草稿。',
  '青禾精密（supplier_green_01）的數據分享已撤銷，請再試一次申請寫入申報草稿。',
];

async function runAgentDemo({ sessionId = 'demo' } = {}) {
  agentSession.clearSession(sessionId);
  const acts = [];

  for (let i = 0; i < DEMO_MESSAGES.length; i += 1) {
    if (i === 2) {
      acts.push({
        act: i + 1,
        note: '幕三需先由人類撤銷分享，再由 Agent 重試 submit',
        skipped: true,
      });
      break;
    }
    const turn = await runAgentTurn({
      message: DEMO_MESSAGES[i],
      sessionId,
      maxSteps: 6,
    });
    acts.push({ act: i + 1, message: DEMO_MESSAGES[i], ...turn });
    if (turn.pendingApproval) {
      acts[acts.length - 1].needsApproval = true;
      acts[acts.length - 1].approvalId = turn.pendingApproval.approvalId;
    }
    if (turn.error) break;
  }

  return {
    configured: llm.isConfigured(),
    demoReady: llm.isConfigured(),
    acts,
    act3Message: DEMO_MESSAGES[2],
  };
}

module.exports = {
  runAgentTurn,
  runAgentDemo,
  DEMO_MESSAGES,
};
