'use strict';

/**
 * Shared API router — Node server + Cloudflare Worker.
 * Returns { status, body } (body will be JSON-serialized by caller).
 */

const store = require('./store');
const llm = require('./llm');
const agent = require('./agent');
const agentSession = require('./agentSession');
const { invokeTool, runEvaluate, executeTool, attachPlain } = require('./toolRuntime');
const { evaluateWithTrace, STEP_META } = require('./policy');
const { POLICIES } = require('./policyCatalog');
const { checkPcfPayload, buildSupplementLetter } = require('./pcfCheck');
const { plainReason } = require('./plainReason');
const supabaseSync = require('./supabaseSync');
const pactMapping = require('./pactMapping');
const { handleWorkflowApi, handleDppApi } = require('./workflowApi');

function buildActor(body) {
  const st = store.getState();
  const actorType = (body && body.actorType) || 'AGENT';
  if (actorType === 'HUMAN') {
    const isApprover = body && body.asApprover;
    const p = isApprover ? st.approver : st.principal;
    return {
      actorId: p.principalId,
      actorType: 'HUMAN',
      onBehalfOf: st.principal.principalId,
    };
  }
  if (actorType === 'SYSTEM') {
    return {
      actorId: 'system',
      actorType: 'SYSTEM',
      onBehalfOf: st.principal.principalId,
    };
  }
  return {
    actorId: st.agent.agentId,
    actorType: 'AGENT',
    onBehalfOf: st.principal.principalId,
  };
}

function enrichDecisionBody(body, input) {
  if (!body || !body.policyId) return body;
  return {
    ...body,
    plainReason: body.plainReason || plainReason(body.decision, body.policyId, body.reason, input),
  };
}

function buildContextSnapshot(st, toolName, actorType, input) {
  const supplierId = (input && input.supplierId) || null;
  const { emissionsRequests, revokedShares, staging } = st;

  let hasRequest = false;
  if (supplierId && emissionsRequests) {
    if (emissionsRequests instanceof Set) hasRequest = emissionsRequests.has(supplierId);
    else if (Array.isArray(emissionsRequests)) hasRequest = emissionsRequests.includes(supplierId);
  }

  let shareRevoked = false;
  if (supplierId && revokedShares) {
    if (revokedShares instanceof Set) shareRevoked = revokedShares.has(supplierId);
    else if (Array.isArray(revokedShares)) shareRevoked = revokedShares.includes(supplierId);
  }

  let hasStaging = false;
  if (supplierId && staging) {
    if (staging instanceof Map) {
      const entry = staging.get(supplierId);
      hasStaging = Boolean(entry && !entry.revoked);
    }
  }

  const emissionsRequestList =
    emissionsRequests instanceof Set
      ? [...emissionsRequests]
      : Array.isArray(emissionsRequests)
        ? emissionsRequests
        : [];

  const revokedShareList =
    revokedShares instanceof Set
      ? [...revokedShares]
      : Array.isArray(revokedShares)
        ? revokedShares
        : [];

  return {
    mandateStatus: st.mandate && st.mandate.status,
    mandateExpiresAt: st.mandate && st.mandate.expiresAt,
    actorType,
    toolName,
    supplierId,
    shareRevoked,
    hasEmissionsRequest: hasRequest,
    hasStaging,
    emissionsRequests: emissionsRequestList,
    revokedShares: revokedShareList,
    stagingSuppliers: store.listStaging().map((s) => s.supplierId),
  };
}

function runPolicySimulate(body) {
  const toolName = body.toolName;
  if (!toolName || typeof toolName !== 'string') {
    return { error: 'toolName required', status: 400 };
  }

  const st = store.getState();
  const actorType = (body.actorType || 'AGENT').toUpperCase();
  const input = body.input || {};
  const actor = buildActor({ actorType, asApprover: actorType === 'HUMAN' && body.asApprover });
  const approval = body.approvalId ? store.getApproval(body.approvalId) : body.approval || null;

  const raw = evaluateWithTrace({
    mandate: st.mandate,
    actor,
    principal: st.principal,
    agent: st.agent,
    toolName,
    input,
    now: new Date().toISOString(),
    getSupplier: store.getSupplier,
    getPcfPayload: store.getPcfPayload,
    revokedShares: st.revokedShares,
    staging: st.staging,
    emissionsRequests: st.emissionsRequests,
    approval,
  });

  const decisionBody = enrichDecisionBody(
    {
      decision: raw.decision,
      policyId: raw.policyId,
      reason: raw.reason,
    },
    input
  );

  return {
    status: 200,
    body: {
      ...decisionBody,
      trace: raw.trace,
      contextSnapshot: buildContextSnapshot(st, toolName, actorType, input),
      simulate: true,
    },
  };
}

async function handleApiPath(method, pathname, body, requestContext) {
  const reqBody = body || {};
  // GS1/DPP 分層揭露示意刻意不經過 handleWorkflowApi() 的 x-demo-role 認證閘門（見
  // server/workflowApi.js handleDppApi() 開頭註解），所以要在它之前檢查。
  const dppResult = handleDppApi(method, pathname, requestContext || {});
  if (dppResult) return dppResult;
  const workflowResult = await handleWorkflowApi(
    method,
    pathname,
    reqBody,
    requestContext || {}
  );
  if (workflowResult) return workflowResult;

  if (method === 'GET' && pathname === '/api/session') {
    return { status: 200, body: store.getSession() };
  }

  if (method === 'GET' && pathname === '/api/audit') {
    const events = store.getAudit().map((ev) => ({
      ...ev,
      plainReason: plainReason(ev.decision, ev.policyId, ev.reason, ev.inputRedacted),
    }));
    return { status: 200, body: { events } };
  }

  if (method === 'GET' && pathname === '/api/policies') {
    return { status: 200, body: { policies: POLICIES, evalSteps: STEP_META } };
  }

  if (method === 'POST' && pathname === '/api/policy/simulate') {
    const sim = runPolicySimulate(reqBody);
    if (sim.error) {
      return { status: sim.status, body: { error: sim.error } };
    }
    return { status: sim.status, body: sim.body };
  }

  if (method === 'GET' && pathname === '/api/suppliers') {
    return { status: 200, body: { suppliers: store.listSuppliers() } };
  }

  if (method === 'GET' && pathname === '/api/staging') {
    return { status: 200, body: { staging: store.listStaging() } };
  }

  const pcfMatch = pathname.match(/^\/api\/pcf\/([^/]+)$/);
  if (method === 'GET' && pcfMatch) {
    const supplierId = decodeURIComponent(pcfMatch[1]);
    const payload = store.getPcfPayload(supplierId);
    if (!payload) {
      return { status: 404, body: { error: 'PCF payload not found', supplierId } };
    }
    return { status: 200, body: { payload } };
  }

  const pcfPactMatch = pathname.match(/^\/api\/pcf\/([^/]+)\/pact$/);
  if (method === 'GET' && pcfPactMatch) {
    const supplierId = decodeURIComponent(pcfPactMatch[1]);
    const payload = store.getPcfPayload(supplierId);
    if (!payload) {
      return { status: 404, body: { error: 'PCF payload not found', supplierId } };
    }
    const supplier = store.getSupplier(supplierId);
    const mapped = pactMapping.toProductFootprint(payload, supplier);
    return {
      status: 200,
      body: {
        spec: 'PACT Technical Specifications V3 (github.com/wbcsd/data-exchange-protocol)',
        note: '此為展示用格式對齊，非官方 PACT Conformance 驗證結果；未涵蓋欄位見 pactGaps。',
        ...mapped,
      },
    };
  }

  if (method === 'GET' && pathname === '/api/agent/status') {
    return { status: 200, body: llm.status() };
  }

  if (method === 'GET' && pathname === '/api/audit/cloud') {
    if (!supabaseSync.isConfigured()) {
      return { status: 200, body: { configured: false } };
    }
    try {
      const events = await supabaseSync.fetchAuditLog({ limit: 50 });
      // Verify the chain for whichever boot_id the most recent row belongs to (the
      // chain is scoped per boot_id; older rows in the list may be from earlier runs).
      const latestBootId = events[0]?.boot_id || null;
      const brokenEntries = latestBootId ? await supabaseSync.verifyAuditChain(latestBootId) : [];
      return {
        status: 200,
        body: {
          configured: true,
          bootId: latestBootId,
          count: events.length,
          chainIntact: brokenEntries.length === 0,
          brokenCount: brokenEntries.length,
          events,
        },
      };
    } catch (e) {
      return {
        status: 200,
        body: { configured: true, error: e.message || String(e) },
      };
    }
  }

  const exportDraftMatch = pathname.match(/^\/api\/export\/client-draft\/([^/]+)$/);
  if (method === 'GET' && exportDraftMatch) {
    const supplierId = decodeURIComponent(exportDraftMatch[1]);
    const actor = {
      actorId: store.getState().approver.principalId,
      actorType: 'HUMAN',
      onBehalfOf: store.getState().principal.principalId,
    };
    const invoked = invokeTool('export_client_draft', { supplierId }, actor, null);
    return { status: invoked.httpStatus, body: enrichDecisionBody(invoked.body, { supplierId }) };
  }

  if (method === 'GET' && pathname === '/api/export/audit') {
    const actor = {
      actorId: store.getState().approver.principalId,
      actorType: 'HUMAN',
      onBehalfOf: store.getState().principal.principalId,
    };
    const invoked = invokeTool('export_audit', { format: 'text' }, actor, null);
    return { status: invoked.httpStatus, body: enrichDecisionBody(invoked.body, {}) };
  }

  if (method === 'POST' && pathname === '/api/check/pcf') {
    const payload = reqBody.payload || reqBody;
    const check = checkPcfPayload(payload);
    const supplementLetter = check.pass
      ? null
      : buildSupplementLetter(payload, check.missingFields);
    return {
      status: 200,
      body: {
        ...check,
        plainReason: plainReason(check.decision, check.policyId, null, payload),
        supplementLetter,
        disclaimer:
          '通過本檢查 ≠ 通過官方 CBAM 查驗 ≠ 免預設值。台灣碳費／試申報欄位 V1 未完整對接。',
      },
    };
  }

  if (method === 'POST' && pathname === '/api/agent/chat') {
    const message = reqBody.message || reqBody.text || '';
    if (!String(message).trim()) {
      return { status: 400, body: { error: 'message required' } };
    }
    try {
      const result = await agent.runAgentTurn({
        message,
        sessionId: reqBody.sessionId || 'default',
        maxSteps: reqBody.maxSteps || 5,
      });
      return { status: 200, body: result };
    } catch (e) {
      return {
        status: 502,
        body: {
          error: 'Agent 執行失敗',
          detail: e.message || String(e),
          configured: llm.isConfigured(),
        },
      };
    }
  }

  if (method === 'POST' && pathname === '/api/agent/demo') {
    try {
      const result = await agent.runAgentDemo({ sessionId: reqBody.sessionId || 'demo' });
      return { status: 200, body: result };
    } catch (e) {
      return {
        status: 502,
        body: {
          error: 'Agent Demo 失敗',
          detail: e.message || String(e),
          configured: llm.isConfigured(),
        },
      };
    }
  }

  const toolMatch = pathname.match(/^\/api\/tools\/([a-z_]+)$/);
  if (method === 'POST' && toolMatch) {
    const toolId = toolMatch[1];
    const input = reqBody.input || reqBody.args || reqBody;
    const cleanInput = { ...input };
    delete cleanInput.actorType;
    delete cleanInput.asApprover;
    delete cleanInput.input;
    delete cleanInput.args;
    delete cleanInput.approvalId;

    const actor = buildActor(reqBody);
    const approval = reqBody.approvalId ? store.getApproval(reqBody.approvalId) : null;
    const invoked = invokeTool(toolId, cleanInput, actor, approval);
    return { status: invoked.httpStatus, body: enrichDecisionBody(invoked.body, cleanInput) };
  }

  if (method === 'POST' && pathname === '/api/share/revoke') {
    const supplierId = reqBody.supplierId;
    if (!supplierId) {
      return { status: 400, body: { error: 'supplierId required' } };
    }
    const st = store.getState();
    const actor = {
      actorId: st.approver.principalId,
      actorType: 'HUMAN',
      onBehalfOf: st.principal.principalId,
    };
    const input = {
      supplierId,
      reason: reqBody.reason || 'Demo data share revoke',
    };
    const decisionRaw = runEvaluate('revoke_data_share', input, actor, null);
    const decision = attachPlain(decisionRaw, input);
    const digest = store.argsDigest(input);
    if (decision.decision !== 'ALLOW') {
      const audit = store.appendAudit({
        principalId: st.principal.principalId,
        actorId: actor.actorId,
        actorType: 'HUMAN',
        toolName: 'revoke_data_share',
        decision: decision.decision,
        policyId: decision.policyId,
        reason: decision.reason,
        reasoningSummary: decision.plainReason,
        argsDigest: digest,
        inputRedacted: { supplierId },
      });
      return {
        status: decision.decision === 'DENY_CONSTRAINT' ? 422 : 403,
        body: {
          ...decision,
          toolId: 'revoke_data_share',
          argsDigest: digest,
          auditEventId: audit.auditEventId,
        },
      };
    }
    const result = store.revokeShare(supplierId, input.reason);
    const audit = store.appendAudit({
      principalId: st.principal.principalId,
      actorId: actor.actorId,
      actorType: 'HUMAN',
      toolName: 'revoke_data_share',
      decision: 'ALLOW',
      policyId: 'POL-REV-010',
      reason: 'Data share revoked; pending approvals cancelled.',
      reasoningSummary:
        '供應商資料分享已撤銷；該供應商所有待核准的申請已同步作廢，且撤銷後不得再用這批數據申報，需重新索取並取得同意。',
      argsDigest: digest,
      inputRedacted: { supplierId },
    });
    return {
      status: 200,
      body: {
        decision: 'ALLOW',
        policyId: 'POL-REV-010',
        plainReason: plainReason('ALLOW', 'POL-REV-010', null, input),
        reason: 'Data share revoked.',
        toolId: 'revoke_data_share',
        result,
        auditEventId: audit.auditEventId,
      },
    };
  }

  const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
  if (method === 'POST' && approveMatch) {
    const approvalId = approveMatch[1];
    const action = approveMatch[2];
    const approval = store.getApproval(approvalId);
    if (!approval) {
      return { status: 404, body: { error: 'Approval not found' } };
    }
    if (approval.status !== 'PENDING') {
      return { status: 409, body: { error: 'Approval not PENDING', status: approval.status } };
    }

    const st = store.getState();
    const now = store.nowIso();
    const mandateOk =
      st.mandate.status === 'ACTIVE' &&
      new Date(now).getTime() < new Date(st.mandate.expiresAt).getTime();

    if (action === 'approve') {
      if (!mandateOk) {
        return {
          status: 403,
          body: {
            decision: st.mandate.status === 'REVOKED' ? 'DENY_REVOKED' : 'DENY_EXPIRED',
            policyId: st.mandate.status === 'REVOKED' ? 'POL-AUTH-001' : 'POL-AUTH-002',
            reason: 'Cannot approve under inactive mandate.',
          },
        };
      }
      approval.status = 'APPROVED';
      approval.approverId = st.approver.principalId;
      approval.decidedAt = now;

      store.appendAudit({
        principalId: st.principal.principalId,
        actorId: st.approver.principalId,
        actorType: 'HUMAN',
        toolName: 'approve_approval',
        decision: 'ALLOW',
        policyId: 'POL-HITL-010',
        reason: 'Approval granted; CBAM commit may proceed.',
        reasoningSummary: '合規主管已核准這筆待審申請，系統將接著嘗試把碳數據正式寫入 CBAM 申報草稿。',
        approvalId: approval.approvalId,
        argsDigest: store.argsDigest(approval.payload),
      });

      let commitResult = null;
      if (approval.type === 'CBAM' || approval.payload?.toolName === 'submit_cbam_draft') {
        const sysActor = {
          actorId: 'system',
          actorType: 'SYSTEM',
          onBehalfOf: st.principal.principalId,
        };
        const execInput = { supplierId: approval.payload.supplierId };
        const execDecision = runEvaluate('commit_cbam_draft', execInput, sysActor, approval);
        if (execDecision.decision === 'ALLOW') {
          commitResult = executeTool('commit_cbam_draft', execInput);
          store.consumeApproval(approval.approvalId);
          store.appendAudit({
            principalId: st.principal.principalId,
            actorId: 'system',
            actorType: 'SYSTEM',
            toolName: 'commit_cbam_draft',
            decision: 'ALLOW',
            policyId: 'POL-HITL-010',
            reason: 'System committed CBAM draft after human approval.',
            reasoningSummary:
              '已依人類核准結果，由系統（非 Agent）將草稿正式寫入內部 CBAM 草稿庫；commit_cbam_draft 這個動作永遠不對 Agent 開放。',
            approvalId: approval.approvalId,
            argsDigest: store.argsDigest(execInput),
          });
        }
      }

      return {
        status: 200,
        body: {
          decision: 'ALLOW',
          policyId: 'POL-HITL-010',
          plainReason: plainReason('ALLOW', 'POL-HITL-010', 'Approval granted', null),
          approval,
          commitResult,
        },
      };
    }

    approval.status = 'REJECTED';
    approval.approverId = st.approver.principalId;
    approval.decidedAt = now;
    store.appendAudit({
      principalId: st.principal.principalId,
      actorId: st.approver.principalId,
      actorType: 'HUMAN',
      toolName: 'deny_approval',
      decision: 'DENY_POLICY',
      policyId: 'POL-HITL-010',
      reason: 'Approval denied by human.',
      reasoningSummary: '合規主管否決了這筆待審申請；這批碳數據不會被寫入 CBAM 申報草稿。',
      approvalId: approval.approvalId,
    });
    return {
      status: 200,
      body: {
        decision: 'DENY_POLICY',
        policyId: 'POL-HITL-010',
        approval,
      },
    };
  }

  if (method === 'POST' && pathname === '/api/mandate/revoke') {
    const result = store.revokeMandate((reqBody && reqBody.reason) || 'Demo revoke');
    store.appendAudit({
      principalId: store.getState().principal.principalId,
      actorId: store.getState().approver.principalId,
      actorType: 'HUMAN',
      toolName: 'revoke_mandate',
      decision: 'ALLOW',
      policyId: 'POL-REV-001',
      reason: 'Mandate revoked; pending approvals cancelled.',
      reasoningSummary:
        '整個 Mandate 授權已被收回；所有待核准申請同步作廢，AI 之後將無法再代表本組織執行任何動作，須重新發授權才能恢復。',
    });
    return {
      status: 200,
      body: {
        decision: 'ALLOW',
        policyId: 'POL-REV-001',
        mandate: result.mandate,
        cancelledApprovals: result.cancelled,
      },
    };
  }

  if (method === 'POST' && pathname === '/api/mandate/simulate-expiry') {
    const mandate = store.simulateExpiry();
    store.appendAudit({
      principalId: store.getState().principal.principalId,
      actorId: 'system',
      actorType: 'SYSTEM',
      toolName: 'simulate_expiry',
      decision: 'ALLOW',
      policyId: 'POL-AUTH-002',
      reason: 'Simulated mandate expiry for demo.',
      reasoningSummary: 'Demo 用途：手動把 Mandate 授權模擬成已過期，用來展示授權過期後的閘門行為（非真實事件）。',
    });
    return { status: 200, body: { mandate } };
  }

  if (method === 'POST' && pathname === '/api/reset') {
    const session = store.reset();
    agentSession.clearAll();
    return { status: 200, body: { ok: true, session } };
  }

  return { status: 404, body: { error: 'API not found', path: pathname } };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function handleFetchRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method || 'GET';
  const requestContext = {
    // Explicit demo-only role switch mapped to a fixed server-side whitelist.
    demoRole: request.headers.get('x-demo-role') || url.searchParams.get('demoRole'),
    // Keep Vault credentials out of URLs and query logs.
    vaultToken: request.headers.get('x-vault-token'),
    // GS1/DPP 分層揭露示意（services/dpp）：public/customer/customs，跟上面的
    // demoRole（案件參與者角色）是不同軸線，故意分開一個查詢參數。
    dppRole: url.searchParams.get('role'),
  };

  if (!pathname.startsWith('/api/')) {
    return null;
  }

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonResponse(400, {
          code: 'INVALID_JSON',
          message: 'JSON request body 格式無效。',
          retryable: false,
          details: null,
        });
      }
    }
  }

  try {
    const result = await handleApiPath(method, pathname, body, requestContext);
    return jsonResponse(result.status, result.body);
  } catch (err) {
    return jsonResponse(500, {
      code: 'INTERNAL_ERROR',
      message: '伺服器暫時無法處理此請求。',
      retryable: false,
      details: null,
    });
  }
}

module.exports = {
  handleApiPath,
  handleFetchRequest,
  jsonResponse,
};
