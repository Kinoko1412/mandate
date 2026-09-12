'use strict';

/**
 * services/timestamp/rfc3161 — 低階 ASN.1:建構 TimeStampReq、解析 TimeStampResp。
 *
 * 用 @peculiar/asn1-tsp 系列套件(純 JS,無原生/WASM 依賴)做 DER 編解碼,不手刻 ASN.1——
 * 跟 zk 電路(`services/proof/zk.js`)刻意直接讀官方演算法照抄不同,RFC 3161 是通用協定,
 * 手刻 ASN.1 沒有額外價值,只有出錯風險。
 */

const { AsnConvert, OctetString } = require('@peculiar/asn1-schema');
const { TimeStampReq, TimeStampResp, MessageImprint } = require('@peculiar/asn1-tsp');
const { AlgorithmIdentifier } = require('@peculiar/asn1-x509');

const HASH_ALGO_OIDS = Object.freeze({
  sha256: '2.16.840.1.101.3.4.2.1',
});

const WEBCRYPTO_DIGEST_NAMES = Object.freeze({
  sha256: 'SHA-256',
});

// RFC 3161 PKIStatus:0=granted、1=grantedWithMods 都代表拿到可用的 token;其餘一律視為失敗。
const GRANTED_STATUSES = new Set([0, 1]);

function assertSupportedHashAlgo(hashAlgo) {
  if (!HASH_ALGO_OIDS[hashAlgo]) {
    throw new TypeError(`不支援的雜湊演算法:${hashAlgo}(目前只支援:${Object.keys(HASH_ALGO_OIDS).join(', ')})`);
  }
}

/**
 * @param {ArrayBuffer} digestBuffer - 已經算好的雜湊值(不是原始資料)
 * @param {{hashAlgo?: string, certReq?: boolean}} [options]
 * @returns {ArrayBuffer} DER 編碼的 TimeStampReq
 */
function buildTimeStampReq(digestBuffer, { hashAlgo = 'sha256', certReq = true } = {}) {
  assertSupportedHashAlgo(hashAlgo);
  const req = new TimeStampReq({
    version: 1,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithm: HASH_ALGO_OIDS[hashAlgo] }),
      hashedMessage: new OctetString(digestBuffer),
    }),
    certReq,
  });
  return AsnConvert.serialize(req);
}

/**
 * @param {ArrayBuffer|Uint8Array} responseBytes - TSA 回應的原始 DER bytes
 * @returns {{status: number, tokenDer: ArrayBuffer}}
 */
function parseTimeStampResp(responseBytes) {
  let resp;
  try {
    resp = AsnConvert.parse(responseBytes, TimeStampResp);
  } catch (err) {
    throw new Error(`TimeStampResp 解析失敗(不是合法的 DER 或不符合 RFC 3161 結構):${err.message}`);
  }
  const status = resp.status.status;
  if (!GRANTED_STATUSES.has(status) || !resp.timeStampToken) {
    const failInfo = resp.status.failInfo ? `,failInfo=${resp.status.failInfo}` : '';
    throw new Error(`TSA 拒絕核發時戳(PKIStatus=${status}${failInfo})`);
  }
  return { status, tokenDer: AsnConvert.serialize(resp.timeStampToken) };
}

module.exports = {
  HASH_ALGO_OIDS,
  WEBCRYPTO_DIGEST_NAMES,
  buildTimeStampReq,
  parseTimeStampResp,
};
