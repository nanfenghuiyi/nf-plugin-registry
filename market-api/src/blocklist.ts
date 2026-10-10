/**
 * 下架（pulled）名单 — 阶段 3 设计 七 / 十二
 *
 * 存储：KV 单键 `index:blocklist` → JSON 字符串数组 `["<pluginId>@<version>", ...]`。
 * 为什么不放 D1：索引层每次列表都要读，KV 读免费额度更宽松且延迟更低；
 * 名单体量极小（下架是低频动作），单键读写即可。
 *
 * 生效路径：
 *   1. Workers 索引层（handleList/handleDetail/handleVersions）过滤被下架版本
 *   2. /api/download 对已下架版本返回 404（客户端已安装副本继续运行，设计 九-5）
 *   3. registry 侧在 drain 时同步写入条目级 pulled 标记（持久事实源头）
 */
import type { Env, RegistryData, RegistryPlugin } from './types';

const BLOCKLIST_KEY = 'index:blocklist';

/** 读取下架名单（解析失败视为空名单，fail-open 到「不下架」而非「全下架」） */
export async function getBlocked(env: Env): Promise<Set<string>> {
  try {
    const raw = await env.KV.get<string[]>(BLOCKLIST_KEY, 'json');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

async function writeBlocked(env: Env, blocked: Set<string>): Promise<void> {
  await env.KV.put(BLOCKLIST_KEY, JSON.stringify([...blocked]));
}

/** 加入下架名单（幂等） */
export async function addBlocked(env: Env, key: string): Promise<void> {
  const blocked = await getBlocked(env);
  blocked.add(key);
  await writeBlocked(env, blocked);
}

/** 移出下架名单（撤销误下架） */
export async function removeBlocked(env: Env, key: string): Promise<void> {
  const blocked = await getBlocked(env);
  if (blocked.delete(key)) await writeBlocked(env, blocked);
}

/** 语义化版本比较（降序用）：x.y.z[-pre] */
function cmpDesc(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

/**
 * 从 registry 副本中剔除被下架的版本。
 * - 某插件全部版本均被下架 → 整个条目移除（用户彻底搜不到）
 * - 仅部分版本被下架 → 保留条目，latestVersion 回退到最高的未下架版本
 *
 * @returns 新的 registry 对象（浅拷贝 plugins 与受影响条目的 versions）
 */
export function applyBlocklist(registry: RegistryData, blocked: Set<string>): RegistryData {
  if (blocked.size === 0) return registry;

  const plugins: RegistryPlugin[] = [];
  for (const p of registry.plugins) {
    const versions = p.versions || {};
    const kept: Record<string, (typeof versions)[string]> = {};
    for (const [ver, info] of Object.entries(versions)) {
      if (!blocked.has(`${p.id}@${ver}`)) kept[ver] = info;
    }
    const keptKeys = Object.keys(kept);
    if (keptKeys.length === 0) continue;
    if (keptKeys.length === Object.keys(versions).length) {
      plugins.push(p);
      continue;
    }
    const newLatest = keptKeys.slice().sort(cmpDesc)[0];
    plugins.push({ ...p, versions: kept, latestVersion: newLatest });
  }
  return { ...registry, plugins, totalPlugins: plugins.length };
}
