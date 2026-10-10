-- 阶段 4：付费插件支持（接入支付 / 授权验证 / 收入分成）
-- 依赖：0001_download_stats.sql, 0002_developer_portal.sql

-- 订单
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,                       -- 订单号（UUID）
  plugin_id   TEXT NOT NULL,
  edition     TEXT,                                   -- 对应 manifest.pricing.editions[].id
  buyer       TEXT NOT NULL,                          -- 账户 id 或 machineId（绑定粒度由 manifest 决定）
  amount      REAL NOT NULL,                          -- 订单金额
  currency    TEXT NOT NULL DEFAULT 'CNY',
  provider    TEXT,                                   -- stripe | wechat | alipay | mock
  provider_order_id TEXT,                             -- 支付商回传的单号（mock 为 null）
  status      TEXT NOT NULL DEFAULT 'created',        -- created | paid | refunded | failed
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_plugin ON orders(plugin_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer);

-- 许可证令牌（已签发，供客户端拉取/激活）
CREATE TABLE IF NOT EXISTS licenses (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  plugin_id   TEXT NOT NULL,
  edition     TEXT,
  subject     TEXT NOT NULL,                          -- machineId 或 account id（与 orders.buyer 一致）
  token       TEXT NOT NULL,                          -- 已签名的 entitlement（b64url(header).b64url(payload).b64url(sig)）
  exp         INTEGER,                                -- NULL=永久；订阅型带过期时间
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_licenses_subject ON licenses(subject, plugin_id);

-- 收入分成 / 结算（本期仅记账，提现通道为后续子阶段）
CREATE TABLE IF NOT EXISTS payouts (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,
  gross           REAL NOT NULL,                      -- 订单总额
  platform_fee    REAL NOT NULL,                      -- 平台抽成 = gross * share
  developer_amount REAL NOT NULL,                     -- 开发者应得 = gross - platform_fee
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending | paid
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_payouts_plugin ON payouts(plugin_id);
