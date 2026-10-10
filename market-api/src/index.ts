/**
 * NF Client 插件市场 API（Cloudflare Workers）
 *
 * 职责：索引服务（搜索/分类/分页/排序）+ 下载统计 + 速率限制
 *       + 阶段 3：开发者门户（OAuth / 发布 / 审核 / 评分）。
 * 官方插件包不落盘：/api/download 由 Worker 实时回源官方仓库并流式转发
 * （原 302 跳转方案在客户端网络无法直连 GitHub 时不可用，改为边缘中转）；
 * 第三方待发布包体暂存 KV（审批通过后由核心成员 drain 签名合入 registry）。
 * 包的信任边界仍在客户端（checksum + Ed25519 强验签 + registry.sig 索引签名）。
 *
 * 契约对齐 tools/plugin-market/server.js，客户端 REST 分支零适配。
 */
import type { Env, MarketItem, RateLimitBinding, RegistryPlugin, Responder } from './types';
import { getCachedRaw, getCachedSignature, getRegistry } from './registry.ts';
import { latestVersionOf, semverCmp, toItem } from './normalize.ts';
import { getAllCounts, incrementDownload } from './stats.ts';
import { applyBlocklist, getBlocked } from './blocklist.ts';
import { handlePublish } from './publish.ts';
import {
  handleAdminSubmissions,
  handleMySubmissions,
  handlePull,
  handleQueueAck,
  handleQueueItem,
  handleReleaseQueue,
  handleReviewDecision,
  handleSubmitForReview,
  handleUnpull,
} from './review.ts';
import {
  handleDeleteReview,
  handleHideReview,
  handleListReviews,
  handlePostReview,
  getRating,
  getRatings,
} from './reviews.ts';
import {
  handleMe,
  handleOAuthCallback,
  handleOAuthLogin,
  handleTokenRevoke,
  handleTokens,
} from './portal.ts';
import { handleCreateOrder, handleMockPay, handleGetLicense } from './payments.ts';

/** 固定 CORS 头（Origin 白名单之外的请求） */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  // 阶段 3：客户端/门户需读取索引签名头
  'Access-Control-Expose-Headers': 'X-Registry-Signature',
  'Access-Control-Max-Age': '86400',
};

/**
 * 按请求构造 responder：门户 Pages 域名（PORTAL_ORIGIN）白名单内回显 Origin
 * 并允许凭据（cookie 会话）；其余请求保持 Access-Control-Allow-Origin: *。
 * isolate 在 await 点会交叉处理多个请求，故必须按请求构造，禁止模块级缓存。
 */
function createResponder(request: Request, env: Env): Responder {
  const cors: Record<string, string> = { ...CORS_HEADERS };
  const origin = request.headers.get('Origin');
  if (origin && env.PORTAL_ORIGIN && origin === env.PORTAL_ORIGIN) {
    cors['Access-Control-Allow-Origin'] = origin;
    cors['Access-Control-Allow-Credentials'] = 'true';
    cors['Vary'] = 'Origin';
  } else {
    cors['Access-Control-Allow-Origin'] = '*';
  }

  return {
    cors,
    json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...cors,
          ...extra,
        },
      });
    },
    redirect(location: string, setCookies: string[] = []): Response {
      const headers = new Headers({
        Location: location,
        'Cache-Control': 'no-store',
      });
      for (const c of setCookies) headers.append('Set-Cookie', c);
      return new Response(null, { status: 302, headers });
    },
  };
}

function tooMany(rsp: Responder): Response {
  return rsp.json({ code: 429, msg: '请求过于频繁，请稍后重试' }, 429, { 'Retry-After': '60' });
}

/** 速率限制检查；binding 异常时 fail-open，不影响可用性 */
async function checkLimit(binding: RateLimitBinding | undefined, key: string): Promise<boolean> {
  if (!binding?.limit) return true;
  try {
    const result = await binding.limit({ key });
    return result.success !== false;
  } catch {
    return true;
  }
}

// ---------- 下载计数去重（isolate 内 60s 窗口，MVP 级防刷） ----------
const recentCountKeys = new Map<string, number>();
function shouldCount(key: string, windowMs = 60_000): boolean {
  const now = Date.now();
  const expiresAt = recentCountKeys.get(key);
  if (expiresAt && expiresAt > now) return false;
  recentCountKeys.set(key, now + windowMs);
  if (recentCountKeys.size > 5000) {
    for (const [k, exp] of recentCountKeys) {
      if (exp <= now) recentCountKeys.delete(k);
    }
  }
  return true;
}

// ---------- 列表 / 搜索 ----------

interface ListParams {
  keyword: string;
  category: string;
  page: number;
  pageSize: number;
  sort: 'downloads' | 'newest';
}

function parseListParams(url: URL): ListParams {
  const keyword = (url.searchParams.get('keyword') || url.searchParams.get('q') || '').toLowerCase().trim();
  const category = (url.searchParams.get('category') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '12', 10) || 12));
  const sortRaw = (url.searchParams.get('sort') || 'downloads').toLowerCase();
  const sort: ListParams['sort'] = sortRaw === 'newest' ? 'newest' : 'downloads';
  return { keyword, category, page, pageSize, sort };
}

async function handleList(env: Env, rsp: Responder, url: URL): Promise<Response> {
  const { keyword, category, page, pageSize, sort } = parseListParams(url);
  const [rawRegistry, counts, blocked] = await Promise.all([
    getRegistry(env),
    getAllCounts(env.DB),
    getBlocked(env),
  ]);
  // 下架名单：索引层立即剔除（设计 七），无需等待 registry 变更
  const registry = applyBlocklist(rawRegistry, blocked);
  // 评分聚合：0002 迁移未应用时降级为 0，不阻塞索引（fail-open）
  const ratings = await safeRatings(env, registry.plugins.map((p) => p.id));

  let items: MarketItem[] = registry.plugins.map((p) =>
    toItem(
      p,
      url.origin,
      counts.map.get(`${p.id}@${latestVersionOf(p)}`) || 0,
      ratings.get(p.id),
    ),
  );

  if (keyword) {
    items = items.filter(
      (it) =>
        it.name.toLowerCase().includes(keyword) ||
        it.description.toLowerCase().includes(keyword) ||
        it.tags.some((t) => String(t).toLowerCase().includes(keyword)),
    );
  }
  if (category) {
    items = items.filter((it) => it.category === category);
  }

  if (sort === 'newest') {
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } else {
    // 默认：下载量降序，同量按名称稳定排序
    items.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  return rsp.json(
    {
      code: 200,
      msg: 'success',
      data: { list: items.slice(start, start + pageSize), total, page, pageSize },
    },
    200,
    sigHeaders(),
  );
}

// ---------- registry.json 原始字节 + registry.sig ----------

/**
 * GET /api/registry：回传 registry.json **原始字节**（非重新序列化），
 * 并通过 X-Registry-Signature 头透传根密钥签名，供客户端做索引完整性校验
 * （阶段 3 信任链 T0：Workers 被攻破也无法换钥/换包）。
 */
async function handleRawRegistry(env: Env, rsp: Responder): Promise<Response> {
  await getRegistry(env);
  const raw = getCachedRaw();
  if (!raw) return rsp.json({ code: 502, msg: 'registry 不可用' }, 502);

  return new Response(raw, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      ...rsp.cors,
      ...sigHeaders(),
    },
  });
}

// ---------- 详情 / 版本 ----------

async function handleDetail(env: Env, rsp: Responder, url: URL, pluginId: string): Promise<Response> {
  const [rawRegistry, blocked] = await Promise.all([getRegistry(env), getBlocked(env)]);
  const p = applyBlocklist(rawRegistry, blocked).plugins.find((x) => x.id === pluginId);
  if (!p) return rsp.json({ code: 404, msg: '插件不存在或已下架' }, 404);

  const counts = await getAllCounts(env.DB);
  const item = toItem(
    p,
    url.origin,
    counts.map.get(`${p.id}@${latestVersionOf(p)}`) || 0,
    await safeRating(env, p.id),
  );
  return rsp.json({ code: 200, msg: 'success', data: item }, 200, sigHeaders());
}

async function handleVersions(env: Env, rsp: Responder, pluginId: string): Promise<Response> {
  const [rawRegistry, blocked] = await Promise.all([getRegistry(env), getBlocked(env)]);
  const p = applyBlocklist(rawRegistry, blocked).plugins.find((x) => x.id === pluginId);
  if (!p) return rsp.json({ code: 404, msg: '插件不存在或已下架' }, 404);

  const versions = p.versions || {};
  const counts = await getAllCounts(env.DB);

  const list = Object.keys(versions)
    .sort(semverCmp)
    .map((ver) => {
      const v = versions[ver];
      return {
        version: ver,
        engines: p.engines || {},
        dependencies: [],
        changelog: v.changelog || '初始版本发布',
        publishedAt: v.publishedAt || null,
        checksum: v.checksum || '',
        signed: !!(v.signature && v.publicKey),
        publicKey: v.publicKey || '',
        signature: v.signature || '',
        downloads: counts.map.get(`${pluginId}@${ver}`) || 0,
        compatibility: null,
      };
    });

  // 兼容矩阵：汇总各版本 engines 的约束
  const engineKeys = new Set<string>();
  list.forEach((v) => Object.keys(v.engines).forEach((k) => engineKeys.add(k)));
  const compatibilityMatrix: Record<string, string[]> = {};
  engineKeys.forEach((k) => {
    compatibilityMatrix[k] = list.map((v) => v.engines[k]).filter(Boolean);
  });

  return rsp.json({
    code: 200,
    msg: 'success',
    data: {
      id: pluginId,
      latestVersion: latestVersionOf(p),
      versionCount: list.length,
      versions: list,
      compatibilityMatrix,
    },
  });
}

// ---------- 下载（Worker 回源代理 + 计数） ----------

/** 回源地址必须落在官方仓库前缀白名单内（registry 被篡改时兜底） */
function safePackageTarget(
  env: Env,
  downloadUrl: string | undefined,
  pluginId: string,
  version: string,
): string {
  const prefixes = [
    `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/`,
    `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@`,
  ];
  if (downloadUrl && prefixes.some((prefix) => downloadUrl.startsWith(prefix))) {
    return downloadUrl;
  }
  // downloadUrl 缺失或不在白名单内：按仓库结构回退构造 raw 地址
  return `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/packages/${pluginId}/${version}.nfpkg`;
}

/**
 * Worker 侧回源拉取包文件并流式转发：客户端网络可能无法直连 GitHub/jsdelivr，
 * 由边缘网络代取（raw.githubusercontent.com 失败时按仓库结构派生 jsdelivr 重试）。
 * 包地址含版本号且包发布后不可变，可安全启用边缘缓存。
 */
async function proxyPackage(env: Env, target: string): Promise<Response | null> {
  const sources = [target];
  const rawPrefix = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/`;
  if (target.startsWith(rawPrefix)) {
    const rel = target.slice(rawPrefix.length);
    sources.push(
      `https://cdn.jsdelivr.net/gh/${env.GITHUB_OWNER}/${env.GITHUB_REPO}@${env.GITHUB_BRANCH}/${rel}`,
    );
  }
  for (const source of sources) {
    try {
      const r = await fetch(source, {
        headers: { 'User-Agent': 'nf-market-api' },
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      if (r.ok && r.body) return r;
    } catch {
      // 单源网络异常：尝试下一源
    }
  }
  return null;
}

async function handleDownload(
  env: Env,
  rsp: Responder,
  url: URL,
  ctx: ExecutionContext,
  ip: string,
): Promise<Response> {
  const pluginId = url.searchParams.get('id');
  if (!pluginId) return rsp.json({ code: 400, msg: '缺少 id 参数' }, 400);

  const [rawRegistry, blocked] = await Promise.all([getRegistry(env), getBlocked(env)]);
  const p: RegistryPlugin | undefined = applyBlocklist(rawRegistry, blocked).plugins.find(
    (x) => x.id === pluginId,
  );
  if (!p) return rsp.json({ code: 404, msg: '插件不存在或已下架' }, 404);

  const versions = p.versions || {};
  const version = url.searchParams.get('version') || latestVersionOf(p);
  const v = versions[version];
  // 下架版本不可再安装（已安装副本继续运行，设计 九-5）
  if (!v || blocked.has(`${pluginId}@${version}`)) {
    return rsp.json({ code: 404, msg: `版本 ${version} 不存在或已下架` }, 404);
  }

  // 异步计数：不阻塞响应；同 IP 60s 内同包只计一次
  if (shouldCount(`${ip}:${pluginId}@${version}`)) {
    ctx.waitUntil(incrementDownload(env.DB, pluginId, version));
  }

  // 回源代理：原 302 跳转目标（GitHub raw）在部分客户端网络不可达，改为边缘中转
  const upstream = await proxyPackage(env, safePackageTarget(env, v.downloadUrl, pluginId, version));
  if (!upstream) {
    return rsp.json({ code: 502, msg: '插件包回源失败，请稍后重试' }, 502);
  }
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${pluginId}-${version}.nfpkg"`,
    'Cache-Control': 'no-store',
    ...rsp.cors,
    ...sigHeaders(),
  });
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  return new Response(upstream.body, { status: 200, headers });
}

// ---------- 分类 / 统计 ----------

async function handleCategories(env: Env, rsp: Responder): Promise<Response> {
  const registry = await getRegistry(env);
  const list = Object.entries(registry.categories || {})
    .map(([code, info]) => ({ code, name: info.name || code, count: info.count || 0 }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return rsp.json({ code: 200, msg: 'success', data: list }, 200, sigHeaders());
}

async function handleStats(env: Env, rsp: Responder): Promise<Response> {
  const registry = await getRegistry(env);
  let versionCount = 0;
  registry.plugins.forEach((p) => (versionCount += Object.keys(p.versions || {}).length));
  const counts = await getAllCounts(env.DB);
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { plugins: registry.plugins.length, versions: versionCount, totalDownloads: counts.total },
  });
}

// ---------- 索引签名（阶段 3 信任链） ----------

/**
 * X-Registry-Signature：根密钥对 registry.json 原始字节的 Ed25519 签名（base64），
 * 与 registry.json 同批次拉取缓存；无 sig（迁移期）时不返回该头。
 */
function sigHeaders(): Record<string, string> {
  const sig = getCachedSignature();
  return sig ? { 'X-Registry-Signature': sig } : {};
}

/**
 * 评分聚合查询的容错包装：migration 0002 未应用或 D1 异常时降级为空 Map，
 * 保证阶段 2 的索引能力不被阶段 3 的数据表拖垮（fail-open）。
 */
async function safeRatings(env: Env, pluginIds: string[]): Promise<Map<string, { avg: number; count: number }>> {
  try {
    return await getRatings(env, pluginIds);
  } catch {
    return new Map();
  }
}

/** 单插件评分聚合的容错包装 */
async function safeRating(env: Env, pluginId: string): Promise<{ avg: number; count: number }> {
  try {
    return await getRating(env, pluginId);
  } catch {
    return { avg: 0, count: 0 };
  }
}

// ---------- 路由入口 ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rsp = createResponder(request, env);

    try {
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: rsp.cors });
      }

      if (path === '/health') {
        return rsp.json({
          status: 'ok',
          registry: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}@${env.GITHUB_BRANCH}`,
          time: new Date().toISOString(),
        });
      }

      // /api/* 速率限制：下载接口单独收紧
      if (path.startsWith('/api/')) {
        const isDownload = path === '/api/download';
        const limiter = isDownload ? env.RATE_LIMITER_DOWNLOAD : env.RATE_LIMITER_API;
        if (!(await checkLimit(limiter, isDownload ? `dl:${ip}` : `api:${ip}`))) {
          return tooMany(rsp);
        }
      }

      // ---- 阶段 2：索引 / 下载（GET）----
      if (method === 'GET') {
        // registry.json 原始字节（字节级与 registry.sig 对齐，供客户端验签）
        if (path === '/api/registry') return handleRawRegistry(env, rsp);
        if (path === '/api/plugins' || path === '/api/search') return handleList(env, rsp, url);
        if (path === '/api/categories') return handleCategories(env, rsp);
        if (path === '/api/stats') return handleStats(env, rsp);
        if (path === '/api/download') return handleDownload(env, rsp, url, ctx, ip);

        const versionsMatch = path.match(/^\/api\/plugins\/([^/]+)\/versions$/);
        if (versionsMatch) return handleVersions(env, rsp, decodeURIComponent(versionsMatch[1]));

        // 评论列表：GET /api/plugins/:id/reviews
        const reviewsMatch = path.match(/^\/api\/plugins\/([^/]+)\/reviews$/);
        if (reviewsMatch) {
          return handleListReviews(env, rsp, url, decodeURIComponent(reviewsMatch[1]));
        }

        const detailMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
        if (detailMatch) {
          return handleDetail(env, rsp, url, decodeURIComponent(detailMatch[1]));
        }
      }

      // ---- 阶段 3：门户（OAuth / 会话 / 令牌）----
      if (method === 'GET' && path === '/api/auth/github/login') {
        return handleOAuthLogin(env, rsp, url);
      }
      if (method === 'GET' && path === '/api/auth/github/callback') {
        return handleOAuthCallback(env, rsp, request, url);
      }
      if (path === '/api/me') return handleMe(env, rsp, request);
      if (path === '/api/tokens') return handleTokens(env, rsp, request);
      const tokenRevokeMatch = path.match(/^\/api\/tokens\/([0-9a-zA-Z]+)$/);
      if (tokenRevokeMatch) return handleTokenRevoke(env, rsp, request, tokenRevokeMatch[1]);

      // ---- 阶段 3：发布（CLI 令牌）----
      if (path === '/api/publish') return handlePublish(env, rsp, request);

      // ---- 阶段 3：评分 / 评论 ----
      const reviewMatch = path.match(/^\/api\/plugins\/([^/]+)\/reviews$/);
      if (reviewMatch) {
        const pluginId = decodeURIComponent(reviewMatch[1]);
        if (method === 'POST') return handlePostReview(env, rsp, request, pluginId);
        if (method === 'DELETE') return handleDeleteReview(env, rsp, request, pluginId);
        return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
      }
      if (path === '/api/admin/reviews/hide') return handleHideReview(env, rsp, request);

      // ---- 阶段 3：提交与审核 ----
      if (path === '/api/submissions') return handleMySubmissions(env, rsp, request);

      const submitMatch = path.match(/^\/api\/submissions\/([^/]+)\/([^/]+)\/submit$/);
      if (submitMatch) {
        return handleSubmitForReview(
          env,
          rsp,
          request,
          decodeURIComponent(submitMatch[1]),
          decodeURIComponent(submitMatch[2]),
        );
      }

      // ---- 阶段 3：审批台（管理员）----
      if (method === 'GET' && path === '/api/admin/submissions') {
        return handleAdminSubmissions(env, rsp, request, url);
      }
      if (path === '/api/admin/queue') return handleReleaseQueue(env, rsp, request);
      if (path === '/api/admin/queue/item') return handleQueueItem(env, rsp, request);
      if (path === '/api/admin/queue/ack') return handleQueueAck(env, rsp, request);

      const adminActionMatch = path.match(
        /^\/api\/admin\/submissions\/([^/]+)\/([^/]+)\/(review|pull|unpull)$/,
      );
      if (adminActionMatch) {
        const pid = decodeURIComponent(adminActionMatch[1]);
        const ver = decodeURIComponent(adminActionMatch[2]);
        if (adminActionMatch[3] === 'review') return handleReviewDecision(env, rsp, request, pid, ver);
        if (adminActionMatch[3] === 'pull') return handlePull(env, rsp, request, pid, ver);
        return handleUnpull(env, rsp, request, pid, ver);
      }

      // ---- 阶段 4：付费插件（mock 支付 + 许可证签发 + 拉取）----
      if (path === '/api/orders' && method === 'POST') return handleCreateOrder(env, rsp, request);
      const orderPayMatch = path.match(/^\/api\/orders\/([0-9a-zA-Z-]+)\/pay$/);
      if (orderPayMatch && method === 'POST') return handleMockPay(env, rsp, orderPayMatch[1]);
      const licMatch = path.match(/^\/api\/plugins\/([^/]+)\/license$/);
      if (licMatch && method === 'GET') return handleGetLicense(env, rsp, decodeURIComponent(licMatch[1]), url);

      return rsp.json({ code: 404, msg: 'Not Found' }, 404);
    } catch (err: any) {
      return rsp.json({ code: 500, msg: err?.message || 'Internal Error' }, 500);
    }
  },
};
