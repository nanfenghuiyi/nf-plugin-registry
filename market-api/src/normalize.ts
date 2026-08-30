import type { MarketItem, RegistryPlugin, RegistryVersion } from './types';

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
 * downloadUrl 恒为市场 API 绝对地址（/api/download 302 分发），客户端跟随重定向即可
 */
export function toItem(p: RegistryPlugin, origin: string, downloads: number): MarketItem {
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
    type: p.type || 'app',
    category: p.category || 'tool',
    downloads,
    rating: 0,
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
  };
}