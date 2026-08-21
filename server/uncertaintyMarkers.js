'use strict';

/**
 * 純確定性規則（不呼叫 LLM）：對照常見標準寫法，抓出 PCF payload 裡「不是
 * 明確標示、AI／系統需要推測換算或對應」的欄位片段，回傳可插入推理摘要的
 * 不確定點清單。只標「判斷為推測」的部分（呼應設計文件第 16 節原則 1），
 * 不是每個欄位都標，否則會變成滿版底線、失去指引作用。
 */

const UNIT_STANDARD = /^(t\s?co2e?|tco2e|公噸|噸co2e?|metric\s?ton)/i;
const BOUNDARY_STANDARD = /^(scope\s?[123]|gate-to-gate|cradle-to-gate|cradle-to-grave)/i;

function detectUncertainPoints(input) {
  const points = [];
  if (!input || typeof input !== 'object') return points;

  const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
  if (unit && !UNIT_STANDARD.test(unit)) {
    points.push({
      field: 'unit',
      snippet: unit,
      reason: `供應商欄位填的是「${unit}」，不是標準寫法（如 tCO2e／公噸），已依常見寫法換算，但無法 100% 確定基準一致。`,
    });
  }

  const boundary = typeof input.boundary === 'string' ? input.boundary.trim() : '';
  if (boundary && !BOUNDARY_STANDARD.test(boundary)) {
    points.push({
      field: 'boundary',
      snippet: boundary,
      reason: `原文僅寫「${boundary}」，未明確對應到 Scope 1/2/3 分類，已依上下文推測分類，實際範圍建議人工再確認。`,
    });
  }

  return points;
}

module.exports = { detectUncertainPoints };
