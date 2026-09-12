'use strict';

/**
 * services/timestamp — 對外介面:requestTimestamp(payload) / verifyTimestamp(...)。
 *
 * 命題(見 docs/trust/RFC3161_TIMESTAMP_PLAN.md 第1節):對某個「關鍵事件」的規範化內容,
 * 向符合 RFC 3161 的 TSA 取得時戳權杖,證明「這份內容在某個時間點之前已經存在」。
 *
 * 這是**增量**能力,不是放行的必要條件——呼叫端(例如 server/trustAdapter.js)在拿到
 * GateResult 之後另外呼叫這裡,時戳失敗也不能讓 Gate 判定本身受影響(容錯設計見計畫文件第3節)。
 * 這個模組本身不知道、也不需要知道呼叫端在時戳什麼內容;canonical 化的責任在呼叫端。
 *
 * API 設計筆記(跟計畫文件初版草稿的差異,是實作時才發現的真實限制,誠實記在這裡):
 * 計畫文件原本設想 `requestTimestamp(hashHex)`,即呼叫端自己算好雜湊、這裡直接把雜湊值當
 * messageImprint 送出去。改成收「原始內容(payload)」而非「雜湊值」,原因是驗證端用的
 * pkijs `SignedData.verify()` 對 TSTInfo 型別內容有特殊處理:它會對呼叫端傳入的 `data`
 * 重新雜湊一次、比對 TSTInfo 內的 messageImprint,若直接餵已經算好的雜湊值進去,會變成
 * 「雜湊的雜湊」比對不上。改收原始內容,由這個模組統一負責雜湊,請求與驗證兩邊用同一套
 * 邏輯,不需要呼叫端自己管理雜湊演算法一致性,也避開這個 pkijs API 的隱性限制。
 */

const pkijs = require('pkijs');
const asn1js = require('asn1js');
const rfc3161 = require('./rfc3161');
const { getDefaultTsaUrl, getTsaProfile, TSA_PROFILES } = require('./tsaAdapter');

let engineConfigured = false;

function getWebCrypto() {
  const impl = globalThis.crypto;
  if (!impl || !impl.subtle) {
    throw new Error(
      '找不到 WebCrypto(globalThis.crypto.subtle)——Node 需要 18+(用 `node --experimental-global-webcrypto` 或直接 20+),Cloudflare Workers(workerd)原生支援。'
    );
  }
  return impl;
}

function ensurePkijsEngine() {
  if (engineConfigured) return;
  const cryptoImpl = getWebCrypto();
  pkijs.setEngine(
    'mandateTimestampEngine',
    new pkijs.CryptoEngine({ name: 'mandateTimestampEngine', crypto: cryptoImpl, subtle: cryptoImpl.subtle })
  );
  engineConfigured = true;
}

function toArrayBuffer(payload) {
  if (payload instanceof ArrayBuffer) return payload;
  if (ArrayBuffer.isView(payload)) {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }
  if (typeof payload === 'string') {
    return new TextEncoder().encode(payload).buffer;
  }
  throw new TypeError('payload 必須是 string、ArrayBuffer 或 TypedArray');
}

/**
 * @param {string|ArrayBuffer|Uint8Array} payload - 要時戳的規範化內容(不是雜湊值,見檔頭說明)
 * @param {{hashAlgo?: string, tsaProfileId?: string, tsaUrl?: string, timeoutMs?: number}} [options]
 * @returns {Promise<object>} 見下方各分支回傳形狀;`status` 三態:'ok'|'tsa_unreachable'|'tsa_error'
 */
async function requestTimestamp(payload, { hashAlgo = 'sha256', tsaProfileId, tsaUrl, timeoutMs = 15000 } = {}) {
  ensurePkijsEngine();
  const cryptoImpl = getWebCrypto();
  const digestName = rfc3161.WEBCRYPTO_DIGEST_NAMES[hashAlgo];
  if (!digestName) {
    throw new TypeError(`不支援的雜湊演算法:${hashAlgo}`);
  }

  const url = tsaUrl || (tsaProfileId ? getTsaProfile(tsaProfileId).url : getDefaultTsaUrl());
  const payloadBuffer = toArrayBuffer(payload);
  const digestBuffer = await cryptoImpl.subtle.digest(digestName, payloadBuffer);
  const reqDer = rfc3161.buildTimeStampReq(digestBuffer, { hashAlgo });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  let httpResp;
  try {
    httpResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: reqDer,
      signal: controller.signal,
    });
  } catch (err) {
    return { status: 'tsa_unreachable', tsaUrl: url, hashAlgo, error: err.message, requestedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!httpResp.ok) {
    return { status: 'tsa_error', tsaUrl: url, hashAlgo, httpStatus: httpResp.status, requestedAt: new Date().toISOString() };
  }

  const respBytes = new Uint8Array(await httpResp.arrayBuffer());
  let parsed;
  try {
    parsed = rfc3161.parseTimeStampResp(respBytes);
  } catch (err) {
    return { status: 'tsa_error', tsaUrl: url, hashAlgo, error: err.message, requestedAt: new Date().toISOString() };
  }

  return {
    status: 'ok',
    tsaUrl: url,
    hashAlgo,
    hashHex: bufferToHex(digestBuffer),
    tsToken: bufferToBase64(parsed.tokenDer),
    requestedAt: new Date().toISOString(),
  };
}

/**
 * @param {{tsToken: string, payload: string|ArrayBuffer|Uint8Array, hashAlgo?: string}} params
 * @returns {Promise<{valid: boolean, genTime: string|null, reasonCodes: string[]}>}
 */
async function verifyTimestamp({ tsToken, payload, hashAlgo = 'sha256' }) {
  ensurePkijsEngine();
  if (!tsToken) {
    return { valid: false, genTime: null, reasonCodes: ['MISSING_TS_TOKEN'] };
  }
  const payloadBuffer = toArrayBuffer(payload);
  const tokenDer = base64ToBuffer(tsToken);

  let asn1;
  try {
    asn1 = asn1js.fromBER(tokenDer);
    if (asn1.result.error) throw new Error(asn1.result.error);
  } catch (err) {
    return { valid: false, genTime: null, reasonCodes: ['TOKEN_PARSE_FAILED'] };
  }

  const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });

  try {
    const result = await signedData.verify({
      signer: 0,
      data: payloadBuffer,
      trustedCerts: [],
      checkChain: false,
      extendedMode: true,
    });
    return {
      valid: Boolean(result.signatureVerified),
      genTime: result.date instanceof Date ? result.date.toISOString() : null,
      reasonCodes: result.signatureVerified ? [] : ['SIGNATURE_INVALID'],
    };
  } catch (err) {
    return {
      valid: false,
      genTime: err && err.date instanceof Date ? err.date.toISOString() : null,
      reasonCodes: [err && err.message ? err.message : 'VERIFY_FAILED'],
    };
  }
}

function bufferToHex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function base64ToBuffer(b64) {
  return Buffer.from(b64, 'base64');
}

module.exports = { requestTimestamp, verifyTimestamp, TSA_PROFILES };
