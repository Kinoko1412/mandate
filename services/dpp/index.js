'use strict';

/**
 * services/dpp — Day 5 背景待辦 2：GS1／DPP（Digital Product Passport）分層揭露的
 * 最小示意。
 *
 * 範圍（刻意縮小，任務書要求「API 層面即可，不用做真的 GTIN 查詢基礎設施」）：
 *   - **沒有**接真正的 GS1 GTIN 查詢服務或 Digital Link 標準解析器。
 *   - **沒有**新的權限系統——這裡示範的是「同一筆 Case 資料，依查詢者角色回傳不同欄位
 *     子集」這個概念本身，不是要重做一套認證機制。跟既有 `x-demo-role`（Supplier/
 *     Importer/Verifier，見 server/workflowApi.js `maskCase`）是不同的軸線：那一組是
 *     「案件參與者」的內部角色，這裡的 public/customs/customer 是 GS1 願景裡「產品護照
 *     的外部查詢者分層」，語意上更接近某人掃了產品上的 QR code 之後，依照他是誰
 *     （一般消費者／海關／下游客戶）看到不同深度的資訊。
 *   - 純函式、只讀：拿現有 workflowStore 已經算好的資料做欄位子集，不碰任何寫入路徑、
 *     不影響 Gate／Policy 判斷、不產生新的稽核事件。
 *
 * 三層揭露設計（沿用 CBAM/DPP 產業慣例：公開層最少、海關層最多、客戶層居中）：
 *   - `public`：任何人都能看到的最小資訊——CN code、對外狀態、是否落在合規區間的布林值。
 *     不揭露實際排放數字（那是要付費/授權才看得到的商業資訊，也可能涉及製程機密）。
 *   - `customer`：多揭露「總碳足跡強度」這個下游客戶做採購決策/自身碳盤查會需要的數字，
 *     但不揭露批次分攤明細、不揭露證據來源、不揭露內部稽核狀態。
 *   - `customs`：海關/查驗層級，等同於既有 Importer 摘要的資訊深度（實際 vs 預設係數比較、
 *     批次分攤狀態），因為海關本來就需要這些做申報比對。
 */

const ROLES = Object.freeze(['public', 'customer', 'customs']);

function outwardCompliant(status) {
  return status === 'READY_FOR_VERIFIER';
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
  const publicView = {
    caseId: caseRecord.caseId,
    cnCode: caseRecord.cnCode,
    status,
    compliant: outwardCompliant(status),
    demoOnly: true,
    disclosureLevel: 'public',
  };
  if (role === 'public') return publicView;

  const customerView = {
    ...publicView,
    disclosureLevel: 'customer',
    carbonIntensity: {
      value: carbon.annual.intensity,
      unit: carbon.annual.intensityUnit,
      label: '此產品的總碳足跡強度（已核准年度數值，非個別批次拆解）。',
    },
    reportingYear: carbon.installationYear.reportingYear,
  };
  if (role === 'customer') return customerView;

  // customs：海關/查驗層級，資訊深度比照既有 Importer 摘要（實際 vs 預設係數比較），
  // 因為這正是海關比對申報數字時需要的東西。
  return {
    ...customerView,
    disclosureLevel: 'customs',
    comparison: {
      actualIntensity: carbon.annual.intensity,
      defaultEstimateIntensity: 2.5,
      unit: carbon.annual.intensityUnit,
      label: 'Demo estimate，非官方預設值。',
    },
    shipmentCount: Array.isArray(carbon.shipments) ? carbon.shipments.length : 0,
    policyProfileId: caseRecord.policyProfileId,
  };
}

module.exports = { ROLES, buildLayeredDisclosure };
