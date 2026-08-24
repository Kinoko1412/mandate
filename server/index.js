'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { loadEnv } = require('./loadEnv');
loadEnv();

const { handleApiPath, jsonResponse } = require('./apiFetch');

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
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, {
        // Explicit demo-only role switch mapped to a fixed server-side whitelist.
        demoRole: req.headers['x-demo-role'] || url.searchParams.get('demoRole'),
        // Keep Vault credentials out of URLs and query logs.
        vaultToken: req.headers['x-vault-token'],
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
