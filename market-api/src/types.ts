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
}

/** Workers Rate Limiting binding（open beta） */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
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
}

/** registry.json 顶层结构 */
export interface RegistryData {
  version: number;
  updatedAt: string;
  totalPlugins: number;
  categories: Record<string, { name: string; count: number }>;
  plugins: RegistryPlugin[];
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
  rating: number;
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
}