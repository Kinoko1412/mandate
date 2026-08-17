'use strict';

/**
 * PolicyEngine.evaluate — sole allow/deny gate.
 * Order: 1 status → 2 deny list → 3 allow → 4 constraints → 5 HITL → 6 ALLOW
 */

const {
  hasPcfQualityFields,
  checkVerificationConsistency,
} = require('./pcfCheck');
const { verifySupplierCredentialChain } = require('./vleiCheck');

const TOOL_REGISTRY = new Set([
  'request_emissions',
  'fetch_supplier_response',
  'ingest_pcf_payload',
  'submit_cbam_draft',
  'commit_cbam_draft',
  'revoke_data_share',
  'export_sensitive',
  'export_client_draft',
  'export_audit',
  'change_mandate',
  'revoke_mandate',
  'revoke_supplier_credential',
]);

const PCF_REQUIRED_FIELDS = [
  'tCO2e',
  'unit',
  'method',
  'boundary',
  'period',
  'supplierId',
];

const STEP_META = [
  { step: 1, name: 'status', title: '授權狀態' },
  { step: 2, name: 'deny_list', title: '拒絕清單' },
  { step: 3, name: 'allow', title: '工具準入' },
  { step: 4, name: 'constraints', title: '資料與流程約束' },
  { step: 5, name: 'hitl', title: '人類確認' },
  { step: 6, name: 'allow_final', title: '全部通過' },
];

function result(decision, policyId, reason) {
  return { decision, policyId, reason };
}

function traceEntry(meta, status, extra) {
  return {
    step: meta.step,
    name: meta.name,
    title: meta.title,
    status,
    ...(extra || {}),
  };
}

function skippedTrace(meta) {
  return traceEntry(meta, 'skipped');
}

function parseTime(t) {
  if (t instanceof Date) return t.getTime();
  return new Date(t).getTime();
}

function isShareRevoked(supplierId, revokedShares) {
  if (!supplierId || !revokedShares) return false;
  if (revokedShares instanceof Set) return revokedShares.has(supplierId);
  if (Array.isArray(revokedShares)) return revokedShares.includes(supplierId);
  return false;
}

function isStaged(supplierId, staging) {
  if (!supplierId || !staging) return false;
  if (staging instanceof Map) return staging.has(supplierId);
  if (typeof staging.get === 'function') return Boolean(staging.get(supplierId));
  if (typeof staging === 'object') return Object.prototype.hasOwnProperty.call(staging, supplierId);
  return false;
}

function hasEmissionsRequest(supplierId, emissionsRequests) {
  if (!supplierId || !emissionsRequests) return false;
  if (emissionsRequests instanceof Set) return emissionsRequests.has(supplierId);
  if (Array.isArray(emissionsRequests)) return emissionsRequests.includes(supplierId);
  if (typeof emissionsRequests.has === 'function') return emissionsRequests.has(supplierId);
  return false;
}

function isStagingUsable(supplierId, staging) {
  if (!isStaged(supplierId, staging)) return false;
  if (staging instanceof Map) {
    const entry = staging.get(supplierId);
    return entry && !entry.revoked;
  }
  return true;
}

function buildCtx(raw) {
  const inp = raw.input || {};
  const act = raw.actor || {};
  return {
    ...raw,
    inp,
    act,
    nowMs: parseTime(raw.now),
    supplierId: inp.supplierId || null,
  };
}

function step1_status(ctx) {
  const { mandate, principal } = ctx;

  if (mandate == null) {
    return {
      trace: traceEntry(STEP_META[0], 'fail', {
        policyId: 'POL-AUTH-003',
        detail: '無有效 Mandate 綁定主體。',
      }),
      outcome: result('DENY_POLICY', 'POL-AUTH-003', 'No valid mandate bound to principal.'),
    };
  }

  if (
    principal &&
    (mandate.principalId !== principal.principalId || mandate.orgId !== principal.orgId)
  ) {
    return {
      trace: traceEntry(STEP_META[0], 'fail', {
        policyId: 'POL-AUTH-003',
        detail: 'Mandate 與主體不一致。',
      }),
      outcome: result('DENY_POLICY', 'POL-AUTH-003', 'No valid mandate bound to principal.'),
    };
  }

  if (mandate.status === 'REVOKED') {
    return {
      trace: traceEntry(STEP_META[0], 'fail', {
        policyId: 'POL-AUTH-001',
        detail: 'Mandate 已撤銷。',
      }),
      outcome: result(
        'DENY_REVOKED',
        'POL-AUTH-001',
        'Mandate has been revoked; issue a new mandate to continue.'
      ),
    };
  }

  if (ctx.nowMs >= parseTime(mandate.expiresAt)) {
    return {
      trace: traceEntry(STEP_META[0], 'fail', {
        policyId: 'POL-AUTH-002',
        detail: 'Mandate 已過期。',
      }),
      outcome: result('DENY_EXPIRED', 'POL-AUTH-002', 'Mandate expired at expiresAt.'),
    };
  }

  if (mandate.status !== 'ACTIVE') {
    return {
      trace: traceEntry(STEP_META[0], 'fail', {
        policyId: 'POL-AUTH-003',
        detail: 'Mandate 非 ACTIVE 狀態。',
      }),
      outcome: result('DENY_POLICY', 'POL-AUTH-003', 'No valid mandate bound to principal.'),
    };
  }

  return {
    trace: traceEntry(STEP_META[0], 'pass', { detail: 'Mandate 有效且未過期。' }),
    outcome: null,
  };
}

function step2_deny_list(ctx) {
  const { mandate, act, toolName, supplierId } = ctx;

  if (toolName === 'commit_cbam_draft' && act.actorType === 'AGENT') {
    return {
      trace: traceEntry(STEP_META[1], 'fail', {
        policyId: 'POL-GATE-000',
        detail: 'Agent 不可呼叫 commit_cbam_draft。',
      }),
      outcome: result('DENY_POLICY', 'POL-GATE-000', 'commit_cbam_draft is never exposed to Agent.'),
    };
  }

  const exportTools = new Set(['export_client_draft', 'export_audit', 'export_sensitive']);
  if (exportTools.has(toolName) && act.actorType === 'AGENT') {
    return {
      trace: traceEntry(STEP_META[1], 'fail', {
        policyId: 'POL-EXP-001',
        detail: 'Agent 不可匯出。',
      }),
      outcome: result('DENY_POLICY', 'POL-EXP-001', 'Export tools are denied for Agent.'),
    };
  }

  const toolDenied =
    mandate.deniedTools &&
    mandate.deniedTools.includes(toolName) &&
    !(toolName === 'commit_cbam_draft' && act.actorType === 'SYSTEM');
  const supplierDenied =
    supplierId != null &&
    mandate.deniedSuppliers &&
    mandate.deniedSuppliers.includes(supplierId);

  if (toolDenied || supplierDenied) {
    const detail = supplierDenied
      ? `供應商 ${supplierId} 在拒絕清單。`
      : `工具 ${toolName} 在拒絕清單。`;
    return {
      trace: traceEntry(STEP_META[1], 'fail', {
        policyId: 'POL-GATE-001',
        detail,
      }),
      outcome: result('DENY_POLICY', 'POL-GATE-001', 'Matched deny list (tool or supplier).'),
    };
  }

  if (toolName === 'export_sensitive' && act.actorType === 'AGENT') {
    return {
      trace: traceEntry(STEP_META[1], 'fail', {
        policyId: 'POL-GATE-003',
        detail: 'Agent 不可匯出敏感資料。',
      }),
      outcome: result('DENY_POLICY', 'POL-GATE-003', 'export_sensitive is denied for Agent.'),
    };
  }

  return {
    trace: traceEntry(STEP_META[1], 'pass', { detail: '未命中工具或供應商拒絕清單。' }),
    outcome: null,
  };
}

function step3_allow(ctx) {
  const { mandate, act, agent, toolName, inp, approval } = ctx;

  if (!TOOL_REGISTRY.has(toolName)) {
    return {
      trace: traceEntry(STEP_META[2], 'fail', {
        policyId: 'POL-GATE-000',
        detail: `工具 ${toolName} 未註冊。`,
      }),
      outcome: result('DENY_POLICY', 'POL-GATE-000', 'Tool not registered.'),
    };
  }

  if (toolName === 'commit_cbam_draft') {
    if (
      approval == null ||
      approval.status !== 'APPROVED' ||
      approval.consumedAt != null ||
      approval.mandateId !== mandate.mandateId ||
      (approval.type && approval.type !== 'CBAM' && approval.type !== 'PAYMENT')
    ) {
      return {
        trace: traceEntry(STEP_META[2], 'fail', {
          policyId: 'POL-HITL-010',
          detail: 'commit 需要有效且未消耗的 CBAM 核准。',
        }),
        outcome: result('DENY_POLICY', 'POL-HITL-010', 'Valid unused CBAM approval required.'),
      };
    }
  }

  if (
    toolName === 'change_mandate' &&
    (mandate.status === 'REVOKED' || mandate.status === 'EXPIRED') &&
    inp &&
    inp.status === 'ACTIVE'
  ) {
    return {
      trace: traceEntry(STEP_META[2], 'fail', {
        policyId: 'POL-REV-002',
        detail: '已撤銷或過期的 Mandate 不可復活。',
      }),
      outcome: result(
        'DENY_POLICY',
        'POL-REV-002',
        'Revoked/expired mandate cannot be restored; issue a new mandate.'
      ),
    };
  }

  if (!mandate.allowedTools || !mandate.allowedTools.includes(toolName)) {
    const humanSystemExtra =
      (act.actorType === 'HUMAN' || act.actorType === 'SYSTEM') &&
      (toolName === 'commit_cbam_draft' ||
        toolName === 'revoke_data_share' ||
        toolName === 'revoke_mandate' ||
        toolName === 'revoke_supplier_credential' ||
        toolName === 'export_sensitive' ||
        toolName === 'export_client_draft' ||
        toolName === 'export_audit');
    if (!humanSystemExtra) {
      return {
        trace: traceEntry(STEP_META[2], 'fail', {
          policyId: 'POL-GATE-002',
          detail: `工具 ${toolName} 不在 Mandate 允許清單。`,
        }),
        outcome: result('DENY_POLICY', 'POL-GATE-002', 'Tool not in mandate allow list.'),
      };
    }
  }

  if (
    act.actorType === 'AGENT' &&
    agent &&
    Array.isArray(agent.allowedTools) &&
    !agent.allowedTools.includes(toolName)
  ) {
    return {
      trace: traceEntry(STEP_META[2], 'fail', {
        policyId: 'POL-GATE-002',
        detail: `Agent 白名單不含 ${toolName}。`,
      }),
      outcome: result('DENY_POLICY', 'POL-GATE-002', 'Tool not in mandate allow list.'),
    };
  }

  return {
    trace: traceEntry(STEP_META[2], 'pass', { detail: '工具已註冊且在允許清單。' }),
    outcome: null,
  };
}

function step4_constraints(ctx) {
  const {
    toolName,
    supplierId,
    inp,
    revokedShares,
    staging,
    emissionsRequests,
    getPcfPayload,
    getSupplier,
    approval,
  } = ctx;

  const vleiCheckedTools = new Set(['fetch_supplier_response', 'ingest_pcf_payload']);
  if (vleiCheckedTools.has(toolName) && supplierId && typeof getSupplier === 'function') {
    const supplier = getSupplier(supplierId);
    const chain = verifySupplierCredentialChain(supplier);
    if (!chain.valid) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-CRED-001',
          detail: `供應商 ${supplierId} 的 vLEI 憑證鏈無效（${chain.chainStatus}）：${chain.detail}`,
        }),
        outcome: result(
          'DENY_CONSTRAINT',
          'POL-CRED-001',
          `Supplier vLEI credential chain invalid (${chain.chainStatus}): ${chain.detail}`
        ),
      };
    }
  }

  const shareRevokedTools = new Set([
    'ingest_pcf_payload',
    'submit_cbam_draft',
    'fetch_supplier_response',
    'commit_cbam_draft',
    'export_client_draft',
  ]);
  if (shareRevokedTools.has(toolName) && isShareRevoked(supplierId, revokedShares)) {
    return {
      trace: traceEntry(STEP_META[3], 'fail', {
        policyId: 'POL-REV-010',
        detail: supplierId
          ? `供應商 ${supplierId} 的資料分享已撤銷。`
          : '資料分享已撤銷。',
      }),
      outcome: result('DENY_POLICY', 'POL-REV-010', 'Data share for this supplier has been revoked.'),
    };
  }

  if (toolName === 'fetch_supplier_response') {
    if (!supplierId) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-REQ-001',
          detail: '缺少 supplierId。',
        }),
        outcome: result('DENY_CONSTRAINT', 'POL-REQ-001', 'supplierId required.'),
      };
    }
    if (!hasEmissionsRequest(supplierId, emissionsRequests)) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-REQ-001',
          detail: '須先向供應商索取碳數據才能取回。',
        }),
        outcome: result(
          'DENY_CONSTRAINT',
          'POL-REQ-001',
          'Must request emissions from supplier before fetching response.'
        ),
      };
    }
    if (getPcfPayload && !getPcfPayload(supplierId)) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-REQ-001',
          detail: '供應商尚無可讀取的 PCF 回覆。',
        }),
        outcome: result(
          'DENY_CONSTRAINT',
          'POL-REQ-001',
          'Supplier has no readable PCF response yet.'
        ),
      };
    }
  }

  if (toolName === 'ingest_pcf_payload' && !hasPcfQualityFields(inp)) {
    return {
      trace: traceEntry(STEP_META[3], 'fail', {
        policyId: 'POL-CARB-001',
        detail: 'PCF 缺少必填品質欄位（tCO2e、unit、method、boundary、period、supplierId）。',
      }),
      outcome: result(
        'DENY_CONSTRAINT',
        'POL-CARB-001',
        'PCF payload missing required fields (tCO2e, unit, method, boundary, period, supplierId).'
      ),
    };
  }

  if (toolName === 'ingest_pcf_payload') {
    const verifyErr = checkVerificationConsistency(inp);
    if (verifyErr) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-CARB-002',
          detail: verifyErr,
        }),
        outcome: result('DENY_CONSTRAINT', 'POL-CARB-002', verifyErr),
      };
    }
  }

  if (toolName === 'submit_cbam_draft') {
    if (!supplierId || !isStagingUsable(supplierId, staging)) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-CARB-001',
          detail: '尚無可用暫存 PCF；須先通過品質檢查入庫。',
        }),
        outcome: result(
          'DENY_CONSTRAINT',
          'POL-CARB-001',
          'No staged PCF payload for supplier; ingest first.'
        ),
      };
    }
  }

  if (toolName === 'export_client_draft') {
    if (!supplierId || !isStagingUsable(supplierId, staging)) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-EXP-001',
          detail: '無可匯出的暫存資料。',
        }),
        outcome: result('DENY_CONSTRAINT', 'POL-EXP-001', 'No staged payload to export for supplier.'),
      };
    }
  }

  if (toolName === 'commit_cbam_draft') {
    const commitSupplierId = supplierId || (approval && approval.payload && approval.payload.supplierId);
    if (commitSupplierId && !isStagingUsable(commitSupplierId, staging)) {
      return {
        trace: traceEntry(STEP_META[3], 'fail', {
          policyId: 'POL-REV-010',
          detail: '暫存資料已撤銷或不存在，無法 commit。',
        }),
        outcome: result('DENY_POLICY', 'POL-REV-010', 'Staged data revoked or missing for commit.'),
      };
    }
  }

  return {
    trace: traceEntry(STEP_META[3], 'pass', { detail: '資料與流程約束通過。' }),
    outcome: null,
  };
}

function step5_hitl(ctx) {
  const { toolName, act } = ctx;

  if (toolName === 'submit_cbam_draft') {
    return {
      trace: traceEntry(STEP_META[4], 'pending', {
        policyId: 'POL-HITL-010',
        detail: 'CBAM 草稿申請必須由合規主管確認。',
      }),
      outcome: result(
        'PENDING_HUMAN',
        'POL-HITL-010',
        'CBAM draft submission always requires human approval.'
      ),
    };
  }

  if (toolName === 'export_sensitive' && act.actorType === 'HUMAN') {
    return {
      trace: traceEntry(STEP_META[4], 'pending', {
        policyId: 'POL-GATE-003',
        detail: '敏感匯出需人類確認。',
      }),
      outcome: result('PENDING_HUMAN', 'POL-GATE-003', 'Sensitive export requires human approval.'),
    };
  }

  return {
    trace: traceEntry(STEP_META[4], 'pass', { detail: '無需人類確認或已滿足 HITL 前置。' }),
    outcome: null,
  };
}

function step6_allow() {
  return {
    trace: traceEntry(STEP_META[5], 'pass', {
      policyId: 'POL-ALLOW-000',
      detail: '所有政策檢查通過，允許執行。',
    }),
    outcome: result('ALLOW', 'POL-ALLOW-000', 'All policy checks passed.'),
  };
}

function evaluateWithTrace(rawCtx) {
  const ctx = buildCtx(rawCtx);
  const trace = [];
  const steps = [step1_status, step2_deny_list, step3_allow, step4_constraints, step5_hitl, step6_allow];

  for (let i = 0; i < steps.length; i += 1) {
    const stepFn = steps[i];
    const { trace: stepTrace, outcome } = stepFn(ctx);
    trace.push(stepTrace);

    if (outcome) {
      for (let j = i + 1; j < STEP_META.length; j += 1) {
        trace.push(skippedTrace(STEP_META[j]));
      }
      return { ...outcome, trace };
    }
  }

  return result('ALLOW', 'POL-ALLOW-000', 'All policy checks passed.');
}

function evaluate(rawCtx) {
  const out = evaluateWithTrace(rawCtx);
  return {
    decision: out.decision,
    policyId: out.policyId,
    reason: out.reason,
  };
}

module.exports = {
  evaluate,
  evaluateWithTrace,
  STEP_META,
  TOOL_REGISTRY,
  PCF_REQUIRED_FIELDS,
  hasPcfQualityFields,
};
