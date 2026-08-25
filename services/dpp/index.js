'use strict';

/**
 * services/dpp — Day 5 背景待辦 2：GS1／DPP（Digital Product Passport）分層揭露的
 * 最小示意。Day 5 追加②：把三層揭露從「寫死在程式碼裡的欄位子集」改成
 * **規則驅動**（policy-driven）——對應工作坊投影片 Layer 2「合約邏輯層：存取條件可
 * 程式化」的精神，也更貼近這個專案已經確立的 Policy Gate 設計語言（欄位/條件定義在一份
 * policy 記錄裡，不是散落在 if/else 裡）。
 *
 * 範圍（刻意縮小，任務書要求「API 層面即可，不用做真的 GTIN 查詢基礎設施」）：
 *   - **沒有**接真正的 GS1 GTIN 查詢服務或 Digital Link 標準解析器。
 *   - **沒有**新的權限系統——這裡示範的是「同一筆 Case 資料，依查詢者角色＋案件當下狀態
 *     回傳不同欄位子集」這個概念本身。跟既有 `x-demo-role`（Supplier/Importer/Verifier，
 *     見 server/workflowApi.js `maskCase`）是不同的軸線：那一組是「案件參與者」的內部
 *     角色，這裡的 public/customs/customer 是 GS1 願景裡「產品護照的外部查詢者分層」，
 *     語意上更接近某人掃了產品上的 QR code 之後，依照他是誰看到不同深度的資訊。
 *   - 純函式、只讀：拿現有 workflowStore 已經算好的資料做欄位子集，不碰任何寫入路徑、
 *     不影響 Gate／Policy 判斷、不產生新的稽核事件。
 *
 * 三層揭露設計（沿用 CBAM/DPP 產業慣例：公開層最少、海關層最多、客戶層居中，逐層累加）：
 *   - `public`：CN code、對外狀態、是否落在合規區間的布林值。不揭露實際排放數字。
 *   - `customer`：+ 總碳足跡強度（下游客戶採購決策/自身碳盤查需要）。
 *   - `customs`：+ 實際 vs 預設係數比較、批次分攤狀態——但**這組比較資訊有條件**：案件還沒
 *     推進到 `READY_FOR_VERIFIER` 之前，海關看到的是「尚未完成驗證準備、暫不提供比較數字」
 *     的明確占位訊息，不是提前洩漏一個還沒經過信任閘門檢查的數字。這是「合約邏輯可程式化」
 *     這個概念真正的意思：存取條件本身是可以掛判斷式的，不是單純「哪個角色看哪些欄位」的
 *     靜態表格。
 */

const ROLES = Object.freeze(['public', 'customer', 'customs']);

function outwardCompliant(status) {
  return status === 'READY_FOR_VERIFIER';
}

function publicFields(ctx) {
  return {
    caseId: ctx.caseRecord.caseId,
    cnCode: ctx.caseRecord.cnCode,
    status: ctx.outwardStatus,
    compliant: outwardCompliant(ctx.outwardStatus),
  };
}

function customerFields(ctx) {
  return {
    carbonIntensity: {
      value: ctx.carbon.annual.intensity,
      unit: ctx.carbon.annual.intensityUnit,
      label: '此產品的總碳足跡強度（已核准年度數值，非個別批次拆解）。',
    },
    reportingYear: ctx.carbon.installationYear.reportingYear,
  };
}

function customsBaseFields(ctx) {
  return {
    shipmentCount: Array.isArray(ctx.carbon.shipments) ? ctx.carbon.shipments.length : 0,
    policyProfileId: ctx.caseRecord.policyProfileId,
  };
}

/** 存取條件：案件要推進到 READY_FOR_VERIFIER 之後，才揭露實際 vs 預設係數的比較數字。 */
function readyForVerifierCondition(ctx) {
  return ctx.outwardStatus === 'READY_FOR_VERIFIER';
}

function comparisonFieldsWhenGranted(ctx) {
  return {
    comparison: {
      actualIntensity: ctx.carbon.annual.intensity,
      defaultEstimateIntensity: 2.5,
      unit: ctx.carbon.annual.intensityUnit,
      label: 'Demo estimate，非官方預設值。',
    },
  };
}

function comparisonFieldsWhenDenied() {
  return {
    comparison: {
      withheld: true,
      reason: '案件尚未推進到 READY_FOR_VERIFIER，暫不提供實際 vs 預設係數的比較數字。',
    },
  };
}

/**
 * 揭露政策：逐層累加（`customer` 包含 `public` 的欄位，`customs` 再包含 `customer` 的欄位），
 * 每一層可以再掛「有條件欄位」（`conditionalFields`）——條件不成立時走 `whenDenied()`，
 * 不是整層不給看，是那個欄位本身變成明確的占位說明。
 *
 * 之所以用 `policyProfileId` 當 key（而不是單一寫死的規則）：不同產品類別、不同法規情境
 * 未來可能要有不同的揭露規則，這裡先把「規則長什麼樣子」跟「哪個案件套用哪份規則」分開，
 * 即使目前只有一份 `default`，介面已經是可以延伸的。
 */
const DPP_DISCLOSURE_POLICIES = Object.freeze({
  default: Object.freeze({
    tiers: Object.freeze([
      Object.freeze({ tier: 'public', build: publicFields }),
      Object.freeze({ tier: 'customer', build: customerFields }),
      Object.freeze({
        tier: 'customs',
        build: customsBaseFields,
        conditionalFields: Object.freeze([
          Object.freeze({
            condition: readyForVerifierCondition,
            whenGranted: comparisonFieldsWhenGranted,
            whenDenied: comparisonFieldsWhenDenied,
          }),
        ]),
      }),
    ]),
  }),
});

function resolveDisclosurePolicy(policyProfileId) {
  return DPP_DISCLOSURE_POLICIES[policyProfileId] || DPP_DISCLOSURE_POLICIES.default;
}

/**
 * @param {object} params
 * @param {object} params.caseRecord - workflowStore.getCase() 回傳的案件記錄
 * @param {string} params.outwardStatus - 已經過 outward masking 的狀態字串（呼叫端算好傳進來，
 *   這個模組不重新判斷「trust services 是否 verified」這種邏輯，避免跟 workflowApi.js 的
 *   outwardStatus() 出現兩份不同步的實作）
 * @param {object} params.carbon - workflowStore.getCarbon() 回傳的資料
 * @param {string} params.role - 'public' | 'customer' | 'customs'
 * @returns {object}
 */
function buildLayeredDisclosure({ caseRecord, outwardStatus: status, carbon, role }) {
  if (!ROLES.includes(role)) {
    throw new TypeError(`Invalid DPP disclosure role: ${role}（只接受 ${ROLES.join('/')}）`);
  }
  const policy = resolveDisclosurePolicy(caseRecord.policyProfileId);
  const ctx = { caseRecord, outwardStatus: status, carbon };
  const requestedIndex = policy.tiers.findIndex((t) => t.tier === role);

  let view = {};
  for (let i = 0; i <= requestedIndex; i += 1) {
    const tierDef = policy.tiers[i];
    view = { ...view, ...tierDef.build(ctx) };
    for (const conditional of tierDef.conditionalFields || []) {
      view = { ...view, ...(conditional.condition(ctx) ? conditional.whenGranted(ctx) : conditional.whenDenied(ctx)) };
    }
  }
  return { ...view, disclosureLevel: role, demoOnly: true };
}

module.exports = { ROLES, DPP_DISCLOSURE_POLICIES, resolveDisclosurePolicy, buildLayeredDisclosure };
