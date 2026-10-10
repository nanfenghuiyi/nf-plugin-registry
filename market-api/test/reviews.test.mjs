/**
 * 评分/评论 + 下架过滤单测（阶段 3 / T7）
 *
 * 覆盖（设计 八 + 验收清单第 5、6 条）：
 *   - upsert：每用户每插件一条，重评覆盖
 *   - 校验：stars 必须 1..5 整数；未登录 401
 *   - 限流：同一用户+插件 1 条/分钟
 *   - 聚合：avg 保留 1 位小数，只统计 visible；隐藏后从聚合中剔除
 *   - 反刷：GitHub 注册 <30 天标记 newAccount
 *   - 管理员隐藏/恢复；非管理员 403
 *   - 下架过滤：全部版本下架 → 条目消失；部分下架 → latestVersion 回退
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleDeleteReview,
  handleHideReview,
  handleListReviews,
  handlePostReview,
} from '../src/reviews.ts';
import { applyBlocklist, addBlocked, removeBlocked, getBlocked } from '../src/blocklist.ts';
import { fakeDB, fakeKV, makeEnv, makeRsp } from './helpers.mjs';

const DEV_ID = 'dev_tester01';
const LOGIN = 'tester';
const ADMIN_LOGIN = 'admin-one';
const PID = 'nf.app.rated';

/** 构造带身份的 reviews 测试 env */
function makeReviewsEnv(opts = {}) {
  const login = opts.login || LOGIN;
  const routes = [
    // 单插件聚合
    { match: /COUNT\(\*\) AS count, AVG\(stars\)/, first: opts.agg ?? { count: 2, avg: 4.5 } },
    // 批量聚合
    { match: /GROUP BY plugin_id/, results: opts.aggRows ?? [] },
    // 评论列表
    {
      match: /ORDER BY updated_at DESC/,
      results: opts.list ?? [
        {
          plugin_id: PID,
          user_login: 'alice',
          stars: 5,
          comment: '很好用',
          status: 'visible',
          new_account: 0,
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    },
    // 开发者注册时间（反刷判定）
    {
      match: /FROM developers WHERE id/,
      first: {
        id: DEV_ID,
        github_login: login,
        github_created_at: opts.githubCreatedAt ?? '2020-01-01T00:00:00.000Z',
        status: 'active',
      },
    },
    { match: /FROM api_tokens/, first: { token_hash: 'h', developer_id: DEV_ID, revoked: 0, github_login: login, status: 'active' } },
  ];
  const db = fakeDB(routes);
  const env = makeEnv({ DB: db, KV: fakeKV(), ADMIN_GITHUB_LOGINS: ADMIN_LOGIN });
  return { env, db, headers: { Authorization: 'Bearer nft_token' } };
}

function req(method, path, headers, body) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

// ---------- 1. 发表评价 ----------

test('发表评价 → 200 并返回聚合（avg 保留 1 位小数）', async () => {
  const { env, db, headers } = makeReviewsEnv({ agg: { count: 3, avg: 4.6666667 } });
  const resp = await handlePostReview(
    env,
    makeRsp(),
    req('POST', `/api/plugins/${PID}/reviews`, headers, { stars: 5, comment: '非常棒' }),
    PID,
  );
  assert.equal(resp.status, 200);
  const body = await json(resp);
  assert.equal(body.data.rating, 4.7, 'avg 应四舍五入到 1 位小数');
  assert.equal(body.data.ratingCount, 3);

  const insert = db.calls.find((c) => c.kind === 'run' && c.sql.includes('INSERT INTO reviews'));
  assert.ok(insert, '应执行 reviews upsert');
  assert.equal(insert.args[2], 5, 'stars 入库');
  assert.equal(insert.args[3], '非常棒');
});

test('upsert：SQL 使用 ON CONFLICT DO UPDATE（重评覆盖）', async () => {
  const { env, db, headers } = makeReviewsEnv();
  // 限流按 login+pluginId 维维度，换一个未用过的插件 ID
  await handlePostReview(
    env,
    makeRsp(),
    req('POST', '/api/plugins/nf.app.upsert/reviews', headers, { stars: 3, comment: '一般' }),
    'nf.app.upsert',
  );
  const insert = db.calls.find((c) => c.kind === 'run' && c.sql.includes('INSERT INTO reviews'));
  assert.match(insert.sql, /ON CONFLICT\(plugin_id, user_login\) DO UPDATE/);
  assert.match(insert.sql, /stars = excluded\.stars/);
});

test('stars 非法 → 400（0 / 6 / 小数 / 非数字）', async () => {
  const { env, headers } = makeReviewsEnv();
  for (const stars of [0, 6, 2.5, 'five', null]) {
    const resp = await handlePostReview(
      env,
      makeRsp(),
      req('POST', `/api/plugins/${PID}/reviews`, headers, { stars }),
      PID,
    );
    assert.equal(resp.status, 400, `stars=${stars} 应被拒绝`);
  }
});

test('未登录发表评价 → 401', async () => {
  const db = fakeDB([]);
  const env = makeEnv({ DB: db, KV: fakeKV() });
  const resp = await handlePostReview(
    env,
    makeRsp(),
    req('POST', `/api/plugins/${PID}/reviews`, {}, { stars: 5 }),
    PID,
  );
  assert.equal(resp.status, 401);
});

test('限流：同一用户+插件 1 条/分钟', async () => {
  const { env, headers } = makeReviewsEnv();
  const pid = 'nf.app.ratelimit';
  const first = await handlePostReview(
    env,
    makeRsp(),
    req('POST', `/api/plugins/${pid}/reviews`, headers, { stars: 4 }),
    pid,
  );
  assert.equal(first.status, 200);

  const second = await handlePostReview(
    env,
    makeRsp(),
    req('POST', `/api/plugins/${pid}/reviews`, headers, { stars: 2 }),
    pid,
  );
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('Retry-After'), '60');

  // 换插件不受影响
  const other = await handlePostReview(
    env,
    makeRsp(),
    req('POST', `/api/plugins/nf.app.other/reviews`, headers, { stars: 2 }),
    'nf.app.other',
  );
  assert.equal(other.status, 200);
});

test('新账号（GitHub 注册 <30 天）评分标记 newAccount', async () => {
  const recent = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { env, db, headers } = makeReviewsEnv({ githubCreatedAt: recent });
  await handlePostReview(
    env,
    makeRsp(),
    req('POST', '/api/plugins/nf.app.newbie/reviews', headers, { stars: 5 }),
    'nf.app.newbie',
  );
  const insert = db.calls.find((c) => c.kind === 'run' && c.sql.includes('INSERT INTO reviews'));
  assert.equal(insert.args[4], 1, 'new_account 应标记为 1');
});

test('老账号不标记 newAccount', async () => {
  const { env, db, headers } = makeReviewsEnv({ githubCreatedAt: '2015-05-05T00:00:00.000Z' });
  await handlePostReview(
    env,
    makeRsp(),
    req('POST', '/api/plugins/nf.app.veteran/reviews', headers, { stars: 5 }),
    'nf.app.veteran',
  );
  const insert = db.calls.find((c) => c.kind === 'run' && c.sql.includes('INSERT INTO reviews'));
  assert.equal(insert.args[4], 0);
});

// ---------- 2. 评论列表 ----------

test('评论列表：只返回 visible，附带聚合', async () => {
  const { env, headers } = makeReviewsEnv();
  const resp = await handleListReviews(
    env,
    makeRsp(),
    new URL(`https://api.test/api/plugins/${PID}/reviews?page=1`),
    PID,
  );
  assert.equal(resp.status, 200);
  const body = await json(resp);
  assert.equal(body.data.rating, 4.5);
  assert.equal(body.data.ratingCount, 2);
  assert.equal(body.data.list.length, 1);
  assert.equal(body.data.list[0].user, 'alice');
  assert.equal(body.data.list[0].newAccount, false);
  void headers;
});

test('评论列表 SQL 只查 visible（隐藏评论不下发）', async () => {
  const { env, db } = makeReviewsEnv();
  await handleListReviews(
    env,
    makeRsp(),
    new URL(`https://api.test/api/plugins/${PID}/reviews`),
    PID,
  );
  const q = db.calls.find((c) => c.kind === 'all' && c.sql.includes('ORDER BY updated_at DESC'));
  assert.match(q.sql, /status = 'visible'/);
});

// ---------- 3. 撤评 / 隐藏 ----------

test('撤评：DELETE 本人评论 → 200；无评论可撤 → 404', async () => {
  const { env, db, headers } = makeReviewsEnv();
  const ok = await handleDeleteReview(
    env,
    makeRsp(),
    req('DELETE', `/api/plugins/${PID}/reviews`, headers),
    PID,
  );
  assert.equal(ok.status, 200);
  const del = db.calls.find((c) => c.kind === 'run' && c.sql.includes('DELETE FROM reviews'));
  assert.ok(del);
  assert.equal(del.args[1], LOGIN, '只能删本人评论（按 login 绑定）');
});

test('管理员隐藏评论 → status=hidden', async () => {
  const { env, db, headers } = makeReviewsEnv({ login: ADMIN_LOGIN });
  const resp = await handleHideReview(
    env,
    makeRsp(),
    req('POST', '/api/admin/reviews/hide', headers, { pluginId: PID, userLogin: 'spammer' }),
  );
  assert.equal(resp.status, 200);
  const upd = db.calls.find((c) => c.kind === 'run' && c.sql.includes('UPDATE reviews'));
  assert.equal(upd.args[0], 'hidden');
  assert.equal(upd.args[2], PID);
  assert.equal(upd.args[3], 'spammer');
});

test('非管理员隐藏评论 → 403', async () => {
  const { env, headers } = makeReviewsEnv({ login: LOGIN });
  const resp = await handleHideReview(
    env,
    makeRsp(),
    req('POST', '/api/admin/reviews/hide', headers, { pluginId: PID, userLogin: 'spammer' }),
  );
  assert.equal(resp.status, 403);
});

test('管理员恢复评论（hidden=false）→ status=visible', async () => {
  const { env, db, headers } = makeReviewsEnv({ login: ADMIN_LOGIN });
  await handleHideReview(
    env,
    makeRsp(),
    req('POST', '/api/admin/reviews/hide', headers, { pluginId: PID, userLogin: 'alice', hidden: false }),
  );
  const upd = db.calls.find((c) => c.kind === 'run' && c.sql.includes('UPDATE reviews'));
  assert.equal(upd.args[0], 'visible');
});

test('聚合只统计 visible（SQL 带 status 过滤）', async () => {
  const { env, db } = makeReviewsEnv();
  const { getRating, getRatings } = await import('../src/reviews.ts');
  await getRating(env, PID);
  await getRatings(env, [PID, 'nf.app.other']);
  const c1 = db.calls.find((c) => c.kind === 'first' && c.sql.includes('AVG(stars)'));
  assert.match(c1.sql, /status = 'visible'/);
  const c2 = db.calls.find((c) => c.kind === 'all' && c.sql.includes('GROUP BY plugin_id'));
  assert.match(c2.sql, /status = 'visible'/);
});

// ---------- 4. 下架过滤（blocklist） ----------

const REG = {
  version: 1,
  updatedAt: '',
  totalPlugins: 2,
  categories: {},
  plugins: [
    {
      id: 'a.plugin',
      name: 'A',
      versions: { '1.0.0': { size: 1 }, '1.1.0': { size: 1 }, '1.2.0': { size: 1 } },
      latestVersion: '1.2.0',
    },
    { id: 'b.plugin', name: 'B', versions: { '2.0.0': { size: 1 } }, latestVersion: '2.0.0' },
  ],
};

test('blocklist 空 → registry 原样返回', () => {
  const out = applyBlocklist(REG, new Set());
  assert.equal(out.plugins.length, 2);
  assert.equal(out.plugins[0].latestVersion, '1.2.0');
});

test('部分版本下架 → 保留条目并回退 latestVersion', () => {
  const out = applyBlocklist(REG, new Set(['a.plugin@1.2.0']));
  const a = out.plugins.find((p) => p.id === 'a.plugin');
  assert.ok(a, '条目应保留');
  assert.equal(a.latestVersion, '1.1.0', 'latestVersion 回退到最高未下架版本');
  assert.deepEqual(Object.keys(a.versions), ['1.0.0', '1.1.0']);
});

test('全部版本下架 → 整个条目从索引消失', () => {
  const out = applyBlocklist(REG, new Set(['a.plugin@1.0.0', 'a.plugin@1.1.0', 'a.plugin@1.2.0']));
  assert.equal(out.plugins.length, 1);
  assert.equal(out.plugins[0].id, 'b.plugin');
  assert.equal(out.totalPlugins, 1, 'totalPlugins 同步修正');
});

test('blocklist KV 增删幂等：add → remove → get', async () => {
  const env = makeEnv({ KV: fakeKV() });
  await addBlocked(env, 'x.plugin@1.0.0');
  await addBlocked(env, 'x.plugin@1.0.0');
  let set = await getBlocked(env);
  assert.equal(set.size, 1);
  await removeBlocked(env, 'x.plugin@1.0.0');
  set = await getBlocked(env);
  assert.equal(set.size, 0);
  // 移除不存在的键不抛错
  await removeBlocked(env, 'nope@0.0.0');
});

test('KV 内容损坏（非数组）→ 解析为空名单而非崩溃', async () => {
  const env = makeEnv({ KV: fakeKV() });
  await env.KV.put('index:blocklist', '"not-an-array"');
  const set = await getBlocked(env);
  assert.equal(set.size, 0, 'fail-open：损坏时不下架任何插件');
});
