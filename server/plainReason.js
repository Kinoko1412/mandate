'use strict';

const { getMissingLevel1, PCF_LEVEL2_FIELDS } = require('./pcfCheck');

const FIELD_LABELS = {
  method: '計算方法',
  boundary: '系統邊界',
  period: '報告期間',
  unit: '功能單位',
  tCO2e: '嵌入排放量',
  supplierId: '供應商識別',
  cnCode: '產品 CN 碼',
  emissionPerUnit: '單位產品排放',
  verificationStatus: '查驗狀態',
  verificationReportId: '查驗報告編號',
};

function plainReason(decision, policyId, reason, input) {
  if (policyId === 'POL-CARB-001') {
    const missing = input ? getMissingLevel1(input) : [];
    const list = missing.map((k) => FIELD_LABELS[k] || k).join('、');
    if (list) {
      return `這份回覆缺 ${list}。若直接給客戶去申報，很可能被要求改填預設值或補件，已拒收。`;
    }
    return '這份回覆只有漂亮噸數（或缺方法／邊界／期間／單位），不能當可稽核碳數據，已拒收。';
  }
  if (policyId === 'POL-CARB-002') {
    if (/verification/i.test(reason || '')) {
      return '標示「已查驗」但沒有查驗報告編號，不能對外宣稱已驗證，已拒收。';
    }
    return '進階欄位不完整：可暫存內部使用，但對外申報前建議補齊 CN 碼、單位排放或查驗狀態。';
  }
  if (policyId === 'POL-CRED-001') {
    return '這家供應商的 vLEI 身分憑證鏈已失效（法人憑證或簽署角色憑證被撤銷／過期），在重新取得有效憑證前，不能再收這批碳數據。';
  }
  if (policyId === 'POL-REQ-001') {
    return '尚未向這家供應商索取碳數據，不能直接取回覆。請先執行「索取碳數據」。';
  }
  if (policyId === 'POL-HITL-010' || (decision === 'PENDING_HUMAN' && /cbam|submit/i.test(reason || ''))) {
    return '要把碳數據寫進 CBAM／客戶回覆草稿，屬於高風險對外動作，必須合規主管確認。';
  }
  if (decision === 'PENDING_HUMAN') {
    return '高風險動作已暫停，等待人類確認。';
  }
  if (policyId === 'POL-REV-010') {
    return '這家供應商的數據分享權已撤銷，AI 不得再使用這批數字。';
  }
  if (policyId === 'POL-AUTH-001' || decision === 'DENY_REVOKED') {
    return '授權已被收回，AI 不能再代表公司做事。';
  }
  if (policyId === 'POL-AUTH-002' || decision === 'DENY_EXPIRED') {
    return '授權期限已過，必須重新發授權。';
  }
  if (policyId === 'POL-EXP-001') {
    return reason || '匯出條件不符（可能尚無可匯出的草稿或紀錄）。';
  }
  if (policyId === 'POL-ALLOW-000' || decision === 'ALLOW') {
    if (/ingest|staging|品質/i.test(reason || '')) {
      return '品質欄位齊全，已進入暫存區，可進一步申請寫入申報。';
    }
    if (/request|索取/i.test(reason || '')) {
      return '已向供應商發出碳數據請求，可接著取回對方回覆。';
    }
    if (/fetch|回覆/i.test(reason || '')) {
      return '已取得供應商回覆的碳數據，可進行品質檢查。';
    }
    return '檢查都過了，可以執行這一步。';
  }
  return reason || decision || '—';
}

module.exports = { plainReason, FIELD_LABELS };
