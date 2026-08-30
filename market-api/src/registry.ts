import type { Env, RegistryData } from './types';

interface CacheEntry {
  data: RegistryData;
  fetchedAt: number;
}

/** isolate 级内存缓存（同节点多 isolate 各自独立，TTL 到期重新回源） */
let cache: CacheEntry | null = null;

/** registry.json 拉取源：raw 主源（分支实时性好）+ jsdelivr 回退（国内可达） */
function registryUrls(env: Env): string[] {
  const { GITHUB_OWNER: owner, GITHUB_REPO: repo, GITHUB_BRANCH: branch } = env;
  return [
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/registry.json`,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/registry.json`,
  ];
}

function isValidRegistry(json: unknown): json is RegistryData {
  return !!(json && typeof json === 'object' && Array.isArray((json as RegistryData).plugins));
}

/**
 * 获取 registry.json（内存缓存 TTL + 双源回退 + 过期缓存兜底）
 * @throws 双源均失败且无任何缓存时抛错（由路由层转 502）
 */
export async function getRegistry(env: Env, force = false): Promise<RegistryData> {
  const ttl = (parseInt(env.REGISTRY_CACHE_TTL_SECONDS, 10) || 300) * 1000;
  if (!force && cache && Date.now() - cache.fetchedAt < ttl) {
    return cache.data;
  }

  for (const url of registryUrls(env)) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        // 边缘缓存 60s 防回源风暴（jsdelivr 源自带 CDN 缓存）
        cf: { cacheTtl: 60 },
      });
      if (!resp.ok) continue;
      const json: unknown = await resp.json();
      if (!isValidRegistry(json)) continue;
      cache = { data: json, fetchedAt: Date.now() };
      return json;
    } catch {
      // 尝试下一个源
    }
  }

  if (cache) return cache.data; // 双源失败：降级用过期缓存
  throw new Error('registry 拉取失败且无可用缓存');
}