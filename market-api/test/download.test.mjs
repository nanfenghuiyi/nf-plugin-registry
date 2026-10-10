/**
 * /api/download 回源代理单测
 *
 * 原方案 302 跳转官方仓库 raw 地址，客户端网络无法直连 GitHub 时下载必败；
 * 现改为 Worker 回源流式转发（raw 失败自动回退 jsdelivr）。
 *
 * 覆盖：
 *   1. 正常下载：200 流式返回包体，Content-Type/Content-Length 正确，计数入队
 *   2. 主源（raw.githubusercontent.com）失败：自动回退 jsdelivr 成功
 *   3. 全部回源失败：502
 *   4. 插件不存在 / 版本不存在：404
 *   5. 下载限流：429
 *
 * 运行：npm test（Node 22 原生 type-stripping，无新依赖）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.ts';
import { FAKE_REGISTRY, fakeDB, makeEnv, resetRegistryCache } from './helpers.mjs';

/** ExecutionContext 桩：记录 waitUntil 的任务，测试尾部统一 await */
function makeCtx() {
  const waits = [];
  return {
    waits,
    waitUntil(p) {
      waits.push(Promise.resolve(p).catch(() => {}));
    },
  };
}

/**
 * 全量 fetch 桩：registry.json / registry.sig / 包文件全部拦截。
 * upstreams 为前缀 → (url) => Response 映射，记录每个请求 URL 便于断言回退顺序。
 */
function stubFetch({ registry = FAKE_REGISTRY, sig = '', upstreams = {} } = {}) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(typeof url === 'string' ? url : url?.url ?? url);
    if (u.includes('registry.json')) {
      return new Response(JSON.stringify(registry), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('registry.sig')) {
      return new Response(sig, { status: sig ? 200 : 404 });
    }
    for (const [prefix, handler] of Object.entries(upstreams)) {
      if (u.startsWith(prefix)) {
        seen.push(u);
        return handler(u);
      }
    }
    return new Response(`unstubbed: ${u}`, { status: 599 });
  };
  const restore = () => {
    globalThis.fetch = original;
  };
  return { seen, restore };
}

const PKG_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const RAW_URL = 'https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/packages/nf.app.official/1.0.0.nfpkg';
const JSDELIVR_URL = 'https://cdn.jsdelivr.net/gh/nanfenghuiyi/nf-plugin-registry@main/packages/nf.app.official/1.0.0.nfpkg';

async function getDownload(env = makeEnv(), url = 'https://api.test/api/download?id=nf.app.official') {
  const ctx = makeCtx();
  const resp = await worker.fetch(new Request(url), env, ctx);
  await Promise.all(ctx.waits);
  return resp;
}

test('正常下载：200 流式返回包体与响应头，计数入队', async () => {
  const { seen, restore } = stubFetch({
    upstreams: {
      'https://raw.githubusercontent.com/': () =>
        new Response(PKG_BYTES, {
          status: 200,
          headers: { 'Content-Length': String(PKG_BYTES.length) },
        }),
    },
  });
  const db = fakeDB();
  try {
    // 先打桩再回源填充 registry 缓存，否则强制回源会走真实网络
    await resetRegistryCache();
    const resp = await getDownload(makeEnv({ DB: db }));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(resp.headers.get('Content-Length'), String(PKG_BYTES.length));
    assert.ok(resp.headers.get('Content-Disposition').includes('nf.app.official-1.0.0.nfpkg'));
    const body = new Uint8Array(await resp.arrayBuffer());
    assert.deepEqual(body, PKG_BYTES);
    // 只回源主源，未触发 jsdelivr 回退
    assert.deepEqual(seen, [RAW_URL]);
    // 下载计数已通过 waitUntil 落库
    assert.ok(db.calls.some((c) => c.kind === 'run' || c.kind === 'first'));
  } finally {
    restore();
  }
});

test('主源失败自动回退 jsdelivr 成功', async () => {
  const { seen, restore } = stubFetch({
    upstreams: {
      'https://raw.githubusercontent.com/': () => new Response('boom', { status: 500 }),
      'https://cdn.jsdelivr.net/': () => new Response(PKG_BYTES, { status: 200 }),
    },
  });
  try {
    await resetRegistryCache();
    const resp = await getDownload();
    assert.equal(resp.status, 200);
    assert.deepEqual(new Uint8Array(await resp.arrayBuffer()), PKG_BYTES);
    assert.deepEqual(seen, [RAW_URL, JSDELIVR_URL]);
  } finally {
    restore();
  }
});

test('全部回源失败返回 502', async () => {
  const { restore } = stubFetch({
    upstreams: {
      'https://raw.githubusercontent.com/': () => new Response('boom', { status: 500 }),
      'https://cdn.jsdelivr.net/': () => new Response('boom', { status: 500 }),
    },
  });
  try {
    await resetRegistryCache();
    const resp = await getDownload();
    assert.equal(resp.status, 502);
    const json = await resp.json();
    assert.equal(json.code, 502);
  } finally {
    restore();
  }
});

test('插件不存在返回 404', async () => {
  const { restore } = stubFetch();
  try {
    await resetRegistryCache();
    const resp = await getDownload(makeEnv(), 'https://api.test/api/download?id=nf.app.missing');
    assert.equal(resp.status, 404);
  } finally {
    restore();
  }
});

test('版本不存在返回 404', async () => {
  const { restore } = stubFetch();
  try {
    await resetRegistryCache();
    const resp = await getDownload(makeEnv(), 'https://api.test/api/download?id=nf.app.official&version=9.9.9');
    assert.equal(resp.status, 404);
  } finally {
    restore();
  }
});

test('下载限流返回 429', async () => {
  const { restore } = stubFetch();
  try {
    await resetRegistryCache();
    const env = makeEnv({ RATE_LIMITER_DOWNLOAD: { limit: async () => ({ success: false }) } });
    const resp = await getDownload(env);
    assert.equal(resp.status, 429);
  } finally {
    restore();
  }
});
