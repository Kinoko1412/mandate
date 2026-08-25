'use strict';

/**
 * services/credential — Day 5 追加功能①：把 ZK 電路 + vLEI 身份驗證的輸出，包裝成一張
 * 真正可攜帶、外部工具能獨立驗證的「碳足跡憑證」（Carbon Footprint Verifiable Credential）。
 *
 * 格式：W3C Verifiable Credentials Data Model 的 **JWT 序列化**（VC-JWT），不是完整
 * JSON-LD + Linked Data Proof。這是跟使用者討論過的取捨（不是我自己選的）：
 *   - JWT-VC 一樣是 W3C 正式支援的序列化方式，不是變通做法。
 *   - JSON-LD VC 簽章前需要 RDF canonicalization（URDNA2015 這類演算法）才能對「語意相同
 *     但位元組不同」的文件簽出一致的結果，這一步很難自己刻對、業界都是直接用現成函式庫，
 *     且要連網解析 `@context`——demo 現場網路不穩會直接讓驗證失敗。
 *   - JWT 直接對固定位元組簽章，Node 內建 `crypto` 就做得完整（見 ./jwt.js），沒有這些風險。
 *
 * 誠實揭露這張憑證「有多真」（這個問題使用者直接問過，答案照實寫在這裡）：
 *   - **簽章這層是真的**：任何人拿到這個 JWT + 對應公鑰，用任何語言的通用 JWT 驗證工具都能
 *     獨立驗證簽章沒被竄改——不需要打這個專案的 API。
 *   - **ZK 這層是真的**：憑證裡包了完整的 groth16 proof + publicSignals，任何人拿到
 *     `circuits/build/verification_key.json`（公開檔案，沒有秘密）也能自己重新驗證這個 proof，
 *     不用相信這個系統的說法。
 *   - **身份根這層是 demo 等級**：簽章金鑰對應的 vLEI 身份，來自 `services/identity` 的寫死
 *     demo registry，不是真的 GLEIF 網路——「這把金鑰真的屬於台灣鋼鐵公司」這件事，這個系統
 *     以外的人沒辦法獨立驗證，跟專案裡其他 demoOnly 模組是同一種、一路誠實標記的限制。
 */

const crypto = require('crypto');
const identity = require('../identity');
const zk = require('../proof/zk');
const { toScaled } = require('../../packages/contracts/fixedPoint');
const { getPolicyRecord } = require('../policy-registry');
const { signJwt, verifyJwt, decodeUnverified, JwtError } = require('./jwt');

const VC_CONTEXT = Object.freeze(['https://www.w3.org/2018/credentials/v1']);
const VC_TYPE = Object.freeze(['VerifiableCredential', 'CarbonFootprintCredential']);
const CIRCUIT_ID = 'mandate-carbon-proof-v1';
const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 年，跟 reportingYear 的量級對齊

class CredentialError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    this.details = details || null;
  }
}

/**
 * 簽發一張碳足跡憑證。
 *
 * 電路輸入的映射方式沿用 `circuits/README.md`「架構決策」一節先前寫好、但當時還沒接線的
 * 建議路徑：`quantityScaled=[verifiedIntensity,0,0,0]`（私密，唯一真正被隱藏的數字）、
 * `factorScaled=[productionTonnes,0,0,0]`（公開，出貨量本來就不是機密）——電路算出來的
 * `totalScaled` 因此等於 `intensity × production`，跟 carbon-core 既有算法一致，可以互相
 * 核對，且沒有杜撰任何電路命題假設之外的東西。
 *
 * @param {object} params
 * @param {string} params.actorId - 簽發者在 services/identity registry 裡的 actorId
 * @param {string} params.caseId
 * @param {string} params.installationId
 * @param {number} params.reportingYear
 * @param {number} params.productionTonnes - 公開（出貨量不是機密）
 * @param {number} params.verifiedIntensity - 私密（製程效率，這是真正要隱藏的商業機密）
 * @param {number} [params.ttlSeconds]
 * @returns {Promise<{jwt: string, payload: object}>}
 */
async function issueCarbonFootprintVC({
  actorId,
  caseId,
  installationId,
  reportingYear,
  productionTonnes,
  verifiedIntensity,
  ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  const record = identity.getIdentityRecord(actorId);
  if (!record) {
    throw new CredentialError('ISSUER_UNKNOWN', `actorId ${actorId} 不在身份憑證 Registry 內，無法簽發憑證。`);
  }
  // 簽發前一定要先驗證身份鏈——已撤銷或過期的身份不能簽出新憑證，這跟現實世界「憑證被吊銷
  // 的人不能再用這張憑證做任何事」的邏輯一致，重用既有的 verifyIdentityContext()，不重寫。
  const identityResult = identity.verifyIdentityContext({ actorId, orgId: record.orgId });
  if (identityResult.decision !== identity.GATE_DECISION.OK) {
    throw new CredentialError(
      'ISSUER_IDENTITY_INVALID',
      `簽發者身份未通過驗證，拒絕簽發：${identityResult.reasonCodes.join(', ')}`,
      { identityResult }
    );
  }

  const keyPair = identity.getSigningKeyPair(actorId);
  if (!keyPair) {
    throw new CredentialError('ISSUER_KEY_UNAVAILABLE', `actorId ${actorId} 沒有可用的簽章金鑰。`);
  }

  const policyRecord = getPolicyRecord('CBAM-STEEL-2026-v1');
  if (!policyRecord || !Number.isFinite(policyRecord.complianceThresholdScaled)) {
    throw new CredentialError('POLICY_THRESHOLD_UNAVAILABLE', 'Policy Registry 沒有可用的合規上限。');
  }

  const zkResult = await zk.generateRealZkProof({
    quantityScaled: [toScaled(verifiedIntensity), 0, 0, 0],
    factorScaled: [toScaled(productionTonnes), 0, 0, 0],
    complianceThresholdScaled: policyRecord.complianceThresholdScaled,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: actorId,
    sub: caseId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: `urn:mandate:credential:${crypto.randomBytes(12).toString('hex')}`,
    vc: {
      '@context': VC_CONTEXT,
      type: VC_TYPE,
      credentialSubject: {
        caseId,
        installationId,
        reportingYear,
        totalScaled: zkResult.totalScaled,
        compliant: zkResult.compliant,
        complianceThresholdScaled: policyRecord.complianceThresholdScaled,
        circuitId: CIRCUIT_ID,
        zkProof: { proof: zkResult.proof, publicSignals: zkResult.publicSignals },
      },
      demoOnly: true, // 誠實標記：身份根是 demo registry，見本檔開頭說明
    },
  };

  return { jwt: signJwt(payload, keyPair.privateKey), payload };
}

/**
 * 驗證一張碳足跡憑證。三層各自獨立檢查，缺一不可，任何一層失敗整體 valid=false：
 *   1. JWT 簽章（內容沒被竄改，真的是宣稱的簽發者簽的）
 *   2. 沒過期
 *   3. 內嵌的 ZK proof 重新驗證（總排放量/合規判斷真的是從私密分量算對的，不是憑證作者亂填）
 *   4. 簽發者身份**現在**還有效（不是「簽發當下」有效——如果之後被撤銷，舊憑證應該跟著
 *      不再被信任，這是真實世界憑證撤銷該有的行為）
 *
 * @param {string} token
 * @returns {Promise<{valid: boolean, signatureValid: boolean, notExpired: boolean,
 *   zkProofValid: boolean, issuerIdentityValid: boolean, payload: object|null, errors: string[]}>}
 */
async function verifyCarbonFootprintVC(token) {
  const errors = [];
  let claimedIss = null;
  try {
    ({ payload: { iss: claimedIss } = {} } = decodeUnverified(token));
  } catch (err) {
    return {
      valid: false,
      signatureValid: false,
      notExpired: false,
      zkProofValid: false,
      issuerIdentityValid: false,
      payload: null,
      errors: [`JWT 格式錯誤，無法解析：${err.message}`],
    };
  }

  const record = claimedIss ? identity.getIdentityRecord(claimedIss) : null;
  const keyPair = claimedIss ? identity.getSigningKeyPair(claimedIss) : null;
  if (!record || !keyPair) {
    return {
      valid: false,
      signatureValid: false,
      notExpired: false,
      zkProofValid: false,
      issuerIdentityValid: false,
      payload: null,
      errors: [`宣稱的簽發者 ${claimedIss} 不在身份 Registry 內，沒有公鑰可以驗證，視為無效憑證。`],
    };
  }

  let signatureValid = false;
  let payload = null;
  try {
    ({ payload } = verifyJwt(token, keyPair.publicKey));
    signatureValid = true;
  } catch (err) {
    errors.push(err instanceof JwtError ? err.message : `簽章驗證發生未預期錯誤：${err.message}`);
    return {
      valid: false,
      signatureValid: false,
      notExpired: false,
      zkProofValid: false,
      issuerIdentityValid: false,
      payload: null, // 簽章沒過就不回傳內容——內容此時不可信，不能被誤用
      errors,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const notExpired = typeof payload.exp === 'number' && payload.exp > nowSeconds;
  if (!notExpired) errors.push(`憑證已過期（exp=${payload.exp}）。`);

  let zkProofValid = false;
  try {
    const subject = payload.vc && payload.vc.credentialSubject;
    if (!subject || !subject.zkProof) {
      throw new Error('憑證內容缺少 zkProof。');
    }
    const proofOk = await zk.verifyRealZkProof(subject.zkProof);
    if (!proofOk) {
      errors.push('內嵌的 ZK proof 驗證失敗（總排放量/合規判斷無法被獨立證實）。');
    } else {
      // 只驗證 proof 本身合法還不夠——一定要交叉比對 credentialSubject 外層寫的
      // totalScaled/compliant，是不是真的等於這份 proof 的 publicSignals 裡編碼的數字。
      // 沒有這一步，簽發者（或竄改者，如果拿得到簽章金鑰）可以放一份「自己算對」的合法
      // proof，但外層 JSON 隨便填一個不相關的 totalScaled——proof 驗證會過，但整張
      // 憑證講的是假話。順序見 circuits/carbon_proof.circom 的
      // `component main {public [factorScaled, complianceThresholdScaled]}` 宣告：
      // publicSignals = [totalScaled, compliant, factorScaled[0..3], complianceThresholdScaled]。
      const [claimedTotal, claimedCompliant, , , , , claimedThreshold] = subject.zkProof.publicSignals;
      const totalMatches = String(subject.totalScaled) === String(claimedTotal);
      const compliantMatches = Boolean(subject.compliant) === (claimedCompliant === '1');
      const thresholdMatches = String(subject.complianceThresholdScaled) === String(claimedThreshold);
      if (!totalMatches || !compliantMatches || !thresholdMatches) {
        errors.push(
          '憑證外層宣稱的 totalScaled/compliant/complianceThresholdScaled 跟內嵌 ZK proof 的 publicSignals 對不起來——proof 本身合法，但憑證講的數字是假的。'
        );
      } else {
        zkProofValid = true;
      }
    }
  } catch (err) {
    errors.push(`ZK proof 驗證發生錯誤：${err.message}`);
  }

  const identityResult = identity.verifyIdentityContext({ actorId: claimedIss, orgId: record.orgId });
  const issuerIdentityValid = identityResult.decision === identity.GATE_DECISION.OK;
  if (!issuerIdentityValid) {
    errors.push(`簽發者身份目前已無效（${identityResult.reasonCodes.join(', ')}）——即使簽發當下有效，現在也不再信任這張憑證。`);
  }

  return {
    valid: signatureValid && notExpired && zkProofValid && issuerIdentityValid,
    signatureValid,
    notExpired,
    zkProofValid,
    issuerIdentityValid,
    payload,
    errors,
  };
}

module.exports = { CredentialError, issueCarbonFootprintVC, verifyCarbonFootprintVC, CIRCUIT_ID };
