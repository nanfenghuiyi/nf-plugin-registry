/**
 * 发布通道 /api/publish 单测（阶段 3 / T4）
 *
 * 覆盖（设计 六 机器检查项 + 验收清单第 2 条）：
 *   1. 鉴权：无令牌 401、门户会话 401（必须 CLI 令牌）、无效令牌 401
 *   2. 通过：合法包 → 200 submitted，包体入 KV，submissions 落库
 *   3. 拦截：签名不匹配 / 缺 manifest 必填字段 / 非法权限 / 超体积 / 占用官方 ID
 *   4. 安全：明文令牌不出现在任何 SQL 参数中
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { handlePublish } from '../src/publish.ts';
import { createSessionToken } from '../src/auth.ts';
import { MAX_PACKAGE_SIZE } from '../src/machineCheck.ts';
import {
  FAKE_REGISTRY,
  buildPluginZip,
  fakeDB,
  fakeKV,
  makeDevKeyPair,
  makeEnv,
  makeRsp,
  stubRegistryFetch,
  toBase64,
} from './helpers.mjs';

const DEV_ID = 'dev_tester01';
const LOGIN = 'tester';

/** 已鉴权的 CLI 令牌环境（api_tokens 命中 + submissions 未命中） */
function makeAuthedEnv(opts = {}) {
  const token = opts.token || 'nft_' + 'a'.repeat(48);
  const db = fakeDB([
    {
      match: /FROM api_tokens/,
      first: {
        token_hash: 'hash-of-' + token,
        developer_id: DEV_ID,
        revoked: 0,
        github_login: LOGIN,
        status: opts.banned ? 'banned' : 'active',
      },
    },
    { match: /FROM developers WHERE github_login/, first: { id: DEV_ID, github_login: LOGIN } },
    { match: /FROM submissions/, first: opts.submission ?? null },
    {
      match: /FROM developers WHERE id/,
      first: {
        id: DEV_ID,
        github_login: LOGIN,
        display_name: LOGIN,
        github_created_at: null,
        status: opts.banned ? 'banned' : 'active',
        created_at: '2026-08-31T00:00:00.000Z',
      },
    },
  ]);
  return { env: makeEnv({ DB: db, KV: fakeKV() }), db, token };
}

/** 构造 publish 请求 */
function publishRequest(token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://api.test/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** 打一次 publish（自动安装 registry 桩并在结束后还原） */
async function run(env, request) {
  const restore = stubRegistryFetch(FAKE_REGISTRY);
  try {
    const resp = await handlePublish(env, makeRsp(), request);
    return { resp, body: await resp.json() };
  } finally {
    restore();
  }
}

// ---------- 1. 鉴权 ----------

test('publish 无令牌 → 401', async () => {
  const { env } = makeAuthedEnv();
  const { zip, manifest } = await buildPluginZip();
  const keys = await makeDevKeyPair();
  const { resp } = await run(
    env,
    publishRequest(null, { manifest, zipBase64: toBase64(zip), signature: keys.sign(zip), publicKey: keys.pubPem }),
  );
  assert.equal(resp.status, 401);
});

test('publish 用门户会话 cookie → 401（必须 CLI 令牌）', async () => {
  const { env } = makeAuthedEnv();
  const session = await createSessionToken(env, {
    id: DEV_ID,
    github_login: LOGIN,
    display_name: LOGIN,
    github_created_at: null,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  const { zip, manifest } = await buildPluginZip();
  const keys = await makeDevKeyPair();
  const req = new Request('https://api.test/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `nf_session=${session}` },
    body: JSON.stringify({
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: keys.pubPem,
    }),
  });
  const { resp, body } = await run(env, req);
  assert.equal(resp.status, 401);
  assert.match(body.msg, /CLI 令牌/);
});

test('publish 无效令牌 → 401', async () => {
  // api_tokens 查不到（fakeDB 无路由 → null）
  const emptyEnv = makeEnv({ DB: fakeDB([]), KV: fakeKV() });
  const { zip, manifest } = await buildPluginZip();
  const keys = await makeDevKeyPair();
  const { resp } = await run(
    emptyEnv,
    publishRequest('nft_' + 'b'.repeat(48), {
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: keys.pubPem,
    }),
  );
  assert.equal(resp.status, 401);
});

// ---------- 2. 合法包 → submitted ----------

test('publish 合法包 → 200 submitted，包体入 KV + submissions 落库', async () => {
  const { env, db, token } = makeAuthedEnv();
  const { zip, manifest } = await buildPluginZip();
  const keys = await makeDevKeyPair();

  const { resp, body } = await run(
    env,
    publishRequest(token, {
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: keys.pubPem,
      changelog: '首次提交',
    }),
  );

  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'submitted');
  assert.equal(body.data.pluginId, 'com.example.demo');

  // 机器检查全部通过
  const report = JSON.parse(body.data.report);
  assert.equal(report.ok, true);
  for (const c of report.checks) assert.equal(c.ok, true, `${c.name} 应通过: ${c.detail}`);

  // 包体与元信息入 KV
  assert.ok(env.KV.store.has('pkg:com.example.demo@1.0.0'), 'zip 应存入 KV');
  const meta = JSON.parse(env.KV.store.get('meta:com.example.demo@1.0.0'));
  assert.equal(meta.developerId, DEV_ID);
  assert.equal(meta.size, zip.length);
  assert.ok(meta.checksum.length === 64, 'checksum 应为 SHA-256 hex');

  // submissions 落库
  const insert = db.calls.find((c) => c.kind === 'run' && c.sql.includes('INSERT INTO submissions'));
  assert.ok(insert, '应插入 submissions');
  assert.equal(insert.args[3], 'submitted');

  // 安全：明文令牌不得出现在任何 SQL 参数中
  const allArgs = JSON.stringify(db.calls.map((c) => c.args));
  assert.ok(!allArgs.includes(token), '明文令牌不得入库');
});

// ---------- 3. 机器检查拦截 ----------

test('签名与公钥不匹配 → 422 machine_check_failed（报告含 signature 失败项）', async () => {
  const { env, token } = makeAuthedEnv();
  const { zip, manifest } = await buildPluginZip();
  const keys = await makeDevKeyPair();
  const other = await makeDevKeyPair(); // 另一把公钥

  const { resp, body } = await run(
    env,
    publishRequest(token, {
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: other.pubPem, // 公钥与签名不匹配
    }),
  );

  assert.equal(resp.status, 422);
  assert.equal(body.data.status, 'machine_check_failed');
  const report = JSON.parse(body.data.report);
  const sig = report.checks.find((c) => c.name === 'signature');
  assert.equal(sig.ok, false);
});

test('manifest 缺必填字段 main → 422（报告含 manifest 失败项）', async () => {
  const { env, token } = makeAuthedEnv();
  const { zip } = await buildPluginZip();
  const keys = await makeDevKeyPair();
  // zip 内 manifest 完整，但提交的 manifest 去掉 main → 必填字段校验拒绝
  const manifest = {
    id: 'com.example.demo',
    name: '示例插件',
    version: '1.0.0',
    type: 'app',
    category: 'tool',
    permissions: [],
  };

  const { resp, body } = await run(
    env,
    publishRequest(token, {
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: keys.pubPem,
    }),
  );
  assert.equal(resp.status, 422);
  const report = JSON.parse(body.data.report);
  assert.equal(report.checks.find((c) => c.name === 'manifest').ok, false);
  assert.match(report.checks.find((c) => c.name === 'manifest').detail, /main/);
});

test('声明未授权权限 → 422（报告含 permissions 失败项）', async () => {
  const { env, token } = makeAuthedEnv();
  const { zip, manifest } = await buildPluginZip({ permissions: ['system:rm-rf'] });
  const keys = await makeDevKeyPair();

  const { resp, body } = await run(
    env,
    publishRequest(token, {
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: keys.pubPem,
    }),
  );
  assert.equal(resp.status, 422);
  const report = JSON.parse(body.data.report);
  const perms = report.checks.find((c) => c.name === 'permissions');
  assert.equal(perms.ok, false);
  assert.match(perms.detail, /system:rm-rf/);
});

test('占用官方插件 ID → 422（报告含 duplicates 失败项）', async () => {
  const { env, token } = makeAuthedEnv();
  // FAKE_REGISTRY 中 nf.app.official 无 developerId → 视为官方条目
  const { zip, manifest } = await buildPluginZip({ id: 'nf.app.official' });
  const keys = await makeDevKeyPair();

  const { resp, body } = await run(
    env,
    publishRequest(token, {
      manifest,
      zipBase64: toBase64(zip),
      signature: keys.sign(zip),
      publicKey: keys.pubPem,
    }),
  );
  assert.equal(resp.status, 422);
  const report = JSON.parse(body.data.report);
  const dup = report.checks.find((c) => c.name === 'duplicates');
  assert.equal(dup.ok, false);
  assert.match(dup.detail, /官方插件/);
});

test('包体超过 20MB → 413', async () => {
  const { env, token } = makeAuthedEnv();
  const keys = await makeDevKeyPair();
  const oversize = new Uint8Array(MAX_PACKAGE_SIZE + 1);
  const { resp, body } = await run(
    env,
    publishRequest(token, {
      manifest: { id: 'com.example.big', name: 'big', version: '1.0.0', type: 'app', category: 'tool', main: 'index.js', permissions: [] },
      zipBase64: toBase64(oversize),
      signature: keys.sign(oversize),
      publicKey: keys.pubPem,
    }),
  );
  assert.equal(resp.status, 413);
  assert.match(body.msg, /超限/);
});

test('缺少 zipBase64 / signature / publicKey → 400', async () => {
  const { env, token } = makeAuthedEnv();
  const { zip, manifest } = await buildPluginZip();
  const keys = await makeDevKeyPair();

  const noZip = await run(env, publishRequest(token, { manifest, signature: 'x', publicKey: keys.pubPem }));
  assert.equal(noZip.resp.status, 400);

  const noSig = await run(env, publishRequest(token, { manifest, zipBase64: toBase64(zip), publicKey: keys.pubPem }));
  assert.equal(noSig.resp.status, 400);

  const noKey = await run(env, publishRequest(token, { manifest, zipBase64: toBase64(zip), signature: keys.sign(zip) }));
  assert.equal(noKey.resp.status, 400);
});

test('请求体非 JSON → 400', async () => {
  const { env, token } = makeAuthedEnv();
  const restore = stubRegistryFetch(FAKE_REGISTRY);
  try {
    const req = new Request('https://api.test/api/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: 'not-json',
    });
    const resp = await handlePublish(env, makeRsp(), req);
    assert.equal(resp.status, 400);
  } finally {
    restore();
  }
});
