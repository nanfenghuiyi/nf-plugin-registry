import type { MarketItem, RegistryPlugin, RegistryVersion } from './types';
import type { RatingAgg } from './reviews.ts';

/** semver 三段比较（与 tools/plugin-market/server.js 一致） */
export function semverCmp(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** 最新版本号：优先 latestVersion，否则取 semver 最大 */
export function latestVersionOf(p: RegistryPlugin): string {
  if (p.latestVersion && p.versions && p.versions[p.latestVersion]) {
    return p.latestVersion;
  }
  return Object.keys(p.versions || {}).sort(semverCmp).pop() || '';
}

/**
 * registry 插件条目 → 前端 PluginMarketItem
 * downloadUrl 恒为市场 API 绝对地址（/api/download 由 Worker 回源代理流式返回包体）
 *
 * @param rating 评分聚合（阶段 3：由 reviews 表批量查询回填；缺省为 0）
 */
export function toItem(
  p: RegistryPlugin,
  origin: string,
  downloads: number,
  rating?: RatingAgg,
): MarketItem {
  const versions = p.versions || {};
  const latestVer = latestVersionOf(p);
  const latest: RegistryVersion = versions[latestVer] || {};
  const dates = Object.values(versions)
    .map((v) => v.publishedAt || '')
    .filter(Boolean)
    .sort();
  const createdAt = dates[0] || new Date().toISOString();

  return {
    id: p.id,
    name: p.name || p.id,
    version: latestVer,
    description: p.description || '',
    author: p.author || 'NF Team',
    icon: p.icon || '',
    // 图标由市场 API 代理回源（.nfpkg 整体加密，包内图标无法直接读取）
    iconUrl: p.icon ? `${origin}/api/icon?id=${encodeURIComponent(p.id)}` : '',
    type: p.type || 'app',
    category: p.category || 'tool',
    downloads,
    rating: rating?.avg ?? 0,
    ratingCount: rating?.count ?? 0,
    latestVersion: latestVer,
    changelog: latest.changelog || '初始版本发布',
    dependencies: [],
    homepage: p.homepage || '',
    tags: Array.isArray(p.keywords) ? p.keywords : [],
    createdAt,
    updatedAt: dates[dates.length - 1] || createdAt,
    engine: p.engines || {},
    permissions: Array.isArray(p.permissions) ? p.permissions : [],
    signed: !!(latest.signature && latest.publicKey),
    checksum: latest.checksum || '',
    signature: latest.signature || '',
    publicKey: latest.publicKey || '',
    downloadUrl: `${origin}/api/download?id=${encodeURIComponent(p.id)}&version=${encodeURIComponent(latestVer)}`,
    paid: !!p.paid,
    pricing: p.pricing || null,
  };
}