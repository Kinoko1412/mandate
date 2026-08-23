'use strict';

/**
 * 固定 scale 的定點數運算——「Vibe Coding AI 完整工程規格與指令手冊」p.10：
 * 「後端、前端與 Circom 共用同一 scale，例如 10^6；不可混用浮點。」
 *
 * 這個檔案放在 packages/contracts/，因為 scale 常數必須是後端（carbon-core）、
 * 前端（apps/web）跟電路（circuits/，Circom 域裡沒有浮點數，只有整數）三邊共用
 * 的同一份事實來源，不是 carbon-core 私有的實作細節。
 */

const SCALE = 1_000_000; // 10^6，對應規格 p.10 範例

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} 必須是有限數字，收到 ${JSON.stringify(value)}`);
  }
}

/** 十進位數字 → 定點整數（四捨五入，避免累積浮點誤差）。 */
function toScaled(value) {
  assertFiniteNumber(value, 'toScaled(value)');
  return Math.round(value * SCALE);
}

/** 定點整數 → 十進位數字（僅供顯示／人類可讀輸出使用，不可再拿去參與定點運算）。 */
function fromScaled(scaledValue) {
  assertFiniteNumber(scaledValue, 'fromScaled(scaledValue)');
  return scaledValue / SCALE;
}

/**
 * 兩個「已經是 scale 過的整數」相乘，除回一次 SCALE，避免變成 SCALE^2。
 * 例：intensityScaled(1.80 × 10^6) × quantityScaled(100 × 10^6) / SCALE = allocatedEmissionsScaled(180 × 10^6)。
 * 溢位偵測：JS number 超過 Number.MAX_SAFE_INTEGER 就不保證精確，這裡在相乘前就檔掉。
 */
function mulScaled(aScaled, bScaled) {
  assertFiniteNumber(aScaled, 'mulScaled(aScaled)');
  assertFiniteNumber(bScaled, 'mulScaled(bScaled)');
  const product = aScaled * bScaled;
  if (!Number.isFinite(product) || Math.abs(product) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`mulScaled 中間值溢位：${aScaled} * ${bScaled}`);
  }
  return Math.round(product / SCALE);
}

function addScaled(aScaled, bScaled) {
  assertFiniteNumber(aScaled, 'addScaled(aScaled)');
  assertFiniteNumber(bScaled, 'addScaled(bScaled)');
  const sum = aScaled + bScaled;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(`addScaled 結果溢位：${aScaled} + ${bScaled}`);
  }
  return sum;
}

module.exports = {
  SCALE,
  toScaled,
  fromScaled,
  mulScaled,
  addScaled,
};
