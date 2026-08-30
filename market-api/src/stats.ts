/**
 * D1 下载统计。表 download_stats：每个 插件@版本 一行。
 * 全部操作静默容错——统计不可用不影响列表/下载主流程。
 */

export interface DownloadCounts {
  /** "pluginId@version" -> count */
  map: Map<string, number>;
  total: number;
}

export async function getAllCounts(db: D1Database): Promise<DownloadCounts> {
  const map = new Map<string, number>();
  let total = 0;
  try {
    const { results } = await db
      .prepare('SELECT plugin_id, version, count FROM download_stats')
      .all<{ plugin_id: string; version: string; count: number }>();
    for (const row of results || []) {
      map.set(`${row.plugin_id}@${row.version}`, row.count);
      total += row.count;
    }
  } catch {
    // 表不存在 / D1 不可用：按 0 处理
  }
  return { map, total };
}

/** 计数原子自增（无行则建行）。调用方用 waitUntil 异步执行，不阻塞响应 */
export async function incrementDownload(db: D1Database, pluginId: string, version: string): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO download_stats (plugin_id, version, count, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(plugin_id, version)
         DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
      )
      .bind(pluginId, version, new Date().toISOString())
      .run();
  } catch {
    // 计数失败不影响下载
  }
}