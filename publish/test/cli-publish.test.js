'use strict';
/**
 * 发布 CLI 单测（阶段 3 / T6）
 *
 * 覆盖：
 *   1. parseFlags：--key value / --flag 布尔 / 位置参数
 *   2. loadDevKeys：缺失返回 null，存在返回 PEM
 *   3. keygen 产物可被 sign/verify 使用（开发者自有密钥签名链路）
 *   4. upsertDeveloperEntry：新建条目带 publisher/developerId；更新条目 bump latestVersion
 *   5. 双信任链：开发者签的包能被开发者公钥验过、不能被项目根公钥验过
 *   6. portalClient：错误映射（非 200 code / 非 JSON / 超时）
 *
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const signLib = require('../../lib/sign');
const encryptLib = require('../../lib/encrypt');
const portalClient = require('../lib/portalClient');
const cli = require('../nf-plugin-cli');

// ---------- 1. parseFlags ----------

test('parseFlags：--key value / --flag 布尔 / 位置参数', () => {
  const r = cli.parseFlags(['../my-plugin', '--token', 'nft_abc', '--no-push', '--server']);
  assert.deepEqual(r.positional, ['../my-plugin']);
  assert.equal(r.flags.token, 'nft_abc');
  assert.equal(r.flags['no-push'], true);
  assert.equal(r.flags.server, true, '无值长选项应为 true（回落到默认门户地址）');
});

test('parseFlags：--server <url> 取值', () => {
  const r = cli.parseFlags(['--server', 'https://example.test']);
  assert.equal(r.flags.server, 'https://example.test');
});

// ---------- 2. loadDevKeys ----------

test('loadDevKeys：目录不存在 → null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-keys-none-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(cli.loadDevKeys(dir), null);
});

test('loadDevKeys：密钥存在 → 返回 PEM', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-keys-ok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  signLib.ensureKeys(dir);
  const keys = cli.loadDevKeys(dir);
  assert.ok(keys, '应加载出密钥');
  assert.match(keys.privPem, /BEGIN PRIVATE KEY/);
  assert.match(keys.pubPem, /BEGIN PUBLIC KEY/);
});

// ---------- 3. 开发者密钥签名链路（keygen 产物可用） ----------

test('keygen 产物：开发者私钥签名可被自身公钥验证', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-keygen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  signLib.ensureKeys(dir); // 与 cmdKeygen 相同的生成方式
  const { privPem, pubPem } = cli.loadDevKeys(dir);

  const zipBuf = Buffer.from('PKfake-zip-bytes');
  const sig = signLib.sign(zipBuf, privPem);
  assert.equal(sig.length, 64, 'Ed25519 签名 64 字节');
  assert.equal(signLib.verify(zipBuf, sig, pubPem), true);
  assert.equal(signLib.verify(Buffer.from('PKtampered'), sig, pubPem), false, '篡改包体必须验签失败');
});

// ---------- 4. upsertDeveloperEntry ----------

function makeMeta(over = {}) {
  return {
    pluginId: 'com.dev.widget',
    version: '1.0.0',
    developerId: 'dev_abc123',
    login: 'octocat',
    checksum: 'c'.repeat(64),
    signature: 'sig-base64',
    publicKey: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
    changelog: '首次发布',
    manifest: {
      id: 'com.dev.widget',
      name: '开发者小组件',
      description: '第三方插件',
      version: '1.0.0',
      type: 'app',
      category: '工具', // 中文分类，应被归一化为 tool
      main: 'index.js',
      permissions: ['ipc:register'],
      engines: { 'nf-client': '>=1.2.0' },
      author: 'octocat',
    },
    ...over,
  };
}

test('upsertDeveloperEntry：新建条目带 publisher=developer / developerId，版本条目字段完整', () => {
  const registry = { version: 1, updatedAt: '', totalPlugins: 0, categories: {}, plugins: [] };
  const zipBuf = Buffer.from('zip-bytes');
  cli.upsertDeveloperEntry(registry, makeMeta(), zipBuf, 'd'.repeat(64));

  assert.equal(registry.plugins.length, 1);
  const p = registry.plugins[0];
  assert.equal(p.id, 'com.dev.widget');
  assert.equal(p.publisher, 'developer');
  assert.equal(p.developerId, 'dev_abc123');
  assert.equal(p.developerLogin, 'octocat');
  assert.equal(p.category, 'tool', '中文分类应归一化');
  assert.equal(p.latestVersion, '1.0.0');

  const v = p.versions['1.0.0'];
  assert.equal(v.checksum, 'd'.repeat(64));
  assert.equal(v.signature, 'sig-base64');
  assert.equal(v.format, 'nfpkg');
  assert.equal(v.encrypted, true);
  assert.equal(v.encryptionVersion, 1);
  assert.equal(v.minAppVersion, '>=1.2.0', '取 engines[nf-client]');
  assert.match(v.downloadUrl, /\.nfpkg$/);
});

test('upsertDeveloperEntry：已有条目追加版本并 bump latestVersion', () => {
  const registry = { plugins: [] };
  cli.upsertDeveloperEntry(registry, makeMeta({ version: '1.0.0' }), Buffer.from('a'), 'x');
  cli.upsertDeveloperEntry(registry, makeMeta({ version: '1.2.0' }), Buffer.from('b'), 'y');
  // 旧版本回补不应回退 latestVersion
  cli.upsertDeveloperEntry(registry, makeMeta({ version: '1.1.0' }), Buffer.from('c'), 'z');

  assert.equal(registry.plugins.length, 1, '同 ID 不新增条目');
  const p = registry.plugins[0];
  assert.deepEqual(Object.keys(p.versions).sort(), ['1.0.0', '1.1.0', '1.2.0']);
  assert.equal(p.latestVersion, '1.2.0');
  assert.equal(p.versions['1.1.0'].checksum, 'z');
});

test('upsertDeveloperEntry：minAppVersion 缺省回落 >=1.0.8', () => {
  const registry = { plugins: [] };
  const meta = makeMeta();
  delete meta.manifest.engines;
  cli.upsertDeveloperEntry(registry, meta, Buffer.from('a'), 'x');
  assert.equal(registry.plugins[0].versions['1.0.0'].minAppVersion, '>=1.0.8');
});

// ---------- 5. 双信任链 ----------

test('双信任链：开发者签的包能被开发者公钥验过，不能被项目根公钥验过', (t) => {
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-trust-dev-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-trust-root-'));
  t.after(() => {
    fs.rmSync(devDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  signLib.ensureKeys(devDir);
  signLib.ensureKeys(rootDir);
  const dev = cli.loadDevKeys(devDir);
  const root = cli.loadDevKeys(rootDir);

  const zipBuf = Buffer.from('third-party-zip');
  const sig = signLib.sign(zipBuf, dev.privPem);
  assert.equal(signLib.verify(zipBuf, sig, dev.pubPem), true, '开发者公钥应验过');
  assert.equal(signLib.verify(zipBuf, sig, root.pubPem), false, '根公钥不能验过第三方包（设计 4.2）');
});

test('drain 加密产物可被客户端解密还原为原 zip', () => {
  const zipBuf = Buffer.from('PKoriginal-zip-content');
  const packet = encryptLib.encrypt(zipBuf);
  assert.notEqual(packet.equals(zipBuf), true, '密文应不同于明文');
  assert.equal(encryptLib.decrypt(packet).toString(), zipBuf.toString(), '解密应还原原 zip');
});

// ---------- 6. portalClient 错误映射 ----------

/** 安装临时 fetch 桩，返回还原函数 */
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('portalClient：code!==200 → 抛 PortalError 且携带 msg 与 data', async () => {
  const restore = stubFetch(async () =>
    jsonResponse(422, { code: 422, msg: '机器检查未通过', data: { report: '{"ok":false}' } }),
  );
  try {
    await assert.rejects(
      () => portalClient.fetchQueue('https://api.test', 'nft_token'),
      (e) => {
        assert.equal(e.name, 'PortalError');
        assert.equal(e.code, 422);
        assert.equal(e.message, '机器检查未通过');
        assert.equal(e.data.report, '{"ok":false}');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('portalClient：非 JSON 响应 → 抛 PortalError', async () => {
  const restore = stubFetch(async () => new Response('<html>502</html>', { status: 502 }));
  try {
    await assert.rejects(
      () => portalClient.fetchQueue('https://api.test', 't'),
      /非 JSON 响应/,
    );
  } finally {
    restore();
  }
});

test('portalClient：网络失败 → 抛 PortalError（提示无法连接）', async () => {
  const restore = stubFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  try {
    await assert.rejects(
      () => portalClient.fetchQueue('https://api.test', 't'),
      /无法连接门户/,
    );
  } finally {
    restore();
  }
});

test('portalClient：成功响应返回 data，并带 Bearer 头', async () => {
  let seenAuth = null;
  let seenUrl = null;
  const restore = stubFetch(async (url, init) => {
    seenUrl = String(url);
    seenAuth = init.headers.Authorization;
    return jsonResponse(200, { code: 200, msg: 'success', data: { total: 3, items: [] } });
  });
  try {
    const data = await portalClient.fetchQueue('https://api.test/', 'nft_abc');
    assert.equal(data.total, 3);
    assert.equal(seenAuth, 'Bearer nft_abc');
    assert.equal(seenUrl, 'https://api.test/api/admin/queue', '尾部斜杠应被清理');
  } finally {
    restore();
  }
});

test('portalClient：ack 请求体为 { items }', async () => {
  let seenBody = null;
  const restore = stubFetch(async (_url, init) => {
    seenBody = JSON.parse(init.body);
    return jsonResponse(200, { code: 200, msg: 'success', data: { acked: [], skipped: [] } });
  });
  try {
    await portalClient.ackQueue('https://api.test', 't', [{ pluginId: 'a.b', version: '1.0.0' }]);
    assert.deepEqual(seenBody, { items: [{ pluginId: 'a.b', version: '1.0.0' }] });
  } finally {
    restore();
  }
});

test('sanity：Node crypto 与 lib/sign 的 Ed25519 互通（跨实现一致性）', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const data = Buffer.from('cross-impl-check');
  // Node crypto 签 → lib/sign 验
  const nodeSig = crypto.sign(null, data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(signLib.verify(data, nodeSig, pubPem), true);
  // lib/sign 签 → Node crypto 验
  const libSig = signLib.sign(data, privPem);
  assert.equal(
    crypto.verify(null, data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, libSig),
    true,
  );
});
