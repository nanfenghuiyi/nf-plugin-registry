/**
 * 类型定义 — 契约对齐 tools/plugin-market/server.js（响应统一 { code, msg, data }）
 */

/** Workers 绑定（对应 wrangler.toml） */
export interface Env {
  DB: D1Database;
  RATE_LIMITER_API: RateLimitBinding;
  RATE_LIMITER_DOWNLOAD: RateLimitBinding;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  REGISTRY_CACHE_TTL_SECONDS: string;
  // ---- 阶段 3（开发者门户）----
  /** 待发布包体存储（publish 上传的 zip，≤20MB；KV 免费额度） */
  KV: KVNamespace;
  /** GitHub OAuth App Client ID（公开） */
  GH_CLIENT_ID: string;
  /** GitHub OAuth App Client Secret（secret） */
  GH_CLIENT_SECRET: string;
  /** 门户会话 cookie / state 签名密钥（secret） */
  COOKIE_SECRET: string;
  /** 管理员 GitHub 登录名（逗号分隔） */
  ADMIN_GITHUB_LOGINS: string;
  /** 门户 Pages 域名（CORS 凭据白名单；登录后回跳） */
  PORTAL_ORIGIN: string;
  /** 客户端深链（OAuth 回跳 nf-client://auth/callback） */
  CLIENT_DEEP_LINK: string;
  // ---- 阶段 4：付费插件（授权验证）----
  /** 市场许可证权威私钥（PKCS8 PEM，Worker secret）；永不出云、不进仓库 */
  MARKET_LICENSE_KEY?: string;
}

/** Workers Rate Limiting binding（open beta） */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * 按请求注入的响应构造器（index.ts 创建）：
 * CORS 依赖请求 Origin（门户凭据白名单），isolate 会在 await 点交叉处理请求，
 * 因此不能用模块级全局，必须每请求独立构造。
 */
export interface Responder {
  /** 统一 { code, msg, data } JSON 响应（自动携带 CORS 与 sig 头可由 extra 传入） */
  json(data: unknown, status?: number, extra?: Record<string, string>): Response;
  /** 302 跳转；setCookies 为多个独立 Set-Cookie 值 */
  redirect(location: string, setCookies?: string[]): Response;
  /** 计算后的 CORS 头（供 302 等手动构造响应复用） */
  cors: Record<string, string>;
}

/** registry.json 版本条目 */
export interface RegistryVersion {
  minAppVersion?: string;
  requiresPro?: boolean;
  size?: number;
  downloadUrl?: string;
  checksum?: string;
  signature?: string;
  publicKey?: string;
  format?: string;
  encrypted?: boolean;
  encryptionVersion?: number;
  changelog?: string;
  publishedAt?: string;
}

/** registry.json 插件条目 */
export interface RegistryPlugin {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  author?: string;
  icon?: string;
  homepage?: string;
  keywords?: string[];
  permissions?: string[];
  engines?: Record<string, string>;
  versions?: Record<string, RegistryVersion>;
  latestVersion?: string;
  /** 阶段 4：是否为付费插件 */
  paid?: boolean;
  /** 阶段 4：定价与绑定粒度 { editions:[{id,name,price,currency,period}], share?, bind?:'machine'|'account' } */
  pricing?: {
    editions?: Array<{ id: string; name?: string; price: number; currency?: string; period?: string }>;
    share?: number;
    bind?: 'machine' | 'account';
  } | null;
}

/** registry.json 顶层结构 */
export interface RegistryData {
  version: number;
  updatedAt: string;
  totalPlugins: number;
  categories: Record<string, { name: string; count: number }>;
  plugins: RegistryPlugin[];
}

// ---- 阶段 3：开发者门户（设计第五节数据模型）----

/** developers 表行 */
export interface Developer {
  id: string;
  github_login: string;
  display_name: string | null;
  github_created_at: string | null;
  status: 'active' | 'banned';
  created_at: string;
}

/** api_tokens 表行 */
export interface ApiToken {
  token_hash: string;
  developer_id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

/** submissions 表行（状态机见设计第七节） */
export interface Submission {
  plugin_id: string;
  version: string;
  developer_id: string;
  status:
    | 'submitted'
    | 'machine_check_failed'
    | 'in_review'
    | 'approved'
    | 'published'
    | 'rejected'
    | 'pulled';
  machine_report: string | null;
  reject_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewer: string | null;
}

/** reviews 表行 */
export interface Review {
  plugin_id: string;
  user_login: string;
  stars: number;
  comment: string | null;
  status: 'visible' | 'hidden';
  new_account: number;
  created_at: string;
  updated_at: string;
}

/** 鉴权后的身份（会话 cookie 或 CLI 令牌） */
export interface AuthContext {
  developerId: string;
  login: string;
  /** 是否管理员（ADMIN_GITHUB_LOGINS） */
  isAdmin: boolean;
  /** 鉴权方式：门户 cookie 会话 / CLI 或客户端 Bearer 令牌 */
  via: 'session' | 'token';
}

/** 前端 PluginMarketItem（frontend/src/api/pluginMarket/index.ts）+ 安装扩展字段 */
export interface MarketItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  type: string;
  category: string;
  downloads: number;
  /** 评分均值（1 位小数；无评分时为 0） */
  rating: number;
  /** 评分人数（visible 评论数） */
  ratingCount: number;
  latestVersion: string;
  changelog: string;
  dependencies: string[];
  homepage: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  // 扩展字段（对齐 tools/plugin-market/server.js normalizeItem，供安装端强验签）
  engine: Record<string, string>;
  permissions: string[];
  signed: boolean;
  checksum: string;
  signature: string;
  publicKey: string;
  downloadUrl: string;
  // 阶段 4：付费标记与定价
  paid: boolean;
  pricing: RegistryPlugin['pricing'];
}