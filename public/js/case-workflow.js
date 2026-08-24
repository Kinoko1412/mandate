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
  EVIDENCE_JSON_INVALID: ['Synthetic evidence 無法解析。', '重置 Demo 後重新載入固定四份文件。'],
  DEMO_SCENARIO_INVALID: ['攻擊情境不在 server allowlist。', '請使用控制台提供的三個固定情境。'],
  CLIPBOARD_UNAVAILABLE: ['瀏覽器未允許剪貼簿操作。', '可直接切換 Verifier，token 已保存在本次 session。'],
  INVALID_JSON: ['送出的資料格式無效。', '重新載入頁面後再試。'],
  INTERNAL_ERROR: ['伺服器暫時無法完成操作。', '稍後重試；若持續發生，檢查 server 狀態。'],
  NETWORK_UNAVAILABLE: ['無法連上本機 API。', '確認 npm start 正在執行，然後重新整理。'],
};

const state = {
  role: 'Supplier',
  actor: null,
  caseRecord: null,
  evidence: [],
  grant: readGrant(),
  busy: false,
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

async function runAction(action, successMessage) {
  clearMessages();
  setBusy(true);
  try {
    const result = await action();
    if (successMessage) showNotice(successMessage);
    return result;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    setBusy(false);
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
  const rows = state.evidence.map((item) => [
    item.evidenceId,
    item.type,
    item.filename,
    `${item.coveredFrom} → ${item.coveredTo}`,
    item.source,
    item.humanConfirmed ? '已人工確認' : '未確認',
  ]);
  replaceChildren(
    $('verifier-evidence'),
    [createTable(['ID', 'Type', 'Filename', 'Covered dates', 'Source', 'Confirm'], rows)]
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
  } else if (state.role === 'Importer') {
    const summary = await api(`/api/importer/cases/${CASE_ID}/summary`);
    renderImporter(summary);
  } else {
    const index = await api(`/api/verifier/cases/${CASE_ID}/evidence`);
    renderVerifier(detail.case, index);
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

async function uploadEvidence(input) {
  return api('/api/evidence', {
    method: 'POST',
    role: 'Supplier',
    body: {
      caseId: CASE_ID,
      filename: input.filename,
      mediaType: input.mediaType,
      contentBase64: utf8ToBase64(input.content),
      metadata: {
        type: input.type,
        coveredFrom: input.coveredFrom,
        coveredTo: input.coveredTo,
        source: input.source,
      },
    },
  });
}

async function handleUpload(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await runAction(
    () => uploadEvidence(Object.fromEntries(form.entries())),
    'Evidence 已安全上傳；原始內容不會出現在 Audit Timeline。'
  );
  if (result) await runAction(loadRole);
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

async function analyzeCase() {
  const result = await runAction(
    () => api(`/api/cases/${CASE_ID}/agent/analyze`, {
      method: 'POST',
      role: 'Supplier',
      body: {},
    }),
    'Evidence Agent 預審已完成；這是衍生風險報告，不參與 Gate。'
  );
  if (result) await runAction(loadRole);
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

function downloadBase64Evidence(evidence) {
  const binary = atob(evidence.contentBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
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
  if (mode === 'download') {
    downloadBase64Evidence(result.evidence);
    showNotice('指定底稿已下載一次；Grant 與 session token 已清除。');
  } else {
    $('opened-content').textContent = base64ToUtf8(result.evidence.contentBase64);
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
  $('evidence-form').addEventListener('submit', handleUpload);
  $('seed-evidence').addEventListener('click', seedEvidence);
  $('run-agent-analysis').addEventListener('click', analyzeCase);
  $('revalidate-trust').addEventListener('click', revalidateTrust);
  $('confirm-all').addEventListener('click', confirmAll);
  $('submit-case').addEventListener('click', submitCase);
  $('create-grant').addEventListener('click', createGrant);
  $('revoke-grant').addEventListener('click', revokeGrant);
  $('copy-token').addEventListener('click', copyToken);
  $('clear-token').addEventListener('click', clearToken);
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
