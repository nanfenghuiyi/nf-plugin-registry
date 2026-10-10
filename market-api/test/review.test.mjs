/**
 * 审核工作流单测（阶段 3 / T5）
 *
 * 覆盖（设计 七 状态机 + 验收清单第 3、6 条）：
 *   submitted → in_review → approved → published（ack）
 *   机器检查失败 / 终态 拒绝流转；rejected 必须带理由并释放包体
 *   pulled 紧急下架 → 索引层立即剔除（blocklist）+ 可恢复（unpull）
 *   非管理员 403；跨开发者 403
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleAdminSubmissions,
  handlePull,
  handleQueueAck,
  handleQueueItem,
  handleReleaseQueue,
  handleReviewDecision,
  handleSubmitForReview,
  handleUnpull,
} from '../src/review.ts';
import {
  fakeDB,
  fakeKV,
  makeEnv,
  makeRsp,
  stubRegistryFetch,
  FAKE_REGISTRY,
} from './helpers.mjs';

const DEV_ID = 'dev_tester01';
const ADMIN_LOGIN = 'admin-one';
const USER_LOGIN = 'tester';

/** 构造 submissions 行 */
function sub(over = {}) {
  return {
    plugin_id: 'com.example.demo',
    version: '1.0.0',
    developer_id: DEV_ID,
    status: 'submitted',
    machine_report: null,
    reject_reason: null,
    submitted_at: '2026-08-31T00:00:00.000Z',
    reviewed_at: null,
    reviewer: null,
    ...over,
  };
}

/**
 * 构造带身份的 env：login 落在 ADMIN_GITHUB_LOGINS 内即管理员。
 * 身份用 Bearer 令牌（api_tokens 命中）。
 */
function makeAuthed(opts = {}) {
  const login = opts.login || USER_LOGIN;
  const db = fakeDB([
    {
      match: /FROM api_tokens/,
      first: {
        token_hash: 'h',
        developer_id: opts.developerId || DEV_ID,
        revoked: 0,
        github_login: login,
        status: 'active',
      },
    },
    {
      match: /FROM submissions/,
      first: opts.submission ?? null,
      results: opts.submission ? [opts.submission] : [],
    },
    {
      match: /FROM developers WHERE id/,
      first: { id: DEV_ID, github_login: login, status: 'active', github_created_at: null },
    },
  ]);
  const env = makeEnv({ DB: db, KV: fakeKV() });
  const headers = { Authorization: 'Bearer nft_token' };
  return { env, db, headers };
}

function req(method, path, headers, body) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(fn, env, request, extra = []) {
  const restore = stubRegistryFetch(FAKE_REGISTRY);
  try {
    const resp = await fn(env, makeRsp(), request, ...extra);
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return { resp, body };
  } finally {
    restore();
  }
}

// ---------- 提交审核 ----------

test('submitted → in_review（本人提交）', async () => {
  const { env, db, headers } = makeAuthed({ submission: sub() });
  const { resp, body } = await call(
    handleSubmitForReview,
    env,
    req('POST', '/api/submissions/com.example.demo/1.0.0/submit', headers),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'in_review');
  const upd = db.calls.find((c) => c.kind === 'run' && c.sql.includes('UPDATE submissions'));
  assert.ok(upd, '应更新 submissions 状态');
});

test('机器检查失败的记录不可提交审核 → 422', async () => {
  const { env, headers } = makeAuthed({ submission: sub({ status: 'machine_check_failed' }) });
  const { resp } = await call(
    handleSubmitForReview,
    env,
    req('POST', '/api/submissions/com.example.demo/1.0.0/submit', headers),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 422);
});

test('不存在的提交 → 404', async () => {
  const { env, headers } = makeAuthed({ submission: null });
  const { resp } = await call(
    handleSubmitForReview,
    env,
    req('POST', '/api/submissions/com.example.demo/1.0.0/submit', headers),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 404);
});

// ---------- 管理员审批 ----------

test('管理员 approve → approved（进入待发布队列）', async () => {
  const { env, db, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'in_review' }) });
  const { resp, body } = await call(
    handleReviewDecision,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/review', headers, { decision: 'approved' }),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'approved');
  const upd = db.calls.find((c) => c.sql.includes('UPDATE submissions') && c.args[0] === 'approved');
  assert.ok(upd, '状态应写为 approved');
});

test('非管理员审批 → 403', async () => {
  const { env, headers } = makeAuthed({ login: USER_LOGIN, submission: sub({ status: 'in_review' }) });
  const { resp } = await call(
    handleReviewDecision,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/review', headers, { decision: 'approved' }),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 403);
});

test('reject 必须带理由，否则 400', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'in_review' }) });
  const { resp } = await call(
    handleReviewDecision,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/review', headers, { decision: 'rejected' }),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 400);
});

test('管理员 reject（带理由）→ rejected 且释放 KV 包体', async () => {
  const { env, db, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'in_review' }) });
  // 预置包体到 KV
  await env.KV.put('pkg:com.example.demo@1.0.0', new Uint8Array([1, 2, 3]));
  await env.KV.put('meta:com.example.demo@1.0.0', JSON.stringify({ pluginId: 'com.example.demo', version: '1.0.0' }));

  const { resp, body } = await call(
    handleReviewDecision,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/review', headers, {
      decision: 'rejected',
      reason: '权限声明与功能不符',
    }),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'rejected');
  const upd = db.calls.find((c) => c.sql.includes('UPDATE submissions') && c.args[0] === 'rejected');
  assert.equal(upd.args[2], '权限声明与功能不符', '拒绝理由应入库');
  assert.equal(env.KV.store.has('pkg:com.example.demo@1.0.0'), false, '拒绝后应释放包体');
});

test('已发布终态不可再次审批 → 409', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'published' }) });
  const { resp } = await call(
    handleReviewDecision,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/review', headers, { decision: 'approved' }),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 409);
});

// ---------- 待发布队列与回执 ----------

test('管理员查看待发布队列 → 含 approved 条目与包体可用性', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN });
  env.DB = fakeDB([
    { match: /FROM api_tokens/, first: { token_hash: 'h', developer_id: DEV_ID, revoked: 0, github_login: ADMIN_LOGIN, status: 'active' } },
    {
      match: /FROM submissions/,
      results: [sub({ status: 'approved' })],
    },
  ]);
  // 队列条目有包体
  await env.KV.put('pkg:com.example.demo@1.0.0', new Uint8Array([80, 75]));
  await env.KV.put('meta:com.example.demo@1.0.0', JSON.stringify({ pluginId: 'com.example.demo', version: '1.0.0', checksum: 'c'.repeat(64) }));

  const { resp, body } = await call(handleReleaseQueue, env, req('GET', '/api/admin/queue', headers));
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.total, 1);
  assert.equal(body.data.items[0].hasPackage, true);
  assert.equal(body.data.items[0].meta.checksum, 'c'.repeat(64));
});

test('队列取包 → 返回 zipBase64', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'approved' }) });
  await env.KV.put('pkg:com.example.demo@1.0.0', new Uint8Array([80, 75, 3, 4]));
  await env.KV.put('meta:com.example.demo@1.0.0', JSON.stringify({ pluginId: 'com.example.demo', version: '1.0.0' }));

  const { resp, body } = await call(
    handleQueueItem,
    env,
    req('POST', '/api/admin/queue/item', headers, { pluginId: 'com.example.demo', version: '1.0.0' }),
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.zipBase64, Buffer.from([80, 75, 3, 4]).toString('base64'));
});

test('ack 回执 → published 并释放包体', async () => {
  const { env, db, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'approved' }) });
  await env.KV.put('pkg:com.example.demo@1.0.0', new Uint8Array([1]));
  await env.KV.put('meta:com.example.demo@1.0.0', '{}');

  const { resp, body } = await call(
    handleQueueAck,
    env,
    req('POST', '/api/admin/queue/ack', headers, { items: [{ pluginId: 'com.example.demo', version: '1.0.0' }] }),
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.acked.length, 1);
  assert.equal(body.data.acked[0].status, 'published');
  assert.equal(env.KV.store.has('pkg:com.example.demo@1.0.0'), false);
  const upd = db.calls.find((c) => c.sql.includes('UPDATE submissions') && c.args[0] === 'published');
  assert.ok(upd);
});

test('ack 非 approved 条目 → skipped 而非报错', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'in_review' }) });
  const { resp, body } = await call(
    handleQueueAck,
    env,
    req('POST', '/api/admin/queue/ack', headers, { items: [{ pluginId: 'com.example.demo', version: '1.0.0' }] }),
  );
  assert.equal(resp.status, 200);
  assert.equal(body.data.acked.length, 0);
  assert.equal(body.data.skipped.length, 1);
  assert.match(body.data.skipped[0].reason, /in_review/);
});

// ---------- 紧急下架 ----------

test('pull 已发布版本 → pulled + 写入 blocklist', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'published' }) });
  const { resp, body } = await call(
    handlePull,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/pull', headers, { reason: '存在恶意行为' }),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'pulled');
  const blocked = JSON.parse(env.KV.store.get('index:blocklist'));
  assert.deepEqual(blocked, ['com.example.demo@1.0.0'], '下架名单应持久化到 KV');
});

test('pull 非已发布状态 → 409', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'approved' }) });
  const { resp } = await call(
    handlePull,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/pull', headers),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 409);
});

test('unpull 恢复已下架版本 → published + 移出 blocklist', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN, submission: sub({ status: 'pulled' }) });
  await env.KV.put('index:blocklist', JSON.stringify(['com.example.demo@1.0.0']));
  const { resp, body } = await call(
    handleUnpull,
    env,
    req('POST', '/api/admin/submissions/com.example.demo/1.0.0/unpull', headers),
    ['com.example.demo', '1.0.0'],
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'published');
  assert.equal(env.KV.store.get('index:blocklist'), '[]');
});

// ---------- 审核队列列表 ----------

test('非管理员访问审核队列 → 403', async () => {
  const { env, headers } = makeAuthed({ login: USER_LOGIN });
  const { resp } = await call(
    handleAdminSubmissions,
    env,
    req('GET', '/api/admin/submissions', headers),
    [new URL('https://api.test/api/admin/submissions')],
  );
  assert.equal(resp.status, 403);
});

test('管理员按状态过滤审核队列 → 返回列表', async () => {
  const { env, headers } = makeAuthed({ login: ADMIN_LOGIN });
  env.DB = fakeDB([
    { match: /FROM api_tokens/, first: { token_hash: 'h', developer_id: DEV_ID, revoked: 0, github_login: ADMIN_LOGIN, status: 'active' } },
    { match: /FROM submissions/, results: [sub({ status: 'in_review' })] },
  ]);
  const { resp, body } = await call(
    handleAdminSubmissions,
    env,
    req('GET', '/api/admin/submissions?status=in_review', headers),
    [new URL('https://api.test/api/admin/submissions?status=in_review')],
  );
  assert.equal(resp.status, 200, JSON.stringify(body));
  assert.equal(body.data.total, 1);
  assert.equal(body.data.list[0].status, 'in_review');
});
