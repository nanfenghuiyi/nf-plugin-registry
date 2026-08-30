-- 下载统计表：每个 插件@版本 一行，计数原子自增
CREATE TABLE IF NOT EXISTS download_stats (
  plugin_id  TEXT NOT NULL,
  version    TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

-- 按插件聚合查询索引（/api/stats、热门排序可用）
CREATE INDEX IF NOT EXISTS idx_download_stats_plugin ON download_stats (plugin_id);