/**
 * NF Client 插件市场 API（Cloudflare Workers）
 *
 * 职责：索引服务（搜索/分类/分页/排序）+ 下载统计 + 速率限制。
 * 不落盘不分发插件包：/api/download 302 重定向到官方仓库地址，
 * 包的信任边界仍在客户端（checksum + Ed25519 强验签）。
 *
 * 契约对齐 tools/plugin-market/server.js，客户端 REST 分支零适配。
 */
import type { Env, MarketItem, RateLimitBinding, RegistryPlugin } from './types';
import { getRegistry } from './registry';
import { latestVersionOf, semverCmp, toItem } from './normalize';
import { getAllCounts, incrementDownload } from './stats';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

function tooMany(): Response {
  return json({ code: 429, msg: '请求过于频繁，请稍后重试' }, 429, { 'Retry-After': '60' });
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

async function handleList(env: Env, url: URL): Promise<Response> {
  const { keyword, category, page, pageSize, sort } = parseListParams(url);
  const registry = await getRegistry(env);
  const counts = await getAllCounts(env.DB);

  let items: MarketItem[] = registry.plugins.map((p) =>
    toItem(p, url.origin, counts.map.get(`${p.id}@${latestVersionOf(p)}`) || 0),
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
  return json({
    code: 200,
    msg: 'success',
    data: { list: items.slice(start, start + pageSize), total, page, pageSize },
  });
}

// ---------- 详情 / 版本 ----------

async function handleDetail(env: Env, url: URL, pluginId: string): Promise<Response> {
  const registry = await getRegistry(env);
  const p = registry.plugins.find((x) => x.id === pluginId);
  if (!p) return json({ code: 404, msg: '插件不存在' }, 404);

  const counts = await getAllCounts(env.DB);
  const item = toItem(p, url.origin, counts.map.get(`${p.id}@${latestVersionOf(p)}`) || 0);
  return json({ code: 200, msg: 'success', data: item });
}

async function handleVersions(env: Env, pluginId: string): Promise<Response> {
  const registry = await getRegistry(env);
  const p = registry.plugins.find((x) => x.id === pluginId);
  if (!p) return json({ code: 404, msg: '插件不存在' }, 404);

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

  return json({
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

// ---------- 下载（302 分发 + 计数） ----------

/** 302 目标必须落在官方仓库前缀白名单内（registry 被篡改时兜底） */
function safeRedirectTarget(
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

async function handleDownload(env: Env, url: URL, ctx: ExecutionContext, ip: string): Promise<Response> {
  const pluginId = url.searchParams.get('id');
  if (!pluginId) return json({ code: 400, msg: '缺少 id 参数' }, 400);

  const registry = await getRegistry(env);
  const p: RegistryPlugin | undefined = registry.plugins.find((x) => x.id === pluginId);
  if (!p) return json({ code: 404, msg: '插件不存在' }, 404);

  const versions = p.versions || {};
  const version = url.searchParams.get('version') || latestVersionOf(p);
  const v = versions[version];
  if (!v) return json({ code: 404, msg: `版本 ${version} 不存在` }, 404);

  const target = safeRedirectTarget(env, v.downloadUrl, pluginId, version);

  // 异步计数：不阻塞重定向；同 IP 60s 内同包只计一次
  if (shouldCount(`${ip}:${pluginId}@${version}`)) {
    ctx.waitUntil(incrementDownload(env.DB, pluginId, version));
  }

  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

// ---------- 分类 / 统计 ----------

async function handleCategories(env: Env): Promise<Response> {
  const registry = await getRegistry(env);
  const list = Object.entries(registry.categories || {})
    .map(([code, info]) => ({ code, name: info.name || code, count: info.count || 0 }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return json({ code: 200, msg: 'success', data: list });
}

async function handleStats(env: Env): Promise<Response> {
  const registry = await getRegistry(env);
  let versionCount = 0;
  registry.plugins.forEach((p) => (versionCount += Object.keys(p.versions || {}).length));
  const counts = await getAllCounts(env.DB);
  return json({
    code: 200,
    msg: 'success',
    data: { plugins: registry.plugins.length, versions: versionCount, totalDownloads: counts.total },
  });
}

// ---------- 路由入口 ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    try {
      if (request.method !== 'GET') {
        return json({ code: 405, msg: 'Method Not Allowed' }, 405);
      }

      if (path === '/health') {
        return json({
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
          return tooMany();
        }
      }

      if (path === '/api/plugins' || path === '/api/search') return handleList(env, url);
      if (path === '/api/categories') return handleCategories(env);
      if (path === '/api/stats') return handleStats(env);
      if (path === '/api/download') return handleDownload(env, url, ctx, ip);

      const versionsMatch = path.match(/^\/api\/plugins\/([^/]+)\/versions$/);
      if (versionsMatch) return handleVersions(env, decodeURIComponent(versionsMatch[1]));

      const detailMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
      if (detailMatch) return handleDetail(env, url, decodeURIComponent(detailMatch[1]));

      return json({ code: 404, msg: 'Not Found' }, 404);
    } catch (err: any) {
      return json({ code: 500, msg: err?.message || 'Internal Error' }, 500);
    }
  },
};