'use strict';

/**
 * services/credential/jwt.js — 最小、手寫的 JWT 簽章/驗證（只支援 EdDSA/Ed25519）。
 *
 * 為什麼自己寫，不用 `jsonwebtoken` 這類套件：JWT 的簽章機制本身很單純——把
 * base64url(header) + "." + base64url(payload) 這串固定位元組拿去做一次標準簽章，
 * 驗證時反過來做同一件事。核心邏輯二十幾行講得完，用 Node 內建 `crypto` 就能做完整，
 * 不需要多引入一個相依套件的攻擊面/更新風險。
 *
 * 安全設計（不是隨便寫）：
 *   - 演算法寫死 `EdDSA`，簽的時候寫死、驗的時候也**強制檢查** token header 裡的 `alg`
 *     一定要是 `EdDSA` 才繼續，不接受 token 自己宣稱別的演算法——這是防「algorithm
 *     confusion」這類 JWT 經典漏洞的基本紀律，即使這裡只有一種簽章方式也照做。
 *   - 沒有「alg: none」的後門。
 *   - 用 Node 原生的 base64url 編碼（Node 15+ 內建，不用手刻 base64 再替換字元）。
 */

const crypto = require('crypto');

const ALG = 'EdDSA';
const TYP = 'JWT';

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function base64urlDecodeJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

class JwtError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'JwtError';
    this.details = details || null;
  }
}

/**
 * @param {object} payload
 * @param {import('crypto').KeyObject} privateKey - Ed25519 私鑰
 * @returns {string} 完整 JWT（header.payload.signature，全部 base64url）
 */
function signJwt(payload, privateKey) {
  const header = { alg: ALG, typ: TYP };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * @param {string} token
 * @param {import('crypto').KeyObject} publicKey - Ed25519 公鑰（呼叫端要自己決定信任哪把公鑰，
 *   這個函式不做「這把公鑰是不是真的屬於 iss 宣稱的人」這件事——那是上一層
 *   services/credential/index.js 該做的，這裡只管簽章數學對不對）
 * @returns {{header: object, payload: object}}
 */
function verifyJwt(token, publicKey) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new JwtError('不是合法的 JWT 格式（應為 header.payload.signature）。');
  }
  const [headerSeg, payloadSeg, signatureSeg] = token.split('.');
  let header;
  try {
    header = base64urlDecodeJson(headerSeg);
  } catch (err) {
    throw new JwtError('JWT header 不是合法 JSON。', { cause: String(err) });
  }
  if (header.alg !== ALG) {
    throw new JwtError(`JWT alg 必須是 ${ALG}，不接受 token 自己宣稱其他演算法（防 algorithm confusion）。`, {
      claimedAlg: header.alg,
    });
  }
  const signingInput = `${headerSeg}.${payloadSeg}`;
  let signature;
  try {
    signature = Buffer.from(signatureSeg, 'base64url');
  } catch (err) {
    throw new JwtError('JWT 簽章欄位不是合法 base64url。', { cause: String(err) });
  }
  const ok = crypto.verify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature);
  if (!ok) {
    throw new JwtError('JWT 簽章驗證失敗（內容被竄改，或用錯公鑰）。');
  }
  let payload;
  try {
    payload = base64urlDecodeJson(payloadSeg);
  } catch (err) {
    throw new JwtError('JWT payload 不是合法 JSON。', { cause: String(err) });
  }
  return { header, payload };
}

/**
 * 在驗證簽章**之前**，先拆出 header/payload 好知道 `iss` 是誰、要拿哪把公鑰來驗——這是
 * JWT 驗證的正常流程（一定要先知道用誰的鑰匙才驗得下去），不是繞過安全檢查。函式名稱刻意
 * 標「Unverified」提醒呼叫端：**這個函式回傳的內容此時還沒被證明沒被竄改，只能拿來查
 * 「該用哪把公鑰」，不能當成可信資料使用**，真正可信的內容要等 verifyJwt() 通過之後才算數。
 */
function decodeUnverified(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new JwtError('不是合法的 JWT 格式（應為 header.payload.signature）。');
  }
  const [headerSeg, payloadSeg] = token.split('.');
  return { header: base64urlDecodeJson(headerSeg), payload: base64urlDecodeJson(payloadSeg) };
}

module.exports = { JwtError, signJwt, verifyJwt, decodeUnverified, ALG };
