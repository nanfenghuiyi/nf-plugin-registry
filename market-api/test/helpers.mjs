/**
 * 阶段 3 测试桩（Node 原生 test runner，无新依赖）
 *
 * 为什么不用 wrangler dev 联调：CI/沙箱环境无法回源 raw.githubusercontent.com，
 * 且 miniflare 需写全局配置目录。改为直接调用 worker 的 fetch 处理器 + 桩 Env，
 * 测试完全离线、可重复（与本目录 auth.test.mjs 同一套做法）。
 */
import { webcrypto } from 'node:crypto';

// Workers 运行时全局：auth.ts 用到 crypto.subtle / crypto.randomUUID / crypto.getRandomValues
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// ---------- Responder 桩 ----------

export function makeRsp() {
  return {
    cors: { 'Access-Control-Allow-Origin': '*' },
    json(data, status = 200, extra = {}) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extra },
      });
    },
    redirect(location, setCookies = []) {
      const headers = new Headers({ Location: location });
      for (const c of setCookies) headers.append('Set-Cookie', c);
      return new Response(null, { status: 302, headers });
    },
  };
}

// ---------- D1 桩 ----------

/**
 * D1 桩：按 SQL 正则路由 fakeDB([{ match, first|results|run }])。
 * 记录所有调用便于断言（如「明文令牌不得入库」）。
 */
export function fakeDB(routes = []) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      const stmt = {
        sql,
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          calls.push({ sql, args: this._args, kind: 'first' });
          for (const r of routes) {
            if (r.match.test(sql)) {
              return typeof r.first === 'function' ? r.first(this._args) : (r.first ?? null);
            }
          }
          return null;
        },
        async all() {
          calls.push({ sql, args: this._args, kind: 'all' });
          for (const r of routes) {
            if (r.match.test(sql)) return { results: r.results ?? [] };
          }
          return { results: [] };
        },
        async run() {
          calls.push({ sql, args: this._args, kind: 'run' });
          for (const r of routes) {
            if (r.match.test(sql) && typeof r.run === 'function') r.run(this._args);
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

// ---------- KV 桩 ----------

/** KV 桩：内存 Map，支持 text/json/arrayBuffer 三种读取类型 */
export function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type = 'text') {
      const v = store.get(key);
      if (v === undefined) return null;
      if (type === 'json') return JSON.parse(v);
      if (type === 'arrayBuffer') return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      return v;
    },
    async put(key, value) {
      if (typeof value === 'string') store.set(key, value);
      else if (value instanceof ArrayBuffer) store.set(key, new Uint8Array(value));
      else store.set(key, new Uint8Array(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// ---------- registry 源桩 ----------

export const FAKE_REGISTRY = {
  version: 1,
  updatedAt: '2026-08-31T00:00:00.000Z',
  totalPlugins: 1,
  categories: { app: { name: '应用', count: 1 } },
  plugins: [
    {
      id: 'nf.app.official',
      name: '官方插件',
      description: '已存在的官方插件（无 developerId）',
      category: 'app',
      type: 'app',
      author: 'NF Team',
      versions: { '1.0.0': { checksum: 'a'.repeat(64), size: 100 } },
      latestVersion: '1.0.0',
    },
  ],
};

/**
 * 拦截 globalThis.fetch：registry.json / registry.sig 走桩，其余透传（不存在则抛错）。
 * 返回还原函数，测试内 try/finally 调用。
 */
export function stubRegistryFetch(registry = FAKE_REGISTRY, signature = '') {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(typeof url === 'string' ? url : url?.url ?? url);
    if (u.includes('registry.json')) {
      return new Response(JSON.stringify(registry), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('registry.sig')) {
      return new Response(signature, { status: signature ? 200 : 404 });
    }
    if (original) return original(url, init);
    throw new Error(`未拦截的 fetch: ${u}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

// 注意：registry.ts 用模块级缓存，跨用例会串数据。
// 每个用例前调用 resetRegistryCache() 强制回源。
export async function resetRegistryCache() {
  const { getRegistry } = await import('../src/registry.ts');
  await getRegistry({}, true);
}

// ---------- Env 组装 ----------

export function makeEnv(overrides = {}) {
  return {
    DB: fakeDB(),
    KV: fakeKV(),
    RATE_LIMITER_API: { limit: async () => ({ success: true }) },
    RATE_LIMITER_DOWNLOAD: { limit: async () => ({ success: true }) },
    GITHUB_OWNER: 'nanfenghuiyi',
    GITHUB_REPO: 'nf-plugin-registry',
    GITHUB_BRANCH: 'main',
    REGISTRY_CACHE_TTL_SECONDS: '300',
    GH_CLIENT_ID: 'client-id',
    GH_CLIENT_SECRET: 'client-secret',
    COOKIE_SECRET: 'test-cookie-secret',
    ADMIN_GITHUB_LOGINS: 'admin-one',
    PORTAL_ORIGIN: '',
    CLIENT_DEEP_LINK: 'nf-client://auth/callback',
    ...overrides,
  };
}

// ---------- 打包工具：构造最小合法插件 zip ----------

/**
 * 构造一个最小合法插件 zip（manifest.json + main + icon）。
 * @returns {Promise<{ zip: Uint8Array, manifest: object }>}
 */
export async function buildPluginZip(overrides = {}) {
  const { zipSync, strToU8 } = await import('fflate');
  const manifest = {
    id: 'com.example.demo',
    name: '示例插件',
    version: '1.0.0',
    type: 'app',
    category: 'tool',
    main: 'index.js',
    icon: 'icon.png',
    permissions: ['ipc:register', 'storage:read'],
    author: 'tester',
    ...overrides,
  };
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'index.js': strToU8('module.exports = {};'),
    'icon.png': strToU8('\x89PNG\r\n\x1a\n'),
  });
  return { zip, manifest };
}

/** Node crypto 生成 Ed25519 密钥对（PEM），用于构造开发者自有签名 */
export async function makeDevKeyPair() {
  const crypto = await import('node:crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    /** 对 buffer 签名（ieee-p1363，与客户端/服务端 verify 一致）→ base64 */
    sign(buf) {
      return crypto
        .sign(null, Buffer.from(buf), { key: privateKey, dsaEncoding: 'ieee-p1363' })
        .toString('base64');
    },
  };
}

/** Uint8Array → base64 */
export function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return Buffer.from(bin, 'binary').toString('base64');
}
