const http = require("node:http");
const dns = require("node:dns");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { URL } = require("node:url");
const crypto = require("node:crypto");
const os = require("node:os");
const { Agent } = require("undici");
const JSZip = require("jszip");

dns.setDefaultResultOrder("ipv4first");
const ipv4Dispatcher = new Agent({ connect: { family: 4 } });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CURSEFORGE_API_KEY = process.env.CURSEFORGE_API_KEY || "";
const REQUEST_INTERVAL_MS = 220;
const CACHE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 1_000_000;
const ARCHIVE_TTL_MS = 5 * 60_000;
const ARCHIVE_MAX_FILES = 500;
const ARCHIVE_MAX_FILE_BYTES = 128 * 1024 * 1024;
const ARCHIVE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const ARCHIVE_FETCH_TIMEOUT_MS = 120_000;
const ARCHIVE_DIR = path.join(os.tmpdir(), "minecraft-mod-updater-archives");
const DIST_ROOT = path.resolve(
  __dirname,
  "..",
  "dist",
  "angular-mod-updater",
  "browser"
);

let nextRequestAt = 0;
let requestQueue = Promise.resolve();
const cache = new Map();
const archiveJobs = new Map();
const allowedDownloadHosts = new Set([
  "cdn.modrinth.com",
  "cdn-raw.modrinth.com",
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "objects-origin.githubusercontent.com"
]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function isAllowedDownloadHost(hostname) {
  return (
    allowedDownloadHosts.has(hostname) ||
    hostname.endsWith(".modrinth.com") ||
    hostname.endsWith(".forgecdn.net") ||
    hostname.endsWith(".githubusercontent.com")
  );
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function getUpstreamConfig(pathname) {
  if (
    pathname === "/api/modrinth/v2/projects" ||
    pathname === "/api/modrinth/v2/version_files" ||
    pathname === "/api/modrinth/v2/search" ||
    /^\/api\/modrinth\/v2\/project\/[A-Za-z0-9_-]+\/version$/.test(pathname)
  ) {
    return {
      prefix: "/api/modrinth",
      origin: "https://api.modrinth.com",
      headers: {}
    };
  }

  if (/^\/api\/curseforge\/v1\/(mods|fingerprints)/.test(pathname)) {
    return {
      prefix: "/api/curseforge",
      origin: "https://api.curseforge.com",
      headers: CURSEFORGE_API_KEY ? { "x-api-key": CURSEFORGE_API_KEY } : {}
    };
  }

  if (
    /^\/api\/github\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases$/.test(
      pathname
    )
  ) {
    return {
      prefix: "/api/github",
      origin: "https://api.github.com",
      headers: {}
    };
  }

  if (pathname === "/api/mojang/mc/game/version_manifest.json") {
    return {
      prefix: "/api/mojang",
      origin: "https://launchermeta.mojang.com",
      headers: {}
    };
  }

  return null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
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
    targetUrl.pathname.split("/").pop() || "download"
  ).replace(/[\\/\r\n"]/g, "_");
  return pathFilename.includes(".") ? pathFilename : "download";
}

async function fetchDownload(target) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    throw new Error("下载地址无效");
  }

  if (
    targetUrl.protocol !== "https:" ||
    !isAllowedDownloadHost(targetUrl.hostname)
  ) {
    throw new Error("下载地址不在允许的站点范围内");
  }

  let upstreamResponse;
  let currentUrl = targetUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ARCHIVE_FETCH_TIMEOUT_MS
    );
    try {
      upstreamResponse = await fetch(currentUrl, {
        redirect: "manual",
        headers: { "User-Agent": "MinecraftModUpdater/1.0" },
        dispatcher: ipv4Dispatcher,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (upstreamResponse.status < 300 || upstreamResponse.status >= 400) {
      break;
    }

    const location = upstreamResponse.headers.get("location");
    if (!location) break;
    const nextUrl = new URL(location, currentUrl);
    if (
      nextUrl.protocol !== "https:" ||
      !isAllowedDownloadHost(nextUrl.hostname)
    ) {
      throw new Error("下载重定向地址不在允许的站点范围内");
    }
    currentUrl = nextUrl;
  }

  return { targetUrl, upstreamResponse };
}

async function proxyExternalApi(request, response, requestUrl) {
  const upstreamConfig = getUpstreamConfig(requestUrl.pathname);
  if (!upstreamConfig || !["GET", "POST"].includes(request.method)) {
    sendJson(response, 404, { error: "Unsupported external endpoint" });
    return;
  }

  const upstreamPath =
    requestUrl.pathname.replace(upstreamConfig.prefix, "") + requestUrl.search;
  const upstreamUrl = `${upstreamConfig.origin}${upstreamPath}`;
  const cacheKey = getCacheKey(request.method, requestUrl);
  const isCacheable = request.method === "GET";
  const cached = isCacheable ? getCachedResponse(cacheKey) : null;

  if (cached) {
    response.writeHead(cached.status, {
      ...cached.headers,
      "X-Proxy-Cache": "HIT"
    });
    response.end(cached.body);
    return;
  }

  let body;
  if (request.method === "POST") {
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
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "MinecraftModUpdater/1.0",
        ...upstreamConfig.headers
      },
      body
    });
  } catch (error) {
    sendJson(response, 502, {
      error: "Modrinth request failed",
      message: error.message
    });
    return;
  }

  const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  const headers = {
    "Content-Type":
      upstreamResponse.headers.get("content-type") || "application/json",
    "Cache-Control": isCacheable ? "public, max-age=60" : "no-store",
    "X-Proxy-Cache": "MISS"
  };
  for (const name of [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset"
  ]) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers[name] = value;
  }

  if (isCacheable && upstreamResponse.ok) {
    storeCachedResponse(cacheKey, {
      status: upstreamResponse.status,
      headers: { ...headers, "X-Proxy-Cache": "HIT" },
      body: responseBody
    });
  }

  response.writeHead(upstreamResponse.status, headers);
  response.end(responseBody);
}

async function proxyDownload(response, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target) {
    sendJson(response, 400, { error: "Missing download URL" });
    return;
  }

  let upstreamResponse;
  try {
    ({ targetUrl, upstreamResponse } = await fetchDownload(target));
  } catch (error) {
    console.error("Download request failed:", target, error);
    sendJson(response, 502, {
      error: "Download request failed",
      message: error.message
    });
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
    "Cache-Control": "no-store",
    "Content-Type":
      upstreamResponse.headers.get("content-type") ||
      "application/octet-stream",
    "Content-Disposition":
      upstreamResponse.headers.get("content-disposition") ||
      `attachment; filename="${filename}"`
  };
  const contentLength = upstreamResponse.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;

  response.writeHead(200, headers);
  Readable.fromWeb(upstreamResponse.body).pipe(response);
}

async function createArchiveJob(request, response) {
  let body;
  try {
    body = JSON.parse(
      (await readRequestBody(request)).toString("utf8").replace(/^\uFEFF/, "")
    );
  } catch {
    sendJson(response, 400, { error: "下载列表格式无效" });
    return;
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    sendJson(response, 400, { error: "下载列表为空" });
    return;
  }

  if (body.files.length > ARCHIVE_MAX_FILES) {
    sendJson(response, 413, { error: `最多支持 ${ARCHIVE_MAX_FILES} 个文件` });
    return;
  }
  const files = body.files.map((file) => ({
    filename: typeof file?.filename === "string" ? file.filename : "",
    url: typeof file?.url === "string" ? file.url : ""
  }));
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  const existing = [...archiveJobs.values()].find(
    (job) =>
      job.hash === hash &&
      job.status !== "failed" &&
      (!job.expiresAt || job.expiresAt > Date.now())
  );
  if (existing) {
    sendJson(response, 202, archiveJobResponse(existing));
    return;
  }
  const job = {
    id: crypto.randomUUID(),
    downloadId: crypto.randomUUID(),
    hash,
    status: "queued",
    completed: 0,
    total: files.length,
    failures: 0,
    createdAt: Date.now(),
    expiresAt: 0,
    archivePath: "",
    error: ""
  };
  archiveJobs.set(job.id, job);
  sendJson(response, 202, archiveJobResponse(job));
  setImmediate(() => buildArchive(job, files));
}

async function readLimitedBody(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, ARCHIVE_FETCH_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (timedOut) throw new Error("源文件下载超时");
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("文件超过大小限制");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function archiveJobResponse(job) {
  return {
    id: job.id,
    status: job.status,
    completed: job.completed,
    total: job.total,
    failures: job.failures,
    downloadUrl:
      job.status === "ready" ? `/api/download/archive/${job.downloadId}` : null,
    expiresAt: job.expiresAt || null,
    error: job.error || null
  };
}

async function buildArchive(job, files) {
  const zip = new JSZip();
  const failedFiles = [];
  const usedNames = new Set();
  let downloadedCount = 0;
  let totalBytes = 0;
  job.status = "processing";
  try {
    for (let index = 0; index < files.length; index += 4) {
      await Promise.all(
        files.slice(index, index + 4).map(async (file) => {
          try {
            if (!file.url || !file.filename) throw new Error("无效文件条目");
            const { targetUrl, upstreamResponse } = await fetchDownload(
              file.url
            );
            if (!upstreamResponse.ok || !upstreamResponse.body)
              throw new Error(`HTTP ${upstreamResponse.status}`);
            const declaredSize = Number(
              upstreamResponse.headers.get("content-length")
            );
            if (
              Number.isFinite(declaredSize) &&
              declaredSize > ARCHIVE_MAX_FILE_BYTES
            ) {
              await upstreamResponse.body.cancel();
              throw new Error("文件超过大小限制");
            }
            const data = await readLimitedBody(
              upstreamResponse,
              ARCHIVE_MAX_FILE_BYTES
            );
            if (totalBytes + data.length > ARCHIVE_MAX_TOTAL_BYTES)
              throw new Error("归档总大小超过 512 MiB 限制");
            totalBytes += data.length;
            const baseName =
              file.filename.replace(/[\\/\r\n]/g, "_") ||
              getDownloadFilename(targetUrl);
            let safeName = baseName;
            let suffix = 2;
            while (usedNames.has(safeName)) {
              const extensionIndex = baseName.lastIndexOf(".");
              safeName =
                extensionIndex > 0
                  ? `${baseName.slice(0, extensionIndex)} (${suffix++})${baseName.slice(extensionIndex)}`
                  : `${baseName} (${suffix++})`;
            }
            usedNames.add(safeName);
            zip.file(safeName, data);
            downloadedCount++;
          } catch (error) {
            console.error("Archive download failed:", file.url, error);
            failedFiles.push(file.filename || "未知文件");
          } finally {
            job.completed++;
          }
        })
      );
    }
    if (!downloadedCount) throw new Error("所有文件下载失败");
    if (failedFiles.length)
      zip.file(
        "下载失败列表.txt",
        `以下文件下载失败：\n${failedFiles.join("\n")}\n`
      );
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
    job.archivePath = path.join(ARCHIVE_DIR, `${job.downloadId}.zip`);
    await pipeline(
      zip.generateNodeStream({
        streamFiles: true,
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      }),
      fs.createWriteStream(job.archivePath, { flags: "wx" })
    );
    job.failures = failedFiles.length;
    job.status = "ready";
    job.expiresAt = Date.now() + ARCHIVE_TTL_MS;
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "服务器打包下载失败";
    job.expiresAt = Date.now() + ARCHIVE_TTL_MS;
  }
}

function serveArchiveJob(jobId, response) {
  const job = archiveJobs.get(jobId);
  if (!job || (job.expiresAt && job.expiresAt <= Date.now())) {
    sendJson(response, 404, { error: "打包任务不存在或已过期" });
    return;
  }
  sendJson(response, 200, archiveJobResponse(job));
}

function downloadArchive(downloadId, request, response) {
  const job = [...archiveJobs.values()].find(
    (item) => item.downloadId === downloadId
  );
  if (!job || job.status !== "ready" || job.expiresAt <= Date.now()) {
    sendJson(response, 404, { error: "下载链接不存在或已过期" });
    return;
  }
  fs.stat(job.archivePath, (error, stats) => {
    if (error) {
      sendJson(response, 404, { error: "归档文件已清理" });
      return;
    }
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = stats.size - 1;
    let statusCode = 200;
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Number(range[2]);
      if (!range[1] && range[2])
        start = Math.max(0, stats.size - Number(range[2]));
      end = Math.min(end, stats.size - 1);
      if (
        start > end ||
        start >= stats.size ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end)
      ) {
        response.writeHead(416, {
          "Content-Range": `bytes */${stats.size}`,
          "Cache-Control": "no-store"
        });
        response.end();
        return;
      }
      statusCode = 206;
    }
    const headers = {
      "Cache-Control": "private, no-store",
      "X-Accel-Buffering": "no",
      "Accept-Ranges": "bytes",
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="minecraft-mods.zip"',
      "Content-Length": end - start + 1,
      "X-Download-Failures": String(job.failures)
    };
    if (statusCode === 206)
      headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
    response.writeHead(statusCode, headers);
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(job.archivePath, { start, end }).pipe(response);
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of archiveJobs) {
    if (job.expiresAt && job.expiresAt <= now) {
      archiveJobs.delete(id);
      if (job.archivePath)
        fs.promises.rm(job.archivePath, { force: true }).catch(() => {});
    }
  }
}, 30_000).unref();

function serveStatic(request, response, requestUrl) {
  let relativePath = decodeURIComponent(requestUrl.pathname);
  if (relativePath === "/") relativePath = "/index.html";
  const filePath = path.resolve(DIST_ROOT, `.${relativePath}`);

  if (!filePath.startsWith(DIST_ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    const target =
      !error && stats.isFile() ? filePath : path.join(DIST_ROOT, "index.html");
    fs.readFile(target, (readError, content) => {
      if (readError) {
        response.writeHead(404);
        response.end("Frontend build not found. Run npm run build first.");
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          contentTypes[path.extname(target)] || "application/octet-stream",
        "Cache-Control": target.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable"
      });
      response.end(content);
    });
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`
  );

  if (requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (requestUrl.pathname === "/api/download" && request.method === "GET") {
    await proxyDownload(response, requestUrl);
    return;
  }

  if (
    requestUrl.pathname === "/api/download/archive/jobs" &&
    request.method === "POST"
  ) {
    await createArchiveJob(request, response);
    return;
  }

  const jobMatch = requestUrl.pathname.match(
    /^\/api\/download\/archive\/jobs\/([0-9a-f-]+)$/i
  );
  if (jobMatch && request.method === "GET") {
    serveArchiveJob(jobMatch[1], response);
    return;
  }

  const archiveMatch = requestUrl.pathname.match(
    /^\/api\/download\/archive\/([0-9a-f-]+)$/i
  );
  if (archiveMatch && ["GET", "HEAD"].includes(request.method)) {
    downloadArchive(archiveMatch[1], request, response);
    return;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    await proxyExternalApi(request, response, requestUrl);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    serveStatic(request, response, requestUrl);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(
    `Minecraft Mod Updater server listening on http://${HOST}:${PORT}`
  );
});
