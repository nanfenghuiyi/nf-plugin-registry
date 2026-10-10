-- 阶段 3（开发者门户）迁移：developers / api_tokens / submissions / reviews
-- 设计文档第五节「数据模型」。与 0001 一样全部使用 IF NOT EXISTS，可重复执行。

-- 开发者（GitHub OAuth 登录后 upsert）
CREATE TABLE IF NOT EXISTS developers (
  id                TEXT PRIMARY KEY,            -- dev_<random>
  github_login      TEXT NOT NULL UNIQUE,
  display_name      TEXT,
  github_created_at TEXT,                        -- GitHub 账号注册时间（newAccount 反刷标记依据，设计八）
  status            TEXT NOT NULL DEFAULT 'active',   -- active | banned
  created_at        TEXT NOT NULL
);

-- CLI 发布令牌（只存 SHA-256 哈希，明文仅在签发响应中出现一次）
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash   TEXT PRIMARY KEY,                 -- SHA-256(token) hex
  developer_id TEXT NOT NULL REFERENCES developers(id),
  name         TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0
);

-- 插件提交与审核（状态机见设计第七节）
CREATE TABLE IF NOT EXISTS submissions (
  plugin_id      TEXT NOT NULL,
  version        TEXT NOT NULL,
  developer_id   TEXT NOT NULL REFERENCES developers(id),
  status         TEXT NOT NULL DEFAULT 'submitted',
                 -- submitted | machine_check_failed | in_review | approved | published | rejected | pulled
  machine_report TEXT,                           -- 机器检查结果 JSON
  reject_reason  TEXT,
  submitted_at   TEXT NOT NULL,
  reviewed_at    TEXT,
  reviewer       TEXT,
  PRIMARY KEY (plugin_id, version)
);

-- 评分/评论（客户端用户与开发者同用 GitHub 身份；每用户每插件一条，重评覆盖）
CREATE TABLE IF NOT EXISTS reviews (
  plugin_id  TEXT NOT NULL,
  user_login TEXT NOT NULL,                      -- github login
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT,
  status     TEXT NOT NULL DEFAULT 'visible',    -- visible | hidden
  new_account INTEGER NOT NULL DEFAULT 0,        -- GitHub 注册 <30 天的评分标记（后台可见，默认不展示）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, user_login)
);
CREATE INDEX IF NOT EXISTS idx_reviews_plugin ON reviews (plugin_id, status);
