/**
 * /api/icon 明文图标回源单测
 *
 * .nfpkg 整体加密，服务端无法解包取图标；registry 构建时把图标明文导出到
 * packages/<id>/icon.*，由本接口回源代理（raw 失败自动回退 jsdelivr）。
 *
 * 覆盖：
 *   1. 缺少 id：400
 *   2. 插件不存在 / 已下架：404
 *   3. manifest.icon 命中：200 + 正确 Content-Type/Cache-Control
 *   4. 声明图标缺失：按常见命名回退 icon.svg
 *   5. 无任何图标文件：404
 *
 * 运行：npm test（Node 22 原生 type-stripping）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.ts';
import { fakeDB, makeEnv, resetRegistryCache } from './helpers.mjs';

const ICON_REGISTRY = {
  version: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  totalPlugins: 2,
  categories: { app: { name: '应用', count: 2 } },
  plugins: [
    {
      id: 'nf.app.withicon',
      name: '有图标插件',
      description: '声明 icon.svg 且文件存在',
      category: 'app',
      type: 'app',
      icon: 'icon.svg',
      versions: { '1.0.0': { checksum: 'a'.repeat(64), size: 100 } },
      latestVersion: '1.0.0',
    },
    {
      id: 'nf.app.fallback',
      name: '命名回退插件',
      description: 'manifest 声明 icon.png 但实际只有 icon.svg',
      category: 'app',
      type: 'app',
      icon: 'icon.png',
      versions: { '1.0.0': { checksum: 'b'.repeat(64), size: 100 } },
      latestVersion: '1.0.0',
    },
  ],
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const RAW_PREFIX = 'https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/packages/';

/** 全量 fetch 桩：registry 走桩，包文件按「完整 URL → Response」映射 */
function stubFetch({ registry = ICON_REGISTRY, files = {} } = {}) {
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
    if (u.includes('registry.sig')) return new Response('', { status: 404 });
    seen.push(u);
    if (files[u]) return files[u]();
    return new Response('not found', { status: 404 });
  };
  return {
    seen,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function getIcon(path, env = makeEnv({ DB: fakeDB() })) {
  return worker.fetch(new Request(`https://api.test${path}`), env, {
    waitUntil() {},
  });
}

test('缺少 id 返回 400', async () => {
  const { restore } = stubFetch();
  try {
    await resetRegistryCache();
    assert.equal((await getIcon('/api/icon')).status, 400);
  } finally {
    restore();
  }
});

test('插件不存在返回 404', async () => {
  const { restore } = stubFetch();
  try {
    await resetRegistryCache();
    assert.equal((await getIcon('/api/icon?id=nf.app.missing')).status, 404);
  } finally {
    restore();
  }
});

test('命中 manifest.icon：200 + 图片类型 + 长缓存', async () => {
  const { seen, restore } = stubFetch({
    files: { [`${RAW_PREFIX}nf.app.withicon/icon.svg`]: () => new Response(SVG, { status: 200 }) },
  });
  try {
    await resetRegistryCache();
    const resp = await getIcon('/api/icon?id=nf.app.withicon');
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('Content-Type'), 'image/svg+xml');
    assert.match(resp.headers.get('Cache-Control') || '', /max-age=86400/);
    assert.equal(await resp.text(), SVG);
    assert.deepEqual(seen, [`${RAW_PREFIX}nf.app.withicon/icon.svg`]);
  } finally {
    restore();
  }
});

test('声明图标缺失时按常见命名回退', async () => {
  const { seen, restore } = stubFetch({
    files: { [`${RAW_PREFIX}nf.app.fallback/icon.svg`]: () => new Response(SVG, { status: 200 }) },
  });
  try {
    await resetRegistryCache();
    const resp = await getIcon('/api/icon?id=nf.app.fallback');
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('Content-Type'), 'image/svg+xml');
    // 先尝试声明的 icon.png（raw + jsdelivr 均失败），再回退 icon.svg
    assert.ok(seen.some((u) => u.endsWith('/nf.app.fallback/icon.png')));
    assert.ok(seen.some((u) => u.endsWith('/nf.app.fallback/icon.svg')));
  } finally {
    restore();
  }
});

test('无任何图标文件返回 404', async () => {
  const { restore } = stubFetch();
  try {
    await resetRegistryCache();
    assert.equal((await getIcon('/api/icon?id=nf.app.withicon')).status, 404);
  } finally {
    restore();
  }
});
