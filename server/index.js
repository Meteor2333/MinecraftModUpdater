const http = require('node:http');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { URL } = require('node:url');
const { Agent } = require('undici');
const JSZip = require('jszip');

dns.setDefaultResultOrder('ipv4first');
const ipv4Dispatcher = new Agent({ connect: { family: 4 } });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CURSEFORGE_API_KEY = process.env.CURSEFORGE_API_KEY || '';
const REQUEST_INTERVAL_MS = 220;
const CACHE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 1_000_000;
const DIST_ROOT = path.resolve(__dirname, '..', 'dist', 'angular-mod-updater', 'browser');

let nextRequestAt = 0;
let requestQueue = Promise.resolve();
const cache = new Map();
const allowedDownloadHosts = new Set([
  'cdn.modrinth.com',
  'cdn-raw.modrinth.com',
  'edge.forgecdn.net',
  'mediafilez.forgecdn.net',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'objects-origin.githubusercontent.com'
]);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function isAllowedDownloadHost(hostname) {
  return (
    allowedDownloadHosts.has(hostname) ||
    hostname.endsWith('.modrinth.com') ||
    hostname.endsWith('.forgecdn.net') ||
    hostname.endsWith('.githubusercontent.com')
  );
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
}

function getUpstreamConfig(pathname) {
  if (
    pathname === '/api/modrinth/v2/projects' ||
    pathname === '/api/modrinth/v2/version_files' ||
    pathname === '/api/modrinth/v2/search' ||
    /^\/api\/modrinth\/v2\/project\/[A-Za-z0-9_-]+\/version$/.test(pathname)
  ) {
    return {
      prefix: '/api/modrinth',
      origin: 'https://api.modrinth.com',
      headers: {}
    };
  }

  if (/^\/api\/curseforge\/v1\/(mods|fingerprints)/.test(pathname)) {
    return {
      prefix: '/api/curseforge',
      origin: 'https://api.curseforge.com',
      headers: CURSEFORGE_API_KEY ? { 'x-api-key': CURSEFORGE_API_KEY } : {}
    };
  }

  if (/^\/api\/github\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases$/.test(pathname)) {
    return {
      prefix: '/api/github',
      origin: 'https://api.github.com',
      headers: {}
    };
  }

  if (pathname === '/api/mojang/mc/game/version_manifest.json') {
    return {
      prefix: '/api/mojang',
      origin: 'https://launchermeta.mojang.com',
      headers: {}
    };
  }

  return null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function waitForRateLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + REQUEST_INTERVAL_MS;
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function fetchModrinth(url, options) {
  const task = requestQueue.then(async () => {
    await waitForRateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      return await fetch(url, {
        ...options,
        dispatcher: ipv4Dispatcher,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  requestQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

function getCacheKey(method, requestUrl) {
  return `${method} ${requestUrl.toString()}`;
}

function getCachedResponse(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function storeCachedResponse(key, responseData) {
  if (cache.size >= 200) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { ...responseData, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getDownloadFilename(targetUrl) {
  const pathFilename = decodeURIComponent(
    targetUrl.pathname.split('/').pop() || 'download'
  ).replace(/[\\/\r\n"]/g, '_');
  return pathFilename.includes('.') ? pathFilename : 'download';
}

async function fetchDownload(target) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    throw new Error('下载地址无效');
  }

  if (targetUrl.protocol !== 'https:' || !isAllowedDownloadHost(targetUrl.hostname)) {
    throw new Error('下载地址不在允许的站点范围内');
  }

  let upstreamResponse;
  let currentUrl = targetUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    upstreamResponse = await fetch(currentUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': 'MinecraftModUpdater/1.0' },
      dispatcher: ipv4Dispatcher
    });

    if (upstreamResponse.status < 300 || upstreamResponse.status >= 400) {
      break;
    }

    const location = upstreamResponse.headers.get('location');
    if (!location) break;
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== 'https:' || !isAllowedDownloadHost(nextUrl.hostname)) {
      throw new Error('下载重定向地址不在允许的站点范围内');
    }
    currentUrl = nextUrl;
  }

  return { targetUrl, upstreamResponse };
}

async function proxyExternalApi(request, response, requestUrl) {
  const upstreamConfig = getUpstreamConfig(requestUrl.pathname);
  if (!upstreamConfig || !['GET', 'POST'].includes(request.method)) {
    sendJson(response, 404, { error: 'Unsupported external endpoint' });
    return;
  }

  const upstreamPath = requestUrl.pathname.replace(upstreamConfig.prefix, '') + requestUrl.search;
  const upstreamUrl = `${upstreamConfig.origin}${upstreamPath}`;
  const cacheKey = getCacheKey(request.method, requestUrl);
  const isCacheable = request.method === 'GET';
  const cached = isCacheable ? getCachedResponse(cacheKey) : null;

  if (cached) {
    response.writeHead(cached.status, {
      ...cached.headers,
      'X-Proxy-Cache': 'HIT'
    });
    response.end(cached.body);
    return;
  }

  let body;
  if (request.method === 'POST') {
    try {
      body = await readRequestBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchModrinth(upstreamUrl, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'MinecraftModUpdater/1.0',
        ...upstreamConfig.headers
      },
      body
    });
  } catch (error) {
    sendJson(response, 502, { error: 'Modrinth request failed', message: error.message });
    return;
  }

  const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const headers = {
    'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json',
    'Cache-Control': isCacheable ? 'public, max-age=60' : 'no-store',
    'X-Proxy-Cache': 'MISS'
  };
  for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers[name] = value;
  }

  if (isCacheable && upstreamResponse.ok) {
    storeCachedResponse(cacheKey, {
      status: upstreamResponse.status,
      headers: { ...headers, 'X-Proxy-Cache': 'HIT' },
      body: responseBody
    });
  }

  response.writeHead(upstreamResponse.status, headers);
  response.end(responseBody);
}

async function proxyDownload(response, requestUrl) {
  const target = requestUrl.searchParams.get('url');
  if (!target) {
    sendJson(response, 400, { error: 'Missing download URL' });
    return;
  }

  let upstreamResponse;
  try {
    ({ targetUrl, upstreamResponse } = await fetchDownload(target));
  } catch (error) {
    console.error('Download request failed:', target, error);
    sendJson(response, 502, { error: 'Download request failed', message: error.message });
    return;
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    sendJson(response, upstreamResponse.status, {
      error: `Download failed with status ${upstreamResponse.status}`
    });
    return;
  }

  const filename = getDownloadFilename(targetUrl);
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': upstreamResponse.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition':
      upstreamResponse.headers.get('content-disposition') ||
      `attachment; filename="${filename}"`
  };
  const contentLength = upstreamResponse.headers.get('content-length');
  if (contentLength) headers['Content-Length'] = contentLength;

  response.writeHead(200, headers);
  Readable.fromWeb(upstreamResponse.body).pipe(response);
}

async function proxyArchive(request, response) {
  let body;
  try {
    body = JSON.parse(
      (await readRequestBody(request)).toString('utf8').replace(/^\uFEFF/, '')
    );
  } catch {
    sendJson(response, 400, { error: '下载列表格式无效' });
    return;
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    sendJson(response, 400, { error: '下载列表为空' });
    return;
  }

  const zip = new JSZip();
  const failedFiles = [];
  let downloadedCount = 0;

  for (let index = 0; index < body.files.length; index += 4) {
    const batch = body.files.slice(index, index + 4);
    await Promise.all(
      batch.map(async (file) => {
        if (!file || typeof file.url !== 'string' || typeof file.filename !== 'string') {
          failedFiles.push('未知文件');
          return;
        }

        try {
          const { targetUrl, upstreamResponse } = await fetchDownload(file.url);
          if (!upstreamResponse.ok) {
            throw new Error(`HTTP ${upstreamResponse.status}`);
          }
          const filename = file.filename || getDownloadFilename(targetUrl);
          zip.file(filename.replace(/[\\/\r\n]/g, '_'), Buffer.from(await upstreamResponse.arrayBuffer()));
          downloadedCount++;
        } catch (error) {
          console.error('Archive download failed:', file.url, error);
          failedFiles.push(file.filename);
        }
      })
    );
  }

  if (downloadedCount === 0) {
    sendJson(response, 502, { error: '所有文件下载失败', failedFiles });
    return;
  }

  if (failedFiles.length > 0) {
    zip.file(
      '下载失败列表.txt',
      `以下文件下载失败：\n${failedFiles.join('\n')}\n`
    );
  }

  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="minecraft-mods.zip"',
    'Content-Length': archive.length,
    'X-Download-Failures': String(failedFiles.length)
  });
  response.end(archive);
}

function serveStatic(request, response, requestUrl) {
  let relativePath = decodeURIComponent(requestUrl.pathname);
  if (relativePath === '/') relativePath = '/index.html';
  const filePath = path.resolve(DIST_ROOT, `.${relativePath}`);

  if (!filePath.startsWith(DIST_ROOT)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    const target = !error && stats.isFile() ? filePath : path.join(DIST_ROOT, 'index.html');
    fs.readFile(target, (readError, content) => {
      if (readError) {
        response.writeHead(404);
        response.end('Frontend build not found. Run npm run build first.');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(target)] || 'application/octet-stream',
        'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
      });
      response.end(content);
    });
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (requestUrl.pathname === '/api/download' && request.method === 'GET') {
    await proxyDownload(response, requestUrl);
    return;
  }

  if (requestUrl.pathname === '/api/download/archive' && request.method === 'POST') {
    await proxyArchive(request, response);
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    await proxyExternalApi(request, response, requestUrl);
    return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    serveStatic(request, response, requestUrl);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Minecraft Mod Updater server listening on http://${HOST}:${PORT}`);
});
