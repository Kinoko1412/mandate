'use strict';

/**
 * services/agent/ocr.js — 用本機 Tesseract（CLI，`tesseract --version` 確認過
 * v5.5.0 已安裝）把圖片證據轉成文字，餵給 LLM 抽取器（services/agent/llmExtract.js）。
 *
 * 設計取捨：OCR 跟「LLM 結構化抽取」故意分成兩個獨立步驟，不是丟圖片給有 vision 能力
 * 的模型一次做完——理由：①不用去賭 `openai/gpt-5-mini` 到底支不支援圖片輸入（沒查證過
 * 就假設支援风险高）②Tesseract 本機跑、免費、確定性，不吃 LLM 預算③OCR 產生的雜訊文字
 * 剛好也是很真實的「LLM 抽取要比正則好在哪」的示範——正則沒辦法處理 OCR 的雜訊，LLM 可以。
 *
 * 只在 Node 環境使用（agentAdapter 目前只在 server/ 端跑，這個模組沒有被要求在
 * Cloudflare Workers 執行——Workers 沒有子行程可以呼叫 tesseract CLI）。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class OcrError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'OcrError';
    this.details = details || null;
  }
}

/**
 * @param {Buffer} imageBuffer - 圖片原始 bytes（png/jpeg）
 * @param {object} [options]
 * @param {string} [options.lang] - tesseract 語言參數，預設 'eng+chi_tra'
 * @returns {string} OCR 出來的文字（可能含雜訊，未經任何清理）
 */
function ocrImageBuffer(imageBuffer, options = {}) {
  const lang = options.lang || 'eng+chi_tra';
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `mandate-ocr-${crypto.randomBytes(8).toString('hex')}.png`);
  fs.writeFileSync(tmpFile, imageBuffer);
  try {
    const result = spawnSync('tesseract', [tmpFile, 'stdout', '-l', lang], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error) {
      throw new OcrError('無法呼叫本機 tesseract（未安裝或不在 PATH）。', { cause: String(result.error) });
    }
    if (result.status !== 0) {
      throw new OcrError('tesseract 執行失敗。', { status: result.status, stderr: result.stderr });
    }
    return result.stdout || '';
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

module.exports = { OcrError, ocrImageBuffer };
