'use strict';

const { evaluate } = require('./policy');
const store = require('./store');
const { plainReason } = require('./plainReason');
const { enrichPayloadWithQualityTier } = require('./pcfCheck');
const vleiCheck = require('./vleiCheck');

function runEvaluate(toolName, input, actor, approval) {
  const state = store.getState();
  return evaluate({
    mandate: state.mandate,
    actor,
    principal: state.principal,
    agent: state.agent,
    toolName,
    input: input || {},
    now: new Date().toISOString(),
    getSupplier: store.getSupplier,
    getPcfPayload: store.getPcfPayload,
    revokedShares: state.revokedShares,
    staging: state.staging,
    emissionsRequests: state.emissionsRequests,
    approval: approval || null,
  });
}

function attachPlain(decision, input) {
  return {
    ...decision,
    plainReason: plainReason(decision.decision, decision.policyId, decision.reason, input),
  };
}

function executeTool(toolName, input) {
  if (toolName === 'request_emissions') {
    store.recordEmissionsRequest(input.supplierId);
    return {
      ok: true,
      requestId: `emis_req_${Date.now()}`,
      supplierId: input.supplierId || null,
      message: '已向供應商發出碳數據請求；可接著取回對方回覆。',
    };
  }
  if (toolName === 'fetch_supplier_response') {
    const payload = store.getPcfPayload(input.supplierId);
    if (!payload) {
      return {
        ok: false,
        supplierId: input.supplierId,
        message: '供應商尚未提供可讀取的碳數據回覆。',
      };
    }
    return {
      ok: true,
      supplierId: input.supplierId,
      payload,
      message: '已取得供應商回覆的碳數據，可進行品質檢查。',
    };
  }
  if (toolName === 'ingest_pcf_payload') {
    const enriched = enrichPayloadWithQualityTier(input);
    const staged = store.stagePayload(enriched);
    return {
      ok: true,
      supplierId: input.supplierId,
      staged: true,
      qualityTier: staged && staged.qualityTier,
      warnings: staged && staged.warnings,
      stagedAt: staged && staged.stagedAt,
      message: 'PCF 已通過品質閘並寫入暫存區。',
    };
  }
  if (toolName === 'commit_cbam_draft') {
    const draft = store.recordCbamDraft({
      supplierId: input.supplierId,
      status: 'COMMITTED',
      source: 'system_after_approve',
    });
    return {
      ok: true,
      draftId: draft.draftId,
      supplierId: input.supplierId,
      message: 'CBAM 申報草稿已寫入（內部草稿庫）。',
    };
  }
  if (toolName === 'revoke_data_share') {
    const result = store.revokeShare(input.supplierId, input.reason);
    return {
      ok: true,
      ...result,
      message: '已撤銷這家供應商的數據使用權。',
    };
  }
  if (toolName === 'revoke_supplier_credential') {
    const supplier = store.getSupplier(input.supplierId);
    const result = vleiCheck.revokeLegalEntityCredential(supplier);
    return {
      ok: true,
      supplierId: input.supplierId,
      ...result,
      message: result.revoked
        ? `已撤銷法人憑證，${result.cascadedRoles} 張角色憑證同步失效。`
        : '此供應商沒有 vLEI 法人憑證可撤銷。',
    };
  }
  if (toolName === 'export_client_draft') {
    const staged = store.listStaging().find((s) => s.supplierId === input.supplierId);
    const supplier = store.getSupplier(input.supplierId);
    const text = buildClientDraftText(staged, supplier);
    return { ok: true, format: 'text', content: text, supplierId: input.supplierId };
  }
  if (toolName === 'export_audit') {
    const events = store.getAudit();
    const text = buildAuditText(events);
    return { ok: true, format: input.format || 'text', content: text, events };
  }
  return { ok: true, toolName, message: 'Execution complete.' };
}

function buildClientDraftText(staged, supplier) {
  if (!staged) return '（無可匯出的暫存數據）';
  const name = (supplier && supplier.orgName) || staged.supplierId;
  const lines = [
    '【給客戶的碳數據回覆草稿】',
    `供應商：${name}`,
    `嵌入排放：${staged.tCO2e} ${staged.unit || ''}`,
    `計算方法：${staged.method || '—'}`,
    `系統邊界：${staged.boundary || '—'}`,
    `報告期間：${staged.period || '—'}`,
    `CN 碼：${staged.cnCode || '（未提供）'}`,
    `單位產品排放：${staged.emissionPerUnit != null ? staged.emissionPerUnit : '（未提供）'}`,
    `查驗狀態：${staged.verificationStatus || '（未提供）'}`,
  ];
  if (staged.verificationStatus === 'verified' && staged.verificationReportId) {
    lines.push(`查驗報告：${staged.verificationReportId}`);
  }
  lines.push('');
  lines.push('免責：通過本系統品質閘 ≠ 通過官方 CBAM 查驗 ≠ 免預設值。');
  if (staged.warnings && staged.warnings.length) {
    lines.push('');
    lines.push('注意事項：');
    for (const w of staged.warnings) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}

function buildAuditText(events) {
  const lines = ['【Mandate 稽核時間軸】', ''];
  for (const ev of events) {
    const pr = plainReason(ev.decision, ev.policyId, ev.reason, null);
    lines.push(`${ev.ts || ''} | ${ev.toolName || '—'} | ${ev.decision} | ${pr}`);
  }
  return lines.join('\n');
}

function invokeTool(toolId, cleanInput, actor, approval) {
  const decisionRaw = runEvaluate(toolId, cleanInput, actor, approval);
  const decision = attachPlain(decisionRaw, cleanInput);
  const digest = store.argsDigest(cleanInput);

  let approvalObj = null;
  let execResult = null;
  let httpStatus = 200;

  if (decision.decision === 'PENDING_HUMAN') {
    httpStatus = 202;
    approvalObj = store.createApproval({
      type: toolId === 'export_sensitive' ? 'EXPORT' : 'CBAM',
      requestedBy: actor.actorId,
      policyId: decision.policyId,
      payload: {
        toolName: toolId,
        supplierId: cleanInput.supplierId,
        tCO2e: cleanInput.tCO2e,
        unit: cleanInput.unit,
        method: cleanInput.method,
        boundary: cleanInput.boundary,
        period: cleanInput.period,
      },
    });
  } else if (decision.decision === 'ALLOW') {
    execResult = executeTool(toolId, cleanInput);
    if (toolId === 'commit_cbam_draft' && approval) {
      store.consumeApproval(approval.approvalId);
    }
  } else if (decision.decision === 'DENY_CONSTRAINT') {
    httpStatus = 422;
  } else {
    httpStatus = 403;
  }

  const audit = store.appendAudit({
    principalId: store.getState().principal.principalId,
    actorId: actor.actorId,
    actorType: actor.actorType,
    toolName: toolId,
    decision: decision.decision,
    policyId: decision.policyId,
    reason: decision.reason,
    reasoningSummary: decision.plainReason,
    approvalId: approvalObj ? approvalObj.approvalId : null,
    argsDigest: digest,
    inputRedacted: {
      supplierId: cleanInput.supplierId,
      tCO2e: cleanInput.tCO2e,
      unit: cleanInput.unit,
      method: cleanInput.method,
    },
  });

  return {
    httpStatus,
    body: {
      ...decision,
      toolId,
      argsDigest: digest,
      approval: approvalObj,
      result: execResult,
      auditEventId: audit.auditEventId,
    },
  };
}

module.exports = {
  runEvaluate,
  executeTool,
  invokeTool,
  attachPlain,
  buildClientDraftText,
  buildAuditText,
};
