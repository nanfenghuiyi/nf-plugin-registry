var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/registry.ts
var cache = null;
function registryUrls(env) {
  const { GITHUB_OWNER: owner, GITHUB_REPO: repo, GITHUB_BRANCH: branch } = env;
  return [
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/registry.json`,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/registry.json`
  ];
}
__name(registryUrls, "registryUrls");
function isValidRegistry(json2) {
  return !!(json2 && typeof json2 === "object" && Array.isArray(json2.plugins));
}
__name(isValidRegistry, "isValidRegistry");
async function getRegistry(env, force = false) {
  const ttl = (parseInt(env.REGISTRY_CACHE_TTL_SECONDS, 10) || 300) * 1e3;
  if (!force && cache && Date.now() - cache.fetchedAt < ttl) {
    return cache.data;
  }
  for (const url of registryUrls(env)) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8e3),
        // 边缘缓存 60s 防回源风暴（jsdelivr 源自带 CDN 缓存）
        cf: { cacheTtl: 60 }
      });
      if (!resp.ok) continue;
      const json2 = await resp.json();
      if (!isValidRegistry(json2)) continue;
      cache = { data: json2, fetchedAt: Date.now() };
      return json2;
    } catch {
    }
  }
  if (cache) return cache.data;
  throw new Error("registry \u62C9\u53D6\u5931\u8D25\u4E14\u65E0\u53EF\u7528\u7F13\u5B58");
}
__name(getRegistry, "getRegistry");

// src/normalize.ts
function semverCmp(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
__name(semverCmp, "semverCmp");
function latestVersionOf(p) {
  if (p.latestVersion && p.versions && p.versions[p.latestVersion]) {
    return p.latestVersion;
  }
  return Object.keys(p.versions || {}).sort(semverCmp).pop() || "";
}
__name(latestVersionOf, "latestVersionOf");
function toItem(p, origin, downloads) {
  const versions = p.versions || {};
  const latestVer = latestVersionOf(p);
  const latest = versions[latestVer] || {};
  const dates = Object.values(versions).map((v) => v.publishedAt || "").filter(Boolean).sort();
  const createdAt = dates[0] || (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: p.id,
    name: p.name || p.id,
    version: latestVer,
    description: p.description || "",
    author: p.author || "NF Team",
    icon: p.icon || "",
    type: p.type || "app",
    category: p.category || "tool",
    downloads,
    rating: 0,
    latestVersion: latestVer,
    changelog: latest.changelog || "\u521D\u59CB\u7248\u672C\u53D1\u5E03",
    dependencies: [],
    homepage: p.homepage || "",
    tags: Array.isArray(p.keywords) ? p.keywords : [],
    createdAt,
    updatedAt: dates[dates.length - 1] || createdAt,
    engine: p.engines || {},
    permissions: Array.isArray(p.permissions) ? p.permissions : [],
    signed: !!(latest.signature && latest.publicKey),
    checksum: latest.checksum || "",
    signature: latest.signature || "",
    publicKey: latest.publicKey || "",
    downloadUrl: `${origin}/api/download?id=${encodeURIComponent(p.id)}&version=${encodeURIComponent(latestVer)}`
  };
}
__name(toItem, "toItem");

// src/stats.ts
async function getAllCounts(db) {
  const map = /* @__PURE__ */ new Map();
  let total = 0;
  try {
    const { results } = await db.prepare("SELECT plugin_id, version, count FROM download_stats").all();
    for (const row of results || []) {
      map.set(`${row.plugin_id}@${row.version}`, row.count);
      total += row.count;
    }
  } catch {
  }
  return { map, total };
}
__name(getAllCounts, "getAllCounts");
async function incrementDownload(db, pluginId, version) {
  try {
    await db.prepare(
      `INSERT INTO download_stats (plugin_id, version, count, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(plugin_id, version)
         DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`
    ).bind(pluginId, version, (/* @__PURE__ */ new Date()).toISOString()).run();
  } catch {
  }
}
__name(incrementDownload, "incrementDownload");

// src/index.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra }
  });
}
__name(json, "json");
function tooMany() {
  return json({ code: 429, msg: "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 429, { "Retry-After": "60" });
}
__name(tooMany, "tooMany");
async function checkLimit(binding, key) {
  if (!binding?.limit) return true;
  try {
    const result = await binding.limit({ key });
    return result.success !== false;
  } catch {
    return true;
  }
}
__name(checkLimit, "checkLimit");
var recentCountKeys = /* @__PURE__ */ new Map();
function shouldCount(key, windowMs = 6e4) {
  const now = Date.now();
  const expiresAt = recentCountKeys.get(key);
  if (expiresAt && expiresAt > now) return false;
  recentCountKeys.set(key, now + windowMs);
  if (recentCountKeys.size > 5e3) {
    for (const [k, exp] of recentCountKeys) {
      if (exp <= now) recentCountKeys.delete(k);
    }
  }
  return true;
}
__name(shouldCount, "shouldCount");
function parseListParams(url) {
  const keyword = (url.searchParams.get("keyword") || url.searchParams.get("q") || "").toLowerCase().trim();
  const category = (url.searchParams.get("category") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "12", 10) || 12));
  const sortRaw = (url.searchParams.get("sort") || "downloads").toLowerCase();
  const sort = sortRaw === "newest" ? "newest" : "downloads";
  return { keyword, category, page, pageSize, sort };
}
__name(parseListParams, "parseListParams");
async function handleList(env, url) {
  const { keyword, category, page, pageSize, sort } = parseListParams(url);
  const registry = await getRegistry(env);
  const counts = await getAllCounts(env.DB);
  let items = registry.plugins.map(
    (p) => toItem(p, url.origin, counts.map.get(`${p.id}@${latestVersionOf(p)}`) || 0)
  );
  if (keyword) {
    items = items.filter(
      (it) => it.name.toLowerCase().includes(keyword) || it.description.toLowerCase().includes(keyword) || it.tags.some((t) => String(t).toLowerCase().includes(keyword))
    );
  }
  if (category) {
    items = items.filter((it) => it.category === category);
  }
  if (sort === "newest") {
    items.sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1);
  } else {
    items.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
  }
  const total = items.length;
  const start = (page - 1) * pageSize;
  return json({
    code: 200,
    msg: "success",
    data: { list: items.slice(start, start + pageSize), total, page, pageSize }
  });
}
__name(handleList, "handleList");
async function handleDetail(env, url, pluginId) {
  const registry = await getRegistry(env);
  const p = registry.plugins.find((x) => x.id === pluginId);
  if (!p) return json({ code: 404, msg: "\u63D2\u4EF6\u4E0D\u5B58\u5728" }, 404);
  const counts = await getAllCounts(env.DB);
  const item = toItem(p, url.origin, counts.map.get(`${p.id}@${latestVersionOf(p)}`) || 0);
  return json({ code: 200, msg: "success", data: item });
}
__name(handleDetail, "handleDetail");
async function handleVersions(env, pluginId) {
  const registry = await getRegistry(env);
  const p = registry.plugins.find((x) => x.id === pluginId);
  if (!p) return json({ code: 404, msg: "\u63D2\u4EF6\u4E0D\u5B58\u5728" }, 404);
  const versions = p.versions || {};
  const counts = await getAllCounts(env.DB);
  const list = Object.keys(versions).sort(semverCmp).map((ver) => {
    const v = versions[ver];
    return {
      version: ver,
      engines: p.engines || {},
      dependencies: [],
      changelog: v.changelog || "\u521D\u59CB\u7248\u672C\u53D1\u5E03",
      publishedAt: v.publishedAt || null,
      checksum: v.checksum || "",
      signed: !!(v.signature && v.publicKey),
      publicKey: v.publicKey || "",
      signature: v.signature || "",
      downloads: counts.map.get(`${pluginId}@${ver}`) || 0,
      compatibility: null
    };
  });
  const engineKeys = /* @__PURE__ */ new Set();
  list.forEach((v) => Object.keys(v.engines).forEach((k) => engineKeys.add(k)));
  const compatibilityMatrix = {};
  engineKeys.forEach((k) => {
    compatibilityMatrix[k] = list.map((v) => v.engines[k]).filter(Boolean);
  });
  return json({
    code: 200,
    msg: "success",
    data: {
      id: pluginId,
      latestVersion: latestVersionOf(p),
      versionCount: list.length,
      versions: list,
      compatibilityMatrix
    }
  });
}
__name(handleVersions, "handleVersions");
function safeRedirectTarget(env, downloadUrl, pluginId, version) {
  const prefixes = [
    `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/`,
    `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@`
  ];
  if (downloadUrl && prefixes.some((prefix) => downloadUrl.startsWith(prefix))) {
    return downloadUrl;
  }
  return `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/packages/${pluginId}/${version}.nfpkg`;
}
__name(safeRedirectTarget, "safeRedirectTarget");
async function handleDownload(env, url, ctx, ip) {
  const pluginId = url.searchParams.get("id");
  if (!pluginId) return json({ code: 400, msg: "\u7F3A\u5C11 id \u53C2\u6570" }, 400);
  const registry = await getRegistry(env);
  const p = registry.plugins.find((x) => x.id === pluginId);
  if (!p) return json({ code: 404, msg: "\u63D2\u4EF6\u4E0D\u5B58\u5728" }, 404);
  const versions = p.versions || {};
  const version = url.searchParams.get("version") || latestVersionOf(p);
  const v = versions[version];
  if (!v) return json({ code: 404, msg: `\u7248\u672C ${version} \u4E0D\u5B58\u5728` }, 404);
  const target = safeRedirectTarget(env, v.downloadUrl, pluginId, version);
  if (shouldCount(`${ip}:${pluginId}@${version}`)) {
    ctx.waitUntil(incrementDownload(env.DB, pluginId, version));
  }
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store", ...CORS_HEADERS }
  });
}
__name(handleDownload, "handleDownload");
async function handleCategories(env) {
  const registry = await getRegistry(env);
  const list = Object.entries(registry.categories || {}).map(([code, info]) => ({ code, name: info.name || code, count: info.count || 0 })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return json({ code: 200, msg: "success", data: list });
}
__name(handleCategories, "handleCategories");
async function handleStats(env) {
  const registry = await getRegistry(env);
  let versionCount = 0;
  registry.plugins.forEach((p) => versionCount += Object.keys(p.versions || {}).length);
  const counts = await getAllCounts(env.DB);
  return json({
    code: 200,
    msg: "success",
    data: { plugins: registry.plugins.length, versions: versionCount, totalDownloads: counts.total }
  });
}
__name(handleStats, "handleStats");
var src_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      if (request.method !== "GET") {
        return json({ code: 405, msg: "Method Not Allowed" }, 405);
      }
      if (path === "/health") {
        return json({
          status: "ok",
          registry: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}@${env.GITHUB_BRANCH}`,
          time: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      if (path.startsWith("/api/")) {
        const isDownload = path === "/api/download";
        const limiter = isDownload ? env.RATE_LIMITER_DOWNLOAD : env.RATE_LIMITER_API;
        if (!await checkLimit(limiter, isDownload ? `dl:${ip}` : `api:${ip}`)) {
          return tooMany();
        }
      }
      if (path === "/api/plugins" || path === "/api/search") return handleList(env, url);
      if (path === "/api/categories") return handleCategories(env);
      if (path === "/api/stats") return handleStats(env);
      if (path === "/api/download") return handleDownload(env, url, ctx, ip);
      const versionsMatch = path.match(/^\/api\/plugins\/([^/]+)\/versions$/);
      if (versionsMatch) return handleVersions(env, decodeURIComponent(versionsMatch[1]));
      const detailMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
      if (detailMatch) return handleDetail(env, url, decodeURIComponent(detailMatch[1]));
      return json({ code: 404, msg: "Not Found" }, 404);
    } catch (err) {
      return json({ code: 500, msg: err?.message || "Internal Error" }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-oUrNXb/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-oUrNXb/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
