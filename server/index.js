'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { loadEnv } = require('./loadEnv');
loadEnv();

const { handleApiPath, jsonResponse } = require('./apiFetch');
const { handleGoogleOAuthCallback } = require('./workflowApi');

const PORT = 3847;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (path.basename(rel).includes('.bak-')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  });
}

async function handleApi(req, res, pathname, requestContext) {
  const method = req.method || 'GET';
  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, {
        code: 'INVALID_JSON',
        message: 'JSON request body 格式無效。',
        retryable: false,
        details: null,
      });
    }
  }
  try {
    const result = await handleApiPath(method, pathname, body, requestContext);
    return sendJson(res, result.status, result.body);
  } catch (err) {
    return sendJson(res, 500, {
      code: 'INTERNAL_ERROR',
      message: '伺服器暫時無法處理此請求。',
      retryable: false,
      details: null,
    });
  }
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const pathname = url.pathname;

  try {
    // Google 導回瀏覽器的重新導向端點——不是 x-demo-role 認證的一般 API 呼叫，回應也不是
    // JSON，而是把瀏覽器導回首頁。跟 apiFetch.js 的 handleFetchRequest() 用同一份邏輯，
    // 但這個本機 Node entry 是自己組 request/response（沒有走 handleFetchRequest），
    // 所以要在這裡另外特別處理一次，不能只改 apiFetch.js 那邊。
    if (req.method === 'GET' && pathname === '/api/oauth/google/callback') {
      const { redirectTo } = await handleGoogleOAuthCallback(url);
      res.writeHead(302, { Location: redirectTo });
      res.end();
      return;
    }
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, {
        // Explicit demo-only role switch mapped to a fixed server-side whitelist.
        demoRole: req.headers['x-demo-role'] || url.searchParams.get('demoRole'),
        // Keep Vault credentials out of URLs and query logs.
        vaultToken: req.headers['x-vault-token'],
        // GS1/DPP 分層揭露示意（services/dpp）：public/customer/customs，跟上面的
        // demoRole（案件參與者角色）是不同軸線，故意分開一個查詢參數。
        dppRole: url.searchParams.get('role'),
        // Google OAuth redirect_uri 要跟目前網域完全一致，見 workflowApi.js
        // googleRedirectUri()——本機測試要記得把 http://localhost:3847/api/oauth/
        // google/callback 也加進 Google Cloud Console 的已授權重新導向 URI。
        origin: url.origin,
      });
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, {
      code: 'INTERNAL_ERROR',
      message: '伺服器暫時無法處理此請求。',
      retryable: false,
      details: null,
    });
  }
});

server.listen(PORT, () => {
  console.log(`Mandate API listening on http://127.0.0.1:${PORT}`);
});

module.exports = { handleApiPath, jsonResponse };
