'use strict';

/**
 * 單一事實來源。schema-v1.json 的 enum 值必須跟這裡手動保持一致——沒有自動同步
 * 腳本，改這裡任何值記得回頭改 schema-v1.json。
 *
 * 優先權依「可信碳排證據Agent_VibeCodingAI完整工程規格與指令手冊.pdf」第 0 頁
 * 文件優先順序表：本檔案是最高優先權規格（Vibe Coding AI 工程規格）跟落地風險
 * 審查修正版方案兩者對照後的結果，衝突時以 Vibe Coding AI 工程規格為準。
 */

/**
 * Case 狀態機（Vibe Coding 規格 p.4，7 態）。
 * 注意：這裡沒有 VERIFIER_REQUIRED——那是舊版（25 頁修正版）沿用下來的自創狀態，
 * 這份最高優先權文件沒有這個值，已移除。
 */
const CASE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  NEEDS_EVIDENCE: 'NEEDS_EVIDENCE',
  METHOD_REVIEW: 'METHOD_REVIEW',
  READY_FOR_VERIFIER: 'READY_FOR_VERIFIER',
  VERIFIER_REVIEW: 'VERIFIER_REVIEW',
  BLOCKED: 'BLOCKED',
  ARCHIVED: 'ARCHIVED',
});

/**
 * GateResult.decision 的值域（Vibe Coding 規格 p.11「Final Mapping」：
 * 硬失敗→BLOCKED；缺件→NEEDS_EVIDENCE；方法→METHOD_REVIEW；GATE_OK 或 reason list）。
 * 這是 Gate 產出的「原始判定」，Case.status 由這個值加上人工工作流動作（例如查驗員
 * 接案）共同決定，兩者不是同一個 enum。
 */
const GATE_DECISION = Object.freeze({
  GATE_OK: 'GATE_OK',
  NEEDS_EVIDENCE: 'NEEDS_EVIDENCE',
  METHOD_REVIEW: 'METHOD_REVIEW',
  BLOCKED: 'BLOCKED',
});

/**
 * reasonCodes（GateResult.reasonCodes 是陣列，不是單一值）。
 * 前半段逐字取自 Vibe Coding 規格 p.11 Gate Check 表 + p.8 Fixture 表；
 * 後半段（標 NOT IN SPEC）是本文件沒有明確定義字串、carbon-core 為了
 * reconcileAllocationLedger／輸入驗證需要而補的，8/24 09:00 需跟隊友確認命名。
 */
const REASON_CODE = Object.freeze({
  // --- 逐字取自規格 p.11 / p.8 ---
  AUTHORIZATION_INVALID: 'AUTHORIZATION_INVALID',
  AUTHORIZATION_REVOKED: 'AUTHORIZATION_REVOKED',
  CASE_CONTEXT_MISMATCH: 'CASE_CONTEXT_MISMATCH',
  EVIDENCE_MISSING: 'EVIDENCE_MISSING',
  EVIDENCE_PERIOD_INCOMPLETE: 'EVIDENCE_PERIOD_INCOMPLETE',
  FACTOR_NOT_ALLOWED: 'FACTOR_NOT_ALLOWED',
  FACTOR_EXPIRED: 'FACTOR_EXPIRED',
  POLICY_NOT_APPLICABLE: 'POLICY_NOT_APPLICABLE',
  PROOF_INVALID: 'PROOF_INVALID',
  PROOF_EXPIRED: 'PROOF_EXPIRED',
  NONCE_REUSED: 'NONCE_REUSED',
  PUBLIC_INPUT_MISMATCH: 'PUBLIC_INPUT_MISMATCH',
  PROOF_CONTEXT_MISMATCH: 'PROOF_CONTEXT_MISMATCH',
  AGENT_REVIEW_REQUIRED: 'AGENT_REVIEW_REQUIRED',
  GATE_OK: 'GATE_OK',

  // --- NOT IN SPEC：carbon-core 自行補上，待 8/24 跟隊友確認命名 ---
  ALLOCATION_EXCEEDS_PRODUCTION: 'ALLOCATION_EXCEEDS_PRODUCTION', // reconcileAllocationLedger「超出年度產量」
  DUPLICATE_SHIPMENT_ID: 'DUPLICATE_SHIPMENT_ID', // reconcileAllocationLedger「重複 shipmentId」
  UNKNOWN_UNIT: 'UNKNOWN_UNIT', // validateInstallationYear/Shipment「未知單位」
  ZERO_OR_NEGATIVE_QUANTITY: 'ZERO_OR_NEGATIVE_QUANTITY', // 「負數、零產量」
  INVALID_REPORTING_YEAR: 'INVALID_REPORTING_YEAR', // 「錯年度」
  CALCULATION_OVERFLOW: 'CALCULATION_OVERFLOW', // 「溢位」
  MISSING_CALCULATION_CONTEXT: 'MISSING_CALCULATION_CONTEXT', // buildCalculationReceipt「缺 policy／factor／context」
  INTENSITY_MISMATCH: 'INTENSITY_MISMATCH',
});

const FACTOR_PURPOSE = Object.freeze({
  TW_INVENTORY: 'TW_INVENTORY',
  CBAM_ACTUAL: 'CBAM_ACTUAL',
  CBAM_DEFAULT: 'CBAM_DEFAULT',
  PACT: 'PACT',
});

const EVIDENCE_TYPE = Object.freeze({
  ELECTRICITY_BILL: 'electricity_bill',
  FUEL_LEDGER: 'fuel_ledger',
  PRODUCTION_REPORT: 'production_report',
  PRECURSOR_LIST: 'precursor_list',
});

const AGENT_REASON_CODE = Object.freeze({
  PROMPT_INJECTION_DETECTED: 'PROMPT_INJECTION_DETECTED',
  UNSAFE_DOCUMENT_TEXT: 'UNSAFE_DOCUMENT_TEXT',
  EXTRACTION_TRUNCATED: 'EXTRACTION_TRUNCATED',
  EVIDENCE_CONTENT_UNAVAILABLE: 'EVIDENCE_CONTENT_UNAVAILABLE',
  EVIDENCE_JSON_INVALID: 'EVIDENCE_JSON_INVALID',
  INVALID_EVIDENCE_PERIOD: 'INVALID_EVIDENCE_PERIOD',
  EVIDENCE_MISSING: 'EVIDENCE_MISSING',
  EVIDENCE_PERIOD_INCOMPLETE: 'EVIDENCE_PERIOD_INCOMPLETE',
  UNIT_AMBIGUOUS: 'UNIT_AMBIGUOUS',
  CROSS_TABLE_CHECK_SKIPPED: 'CROSS_TABLE_CHECK_SKIPPED',
  ELECTRICITY_INTENSITY_OUT_OF_RANGE: 'ELECTRICITY_INTENSITY_OUT_OF_RANGE',
  FUEL_INTENSITY_OUT_OF_RANGE: 'FUEL_INTENSITY_OUT_OF_RANGE',
  PRECURSOR_RATIO_OUT_OF_RANGE: 'PRECURSOR_RATIO_OUT_OF_RANGE',
  EXTRACTED_VALUE: 'EXTRACTED_VALUE',
});

const AGENT_REVIEW_STATUS = Object.freeze({
  HUMAN_REVIEW_REQUIRED: 'HUMAN_REVIEW_REQUIRED',
  READY_FOR_HUMAN_REVIEW: 'READY_FOR_HUMAN_REVIEW',
});

/**
 * InstallationYear.verificationStatus 的值域——規格 p.7 只列出這個欄位名稱，
 * 沒有列舉值。這裡的兩個值是 carbon-core 的判斷（NOT IN SPEC，已在 README 標註待確認）：
 * 'draft'＝供應商年度資料尚未自行確認；'confirmed'＝供應商已確認、可送 Gate 評估。
 * 這跟「合格 CBAM 查驗員正式查驗完成」是不同層次的事——後者是 Case.status
 * 從 READY_FOR_VERIFIER 轉成 VERIFIER_REVIEW 之後才會發生，不由這個欄位決定。
 */
const VERIFICATION_STATUS = Object.freeze({
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
});

module.exports = {
  CASE_STATUS,
  GATE_DECISION,
  REASON_CODE,
  FACTOR_PURPOSE,
  EVIDENCE_TYPE,
  AGENT_REASON_CODE,
  AGENT_REVIEW_STATUS,
  VERIFICATION_STATUS,
};
