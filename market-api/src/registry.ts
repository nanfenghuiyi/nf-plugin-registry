import type { Env, RegistryData } from './types';

interface CacheEntry {
  data: RegistryData;
  /** registry.json 原始字节文本（/api/registry 透传给客户端，供 registry.sig 验签） */
  raw: string;
  /** registry.sig 内容（base64，根密钥对 registry.json 原始字节的 Ed25519 签名）；''=源上无 sig */
  signature: string;
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

/** registry.sig 与 registry.json 同目录同名规则（阶段 3 信任链，见设计 4.1） */
function registrySigUrls(env: Env): string[] {
  return registryUrls(env).map((u) => u.replace(/registry\.json$/, 'registry.sig'));
}

function isValidRegistry(json: unknown): json is RegistryData {
  return !!(json && typeof json === 'object' && Array.isArray((json as RegistryData).plugins));
}

/**
 * 获取 registry.json（内存缓存 TTL + 双源回退 + 过期缓存兜底）。
 * registry.sig 随同源拉取并缓存（index 完整性透传给客户端校验）；
 * sig 拉取失败不阻塞 registry（迁移期兼容：无 sig 时客户端放行并告警）。
 * @throws 双源均失败且无任何缓存时抛错（由路由层转 502）
 */
export async function getRegistry(env: Env, force = false): Promise<RegistryData> {
  const ttl = (parseInt(env.REGISTRY_CACHE_TTL_SECONDS, 10) || 300) * 1000;
  if (!force && cache && Date.now() - cache.fetchedAt < ttl) {
    return cache.data;
  }

  const sigUrls = registrySigUrls(env);
  for (let i = 0; i < registryUrls(env).length; i++) {
    const url = registryUrls(env)[i];
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        // 边缘缓存 60s 防回源风暴（jsdelivr 源自带 CDN 缓存）
        cf: { cacheTtl: 60 },
      });
      if (!resp.ok) continue;
      // 先取原始字节：客户端 registry.sig 验签要求字节级一致，
      // 不能返回本 Worker 重新序列化的 JSON（设计 4.1 信任链要求）
      const raw = await resp.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isValidRegistry(json)) continue;

      // 同源拉 registry.sig（同一 commit 内容一致；失败视为无 sig）
      let signature = '';
      try {
        const sigResp = await fetch(sigUrls[i], {
          signal: AbortSignal.timeout(5000),
          cf: { cacheTtl: 60 },
        });
        if (sigResp.ok) signature = (await sigResp.text()).trim();
      } catch {
        // sig 缺失不阻塞 registry
      }

      cache = { data: json, raw, signature, fetchedAt: Date.now() };
      return json;
    } catch {
      // 尝试下一个源
    }
  }

  if (cache) return cache.data; // 双源失败：降级用过期缓存
  throw new Error('registry 拉取失败且无可用缓存');
}

/**
 * 当前缓存的 registry.sig（base64）。须在 getRegistry 之后调用，
 * 与 registry.json 同批次拉取，保证二者一致（''=无 sig）。
 */
export function getCachedSignature(): string {
  return cache?.signature || '';
}

/**
 * 当前缓存的 registry.json **原始字节文本**。
 * 客户端 registry.sig 是对仓库文件字节的签名，因此 /api/registry 必须回传原始文本，
 * 任何重新序列化都会破坏字节一致性导致验签失败。
 */
export function getCachedRaw(): string {
  return cache?.raw || '';
}
