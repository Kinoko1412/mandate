'use strict';

const CASE_ID = 'CASE-2026-001';
const VERIFIER_ID = 'demo-verifier-001';
const TOKEN_KEY = 'mandate.workflow.vaultToken';
const GRANT_KEY = 'mandate.workflow.grant';
const REQUIRED_TYPES = [
  'electricity_bill',
  'fuel_ledger',
  'production_report',
  'precursor_list',
];
const REQUIRED_TYPE_LABELS = {
  electricity_bill: '電費單',
  fuel_ledger: '燃料紀錄',
  production_report: '產量表',
  precursor_list: '前驅物清單',
};
const DEMO_EVIDENCE = [
  {
    type: 'electricity_bill',
    filename: 'demo-electricity-2026.json',
    entries: [
      { field: 'electricityMWh', value: 100, unit: 'MWh', sourcePage: 2, confidence: 0.99, humanConfirmed: true },
    ],
  },
  {
    type: 'fuel_ledger',
    filename: 'demo-fuel-2026.json',
    entries: [
      { field: 'fuelGJ', value: 80, unit: 'GJ', sourcePage: 3, confidence: 0.98, humanConfirmed: true },
    ],
  },
  {
    type: 'production_report',
    filename: 'demo-production-2026.json',
    entries: [
      { field: 'productionTonnes', value: 200, unit: 'tonne', sourcePage: 4, confidence: 0.99, humanConfirmed: true },
    ],
  },
  {
    type: 'precursor_list',
    filename: 'demo-precursor-2026.json',
    entries: [
      { field: 'precursorTonnes', value: 150, unit: 'tonne', sourcePage: 5, confidence: 0.97, humanConfirmed: true },
    ],
  },
];

const ERROR_GUIDANCE = {
  DEMO_ROLE_REQUIRED: ['尚未選定 Demo 角色。', '請切換 Supplier、Importer 或 Verifier 後重試。'],
  CASE_NOT_FOUND: ['目前角色無法存取這個案件。', '確認 Demo 角色與固定案件是否相符。'],
  ROLE_FORBIDDEN: ['目前角色沒有這項操作權限。', '切回具備權限的 Demo 角色。'],
  EVIDENCE_ALREADY_EXISTS: ['同名 evidence 已存在，系統未覆寫。', '更換檔名，或直接使用 Evidence Index 既有項目。'],
  EVIDENCE_MISSING: ['案件仍有缺件或尚未人工確認的 evidence。', '補齊四種類型並逐筆人工確認。'],
  HUMAN_CONFIRMATION_REQUIRED: ['尚未明確完成人工確認。', '勾選確認動作後重新送出。'],
  INVALID_FILENAME: ['檔名格式不符合安全限制。', '使用 1–128 字元且不含路徑的檔名。'],
  MEDIA_TYPE_NOT_ALLOWED: ['這個媒體類型不在允許清單。', '改用 PDF、JSON、純文字、PNG 或 JPEG。'],
  INVALID_EVIDENCE_METADATA: ['Evidence metadata 缺漏或類型不符。', '檢查 type、涵蓋期間與來源。'],
  INVALID_BASE64: ['內容無法安全編碼。', '重新輸入純文字 Demo 內容後再試。'],
  EVIDENCE_TOO_LARGE: ['Evidence 超過 Demo 上傳大小限制。', '將文件縮小至 512 KiB 以下。'],
  EVIDENCE_NOT_FOUND: ['找不到指定 evidence，或目前角色不可操作。', '重新整理 Evidence Index 並確認角色。'],
  INVALID_GRANT_SUBJECT: ['Grant 未綁定固定 Demo Verifier。', '使用系統預設的 Demo Verifier。'],
  EVIDENCE_IDS_REQUIRED: ['Grant 尚未指定 evidence。', '先在 Evidence Index 選一筆 evidence。'],
  INVALID_GRANT_EXPIRY: ['Grant 有效期不符限制。', '設定 10–290 秒後重建。'],
  GRANT_NOT_FOUND: ['找不到可撤銷的 Grant。', '重新建立短效 Grant。'],
  VAULT_ACCESS_DENIED: ['Vault Grant 無效或已失效。', '請 Supplier 重新建立綁定此 evidence 的短效 Grant。'],
  WEBAUTHN_NOT_SUPPORTED: ['此瀏覽器/裝置不支援 Vault 生物辨識加密。', '換用較新版 Chrome/Edge/Safari，或使用有指紋/臉部辨識的裝置。'],
  WEBAUTHN_PRF_UNSUPPORTED: ['裝置的驗證器不支援 PRF 擴充。', '換一個較新的裝置或瀏覽器再試一次。'],
  WEBAUTHN_USER_CANCELLED: ['已取消裝置驗證。', '按「重試」再次觸發指紋/臉部辨識。'],
  WEBAUTHN_FAILED: ['裝置驗證未完成。', '確認裝置的指紋/臉部辨識功能正常後再試一次。'],
  WEBAUTHN_INVALID_DOMAIN: ['目前網址不支援 Vault 裝置驗證。', '改用 localhost（而非 127.0.0.1）或正式部署網域再試一次。'],
  VAULT_KEY_NOT_REGISTERED: ['此裝置尚未註冊 Vault 金鑰，無法解密。', '請先點擊「註冊 Vault 裝置」。'],
  INVALID_VAULT_KEY_PAYLOAD: ['Vault 金鑰註冊資料不完整。', '重新執行註冊流程。'],
  INVALID_VAULT_ENCRYPTION_PAYLOAD: ['上傳的加密資料不完整。', '重新整理頁面後再次上傳。'],
  GRANT_INVALID: ['Grant 無效或已使用，底稿未開啟。', '請 Supplier 建立新的短效 Grant，再重試一次。'],
  GRANT_EXPIRED: ['Grant 已過期，底稿未開啟。', '請 Supplier 建立新的短效 Grant。'],
  GRANT_REVOKED: ['Grant 已撤銷，底稿未開啟。', '請 Supplier 建立新的短效 Grant。'],
  INVALID_FINDING: ['Finding 的摘要或嚴重度不完整。', '填寫摘要並選 info、warning 或 blocking。'],
  UNKNOWN_UNIT: ['碳排核心不認得輸入單位。', '改用 canonical contract 定義的單位。'],
  ALLOCATION_EXCEEDS_PRODUCTION: ['批次分配超過年度可用產量。', '降低批次數量或更正年度產量。'],
  CONTRACT_VALIDATION_FAILED: ['資料不符合 canonical contract。', '依 reason code 修正必填欄位與型別。'],
  SERVICE_UNAVAILABLE: ['Proof 或 Gate 尚未驗證。', '保留 METHOD_REVIEW，待 Proof 與 Gate 接妥後再重驗；Agent 不參與 readiness。'],
  TRUST_ADAPTER_FAILURE: ['Trust Engine 暫時無法完成檢查。', '稍後按「重驗 Proof / Gate」重試；案件不會被誤標為 READY。'],
  AGENT_ANALYSIS_FAILED: ['Evidence Agent 預審暫時失敗。', '可重試預審；Proof / Gate 與 readiness 不受 Agent 失敗影響。'],
  MEDIA_TYPE_NOT_SUPPORTED_FOR_PREVIEW: ['即時預覽只支援 PNG/JPEG 圖片或純文字內容。', 'PDF 請改貼文字內容，或改用截圖／照片上傳。'],
  PROMPT_INJECTION_DETECTED: ['文件內容疑似含指令注入，已拒絕讀取。', '請確認文件內容後再重新上傳。'],
  EVIDENCE_JSON_INVALID: ['Synthetic evidence 無法解析。', '重置 Demo 後重新載入固定四份文件。'],
  DEMO_SCENARIO_INVALID: ['攻擊情境不在 server allowlist。', '請使用控制台提供的三個固定情境。'],
  CLIPBOARD_UNAVAILABLE: ['瀏覽器未允許剪貼簿操作。', '可直接切換 Verifier，token 已保存在本次 session。'],
  INVALID_JSON: ['送出的資料格式無效。', '重新載入頁面後再試。'],
  INTERNAL_ERROR: ['伺服器暫時無法完成操作。', '稍後重試；若持續發生，檢查 server 狀態。'],
  NETWORK_UNAVAILABLE: ['無法連上本機 API。', '確認 npm start 正在執行，然後重新整理。'],
  GOOGLE_OAUTH_NOT_CONFIGURED: ['伺服器尚未設定 Google OAuth 憑證。', '請聯絡負責部署的人設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET。'],
  GOOGLE_ORIGIN_UNKNOWN: ['無法判斷目前網址。', '重新整理頁面後再試一次。'],
  GOOGLE_TOKEN_EXCHANGE_FAILED: ['Google 授權交換失敗。', '請重新點擊「連接 Google 帳號」再試一次。'],
  GOOGLE_TOKEN_REFRESH_FAILED: ['Google 授權已失效。', '請重新連接 Google 帳號。'],
  GOOGLE_NOT_CONNECTED: ['尚未連接 Google 帳號。', '點擊「連接 Google 帳號」完成授權後再試一次。'],
  GOOGLE_REAUTH_REQUIRED: ['Google 授權已過期。', '請重新連接 Google 帳號。'],
  GMAIL_SEND_FAILED: ['Gmail 寄送失敗。', '確認收件人格式正確，或稍後重試。'],
  CALENDAR_EVENT_FAILED: ['Google 行事曆建立提醒失敗。', '稍後重試；若持續發生，重新連接 Google 帳號。'],
  NO_MISSING_EVIDENCE: ['此案件目前沒有缺件。', '不需要補件通知。'],
  INVALID_NOTIFICATION_PAYLOAD: ['通知內容不完整或格式錯誤。', '確認收件人 Email 與內容欄位皆已填寫。'],
};

const state = {
  role: 'Supplier',
  actor: null,
  caseRecord: null,
  evidence: [],
  grant: readGrant(),
  busy: false,
  // 記錄每個 required type 最近一次上傳失敗的原因，直到該 type 下一次上傳成功為止；
  // 驅動必要文件 stepper 的紅色「有問題」節點與抽屜裡的失敗卡片，兩者都是同一份資料。
  uploadIssues: {},
};

function $(id) {
  return document.getElementById(id);
}

function readGrant() {
  try {
    return JSON.parse(sessionStorage.getItem(GRANT_KEY) || 'null');
  } catch {
    sessionStorage.removeItem(GRANT_KEY);
    return null;
  }
}

function saveGrant(grant) {
  state.grant = grant;
  if (grant) sessionStorage.setItem(GRANT_KEY, JSON.stringify(grant));
  else sessionStorage.removeItem(GRANT_KEY);
}

function setToken(token) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

async function api(path, options = {}) {
  const headers = {
    'x-demo-role': options.role || state.role,
    ...(options.headers || {}),
  };
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw { code: 'NETWORK_UNAVAILABLE', message: '無法連線至 workflow API。', details: null };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = { code: 'INTERNAL_ERROR', message: '伺服器回應格式無法讀取。', details: null };
  }
  if (!response.ok) throw body;
  return body;
}

function setBusy(busy) {
  state.busy = busy;
  document.documentElement.setAttribute('aria-busy', String(busy));
  document.documentElement.dataset.loading = String(busy);
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
  if (!busy && state.role === 'Supplier') {
    renderSupplierEvidence();
    renderGrantControls();
    renderRequiredStepper();
    renderEvidenceDrawer();
  }
  if (!busy) applyRoleControls();
}

function applyRoleControls() {
  const supplier = state.role === 'Supplier';
  $('reset-workflow').hidden = !supplier;
  $('reset-workflow').disabled = !supplier || state.busy;
  $('reset-help').textContent = supplier
    ? '僅 Supplier 可重置 Demo。'
    : `${state.role} 無重置權限；請切換 Supplier。`;
}

async function runAction(action, successMessage, onError) {
  clearMessages();
  setBusy(true);
  try {
    const result = await action();
    if (successMessage) showNotice(successMessage);
    return result;
  } catch (error) {
    showError(error);
    if (onError) onError(error);
    return null;
  } finally {
    setBusy(false);
  }
}

/**
 * WebAuthn 提示框要等使用者真的去摸指紋/看鏡頭，比一般 API 呼叫慢得多——單靠
 * runAction() 的通用忙碌狀態（游標變 progress、按鈕變灰）不夠明確，使用者容易懷疑
 * 「是不是當機了」。這裡把觸發生物辨識的按鈕文字換成「請完成裝置驗證…」，動作結束
 * 後（不管成功失敗）換回原文字。只給真的會跳出 WebAuthn 提示框的按鈕用。
 */
async function runActionWithDeviceVerification(button, action, successMessage) {
  const originalText = button.textContent;
  button.textContent = '請完成裝置驗證…';
  try {
    return await runAction(action, successMessage);
  } finally {
    button.textContent = originalText;
  }
}

function clearMessages() {
  $('notice').hidden = true;
  $('error-panel').hidden = true;
}

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  $('notice').tabIndex = -1;
  $('notice').focus();
}

function errorPresentation(error) {
  const code = String(error && (error.code || error.reasonCode) || 'INTERNAL_ERROR');
  let guidance = ERROR_GUIDANCE[code] || [
    error && error.message ? error.message : '操作未完成。',
    '依 reason code 檢查輸入後再試。',
  ];

  if (code === 'VAULT_ACCESS_DENIED' && state.grant) {
    if (state.grant.revoked) {
      guidance = ['Grant 已由 Supplier 撤銷，Vault 拒絕存取。', '請 Supplier 建立新的短效 Grant。'];
    } else if (state.grant.consumed) {
      guidance = ['一次性 Grant 已被使用，不能重用。', '請 Supplier 建立新的短效 Grant。'];
    } else if (Date.parse(state.grant.expiresAt) <= Date.now()) {
      guidance = ['Grant 已過期，Vault 拒絕存取。', '請 Supplier 建立新的短效 Grant。'];
    }
  }

  return { code, reason: guidance[0], next: guidance[1] };
}

function showError(error) {
  const presentation = errorPresentation(error);
  $('error-title').textContent = '操作未完成';
  $('error-message').textContent = presentation.reason;
  $('error-code').textContent = `reason code: ${presentation.code}`;
  $('error-next').textContent = `下一步：${presentation.next}`;
  $('error-panel').hidden = false;
  $('error-panel').focus();
}

function metric(label, value, note = '') {
  const article = document.createElement('article');
  article.className = 'metric';
  const labelNode = document.createElement('span');
  labelNode.textContent = label;
  const valueNode = document.createElement('strong');
  valueNode.textContent = value == null ? '—' : String(value);
  article.append(labelNode, valueNode);
  if (note) {
    const noteNode = document.createElement('span');
    noteNode.textContent = note;
    article.append(noteNode);
  }
  return article;
}

function replaceChildren(target, children) {
  target.replaceChildren(...children);
}

function createTable(headers, rows) {
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '目前沒有資料。';
    return empty;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headers.forEach((header) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = header;
    headerRow.append(th);
  });
  thead.append(headerRow);
  const tbody = document.createElement('tbody');
  rows.forEach((cells) => {
    const row = document.createElement('tr');
    cells.forEach((value) => {
      const td = document.createElement('td');
      if (value instanceof Node) td.append(value);
      else td.textContent = value == null ? '—' : String(value);
      row.append(td);
    });
    tbody.append(row);
  });
  table.append(thead, tbody);
  return table;
}

function renderHeader(caseRecord) {
  $('case-title').textContent = caseRecord.title;
  $('case-meta').textContent = `${caseRecord.caseId} · CN ${caseRecord.cnCode} · Demo data`;
  $('case-status').textContent = caseRecord.status;
  $('case-status').dataset.status = caseRecord.status;
  $('ready-disclaimer').textContent =
    caseRecord.readyDisclaimer || '具備送交查驗準備條件，不代表正式查驗完成。';
}

function renderServices(services = {}) {
  const chips = ['agent', 'proof', 'gate'].map((name) => {
    const service = services[name] || { status: 'unavailable', verification: 'not_verified' };
    const chip = document.createElement('span');
    chip.className = 'service-chip';
    chip.dataset.state = service.status;
    const label = name[0].toUpperCase() + name.slice(1);
    if (name === 'agent') {
      if (service.execution === 'executed') {
        chip.textContent = 'Agent：預審已完成（不參與 Gate）';
      } else if (service.execution === 'failed') {
        chip.textContent = 'Agent：預審失敗，可重試（不參與 Gate）';
      } else {
        chip.textContent = `Agent：尚未執行（${service.status}，不參與 Gate）`;
      }
    } else {
      chip.textContent =
        service.status === 'available' && service.verification === 'verified'
          ? `${label}：已驗證（Demo commitment，非 zk-SNARK）`
          : `${label}：尚未驗證（${service.status}）`;
    }
    return chip;
  });
  replaceChildren($('service-statuses'), chips);
}

function textList(items, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = emptyText;
    return empty;
  }
  const list = document.createElement('ul');
  items.forEach((value) => {
    const item = document.createElement('li');
    item.textContent = String(value);
    list.append(item);
  });
  return list;
}

function reportSection(title, child) {
  const section = document.createElement('section');
  section.className = 'report-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.append(heading, child);
  return section;
}

function renderRiskReport(target, report) {
  if (!report) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '尚未執行 Evidence Agent 預審。';
    replaceChildren(target, [empty]);
    return;
  }
  const summary = report.summary || {};
  const overview = document.createElement('p');
  overview.className = 'report-overview';
  overview.textContent =
    `${report.reviewStatus} · ${report.modelVersion} · ${report.reportId}`;

  const entryRows = (report.entries || []).map((entry) => [
    entry.field,
    entry.value,
    entry.unit,
    entry.sourceFile,
    entry.sourcePage,
    Number(entry.confidence).toFixed(2),
    entry.humanConfirmed ? '是' : '否',
    entry.eligibleForCalculation ? '可供勾稽' : '待人工確認',
  ]);
  const findingRows = (report.findings || []).map((finding) => [
    finding.reasonCode,
    finding.severity,
    finding.message,
  ]);
  const missingRows = (report.missingEvidence || []).map((item) => [
    item.requiredEvidence,
    item.coveredPeriod,
    item.missingPeriod,
    item.requestedAction,
  ]);
  const discrepancyRows = (report.discrepancies || []).map((item) => [
    item.ruleId,
    item.leftValue,
    item.rightValue,
    item.difference,
    item.severity,
    (item.possibleExplanations || []).join('；'),
  ]);
  const citationRows = (report.citations || []).map((item) => [
    item.reasonCode,
    item.sourceFile,
    item.sourcePage,
  ]);

  replaceChildren(target, [
    overview,
    reportSection('Facts', textList(summary.facts, '尚無 facts。')),
    reportSection(
      '抽取值與來源',
      createTable(
        ['Field', 'Value', 'Unit', 'Source file', 'Page', 'Confidence', 'Human confirmed', 'Eligibility'],
        entryRows
      )
    ),
    reportSection(
      'Findings',
      createTable(['Reason code', 'Severity', 'Message'], findingRows)
    ),
    reportSection(
      'Missing evidence',
      createTable(['Required', 'Covered', 'Missing', 'Requested action'], missingRows)
    ),
    reportSection(
      'Discrepancies',
      createTable(['Rule', 'Left', 'Right', 'Difference', 'Severity', 'Possible explanations'], discrepancyRows)
    ),
    reportSection('Open issues', textList(summary.openIssues, '尚無 open issue。')),
    reportSection('Next actions', textList(summary.nextActions, '交由查驗員進行後續專業檢視。')),
    reportSection(
      'Citations',
      createTable(['Reason code', 'Source file', 'Page'], citationRows)
    ),
  ]);
}

function renderAgentSafeSummary(summary) {
  const target = $('importer-agent-summary');
  if (!summary) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '尚未產生可供 Importer 查看之安全摘要。';
    replaceChildren(target, [empty]);
    return;
  }
  const counts = summary.counts || {};
  replaceChildren(target, [
    document.createTextNode(`${summary.reviewStatus} · ${summary.modelVersion}`),
    reportSection('安全計數', textList([
      `findings: ${counts.findings || 0}`,
      `missing evidence: ${counts.missingEvidence || 0}`,
      `discrepancies: ${counts.discrepancies || 0}`,
      `open issues: ${counts.openIssues || 0}`,
    ], '尚無計數。')),
    reportSection('Reason codes', textList(summary.reasonCodes, '尚無 reason code。')),
    reportSection('Next actions', textList(summary.nextActions, '交由查驗員後續檢視。')),
  ]);
}

function renderSupplier(caseRecord) {
  const year = caseRecord.installationYear || {};
  const annual = caseRecord.carbon && caseRecord.carbon.annual || {};
  replaceChildren($('installation-cards'), [
    metric('Installation', year.installationId),
    metric('Reporting year', year.reportingYear),
    metric('年度產量', `${year.productionTonnes ?? '—'} ${year.productionUnit || ''}`),
    metric('年度強度', `${annual.intensity ?? '—'} ${annual.intensityUnit || ''}`, 'Demo data'),
  ]);
  state.evidence = Array.isArray(caseRecord.evidence) ? caseRecord.evidence : [];
  renderSupplierEvidence();
  renderGrantControls();
  renderRiskReport($('supplier-risk-report'), caseRecord.riskReport);
  renderRequiredStepper();
  renderEvidenceDrawer();
  renderExecOverview(caseRecord);
  checkStaleCaseNudge(caseRecord);
}

/**
 * 「主動照看」的務實版本——2026-08-26 隊長裁示落地，但要老實面對限制：這個 Workers app
 * 沒有背景排程、沒有推播管道（沒有 email／WebSocket／Push API），不可能做到「使用者不在
 * 畫面前也會收到通知」那種真正的背景主動提醒。這裡做的是誠實可行的版本：使用者一打開
 * Supplier 畫面，如果案件建立後已經過了一段時間、必要文件卻還沒到齊，AI 主動先開口講，
 * 不用使用者先問。同一次瀏覽只提醒一次（用 staleCaseNudgeShown 擋），不會每次 loadRole()
 * 刷新都重複講一次。
 */
let staleCaseNudgeShown = false;
const STALE_CASE_DAYS = 2;
function checkStaleCaseNudge(caseRecord) {
  if (staleCaseNudgeShown || !caseRecord || !caseRecord.createdAt) return;
  const uploadedTypes = new Set(state.evidence.map((item) => item.type));
  const missingCount = REQUIRED_TYPES.length - REQUIRED_TYPES.filter((type) => uploadedTypes.has(type)).length;
  if (missingCount <= 0) return;
  const daysSince = (Date.now() - Date.parse(caseRecord.createdAt)) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(daysSince) || daysSince < STALE_CASE_DAYS) return;
  staleCaseNudgeShown = true;
  const text = `這個案件建立後已經 ${Math.floor(daysSince)} 天了，必要文件還缺 ${missingCount} 種，要不要現在補上？`;
  appendChatMessage({ role: 'ai', text });
  pushChatHistory('assistant', text);

  const actions = document.createElement('div');
  actions.className = 'ew-chat-ai-actions';
  const draftBtn = document.createElement('button');
  draftBtn.type = 'button';
  draftBtn.className = 'button secondary';
  draftBtn.textContent = '草擬補件通知（Email + 行事曆提醒）';
  draftBtn.addEventListener('click', async () => {
    draftBtn.disabled = true;
    await requestNotificationDraft();
  });
  actions.appendChild(draftBtn);
  appendChatMessage({ role: 'ai', node: actions });
}

/**
 * Google OAuth 通知串接（2026-08-27 設計定案）——核心原則跟 commit_cbam_draft 的人審精神
 * 一致：AI 只能「問」跟「草擬」，實際寄信/寫入行事曆一定要人類按下確認鈕才會發生。這裡是
 * 前端那一半：草擬（呼叫 /api/cases/:id/notify/draft，純文字、不碰 Google）→ 顯示可編輯的
 * 草稿 → 使用者按「確認寄出」/「確認建立提醒」才真的呼叫會動用 Google API 的端點。
 */
function buildGoogleConnectNode() {
  const wrap = document.createElement('div');
  const status = document.createElement('p');
  status.className = 'ew-chat-ai-head';
  status.textContent = '正在確認 Google 帳號連接狀態…';
  wrap.appendChild(status);
  (async () => {
    let result;
    try {
      result = await api('/api/notify/google/status');
    } catch {
      status.textContent = '無法確認 Google 帳號連接狀態，請稍後再試。';
      return;
    }
    if (result.connected) {
      status.textContent = `✅ Google 帳號已連接（${new Date(result.connectedAt).toLocaleString('zh-TW')}），可以確認寄出。`;
      return;
    }
    status.textContent = '⚠ 尚未連接 Google 帳號，需要先連接才能真的寄出 Email／建立行事曆提醒。';
    const connectBtn = document.createElement('button');
    connectBtn.type = 'button';
    connectBtn.className = 'button secondary';
    connectBtn.textContent = '連接 Google 帳號';
    connectBtn.addEventListener('click', async () => {
      const auth = await runAction(() => api('/api/oauth/google/authorize'));
      if (auth && auth.authorizeUrl) window.location.href = auth.authorizeUrl;
    });
    wrap.appendChild(connectBtn);
  })();
  return wrap;
}

function buildNotificationDraftNode(draft) {
  const wrap = document.createElement('div');

  const head = document.createElement('p');
  head.className = 'ew-chat-ai-head';
  head.textContent = `已草擬補件通知：缺「${draft.missingLabels.join('、')}」。以下內容由 AI 草擬，確認前可自行修改。`;
  wrap.appendChild(head);
  wrap.appendChild(buildGoogleConnectNode());

  const toLabel = document.createElement('label');
  toLabel.className = 'ew-chat-ai-head';
  toLabel.textContent = '收件人 Email：';
  toLabel.style.display = 'block';
  const toInput = document.createElement('input');
  toInput.type = 'email';
  toInput.placeholder = 'supplier@example.com';
  toInput.style.width = '100%';
  toInput.style.boxSizing = 'border-box';
  toLabel.appendChild(toInput);
  wrap.appendChild(toLabel);

  const subjectInput = document.createElement('input');
  subjectInput.type = 'text';
  subjectInput.value = draft.email.subject;
  subjectInput.style.width = '100%';
  subjectInput.style.boxSizing = 'border-box';
  wrap.appendChild(subjectInput);

  const bodyTextarea = document.createElement('textarea');
  bodyTextarea.value = draft.email.bodyText;
  bodyTextarea.rows = 6;
  bodyTextarea.style.width = '100%';
  bodyTextarea.style.boxSizing = 'border-box';
  wrap.appendChild(bodyTextarea);

  const emailActions = document.createElement('div');
  emailActions.className = 'ew-chat-ai-actions';
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'button';
  sendBtn.textContent = '確認寄出 Email';
  emailActions.appendChild(sendBtn);
  wrap.appendChild(emailActions);

  sendBtn.addEventListener('click', async () => {
    const to = toInput.value.trim();
    if (!to) {
      showError({ code: 'INVALID_NOTIFICATION_PAYLOAD', message: '請先填寫收件人 Email。' });
      return;
    }
    const result = await runAction(
      () =>
        api(`/api/cases/${CASE_ID}/notify/email`, {
          method: 'POST',
          body: { confirm: true, to, subject: subjectInput.value, bodyText: bodyTextarea.value },
        }),
      'Email 已寄出。'
    );
    if (result) {
      emailActions.replaceChildren();
      const done = document.createElement('p');
      done.className = 'ew-chat-ai-head';
      done.textContent = `已寄出給 ${to}。`;
      wrap.appendChild(done);
    }
  });

  const reminderAt = new Date(draft.calendarReminder.startIso);
  const calHead = document.createElement('p');
  calHead.className = 'ew-chat-ai-head';
  calHead.textContent = `行事曆提醒草稿：${draft.calendarReminder.summary}（${reminderAt.toLocaleString('zh-TW')}）`;
  wrap.appendChild(calHead);

  const calActions = document.createElement('div');
  calActions.className = 'ew-chat-ai-actions';
  const calBtn = document.createElement('button');
  calBtn.type = 'button';
  calBtn.className = 'button secondary';
  calBtn.textContent = '確認建立行事曆提醒';
  calActions.appendChild(calBtn);
  wrap.appendChild(calActions);

  calBtn.addEventListener('click', async () => {
    const result = await runAction(
      () =>
        api(`/api/cases/${CASE_ID}/notify/calendar`, {
          method: 'POST',
          body: {
            confirm: true,
            summary: draft.calendarReminder.summary,
            description: draft.calendarReminder.description,
            startIso: draft.calendarReminder.startIso,
            endIso: draft.calendarReminder.endIso,
          },
        }),
      '行事曆提醒已建立。'
    );
    if (result) {
      calActions.replaceChildren();
      const done = document.createElement('p');
      done.className = 'ew-chat-ai-head';
      done.textContent = '已加進 Google 行事曆。';
      wrap.appendChild(done);
    }
  });

  return wrap;
}

async function requestNotificationDraft() {
  const draft = await runAction(() => api(`/api/cases/${CASE_ID}/notify/draft`, { method: 'POST' }));
  if (!draft) return;
  appendChatMessage({ role: 'ai', node: buildNotificationDraftNode(draft) });
  pushChatHistory('assistant', `已草擬補件通知（缺 ${draft.missingLabels.join('、')}），等待使用者確認寄出。`);
}

/**
 * 「決策者總覽」卡片格——2026-08-26 隊長裁示落地：吃真實的 caseRecord.carbon.shipments
 * （這個 Demo 案件本身就有 SHIP-A／SHIP-B 兩筆真實批次資料，見 fixtures/normal.json），
 * 不是 mockup 那種寫死的 SHIP-A~D 假資料。批次數量、狀態種類都照案件實際有幾筆就顯示
 * 幾張卡，不會為了畫面好看硬湊卡片數。
 */
/**
 * 刻意不重用既有的 metric()／.metric class——那個是給整個 app 原本「工業感控制台」風格
 * 用的（米棕色底、單格自己的邊框），套進決策者總覽這種要仿 mockup 乾淨白卡片風格的地方，
 * 會疊出雙重邊框、顏色也悶，使用者已經直接反映「跟參考圖樣式不一樣、很醜」。這裡另外寫
 * 一個專用版本：純白底、邊框只靠 grid 的 1px 縫隙做，不疊加格子自己的 border。
 */
function execMetric(label, value) {
  const cell = document.createElement('div');
  cell.className = 'ew-exec-metric';
  const valueEl = document.createElement('strong');
  valueEl.textContent = String(value);
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  cell.append(valueEl, labelEl);
  return cell;
}

function execStatusTone(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('READY')) return 'ready';
  if (s.includes('REVIEW')) return 'review';
  if (s.includes('BLOCK') || s.includes('DENY') || s.includes('REVOKE')) return 'blocked';
  if (s.includes('NEED') || s.includes('MISSING')) return 'needs';
  return 'neutral';
}

function renderExecOverview(caseRecord) {
  const summaryEl = $('exec-summary');
  const grid = $('exec-grid');
  if (!summaryEl || !grid) return;
  const shipments = caseRecord.carbon && Array.isArray(caseRecord.carbon.shipments) ? caseRecord.carbon.shipments : [];
  const readyCount = shipments.filter((item) => execStatusTone(item.allocationStatus) === 'ready').length;

  replaceChildren(summaryEl, [
    execMetric('總批次', shipments.length),
    execMetric('準備完成', readyCount),
    execMetric('需要處理', shipments.length - readyCount),
    execMetric('案件狀態', caseRecord.status || '—'),
  ]);

  if (!shipments.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '這個案件目前沒有出貨批次資料。';
    replaceChildren(grid, [empty]);
    return;
  }

  const cards = shipments.map((shipment) => {
    const card = document.createElement('article');
    card.className = 'ew-exec-card';

    const top = document.createElement('div');
    top.className = 'ew-exec-card-top';
    const id = document.createElement('span');
    id.className = 'ew-exec-card-id mono';
    id.textContent = shipment.shipmentId || '—';
    top.append(id);
    card.append(top);

    const pill = document.createElement('span');
    pill.className = 'ew-exec-pill ' + execStatusTone(shipment.allocationStatus);
    pill.textContent = shipment.allocationStatus || '—';
    card.append(pill);

    const rows = [
      ['出貨量', shipment.quantityTonnes != null ? `${shipment.quantityTonnes} ${shipment.quantityUnit || 'tonne'}` : '—'],
      ['預估排放', shipment.allocatedEmissions != null ? `${shipment.allocatedEmissions} tCO2e` : '—'],
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'ew-exec-card-row';
      const k = document.createElement('span');
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'mono';
      v.textContent = value;
      row.append(k, v);
      card.append(row);
    });

    const footer = document.createElement('div');
    footer.className = 'ew-exec-card-footer';
    const factor = document.createElement('span');
    factor.className = 'ew-exec-factor mono';
    factor.textContent = shipment.factorSetId || '—';
    footer.append(factor);
    card.append(footer);

    return card;
  });
  replaceChildren(grid, cards);
}

function setExecView(showExec) {
  const agentView = $('agent-view');
  const execView = $('exec-overview');
  const toggle = $('exec-view-switch');
  if (!agentView || !execView || !toggle) return;
  agentView.hidden = showExec;
  execView.hidden = !showExec;
  toggle.classList.toggle('on', showExec);
  toggle.setAttribute('aria-checked', String(showExec));
  if (showExec) renderExecOverview(state.caseRecord || {});
}

function renderSupplierEvidence() {
  const rows = state.evidence.map((item) => {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button secondary';
    action.textContent = item.humanConfirmed ? '已確認' : '人工確認';
    action.disabled = item.humanConfirmed || state.busy;
    action.addEventListener('click', () => confirmEvidence(item.evidenceId));
    return [
      item.type,
      item.evidenceId,
      item.filename,
      `${item.coveredFrom} → ${item.coveredTo}`,
      item.source,
      item.fileHash,
      action,
    ];
  });
  replaceChildren(
    $('supplier-evidence'),
    [createTable(['Type', 'ID', 'Filename', 'Covered dates', 'Source', 'SHA-256', 'Human confirm'], rows)]
  );
}

/**
 * 橫向必要文件 stepper：done（綠）＝該 type 至少有一筆已上傳的 evidence；
 * problem（紅）＝該 type 最近一次上傳失敗且至今尚未成功補上；其餘＝尚未上傳（灰）。
 * 只反映「有沒有上傳」，不疊加人工確認狀態——人工確認是另一個獨立步驟，Evidence Index
 * 裡的「已確認／人工確認」按鈕已經在管，這裡不重複疊加語意。
 */
function renderRequiredStepper() {
  const container = $('required-stepper');
  const countLabel = $('required-stepper-count');
  if (!container || !countLabel) return;

  const uploadedTypes = new Set(state.evidence.map((item) => item.type));
  countLabel.textContent = `${REQUIRED_TYPES.filter((type) => uploadedTypes.has(type)).length} / ${REQUIRED_TYPES.length}`;

  const nodes = [];
  REQUIRED_TYPES.forEach((type, index) => {
    if (index > 0) {
      const connector = document.createElement('span');
      connector.className = uploadedTypes.has(REQUIRED_TYPES[index - 1])
        ? 'ew-hstep-connector done'
        : 'ew-hstep-connector';
      nodes.push(connector);
    }
    const issue = state.uploadIssues[type];
    const isDone = uploadedTypes.has(type);
    const step = document.createElement('div');
    step.className = 'ew-hstep' + (issue ? ' problem' : isDone ? ' done' : '');
    const dot = document.createElement('span');
    dot.className = 'ew-hstep-dot';
    const label = document.createElement('span');
    label.className = 'ew-hstep-label';
    label.textContent = REQUIRED_TYPE_LABELS[type] || type;
    step.append(dot, label);
    if (issue) {
      const sub = document.createElement('span');
      sub.className = 'ew-hstep-sub';
      sub.textContent = issue.reason;
      step.append(sub);
    }
    nodes.push(step);
  });
  replaceChildren(container, nodes);
}

/**
 * 已上傳文件的收合式抽屜（開關固定在畫面左上角，展開時用覆蓋層＋背景變暗，不推擠主內容）。
 * 同時列出已上傳成功的 evidence（沿用同一份 state.evidence，不重複打 API）跟目前還沒補上、
 * 但最近一次嘗試上傳失敗的 required type，讓「已完成／待確認／有問題」三種狀態都看得到。
 */
function renderEvidenceDrawer() {
  const list = $('evidence-drawer-list');
  const countBadge = $('evidence-drawer-count');
  if (!list || !countBadge) return;

  const uploadedTypes = new Set(state.evidence.map((item) => item.type));
  const failedTypes = Object.keys(state.uploadIssues).filter((type) => !uploadedTypes.has(type));
  countBadge.textContent = String(state.evidence.length + failedTypes.length);

  if (!state.evidence.length && !failedTypes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '尚未上傳任何 evidence。';
    replaceChildren(list, [empty]);
    return;
  }

  const cards = state.evidence.map((item) => {
    const card = document.createElement('article');
    card.className = 'ew-file-card';
    const top = document.createElement('div');
    top.className = 'ew-file-card-top';
    const meta = document.createElement('div');
    meta.className = 'ew-file-meta';
    const fname = document.createElement('div');
    fname.className = 'ew-fname';
    fname.textContent = item.filename;
    const ftype = document.createElement('div');
    ftype.className = 'ew-ftype';
    ftype.textContent = `${item.type} · ${item.coveredFrom} – ${item.coveredTo}`;
    meta.append(fname, ftype);
    const status = document.createElement('span');
    status.className = 'ew-file-status ' + (item.humanConfirmed ? 'ready' : 'pending');
    status.textContent = item.humanConfirmed ? '已確認' : '待確認';
    top.append(meta, status);
    card.append(top);
    return card;
  });

  const errorCards = failedTypes.map((type) => {
    const issue = state.uploadIssues[type];
    const card = document.createElement('article');
    card.className = 'ew-file-card error';
    const top = document.createElement('div');
    top.className = 'ew-file-card-top';
    const meta = document.createElement('div');
    meta.className = 'ew-file-meta';
    const fname = document.createElement('div');
    fname.className = 'ew-fname';
    fname.textContent = REQUIRED_TYPE_LABELS[type] || type;
    const ftype = document.createElement('div');
    ftype.className = 'ew-ftype';
    ftype.textContent = `${type} · 上傳失敗`;
    meta.append(fname, ftype);
    const status = document.createElement('span');
    status.className = 'ew-file-status error';
    status.textContent = issue.code;
    top.append(meta, status);
    const msg = document.createElement('div');
    msg.className = 'ew-file-error-msg';
    msg.textContent = issue.reason;
    card.append(top, msg);
    return card;
  });

  replaceChildren(list, [...cards, ...errorCards]);
}

/**
 * 四幕 Demo 控制台、角色切換、案件摘要、Audit Timeline 這些是給團隊自己測試/展示
 * 用的技術面板，不是操作人員第一眼該看到的東西——預設收起，只留一個小按鈕，展開
 * 時內容照舊（不拆、不刪），跟 setEvidenceDrawer() 用同一種 hidden 屬性切換寫法。
 */
function setDevTools(open) {
  const toggle = $('dev-tools-toggle');
  const panel = $('dev-tools-panel');
  const label = $('dev-tools-toggle-label');
  if (!toggle || !panel) return;
  panel.hidden = !open;
  toggle.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (label) label.textContent = open ? '收起測試/開發工具' : '顯示測試/開發工具';
}

function setManualForm(open) {
  const toggle = $('manual-form-toggle');
  const panel = $('manual-form-panel');
  const label = $('manual-form-toggle-label');
  if (!toggle || !panel) return;
  panel.hidden = !open;
  toggle.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (label) label.textContent = open ? '收起手動輸入表單' : '顯示手動輸入表單';
}

function setSupplierTools(open) {
  const toggle = $('supplier-tools-toggle');
  const panel = $('supplier-tools-panel');
  const label = $('supplier-tools-toggle-label');
  if (!toggle || !panel) return;
  panel.hidden = !open;
  toggle.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (label) label.textContent = open ? '收起案件資訊與進階工具' : '顯示案件資訊與進階工具';
}

function setEvidenceDrawer(open) {
  const toggle = $('evidence-drawer-toggle');
  const drawer = $('evidence-drawer');
  const scrim = $('evidence-drawer-scrim');
  if (!toggle || !drawer || !scrim) return;
  drawer.classList.toggle('open', open);
  scrim.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.setAttribute('aria-label', open ? '收合已上傳文件' : '展開已上傳文件');
}

/**
 * 上傳/擷取出問題時的浮動通知——跟必要文件 stepper 的紅色節點、抽屜裡的失敗卡片是同一份
 * state.uploadIssues，只是多一個「當下立刻跳出來」的提醒層。全部用 createElement/textContent
 * 組出來，刻意不走「設 HTML 字串再整段塞進節點」那條路——跟這支檔案其他 render 函式一致。
 */
/**
 * opts.key + opts.persistent 是給「頁面本來就有的常駐提醒」用的（Vault 加密狀態、
 * Demo 免責聲明）——2026-08-26 隊長裁示落地：把這兩則原本佔頁面版面的橫幅改成右下角
 * 氣泡通知，同一個 key 重複呼叫是「更新內容」不是「疊一則新的」，persistent 則是不會
 * 7 秒自動消失（免責聲明不該不小心被使用者錯過）。既有的「上傳失敗」錯誤 toast 呼叫端
 * 完全不用改，行為跟原本一樣。
 */
const persistentToasts = {};

function showToast(opts) {
  const stack = $('toast-stack');
  if (!stack) return;

  if (opts.key && persistentToasts[opts.key]) {
    const existing = persistentToasts[opts.key];
    const titleEl = existing.querySelector('.ew-toast-title');
    if (titleEl) titleEl.textContent = opts.title || '';
    existing.querySelector('.ew-toast-msg').textContent = opts.message;
    return;
  }

  const variant = opts.variant || 'error';
  const showViewAction = opts.showViewAction !== undefined ? opts.showViewAction : variant === 'error';
  const el = document.createElement('div');
  el.className = 'ew-toast ew-toast-' + variant;

  const icon = document.createElement('span');
  icon.className = 'ew-toast-icon';
  icon.textContent = variant === 'info' ? 'i' : '!';
  icon.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'ew-toast-body';
  if (opts.title) {
    const title = document.createElement('strong');
    title.className = 'ew-toast-title';
    title.textContent = opts.title;
    body.append(title);
  }
  const message = document.createElement('p');
  message.className = 'ew-toast-msg';
  message.textContent = opts.message;
  body.append(message);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ew-toast-close';
  closeButton.setAttribute('aria-label', '關閉');
  closeButton.textContent = '✕';

  function dismiss() {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
    if (opts.key) delete persistentToasts[opts.key];
  }

  if (showViewAction) {
    const actions = document.createElement('div');
    actions.className = 'ew-toast-actions';
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'ew-toast-action';
    actionButton.textContent = '查看詳情';
    actionButton.addEventListener('click', () => {
      dismiss();
      setEvidenceDrawer(true);
    });
    actions.append(actionButton);
    body.append(actions);
  }

  el.append(icon, body, closeButton);
  stack.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  closeButton.addEventListener('click', dismiss);

  if (opts.key) persistentToasts[opts.key] = el;
  if (!opts.persistent) setTimeout(dismiss, 7000);
}

function fillEvidenceSelect(select, evidence, selectedId) {
  const options = evidence.map((item) => {
    const option = document.createElement('option');
    option.value = item.evidenceId;
    option.textContent = `${item.evidenceId} · ${item.type}`;
    option.selected = item.evidenceId === selectedId;
    return option;
  });
  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '尚無 evidence';
    options.push(option);
  }
  replaceChildren(select, options);
}

function renderGrantControls() {
  fillEvidenceSelect(
    $('grant-evidence'),
    state.evidence,
    state.grant && state.grant.evidenceId
  );
  const token = getToken();
  const mayShowOnce = Boolean(token && state.grant && state.grant.justCreated);
  $('token-once').hidden = !mayShowOnce;
  $('grant-token').textContent = mayShowOnce ? token : '';
  $('grant-expiry').textContent =
    mayShowOnce && state.grant ? `到期 ${formatTime(state.grant.expiresAt)}` : '';
}

function renderImporter(payload) {
  const caseRecord = payload.case;
  const annual = caseRecord.annualSummary || {};
  const completeness = caseRecord.evidenceCompleteness || {};
  const required = completeness.required || [];
  const received = completeness.received || [];
  replaceChildren($('importer-summary'), [
    metric('CN code', caseRecord.cnCode),
    metric('年度強度', `${annual.intensity ?? '—'} ${annual.intensityUnit || ''}`, 'Demo data'),
    metric('證據完整度', `${received.length}/${required.length}`),
    metric('人工確認', `${completeness.confirmedCount || 0} 筆`),
  ]);
  const rows = (caseRecord.shipments || []).map((shipment) => [
    shipment.shipmentId,
    `${shipment.quantityTonnes} ${shipment.quantityUnit || 'tonne'}`,
    `${shipment.allocatedEmissions} tCO2e`,
    shipment.allocationStatus,
  ]);
  replaceChildren(
    $('shipment-summary'),
    [createTable(['Shipment', 'Quantity', 'Allocated emissions', '狀態'], rows)]
  );
  $('actual-intensity').textContent =
    `${payload.comparison.actualIntensity} ${payload.comparison.unit}`;
  $('default-intensity').textContent =
    `${payload.comparison.defaultEstimateIntensity} ${payload.comparison.unit}`;
  $('estimate-label').textContent = payload.comparison.label;
  renderAgentSafeSummary(caseRecord.agentSummary);
}

function renderVerifier(caseRecord, indexPayload) {
  state.evidence = indexPayload.evidenceIndex || [];
  // Vault 加密狀態放第二欄（ID 後面）而不是最後一欄——這張表在 .two-column 版面裡本來
  // 就要橫向捲動才看得完，加密狀態對 Verifier 來說是判斷這份底稿可不可信的關鍵資訊，
  // 放最後面等於要求使用者每次都捲到底才看得到，放前面才符合「一眼看到」的目的。
  const rows = state.evidence.map((item) => [
    item.evidenceId,
    item.vaultEncrypted ? '🔒 已加密' : '⚠ 未加密',
    item.type,
    item.filename,
    `${item.coveredFrom} → ${item.coveredTo}`,
    item.source,
    item.humanConfirmed ? '已人工確認' : '未確認',
  ]);
  replaceChildren(
    $('verifier-evidence'),
    [createTable(['ID', 'Vault', 'Type', 'Filename', 'Covered dates', 'Source', 'Confirm'], rows)]
  );
  fillEvidenceSelect(
    $('verifier-evidence-select'),
    state.evidence,
    state.grant && state.grant.evidenceId
  );
  $('verifier-token').value = getToken();
  renderVerifierGrantState();
  renderFindings(caseRecord.findings || []);
  renderRiskReport($('verifier-risk-report'), caseRecord.riskReport);
}

/**
 * Supplier 端在上傳前就該知道這次上傳會不會被加密——原本這件事只有 Verifier 端事後
 * 從 Evidence Index 的 Vault 欄位才看得到，Supplier 自己完全不知道，等於單向資訊落差。
 */
async function refreshUploadVaultStatus() {
  const status = await VaultCrypto.getVaultKeyStatus('Supplier');
  showToast({
    key: 'vault-status',
    variant: 'info',
    persistent: true,
    message: status.registered
      ? '🔒 Verifier 已註冊 Vault 裝置，內容將自動以其裝置公鑰加密後上傳。'
      : '⚠ Verifier 尚未註冊 Vault 裝置，內容將以現有方式上傳（未加密）。',
  });
}

async function refreshVaultKeyStatus() {
  const status = await VaultCrypto.getVaultKeyStatus('Verifier');
  const badge = $('vault-key-status');
  const button = $('register-vault-device');
  if (status.registered) {
    const historyNote = status.history.length > 1 ? `（含 ${status.history.length} 個歷史版本）` : '';
    badge.textContent = `● 已註冊（${formatTime(status.createdAt)}）${historyNote}`;
    badge.dataset.status = 'registered';
    button.textContent = '輪替金鑰';
  } else {
    badge.textContent = '● 尚未註冊';
    badge.dataset.status = 'unregistered';
    button.textContent = '註冊 Vault 裝置';
  }
}

let pendingRotateConfirm = false;

/**
 * 輪替金鑰是有實質後果的動作（見 vault-crypto.js／server/vaultKeys.js 的保留期限設計：
 * 超過 MAX_HISTORY 筆的最舊版本會被真的淘汰，用那把金鑰加密的底稿之後就解不開了）——
 * 不該一按就送出。這裡用「按第一次進入確認狀態、按鈕文字與提示變色、按第二次才真的送出」
 * 的 inline 兩段式確認，不用 window.confirm()（那是原生瀏覽器對話框，跟這個 app 完全沒用過
 * 原生對話框、一律用畫面內 notice/error 面板的既有風格不一致）。首次註冊不是破壞性動作，
 * 不需要這道關卡。
 */
async function registerVaultDevice() {
  const button = $('register-vault-device');
  const alreadyRegistered = $('vault-key-status').dataset.status === 'registered';

  if (alreadyRegistered && !pendingRotateConfirm) {
    pendingRotateConfirm = true;
    button.textContent = '確定要輪替嗎？再按一次確認';
    button.dataset.confirming = 'true';
    showNotice('輪替後新上傳的底稿會改用新金鑰版本加密；已加密的舊底稿在保留期限內仍可用當時的版本解密，但版本數超過上限時最舊的會被淘汰、屆時無法再解密。再按一次「確定要輪替嗎」才會真的送出。');
    return null;
  }
  pendingRotateConfirm = false;
  button.dataset.confirming = 'false';

  const action = alreadyRegistered ? VaultCrypto.rotateVerifierVaultKey : VaultCrypto.registerVerifierVaultKey;
  const message = alreadyRegistered
    ? 'Vault 金鑰已輪替；之後上傳的底稿改用新版本加密，舊底稿仍可用當時的版本解密。'
    : 'Vault 裝置註冊完成；之後上傳的底稿會自動以此裝置公鑰加密。';
  const result = await runActionWithDeviceVerification(button, action, message);
  if (result) await runAction(refreshVaultKeyStatus);
  else button.textContent = alreadyRegistered ? '輪替金鑰' : '註冊 Vault 裝置'; // 失敗時把按鈕文字換回正常狀態，不留在「請完成裝置驗證…」
}

function renderVerifierGrantState() {
  if (!state.grant) {
    $('verifier-grant-state').textContent = '尚未取得本次 session 的 Grant。';
    return;
  }
  let status = `到期 ${formatTime(state.grant.expiresAt)}`;
  if (state.grant.revoked) status = `已撤銷 · 原到期 ${formatTime(state.grant.expiresAt)}`;
  else if (state.grant.consumed) status = `已使用 · ${formatTime(state.grant.expiresAt)}`;
  else if (Date.parse(state.grant.expiresAt) <= Date.now()) status = `已過期 · ${formatTime(state.grant.expiresAt)}`;
  $('verifier-grant-state').textContent = `Grant ${state.grant.grantId} · ${status}`;
}

function renderFindings(findings) {
  if (!findings.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '尚無 finding；這不代表正式查驗完成。';
    replaceChildren($('finding-list'), [empty]);
    return;
  }
  replaceChildren(
    $('finding-list'),
    findings.map((finding) => {
      const article = document.createElement('article');
      article.className = 'finding';
      article.dataset.severity = finding.severity;
      const strong = document.createElement('strong');
      strong.textContent = `${finding.severity} · ${finding.status}`;
      const text = document.createElement('p');
      text.textContent = finding.summary;
      article.append(strong, text);
      return article;
    })
  );
}

function renderAudit(events) {
  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = '尚無 Audit 事件。';
    replaceChildren($('audit-timeline'), [empty]);
    return;
  }
  const items = [...events].reverse().map((event) => {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = event.timestamp;
    time.textContent = formatTime(event.timestamp);
    const role = document.createElement('strong');
    role.textContent = event.role;
    const action = document.createElement('span');
    action.textContent = `${event.action} · ${event.targetType || 'case'} ${event.targetId || ''}`;
    const result = document.createElement('span');
    result.className = 'result-chip';
    result.textContent = event.reasonCode
      ? `${event.result} · ${event.reasonCode}`
      : event.result;
    item.append(time, role, action, result);
    return item;
  });
  replaceChildren($('audit-timeline'), items);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-TW', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date);
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToUtf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function loadRole() {
  const list = await api('/api/cases');
  state.actor = list.actor;
  $('actor-summary').textContent =
    `${list.actor.role} · ${list.actor.orgId} · Demo actor`;
  const detail = await api(`/api/cases/${CASE_ID}`);
  state.caseRecord = detail.case;
  renderHeader(detail.case);
  renderServices(detail.case.services);

  if (state.role === 'Supplier') {
    renderSupplier(detail.case);
    await refreshUploadVaultStatus();
  } else if (state.role === 'Importer') {
    const summary = await api(`/api/importer/cases/${CASE_ID}/summary`);
    renderImporter(summary);
  } else {
    const index = await api(`/api/verifier/cases/${CASE_ID}/evidence`);
    renderVerifier(detail.case, index);
    await refreshVaultKeyStatus();
  }
  await refreshAudit();
}

async function switchRole(role) {
  if (!['Supplier', 'Importer', 'Verifier'].includes(role)) return;
  if (role !== 'Supplier' && state.grant && state.grant.justCreated) {
    saveGrant({ ...state.grant, justCreated: false });
  }
  $('token-once').hidden = true;
  $('grant-token').textContent = '';
  $('verifier-token').value = '';
  $('opened-content').textContent = '';
  $('opened-evidence').hidden = true;
  state.role = role;
  applyRoleControls();
  document.querySelectorAll('.role-button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.role === role));
  });
  document.querySelectorAll('.role-view').forEach((view) => {
    view.hidden = view.dataset.view !== role;
  });
  await runAction(loadRole);
}

async function refreshAudit() {
  const payload = await api(`/api/cases/${CASE_ID}/audit`);
  renderAudit(payload.events || []);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * input.contentBase64 是給聊天式上傳（見 submitChatUpload）用的：那條路徑手上已經是真的
 * 圖片二進位 base64（FileReader 讀出來的），不是使用者打的文字，不能再套 utf8ToBase64
 * 重新編碼一次文字——那樣會把圖片位元組錯誤地當成 UTF-8 字串處理，資料會壞掉。既有的手動
 * 表單／seedEvidence 都只傳 input.content（文字），這裡完全不受影響、行為不變。
 */
async function uploadEvidence(input) {
  const hasRawBase64 = typeof input.contentBase64 === 'string';
  const plainBytes = hasRawBase64 ? base64ToBytes(input.contentBase64) : VaultCryptoCore.utf8ToBytes(input.content);
  let vaultFields = {
    contentBase64: hasRawBase64 ? input.contentBase64 : utf8ToBase64(input.content),
    vaultEncrypted: false,
  };
  try {
    const encrypted = await VaultCrypto.encryptForVault(plainBytes);
    if (encrypted) vaultFields = encrypted;
  } catch {
    // Verifier 公鑰讀取失敗（例如網路問題）時退回明碼上傳，不擋 Supplier 的上傳動作——
    // 這不是靜默隱藏加密失敗：畫面上的「⚠ 未加密」標記會如實反映這份底稿沒有被加密。
  }
  return api('/api/evidence', {
    method: 'POST',
    role: 'Supplier',
    body: {
      caseId: CASE_ID,
      filename: input.filename,
      mediaType: input.mediaType,
      metadata: {
        type: input.type,
        coveredFrom: input.coveredFrom,
        coveredTo: input.coveredTo,
        source: input.source,
      },
      ...vaultFields,
    },
  });
}

// ---- chat-style upload: attach a file or paste text, AI replies with candidate
// fields to confirm, confirming actually calls the same uploadEvidence()/confirmEvidence()
// as the manual form below — this is a friendlier front door onto the same real endpoints,
// not a separate parallel system. ----
let chatAttachedFile = null;

/**
 * 對話「記憶」——2026-08-26 隊長裁示落地：之前每一句問答都是獨立的，AI 不記得兩句話前
 * 問過什麼。這裡只存精簡過的文字摘要（使用者打的字、AI 的回覆或一句話結果），不存整份
 * 檔案內容或 base64——重送整張圖片給每一輪對話會不必要地貴，而且真的要追問某份文件時，
 * meta 裡本來就還留著那份內容，用不到歷史紀錄。伺服器端會對每一則歷史內容重新跑一次
 * containsInjection，不是前端說安全就直接信任。
 */
let chatHistoryLog = [];
const CHAT_HISTORY_MAX_TURNS = 12;
function pushChatHistory(role, content) {
  const text = String(content || '').trim();
  if (!text) return;
  chatHistoryLog.push({ role, content: text.slice(0, 500) });
  if (chatHistoryLog.length > CHAT_HISTORY_MAX_TURNS) {
    chatHistoryLog = chatHistoryLog.slice(-CHAT_HISTORY_MAX_TURNS);
  }
}

/**
 * 使用者真的檔名（尤其是中文檔名，例如「痛點市場驗證.pdf」）拿去當 API 的 filename 會被
 * server 端的 SAFE_SOURCE_FILE 白名單擋掉（只收 ASCII）——那道白名單是防 prompt injection
 * 的一部分，不能為了遷就中文檔名放寬。所以聊天框一律另外產生一個 ASCII-only 的安全檔名送
 * 給 API，畫面上（聊天泡泡、附件標籤）照樣顯示使用者真正的原始檔名。
 */
function makeSafeChatFilename(mediaType) {
  const ext = mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/png' ? '.png' : '.txt';
  return `chat-upload-${Date.now()}${ext}`;
}

let pdfjsModulePromise = null;
function loadPdfJs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('/vendor/pdfjs/pdf.min.mjs').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return mod;
    });
  }
  return pdfjsModulePromise;
}

/**
 * PDF 沒有真的二進位解析能力（見 server 端 previewEvidence 的註解）——這裡是實際解法：
 * 在瀏覽器端用 pdf.js（自架，不連 CDN）把第一頁畫到 canvas、轉成 PNG，再走既有、已經測過
 * 的圖片辨識路徑。只轉第一頁是刻意的取捨，訊息裡會老實講清楚，不假裝支援多頁。
 */
async function convertPdfFirstPageToPng(file) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function renderChatFileChip() {
  const chip = $('chat-file-chip');
  const nameEl = $('chat-file-name');
  if (!chip || !nameEl) return;
  if (chatAttachedFile) {
    nameEl.textContent = chatAttachedFile.name;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
    reader.readAsDataURL(file);
  });
}

function appendChatMessage({ role, text, node }) {
  const thread = $('chat-thread');
  if (!thread) return null;
  const bubble = document.createElement('div');
  bubble.className = 'ew-chat-bubble ' + (role === 'ai' ? 'ai' : 'user');
  if (node) {
    bubble.appendChild(node);
  } else {
    const p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(p);
  }
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

/**
 * 驗證＋讀檔的共用邏輯，從 handleChatFileSelect 抽出來給單檔（附加到輸入框，
 * 等使用者按送出）跟多檔（選取後直接平行送進各自的預覽）兩條路徑共用。錯誤訊息
 * 直接帶檔名，避免多檔情境下使用者搞不清楚是哪一份失敗。回傳 null 代表這份檔案
 * 不能用，訊息已經印在聊天記錄裡，呼叫端不用再重複處理。
 */
async function prepareChatFile(file) {
  if (!file) return null;
  if (file.type === 'application/pdf') {
    if (file.size > 8 * 1024 * 1024) {
      appendChatMessage({ role: 'ai', text: `「${file.name}」PDF 超過 8 MB 上限，請改用較小的檔案。` });
      return null;
    }
    const thinking = appendChatMessage({ role: 'ai', text: `正在把「${file.name}」第一頁轉成圖片…` });
    try {
      const base64 = await convertPdfFirstPageToPng(file);
      if (thinking) thinking.remove();
      appendChatMessage({ role: 'ai', text: `已把「${file.name}」第一頁轉成圖片準備讀取；只會讀第一頁，多頁 PDF 請分開上傳每一頁的截圖。` });
      return {
        name: file.name.replace(/\.pdf$/i, '') + '-p1.png',
        safeName: makeSafeChatFilename('image/png'),
        mediaType: 'image/png',
        base64,
      };
    } catch (err) {
      if (thinking) thinking.remove();
      appendChatMessage({ role: 'ai', text: `「${file.name}」PDF 轉換失敗（可能是掃描檔或格式特殊），請改用截圖／照片上傳，或直接貼上文字內容。` });
      return null;
    }
  }
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    appendChatMessage({ role: 'ai', text: `「${file.name}」不支援 ${file.type || '這種'} 格式，請改用 PNG／JPEG／PDF，或直接貼上文字內容。` });
    return null;
  }
  if (file.size > 512 * 1024) {
    appendChatMessage({ role: 'ai', text: `「${file.name}」超過 512 KB 上限，請改用較小的檔案。` });
    return null;
  }
  return {
    name: file.name,
    safeName: makeSafeChatFilename(file.type),
    mediaType: file.type,
    base64: await readFileAsBase64(file),
  };
}

async function handleChatFileSelect(file) {
  const prepared = await prepareChatFile(file);
  $('chat-file-input').value = '';
  if (!prepared) return;
  chatAttachedFile = prepared;
  renderChatFileChip();
}

/**
 * 讓 #chat-drop-zone（整個「上傳文件」卡片）接受從桌面/檔案總管直接拖進來的檔案，
 * 不是只能靠迴紋針點開系統選檔視窗。瀏覽器預設行為是「放開就用瀏覽器開啟這個檔案」，
 * 三個事件都要 preventDefault 才擋得掉。dragenter/dragleave 會在子元素間進出時各自觸發，
 * 用一個計數器而不是布林值，避免滑鼠移過內部元素時外框高亮閃爍或提早消失。
 */
function bindChatDropZone() {
  const zone = $('chat-drop-zone');
  if (!zone) return;
  let dragDepth = 0;
  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    zone.classList.add('ew-hero--drag-over');
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  zone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zone.classList.remove('ew-hero--drag-over');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove('ew-hero--drag-over');
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) handleChatFilesSelect(files);
  });
}

/**
 * 多檔選取（例如一次選 4 份必要文件）：每份各自獨立準備、獨立呼叫一次
 * /api/evidence/preview（各自獨立的 LLM 呼叫，不共用 context，跟 services/agent 既有
 * 的信任設計一致），用 Promise.allSettled 平行送出，不互相等待——A 檔案給 LLM 處理的
 * 同時 B 檔案就已經送出去了，不用排隊等前一份做完。每份都各自出現一則聊天訊息＋各自的
 * 「確認並送出／不對，捨棄」，人工確認的把關完全沒被跳過，只是把「附加→送出」這個手動
 * 動作從 4 次縮成 1 次選取。單一檔案時維持原本「附加到輸入框，可以加一句說明再送出」的
 * 流程，不強制走這條路徑。
 */
async function handleChatFilesSelect(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (files.length === 1) {
    await handleChatFileSelect(files[0]);
    return;
  }
  $('chat-file-input').value = '';
  await Promise.allSettled(files.map((file) => previewOneFile(file)));
}

/**
 * 每份檔案各自獨立顯示狀態（排隊中→讀取/上傳中→完成或失敗），不是丟進去之後
 * 靜靜等結果——多檔平行送出時，使用者要看得出「這份卡在哪一步」，而不是只有
 * 送出前跟收到結果兩個時間點。狀態訊息用完即移除，不留殘影堆在對話紀錄裡。
 */
async function previewOneFile(file) {
  const queued = appendChatMessage({ role: 'ai', text: `📎 ${file.name}：排隊中…` });
  const prepared = await prepareChatFile(file);
  if (queued) queued.remove();
  if (!prepared) return;
  const meta = {
    filename: prepared.safeName,
    displayName: prepared.name,
    mediaType: prepared.mediaType,
    contentBase64: prepared.base64,
  };
  appendChatMessage({ role: 'user', text: `📎 ${meta.displayName}` });
  pushChatHistory('user', `[附加檔案：${meta.displayName}]`);
  const processing = appendChatMessage({ role: 'ai', text: `${meta.displayName}：上傳中，AI 讀取中…` });
  const result = await runAction(
    () =>
      api('/api/evidence/preview', {
        method: 'POST',
        role: 'Supplier',
        body: {
          caseId: CASE_ID,
          filename: meta.filename,
          mediaType: meta.mediaType,
          contentBase64: meta.contentBase64,
          chatHistory: chatHistoryLog,
        },
      }),
    null,
    (error) => {
      if (processing) processing.remove();
      const presentation = errorPresentation(error);
      appendChatMessage({ role: 'ai', text: `${meta.displayName}：上傳失敗——${presentation.reason || '暫時無法讀取這份文件。'}` });
    }
  );
  if (result) {
    if (processing) processing.remove();
    appendChatMessage({ role: 'ai', node: buildEntryPreviewNode(result, meta) });
    pushChatHistory('assistant', summarizeResultForHistory(result));
  }
}

function buildEntryPreviewNode(result, meta) {
  const wrap = document.createElement('div');
  const entries = result.entries || [];

  if (result.chatReply) {
    const reply = document.createElement('p');
    reply.textContent = result.chatReply;
    wrap.appendChild(reply);
    return wrap;
  }

  if (!result.documentType) {
    const head = document.createElement('p');
    head.className = 'ew-chat-ai-head';
    head.textContent = '看不出來這是必要文件裡的哪一種，可以直接點選，或用打字告訴我：';
    wrap.appendChild(head);
    const chips = document.createElement('div');
    chips.className = 'ew-chat-ai-actions';
    REQUIRED_TYPES.forEach((type) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'button secondary';
      chip.textContent = REQUIRED_TYPE_LABELS[type] || type;
      chip.addEventListener('click', async () => {
        chips.remove();
        await runPreviewAndRespond(meta, `這是${REQUIRED_TYPE_LABELS[type] || type}`);
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    return wrap;
  }

  const typeLabel = REQUIRED_TYPE_LABELS[result.documentType] || result.documentType;
  const head = document.createElement('p');
  head.className = 'ew-chat-ai-head';
  head.textContent = entries.length
    ? `看起來是「${typeLabel}」，已擷取 ${entries.length} 筆欄位：`
    : `看起來是「${typeLabel}」，但沒有擷取到任何結構化欄位，可以改用下方手動輸入表單。`;
  wrap.appendChild(head);

  if (entries.length) {
    const list = document.createElement('ul');
    list.className = 'ew-chat-entries';
    entries.forEach((entry) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'k';
      label.textContent = entry.field;
      const value = document.createElement('span');
      value.className = 'v';
      value.textContent = `${entry.value}${entry.unit ? ' ' + entry.unit : ''}`;
      const conf = document.createElement('span');
      conf.className = 'c';
      conf.textContent = `信心度 ${Math.round(entry.confidence * 100)}%`;
      li.append(label, value, conf);
      list.appendChild(li);
    });
    wrap.appendChild(list);
  }

  const actions = document.createElement('div');
  actions.className = 'ew-chat-ai-actions';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'button';
  confirmBtn.textContent = '確認並送出';
  confirmBtn.disabled = !entries.length;
  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'button secondary';
  discardBtn.textContent = '不對，捨棄';
  actions.append(confirmBtn, discardBtn);
  wrap.appendChild(actions);

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    discardBtn.disabled = true;
    const type = result.documentType;
    const result2 = await runAction(
      () =>
        uploadEvidence({
          type,
          filename: meta.filename,
          mediaType: meta.mediaType,
          contentBase64: meta.contentBase64,
          coveredFrom: '2026-01-01',
          coveredTo: '2026-12-31',
          source: 'chat-upload',
        }),
      'Evidence 已安全上傳；原始內容不會出現在 Audit Timeline。',
      (error) => {
        const presentation = errorPresentation(error);
        state.uploadIssues[type] = { code: presentation.code, reason: presentation.reason };
      }
    );
    if (result2) {
      delete state.uploadIssues[type];
      await runAction(loadRole);
      await confirmEvidence(result2.evidence.evidenceId);
      actions.replaceChildren();
      const done = document.createElement('p');
      done.className = 'ew-chat-ai-head';
      done.textContent = `${meta.displayName || meta.filename} 已送出並確認完成。`;
      wrap.appendChild(done);
      pushChatHistory('assistant', done.textContent);
      await runAutoAnalysisInChat();
    } else {
      confirmBtn.disabled = false;
      discardBtn.disabled = false;
    }
  });

  discardBtn.addEventListener('click', () => {
    wrap.replaceChildren();
    const note = document.createElement('p');
    note.className = 'ew-chat-ai-head';
    note.textContent = '已捨棄，未送出。';
    wrap.appendChild(note);
  });

  return wrap;
}

function summarizeResultForHistory(result) {
  if (result.chatReply) return result.chatReply;
  if (result.documentType) {
    const label = REQUIRED_TYPE_LABELS[result.documentType] || result.documentType;
    return `已從文件擷取 ${(result.entries || []).length} 筆「${label}」欄位，等待使用者確認。`;
  }
  return '看不出來這份輸入是哪一種必要文件，已請使用者澄清。';
}

async function runPreviewAndRespond(meta, userNote) {
  if (userNote) {
    appendChatMessage({ role: 'user', text: userNote });
    pushChatHistory('user', userNote);
  }
  const result = await runAction(
    () =>
      api('/api/evidence/preview', {
        method: 'POST',
        role: 'Supplier',
        body: { caseId: CASE_ID, filename: meta.filename, mediaType: meta.mediaType, contentBase64: meta.contentBase64, userNote, chatHistory: chatHistoryLog },
      }),
    null,
    (error) => {
      const presentation = errorPresentation(error);
      appendChatMessage({ role: 'ai', text: presentation.reason || '暫時無法讀取這份文件。' });
    }
  );
  if (result) {
    appendChatMessage({ role: 'ai', node: buildEntryPreviewNode(result, meta) });
    pushChatHistory('assistant', summarizeResultForHistory(result));
    if (result.documentType && chatAttachedFile && chatAttachedFile.base64 === meta.contentBase64) {
      // 這次點分類按鈕重試用的內容就是目前composer裡附加的檔案，分類成功了就清掉，
      // 避免使用者以為附件還卡在輸入框裡。
      chatAttachedFile = null;
      renderChatFileChip();
      $('chat-file-input').value = '';
    }
  }
}

async function sendChatUpload() {
  const textValue = $('chat-text-input').value.trim();
  if (!chatAttachedFile && !textValue) {
    appendChatMessage({ role: 'ai', text: '請先附加圖片／PDF，或貼上文字內容再送出。' });
    return;
  }

  const filename = chatAttachedFile ? chatAttachedFile.safeName : `chat-${Date.now()}.txt`;
  const displayName = chatAttachedFile ? chatAttachedFile.name : filename;
  const mediaType = chatAttachedFile ? chatAttachedFile.mediaType : 'text/plain';
  const contentBase64 = chatAttachedFile ? chatAttachedFile.base64 : utf8ToBase64(textValue);
  const userNote = chatAttachedFile ? textValue : '';

  appendChatMessage({ role: 'user', text: chatAttachedFile ? `📎 ${displayName}${textValue ? '　' + textValue : ''}` : textValue });
  pushChatHistory('user', chatAttachedFile ? `[附加檔案：${displayName}]${textValue ? ' ' + textValue : ''}` : textValue);

  const sendBtn = $('chat-send-btn');
  sendBtn.disabled = true;
  const meta = { filename, displayName, mediaType, contentBase64 };
  const result = await runAction(
    () =>
      api('/api/evidence/preview', {
        method: 'POST',
        role: 'Supplier',
        body: { caseId: CASE_ID, filename, mediaType, contentBase64, userNote: userNote || undefined, chatHistory: chatHistoryLog },
      }),
    null,
    (error) => {
      const presentation = errorPresentation(error);
      appendChatMessage({ role: 'ai', text: presentation.reason || '暫時無法讀取這份文件。' });
    }
  );
  sendBtn.disabled = false;
  if (result) {
    appendChatMessage({ role: 'ai', node: buildEntryPreviewNode(result, meta) });
    pushChatHistory('assistant', summarizeResultForHistory(result));
  }
  $('chat-text-input').value = '';
  if (result && (result.documentType || result.chatReply)) {
    // 已經成功分類，或這次根本是聊天訊息不是文件——附件在這個交換裡的任務都結束了
    // （後續確認/捨棄都用 meta 裡存好的內容）。
    chatAttachedFile = null;
    renderChatFileChip();
    $('chat-file-input').value = '';
  }
  // documentType 跟 chatReply 都是 null 時（單純判斷不出來是哪種文件）刻意保留
  // chatAttachedFile：使用者下一句澄清文字（或點分類按鈕）還要用同一份內容重新分類，
  // 不能讓他們重新選一次檔案。
}

async function handleUpload(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const input = Object.fromEntries(form.entries());
  const result = await runAction(
    () => uploadEvidence(input),
    'Evidence 已安全上傳；原始內容不會出現在 Audit Timeline。',
    (error) => {
      const presentation = errorPresentation(error);
      state.uploadIssues[input.type] = { code: presentation.code, reason: presentation.reason };
      showToast({
        title: `${input.filename || input.type} 上傳失敗`,
        message: presentation.reason,
      });
    }
  );
  if (result) {
    delete state.uploadIssues[input.type];
    await runAction(loadRole);
  }
}

async function seedEvidence() {
  let created = 0;
  let skipped = 0;
  const result = await runAction(async () => {
    for (const seed of DEMO_EVIDENCE) {
      try {
        await uploadEvidence({
          type: seed.type,
          filename: seed.filename,
          content: JSON.stringify({ entries: seed.entries }),
          mediaType: 'application/json',
          coveredFrom: '2026-01-01',
          coveredTo: '2026-12-31',
          source: `synthetic-demo-${seed.type}`,
        });
        created += 1;
      } catch (error) {
        if (error.code === 'EVIDENCE_ALREADY_EXISTS') skipped += 1;
        else throw error;
      }
    }
    return true;
  });
  if (result) {
    showNotice(`Synthetic Demo evidence：新增 ${created} 份，既有 ${skipped} 份。`);
    await runAction(loadRole);
  }
}

async function confirmEvidence(evidenceId) {
  const result = await runAction(
    () => api(`/api/evidence/${encodeURIComponent(evidenceId)}/confirm`, {
      method: 'POST',
      role: 'Supplier',
      body: { confirmed: true },
    }),
    `${evidenceId} 已由 Demo Supplier 人工確認。`
  );
  if (result) await runAction(loadRole);
}

async function confirmAll() {
  const pending = state.evidence.filter((item) => !item.humanConfirmed);
  if (!pending.length) {
    showNotice('所有 evidence 均已人工確認。');
    return;
  }
  const result = await runAction(async () => {
    for (const item of pending) {
      await api(`/api/evidence/${encodeURIComponent(item.evidenceId)}/confirm`, {
        method: 'POST',
        role: 'Supplier',
        body: { confirmed: true },
      });
    }
    return true;
  });
  if (result) {
    showNotice(`已人工確認 ${pending.length} 份 evidence。`);
    await runAction(loadRole);
  }
}

async function submitCase() {
  const result = await runAction(async () => {
    try {
      return await api(`/api/cases/${CASE_ID}/submit`, {
        method: 'POST',
        role: 'Supplier',
        body: {},
      });
    } finally {
      await loadRole();
    }
  });
  if (!result) return;
  const message = result.readiness && result.readiness.message
    ? result.readiness.message
    : '案件已提交。';
  showNotice(message);
}

const DISCREPANCY_LABELS = {
  ELECTRICITY_INTENSITY_OUT_OF_RANGE: '用電量',
  FUEL_INTENSITY_OUT_OF_RANGE: '燃料量',
  PRECURSOR_RATIO_OUT_OF_RANGE: '前驅物量',
};

/**
 * 把 RiskReport（結構化、已經算好的真實資料——missingEvidence／discrepancies）套版成
 * 對話口吻的句子，2026-08-26 隊長裁示落地：不是另外叫一次 LLM 生成，是把已經有的真實分析
 * 結果直接講出來，跟畫面上「顯示案件資訊與進階工具」裡的完整報告是同一份資料、只是換一種
 * 呈現方式，不會兩邊講的不一樣。
 */
function formatRiskReportForChat(report) {
  const lines = [];
  const missing = report.missingEvidence || [];
  if (missing.length) {
    const labels = missing.map((item) => REQUIRED_TYPE_LABELS[item.requiredEvidence] || item.requiredEvidence);
    lines.push(`必要文件還缺 ${labels.length} 種：${labels.join('、')}。`);
  } else {
    lines.push('四種必要文件都到齊了。');
  }
  (report.discrepancies || []).forEach((d) => {
    const label = DISCREPANCY_LABELS[d.ruleId] || d.ruleId;
    const ratio = Number.isFinite(d.difference) ? d.difference.toFixed(2) : '—';
    lines.push(`${label}跟產量的比例是 ${ratio}，超出 Demo 預期範圍，數字對得起來嗎？要不要確認一下。`);
  });
  if (!missing.length && !(report.discrepancies || []).length) {
    lines.push('目前沒有發現缺件或數字異常，但這只是 Demo 分析，不代表正式查驗完成。');
  }
  lines.push('完整分析結果可以打開下面的「顯示案件資訊與進階工具」查看。');
  return lines.join('\n');
}

/**
 * 上傳＋確認一份 evidence 之後自動接著跑案件級分析，結果接在同一個對話串裡講——
 * 2026-08-26 隊長裁示落地：不用使用者另外去點「執行 Evidence Agent 預審」那個藏在進階
 * 工具裡的按鈕，AI 主動照看整個案件，不是只回應單一上傳。呼叫既有 analyzeCase()，不重寫
 * 分析邏輯；這裡只是多一步「把結果講給使用者聽」。分析本身失敗（LLM 額度用完等）沿用
 * analyzeCase() 既有的錯誤處理（跳既有的 #error-panel）——不刻意吞掉錯誤，跟手動點
 * 「執行 Evidence Agent 預審」按鈕失敗時看到的是同一套行為，不是自動觸發就假裝沒事。
 * 剛剛的 evidence 上傳／確認已經成功，不受這裡分析失敗與否影響。
 */
async function runAutoAnalysisInChat() {
  const result = await analyzeCase();
  if (result && result.report) {
    const text = formatRiskReportForChat(result.report);
    appendChatMessage({ role: 'ai', text });
    pushChatHistory('assistant', text);
  }
}

async function analyzeCase() {
  const result = await runAction(() => api(`/api/cases/${CASE_ID}/agent/analyze`, {
    method: 'POST',
    role: 'Supplier',
    body: {},
  }));
  if (result) {
    showNotice(
      result.usedFallback
        ? `Evidence Agent 預審已完成（LLM 不可用，已退回規則引擎：${result.fallbackReason || '未知原因'}）；這是衍生風險報告，不參與 Gate。`
        : 'Evidence Agent 預審已完成（LLM）；這是衍生風險報告，不參與 Gate。'
    );
    await runAction(loadRole);
  }
  return result;
}

async function revalidateTrust() {
  const result = await runAction(
    () => api('/api/workflow/revalidate', {
      method: 'POST',
      role: 'Supplier',
      body: {},
    })
  );
  if (!result) return null;
  await runAction(loadRole);
  const codes = result.readiness.reasonCodes || [];
  showNotice(
    result.readiness.status === 'READY_FOR_VERIFIER'
      ? 'Proof / Gate 重驗完成：READY_FOR_VERIFIER。此為 Demo commitment，非 zk-SNARK，也不證明物理真實。'
      : `${result.readiness.message} reason code: ${codes.join(', ') || 'SERVICE_UNAVAILABLE'}`
  );
  return result;
}

async function resetDirect() {
  await api('/api/workflow/reset', { method: 'POST', role: 'Supplier', body: {} });
  setToken('');
  saveGrant(null);
  $('opened-content').textContent = '';
  $('opened-evidence').hidden = true;
}

async function runActOne() {
  if (state.role !== 'Supplier') await switchRole('Supplier');
  const result = await runAction(async () => {
    await resetDirect();
    const uploaded = [];
    for (const seed of DEMO_EVIDENCE) {
      const created = await uploadEvidence({
        type: seed.type,
        filename: seed.filename,
        content: JSON.stringify({ entries: seed.entries }),
        mediaType: 'application/json',
        coveredFrom: '2026-01-01',
        coveredTo: '2026-12-31',
        source: `synthetic-demo-${seed.type}`,
      });
      uploaded.push(created.evidence);
    }
    for (const evidence of uploaded) {
      await api(`/api/evidence/${encodeURIComponent(evidence.evidenceId)}/confirm`, {
        method: 'POST',
        role: 'Supplier',
        body: { confirmed: true },
      });
    }
    await api(`/api/cases/${CASE_ID}/submit`, {
      method: 'POST',
      role: 'Supplier',
      body: {},
    });
    await api(`/api/cases/${CASE_ID}/agent/analyze`, {
      method: 'POST',
      role: 'Supplier',
      body: {},
    });
    const revalidated = await api('/api/workflow/revalidate', {
      method: 'POST',
      role: 'Supplier',
      body: {},
    });
    await loadRole();
    if (revalidated.case.status !== 'READY_FOR_VERIFIER') {
      throw {
        code: revalidated.readiness.reasonCodes[0] || 'SERVICE_UNAVAILABLE',
        message: revalidated.readiness.message,
      };
    }
    return revalidated;
  });
  if (result) {
    showNotice('幕 1 完成：案件已到 READY_FOR_VERIFIER；Agent 預審不參與 readiness。可再次點擊安全重跑。');
  }
}

async function createGrant() {
  const evidenceId = $('grant-evidence').value;
  const seconds = Number($('grant-seconds').value);
  if (!evidenceId) {
    showError({ code: 'EVIDENCE_IDS_REQUIRED' });
    return null;
  }
  const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  const result = await runAction(() => api('/api/vault/grants', {
    method: 'POST',
    role: 'Supplier',
    body: {
      caseId: CASE_ID,
      evidenceIds: [evidenceId],
      subject: VERIFIER_ID,
      expiresAt,
    },
  }));
  if (!result) return null;
  setToken(result.token);
  saveGrant({
    grantId: result.grant.grantId,
    evidenceId,
    expiresAt: result.grant.expiresAt,
    consumed: false,
    revoked: false,
    justCreated: true,
  });
  renderGrantControls();
  showNotice('短效 Grant 已建立。Token 只在此處顯示一次，切換 Verifier 後會從 session 暫存帶入。');
  await runAction(refreshAudit);
  return result;
}

async function runActTwo() {
  if (state.role !== 'Supplier') await switchRole('Supplier');
  if (!state.evidence.length) {
    showError({
      code: 'EVIDENCE_MISSING',
      message: '請先執行幕 1，才能為指定底稿建立 Grant。',
    });
    return;
  }
  const created = await createGrant();
  if (!created) return;
  await switchRole('Importer');
  showNotice('幕 2：Importer 目前只看 server 安全摘要。衍生報告不是底稿；可按「切 Verifier 並開底稿一次」。');
}

async function openActTwoVerifier() {
  if (!getToken() || !state.grant) {
    showError({ code: 'VAULT_ACCESS_DENIED' });
    return;
  }
  await switchRole('Verifier');
  $('verifier-evidence-select').value = state.grant.evidenceId;
  $('verifier-token').value = getToken();
  await openEvidence();
}

async function runAttackScenario(scenario) {
  const result = await runAction(() => api('/api/demo/attack', {
    method: 'POST',
    role: 'Supplier',
    body: { scenario },
  }));
  if (!result) return;
  const target = $('attack-result');
  target.replaceChildren();
  const decision = document.createElement('strong');
  decision.textContent = result.decision;
  const reasons = document.createElement('p');
  reasons.textContent = `reason code: ${result.reasonCodes.join(', ')}`;
  const next = document.createElement('p');
  next.textContent = '下一步：拒絕此輸入、修正案件／係數／Proof 綁定後重新送驗；正常案件未被修改。';
  target.append(decision, reasons, next);
}

async function runPhysicalBoundary() {
  const result = await runAction(() => api('/api/demo/physical-reality', {
    method: 'POST',
    body: {},
  }));
  if (!result) return;
  const target = $('physical-result');
  target.replaceChildren();
  const finding = document.createElement('strong');
  finding.textContent = result.finding;
  const scope = document.createElement('p');
  scope.textContent = `可驗範圍：${result.gateScope}；physicalRealityVerified: ${result.physicalRealityVerified}`;
  const next = document.createElement('p');
  next.textContent = `下一步：${result.nextStep}（${result.recommendedAction}）`;
  target.append(finding, scope, next);
}

async function revokeGrant() {
  if (!state.grant) {
    showError({ code: 'GRANT_NOT_FOUND' });
    return;
  }
  const result = await runAction(() => api(
    `/api/vault/grants/${encodeURIComponent(state.grant.grantId)}/revoke`,
    { method: 'POST', role: 'Supplier', body: {} }
  ));
  if (!result) return;
  setToken('');
  saveGrant({ ...state.grant, revoked: true, justCreated: false });
  $('grant-token').textContent = '';
  $('token-once').hidden = true;
  showNotice('Grant 已撤銷；Verifier 再使用會被拒絕。');
  await runAction(refreshAudit);
}

async function copyToken() {
  const token = getToken();
  if (!token) {
    showError({ code: 'VAULT_ACCESS_DENIED' });
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    showNotice('Token 已複製；請勿貼入 log 或 Audit。');
  } catch {
    showError({
      code: 'CLIPBOARD_UNAVAILABLE',
      message: '瀏覽器未允許剪貼簿操作。',
    });
  }
}

function clearToken() {
  setToken('');
  if (state.grant) saveGrant({ ...state.grant, justCreated: false });
  $('grant-token').textContent = '';
  $('token-once').hidden = true;
  $('verifier-token').value = '';
  showNotice('Token 已從 session 暫存與畫面清除。');
}

function clearVaultSession() {
  setToken('');
  saveGrant(null);
  $('verifier-token').value = '';
  $('grant-token').textContent = '';
  $('token-once').hidden = true;
  renderVerifierGrantState();
}

function downloadBytesEvidence(evidence, bytes) {
  const blob = new Blob([bytes], { type: evidence.mediaType || 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = evidence.filename || 'evidence-download';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

async function accessEvidence(mode) {
  const evidenceId = $('verifier-evidence-select').value;
  const token = $('verifier-token').value.trim();
  const suffix = mode === 'download' ? '/download' : '';
  const result = await runAction(async () => {
    try {
      return await api(
        `/api/vault/items/${encodeURIComponent(evidenceId)}${suffix}`,
        { role: 'Verifier', headers: { 'x-vault-token': token } }
      );
    } catch (error) {
      if (['GRANT_INVALID', 'GRANT_EXPIRED', 'GRANT_REVOKED'].includes(error.code)) {
        clearVaultSession();
      }
      throw error;
    }
  });
  if (!result) {
    try {
      await refreshAudit();
    } catch {
      // Preserve the actionable Vault error already shown to the user.
    }
    return;
  }
  clearVaultSession();
  // 一次性 Grant 已經在伺服器端消耗掉了（上面的 api() 呼叫已經拿到內容），這裡的解密
  // 失敗不該讓底稿「消失」——runAction() 會把 WebAuthn/解密錯誤顯示出來，不是留白裝沒事。
  // 只有 vaultEncrypted 的底稿才會真的觸發 WebAuthn 提示框，明碼底稿走 decryptFromVault()
  // 的快速路徑，不用特地換按鈕文字誤導使用者以為要等生物辨識。
  const actionButton = $(mode === 'download' ? 'download-evidence' : 'open-evidence');
  const plaintextBytes = result.evidence.vaultEncrypted
    ? await runActionWithDeviceVerification(actionButton, () => VaultCrypto.decryptFromVault(result.evidence))
    : await runAction(() => VaultCrypto.decryptFromVault(result.evidence));
  if (!plaintextBytes) {
    try {
      await refreshAudit();
    } catch {
      // Preserve the actionable Vault error already shown to the user.
    }
    return;
  }
  if (mode === 'download') {
    downloadBytesEvidence(result.evidence, plaintextBytes);
    showNotice('指定底稿已下載一次；Grant 與 session token 已清除。');
  } else {
    $('opened-content').textContent = VaultCryptoCore.bytesToUtf8(plaintextBytes);
    $('opened-evidence-vault-status').textContent = result.evidence.vaultEncrypted
      ? '🔒 已加密（Vault PRF）'
      : '⚠ 未加密（Verifier 當時尚未註冊裝置）';
    $('opened-evidence-vault-status').dataset.status = result.evidence.vaultEncrypted ? 'encrypted' : 'plaintext';
    $('opened-evidence').hidden = false;
    showNotice('指定底稿已開啟一次；Grant 與 session token 已清除。這不代表正式查驗完成。');
  }
  try {
    await refreshAudit();
  } catch {
    // The one-time access result remains authoritative even if audit refresh fails.
  }
}

async function openEvidence() {
  return accessEvidence('open');
}

async function downloadEvidence() {
  return accessEvidence('download');
}

function closeEvidence() {
  $('opened-content').textContent = '';
  $('opened-evidence').hidden = true;
  $('verifier-token').value = '';
  showNotice('底稿內容已從畫面記憶體清除。');
}

async function addFinding(event) {
  event.preventDefault();
  const result = await runAction(() => api(
    `/api/verifier/cases/${CASE_ID}/findings`,
    {
      method: 'POST',
      role: 'Verifier',
      body: {
        severity: $('finding-severity').value,
        summary: $('finding-summary').value,
      },
    }
  ), 'Finding 已記錄；案件仍不是正式查驗完成。');
  if (result) await runAction(loadRole);
}

async function resetWorkflow() {
  const result = await runAction(
    () => api('/api/workflow/reset', { method: 'POST', body: {} }),
    'Demo workflow 已重置。'
  );
  if (!result) return;
  setToken('');
  saveGrant(null);
  $('opened-content').textContent = '';
  $('opened-evidence').hidden = true;
  await runAction(loadRole);
}

function bindEvents() {
  document.querySelectorAll('.role-button').forEach((button) => {
    button.addEventListener('click', () => switchRole(button.dataset.role));
  });
  $('dev-tools-toggle').addEventListener('click', () => {
    setDevTools($('dev-tools-panel').hidden);
  });
  $('supplier-tools-toggle').addEventListener('click', () => {
    setSupplierTools($('supplier-tools-panel').hidden);
  });
  $('manual-form-toggle').addEventListener('click', () => {
    setManualForm($('manual-form-panel').hidden);
  });
  const settingsToggle = $('settings-toggle');
  const settingsPanel = $('settings-panel');
  const settingsScrim = $('settings-scrim');
  function setSettingsPanel(open) {
    settingsPanel.hidden = !open;
    settingsScrim.classList.toggle('open', open);
    settingsToggle.classList.toggle('open', open);
    settingsToggle.setAttribute('aria-expanded', String(open));
  }
  settingsToggle.addEventListener('click', () => setSettingsPanel(settingsPanel.hidden));
  settingsScrim.addEventListener('click', () => setSettingsPanel(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !settingsPanel.hidden) setSettingsPanel(false);
  });
  $('exec-view-switch').addEventListener('click', () => {
    setExecView(!$('agent-view').hidden);
  });
  $('evidence-form').addEventListener('submit', handleUpload);
  $('chat-attach-btn').addEventListener('click', () => $('chat-file-input').click());
  $('chat-file-input').addEventListener('change', (event) => handleChatFilesSelect(event.target.files));
  bindChatDropZone();
  $('chat-file-clear').addEventListener('click', () => {
    chatAttachedFile = null;
    renderChatFileChip();
    $('chat-file-input').value = '';
  });
  $('chat-send-btn').addEventListener('click', sendChatUpload);
  $('chat-text-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatUpload();
    }
  });
  $('evidence-drawer-toggle').addEventListener('click', () => {
    setEvidenceDrawer(!$('evidence-drawer').classList.contains('open'));
  });
  $('evidence-drawer-scrim').addEventListener('click', () => setEvidenceDrawer(false));
  $('seed-evidence').addEventListener('click', seedEvidence);
  $('run-agent-analysis').addEventListener('click', analyzeCase);
  $('revalidate-trust').addEventListener('click', revalidateTrust);
  $('confirm-all').addEventListener('click', confirmAll);
  $('submit-case').addEventListener('click', submitCase);
  $('create-grant').addEventListener('click', createGrant);
  $('revoke-grant').addEventListener('click', revokeGrant);
  $('copy-token').addEventListener('click', copyToken);
  $('clear-token').addEventListener('click', clearToken);
  $('register-vault-device').addEventListener('click', registerVaultDevice);
  $('open-evidence').addEventListener('click', openEvidence);
  $('download-evidence').addEventListener('click', downloadEvidence);
  $('close-evidence').addEventListener('click', closeEvidence);
  $('finding-form').addEventListener('submit', addFinding);
  $('refresh-audit').addEventListener('click', () => runAction(refreshAudit));
  $('reset-workflow').addEventListener('click', resetWorkflow);
  $('run-act-1').addEventListener('click', runActOne);
  $('run-act-2').addEventListener('click', runActTwo);
  $('open-act-2-verifier').addEventListener('click', openActTwoVerifier);
  document.querySelectorAll('.attack-button').forEach((button) => {
    button.addEventListener('click', () => runAttackScenario(button.dataset.scenario));
  });
  $('run-act-4').addEventListener('click', runPhysicalBoundary);
}

bindEvents();
switchRole('Supplier');
showToast({
  key: 'demo-disclaimer',
  variant: 'info',
  persistent: true,
  message: 'Demo role，不是真實認證。READY_FOR_VERIFIER 只代表具備送交查驗準備條件，不代表正式查驗完成或官方核准。',
});

/** Google OAuth 授權完成後，Google 會把瀏覽器導回這個網址並帶上 ?googleOauth=connected
 * 或 ?googleOauth=error&reason=...（見 server/apiFetch.js 對 /api/oauth/google/callback
 * 的特別處理）。這裡在聊天視窗裡回報結果，並把這兩個查詢參數從網址列清掉，避免使用者
 * 重新整理頁面時重複觸發。 */
(function handleGoogleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('googleOauth');
  if (!status) return;
  if (status === 'connected') {
    appendChatMessage({ role: 'ai', text: '✅ Google 帳號已連接，之後可以確認寄出補件通知或建立行事曆提醒。' });
  } else {
    const reason = params.get('reason') || 'unknown';
    appendChatMessage({ role: 'ai', text: `⚠ Google 帳號連接失敗（${reason}），請重新點擊「連接 Google 帳號」再試一次。` });
  }
  params.delete('googleOauth');
  params.delete('reason');
  const rest = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
})();
