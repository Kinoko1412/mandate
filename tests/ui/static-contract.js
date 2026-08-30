'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const indexPath = path.join(PUBLIC, 'index.html');
const legacyPath = path.join(PUBLIC, 'legacy.html');
const scriptPath = path.join(PUBLIC, 'js', 'case-workflow.js');
const stylePath = path.join(PUBLIC, 'css', 'case-workflow.css');
const serverPath = path.join(ROOT, 'server', 'index.js');
const gitignorePath = path.join(ROOT, '.gitignore');

let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.message}`);
  }
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function listFilesRecursively(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(entryPath) : [entryPath];
  });
}

function section(html, id) {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `missing section #${id}`);
  const openingEnd = html.indexOf('>', start);
  const nextRoleView = html.indexOf('class="role-view"', openingEnd + 1);
  return html.slice(start, nextRoleView < 0 ? html.length : nextRoleView);
}

const index = read(indexPath);
const legacy = read(legacyPath);
const script = read(scriptPath);
const style = read(stylePath);
const serverSource = read(serverPath);

check('root: 三角色與固定案件 hooks 存在', () => {
  for (const value of [
    'data-role="Supplier"',
    'data-role="Importer"',
    'data-role="Verifier"',
    'CASE-2026-001',
    'id="supplier-view"',
    'id="importer-view"',
    'id="verifier-view"',
    'id="audit-timeline"',
    'id="submit-case"',
    'id="create-grant"',
    'id="open-evidence"',
    'id="download-evidence"',
    'id="finding-form"',
  ]) {
    assert.ok(index.includes(value), `missing ${value}`);
  }
  assert.match(
    index,
    /class="field">\s*<label for="grant-evidence">[\s\S]*?<select id="grant-evidence">/
  );
  assert.match(
    index,
    /class="field">\s*<label for="grant-seconds">[\s\S]*?<input id="grant-seconds"/
  );
});

check('root: 信任邊界與 unavailable 文案存在', () => {
  // Demo-role 免責聲明 2026-08-26 從常駐橫幅改成右下角氣泡通知（showToast），
  // 文案現在活在 case-workflow.js 裡（頁面載入時呼叫一次），不是 index.html 的靜態
  // 標記——這裡改查 script 內容，斷言的意圖不變：這段文字一定要存在、不能被意外刪掉。
  assert.ok(script.includes('Demo role，不是真實認證'));
  assert.ok(script.includes('READY_FOR_VERIFIER 只代表具備送交查驗準備條件，不代表正式查驗完成或官方核准'));
  assert.ok(index.includes('尚未驗證'));
  assert.ok(index.includes('id="ready-disclaimer"'));
  assert.ok(!/CBAM Certified|Officially Approved|海關已核准/i.test(index));
});

check('Day4: 四幕控制台、Agent/Trust 按鈕與誠實文案存在', () => {
  for (const value of [
    'id="run-act-1"',
    'id="run-act-2"',
    'id="open-act-2-verifier"',
    'data-scenario="tampered_quantity"',
    'data-scenario="wrong_factor"',
    'data-scenario="proof_context_swap"',
    'id="run-act-4"',
    'id="run-agent-analysis"',
    'id="revalidate-trust"',
    '非 zk-SNARK',
    '不證明物理真實',
    '衍生分析，不是 Vault 原始底稿',
  ]) {
    assert.ok(index.includes(value), `missing Day4 hook/text ${value}`);
  }
  assert.ok(!index.includes('Agent 已驗證'));
  assert.ok(script.includes('Agent：預審已完成（不參與 Gate）'));
  assert.ok(script.includes("'/api/demo/attack'"));
  assert.ok(script.includes("'/api/demo/physical-reality'"));
});

check('root: favicon 使用內嵌資源，不會再請求缺少的 /favicon.ico', () => {
  assert.ok(index.includes('rel="icon"'));
  assert.ok(index.includes('href="data:image/svg+xml,'));
  assert.ok(!index.includes('href="favicon.ico"'));
});

check('root: 不使用 CDN 或外部字型', () => {
  assert.ok(!/https?:\/\//i.test(index));
  assert.ok(!/fonts\.googleapis|cdnjs|unpkg|jsdelivr/i.test(index));
});

check('Importer: 靜態區塊沒有敏感欄位 hooks', () => {
  const importer = section(index, 'importer-view');
  for (const forbidden of [
    'vaultRef',
    'contentBase64',
    'grant-token',
    'evidence-filename',
    'opened-content',
    'sourceFile',
    'sourcePage',
    'citations',
    'contentBase64',
    'BOM',
  ]) {
    assert.ok(!importer.includes(forbidden), `Importer section contains ${forbidden}`);
  }
});

check('RiskReport: Supplier/Verifier 完整欄位與 Importer 安全摘要 hooks 分離', () => {
  const supplier = section(index, 'supplier-view');
  const importer = section(index, 'importer-view');
  const verifier = section(index, 'verifier-view');
  assert.ok(supplier.includes('id="supplier-risk-report"'));
  assert.ok(verifier.includes('id="verifier-risk-report"'));
  assert.ok(importer.includes('id="importer-agent-summary"'));
  for (const value of [
    "'Facts'",
    "'抽取值與來源'",
    "'Missing evidence'",
    "'Discrepancies'",
    "'Next actions'",
    'entry.sourceFile',
    'entry.sourcePage',
    'entry.confidence',
    'entry.humanConfirmed',
  ]) {
    assert.ok(script.includes(value), `missing full RiskReport renderer ${value}`);
  }
  assert.ok(script.includes('renderAgentSafeSummary(caseRecord.agentSummary)'));
});

check('client: 可控文件與報告值使用安全 DOM API，不使用 innerHTML', () => {
  assert.ok(script.includes('textContent'));
  assert.ok(script.includes('replaceChildren'));
  assert.ok(!script.includes('.innerHTML'));
});

check('client: 所有 API 帶角色 header 且 token 不進 URL', () => {
  assert.ok(script.includes("'x-demo-role'"));
  assert.ok(script.includes("'x-vault-token'"));
  assert.ok(script.includes('sessionStorage'));
  assert.ok(!script.includes('console.log'));
  assert.ok(!/vaultToken\s*=|[?&](?:token|vaultToken)=/.test(script));
  assert.ok(script.includes("'x-vault-token': token"));
  assert.ok(script.includes("mode === 'download' ? '/download' : ''"));
});

check('client: Importer 直接呈現 server allocationStatus，不自行覆寫', () => {
  assert.ok(script.includes('shipment.allocationStatus'));
  assert.ok(!script.includes('trustServicesVerified ? shipment.allocationStatus'));
});

check('client: submit 無論成功失敗都重新載入 server role/state', () => {
  const submitSection = script.slice(
    script.indexOf('async function submitCase()'),
    script.indexOf('async function createGrant()')
  );
  assert.ok(submitSection.includes('finally'));
  assert.ok(submitSection.includes('await loadRole()'));
});

check('client: reset 依角色隱藏並保留權限說明', () => {
  assert.ok(index.includes('aria-describedby="reset-help"'));
  assert.ok(script.includes("$('reset-workflow').hidden = !supplier"));
  assert.ok(script.includes('無重置權限；請切換 Supplier'));
});

check('client: open/download 成功與 Grant 終態都清除 session token', () => {
  assert.ok(script.includes("['GRANT_INVALID', 'GRANT_EXPIRED', 'GRANT_REVOKED']"));
  assert.ok(script.includes('function clearVaultSession()'));
  assert.ok(script.includes("sessionStorage.removeItem(TOKEN_KEY)"));
  assert.ok(script.includes("sessionStorage.removeItem(GRANT_KEY)"));
  assert.ok(script.includes('URL.createObjectURL(blob)'));
});

check('styles: DRAFT/VERIFIER_REVIEW/ARCHIVED、loading、focus 與窄版 hooks 存在', () => {
  for (const value of [
    '[data-status="DRAFT"]',
    '[data-status="VERIFIER_REVIEW"]',
    '[data-status="ARCHIVED"]',
    'html[data-loading="true"]',
    'input:focus-visible',
    '@media (max-width: 640px)',
  ]) {
    assert.ok(style.includes(value), `missing style ${value}`);
  }
});

check('client: Shipment quantityUnit 缺漏時顯示 tonne 而非 undefined', () => {
  assert.ok(script.includes("shipment.quantityUnit || 'tonne'"));
});

check('legacy: 舊 UI 與所有相對資源仍可載入', () => {
  assert.ok(legacy.includes('js/app.js'));
  assert.ok(legacy.includes('css/app.css'));
  const refs = [...legacy.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !/^(?:https?:|#)/.test(ref));
  refs.forEach((ref) => {
    assert.ok(fs.existsSync(path.join(PUBLIC, ref)), `legacy resource missing: ${ref}`);
  });
});

check('assets: 新版 CSS 與 JS 檔案存在', () => {
  assert.ok(fs.existsSync(stylePath));
  assert.ok(index.includes('css/case-workflow.css'));
  assert.ok(index.includes('js/case-workflow.js'));
});

check('static server: 遞迴阻擋 public 備份且不依賴本機備份', () => {
  const leakedBackups = listFilesRecursively(PUBLIC)
    .filter((filePath) => path.basename(filePath).includes('.bak-'));
  assert.deepStrictEqual(
    leakedBackups,
    [],
    `public backups leaked: ${leakedBackups.map((filePath) => path.relative(PUBLIC, filePath)).join(', ')}`
  );
  assert.match(read(gitignorePath), /^_backups\/$/m);
  assert.match(read(gitignorePath), /^\*\.bak-\*$/m);
  assert.ok(serverSource.includes("path.basename(rel).includes('.bak-')"));
  assert.ok(serverSource.includes("sendJson(res, 404, { error: 'Not found' })"));
});

check('client: JavaScript 語法通過 node --check', () => {
  const result = spawnSync(process.execPath, ['--check', scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

console.log('');
if (failed > 0) {
  console.log(`RESULT: ${failed} failed`);
  process.exit(1);
}
console.log('RESULT: all PASS');
