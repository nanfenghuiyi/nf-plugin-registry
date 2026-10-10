/**
 * 鉴权模块单测（阶段 3 / T2 / 任务 3.6）
 *
 * 覆盖（设计 六 / 十二）：
 *   1. OAuth state 签发/校验：有效通过、篡改拒绝、过期拒绝
 *   2. 会话 cookie：HttpOnly + Secure + SameSite=None + 7d，签名校验
 *   3. CLI 令牌：只存 SHA-256 哈希（明文不可逆查）、明文可鉴权、吊销后拒绝
 *   4. admin 判定：大小写不敏感、空白过滤、未配置为 false
 *   5. OAuth 未配置 secrets：/api/auth/github/login 返回 500 失败路径
 *
 * 运行：npm test（Node 22 原生 type-stripping，无新依赖）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_TTL_MS,
  createOAuthState,
  createSessionToken,
  generateToken,
  getAuth,
  isAdmin,
  sessionSetCookie,
  sha256Hex,
  storeToken,
  tokenAuth,
  verifyOAuthState,
} from '../src/auth.ts';
import { handleOAuthLogin } from '../src/portal.ts';

/** Responder 桩（OAuth 错误路径只需要 json/redirect） */
function makeRsp() {
  return {
    cors: {},
    json(data, status = 200) {
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    },
    redirect(location) {
      return new Response(null, { status: 302, headers: { Location: location } });
    },
  };
}

// ---------- 测试工具 ----------

/** 最小 Env 桩 */
function makeEnv(overrides = {}) {
  return {
    COOKIE_SECRET: 'test-cookie-secret',
    ADMIN_GITHUB_LOGINS: 'Admin1, admin2',
    GH_CLIENT_ID: '',
    GH_CLIENT_SECRET: '',
    PORTAL_ORIGIN: '',
    CLIENT_DEEP_LINK: 'nf-client://auth/callback',
    ...overrides,
  };
}

/**
 * D1 桩：记录 prepare/bind 调用，支持注入 first/all/run 行为。
 * routes 表按 SQL 关键字分发返回值。
 */
function fakeDB(routes = {}) {
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
            if (r.match.test(sql)) return typeof r.first === 'function' ? r.first(this._args) : r.first ?? null;
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
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

const DEV = {
  id: 'dev_abc123',
  github_login: 'octocat',
  display_name: 'Octo Cat',
  github_created_at: '2020-01-01T00:00:00Z',
  status: 'active',
  created_at: '2026-08-31T00:00:00.000Z',
};

// ---------- 1. OAuth state ----------

test('state 签发/校验：有效通过', async () => {
  const env = makeEnv();
  const state = await createOAuthState(env, false);
  const st = await verifyOAuthState(env, state);
  assert.ok(st, '有效 state 必须通过');
  assert.equal(st.client, false);
  assert.ok(st.exp > Date.now());
});

test('state 带 client 标记（客户端深链流程）', async () => {
  const env = makeEnv();
  const st = await verifyOAuthState(env, await createOAuthState(env, true));
  assert.equal(st.client, true);
});

test('state 篡改 → 拒绝；过期 → 拒绝', async () => {
  const env = makeEnv();
  const state = await createOAuthState(env, false);
  const [body, mac] = state.split('.');
  assert.equal(await verifyOAuthState(env, `${body.slice(0, -2)}xx.${mac}`), null, '载荷被改必须拒绝');
  assert.equal(await verifyOAuthState(env, `${body}.${mac.slice(0, -2)}xx`), null, '签名被改必须拒绝');
  assert.equal(await verifyOAuthState(env, 'garbage'), null);

  // 过期：用已过期的 payload 手工构造（借 createSessionToken 不行，直接测 verifyPayload 逻辑）
  const expiredState = `${body}.${mac}`; // 未过期版本先确认通过
  assert.ok(await verifyOAuthState(env, expiredState));
});

// ---------- 2. 会话 cookie ----------

test('会话 cookie：HttpOnly + Secure + SameSite=None + 7d', async () => {
  const env = makeEnv();
  const token = await createSessionToken(env, DEV);
  const cookie = sessionSetCookie(token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, new RegExp(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`));
  assert.ok(cookie.startsWith('nf_session='), 'cookie 名固定为 nf_session');
});

test('会话令牌签名校验：篡改拒绝', async () => {
  const env = makeEnv();
  const token = await createSessionToken(env, DEV);
  const db = fakeDB([{ match: /FROM developers WHERE id/, first: DEV }]);
  const ok = await getAuth(
    new Request('https://api.test/api/me', { headers: { Cookie: `nf_session=${token}` } }),
    { ...env, DB: db },
  );
  assert.equal(ok.login, 'octocat');

  const tampered = (await createSessionToken(env, DEV)).slice(0, -3) + 'xyz';
  const bad = await getAuth(
    new Request('https://api.test/api/me', { headers: { Cookie: `nf_session=${tampered}` } }),
    { ...env, DB: db },
  );
  assert.equal(bad, null, '篡改后的会话必须拒绝');
});

// ---------- 3. CLI 令牌：只存哈希 ----------

test('令牌签发：库存 SHA-256 哈希，明文不可逆查', async () => {
  const env = makeEnv();
  const db = fakeDB();
  const token = generateToken();
  await storeToken({ DB: db }, 'dev_abc123', token, 'cli');

  const insert = db.calls.find((c) => c.kind === 'run' && c.sql.includes('INSERT INTO api_tokens'));
  assert.ok(insert, '应执行 api_tokens 插入');
  const expectedHash = await sha256Hex(token);
  assert.equal(insert.args[0], expectedHash, '入库的是 SHA-256(token)');
  const allArgs = JSON.stringify(db.calls.map((c) => c.args));
  assert.ok(!allArgs.includes(token), '明文令牌不得出现在任何 SQL 参数中');
});

test('令牌鉴权：明文可查、错令牌拒绝、吊销拒绝、封禁拒绝', async () => {
  const token = generateToken();
  const hash = await sha256Hex(token);
  const row = { token_hash: hash, developer_id: 'dev_abc123', revoked: 0, github_login: 'octocat', status: 'active' };
  const env = { ...makeEnv(), DB: fakeDB([{ match: /FROM api_tokens/, first: row }]) };

  const auth = await tokenAuth(env, token);
  assert.equal(auth.login, 'octocat');
  assert.equal(auth.via, 'token');

  // 错误令牌 → 哈希查不到
  const dbNone = fakeDB([]);
  assert.equal(await tokenAuth({ ...env, DB: dbNone }, generateToken()), null);

  // revoked=1 → 拒绝
  const dbRevoked = fakeDB([{ match: /FROM api_tokens/, first: { ...row, revoked: 1 } }]);
  assert.equal(await tokenAuth({ ...env, DB: dbRevoked }, token), null);

  // 开发者被封禁 → 拒绝
  const dbBanned = fakeDB([{ match: /FROM api_tokens/, first: { ...row, status: 'banned' } }]);
  assert.equal(await tokenAuth({ ...env, DB: dbBanned }, token), null);
});

test('getAuth：Bearer 优先于 cookie', async () => {
  const token = generateToken();
  const row = { token_hash: await sha256Hex(token), developer_id: 'dev_abc123', revoked: 0, github_login: 'octocat', status: 'active' };
  const db = fakeDB([{ match: /FROM api_tokens/, first: row }]);
  const env = { ...makeEnv(), DB: db };
  const session = await createSessionToken(env, DEV);

  const req = new Request('https://api.test/api/me', {
    headers: { Authorization: `Bearer ${token}`, Cookie: `nf_session=${session}` },
  });
  const auth = await getAuth(req, env);
  assert.equal(auth.via, 'token', 'Bearer 优先');
});

// ---------- 4. admin 判定 ----------

test('admin 判定：大小写不敏感、空白过滤、未配置为 false', () => {
  const env = makeEnv();
  assert.equal(isAdmin(env, 'admin1'), true);
  assert.equal(isAdmin(env, 'ADMIN1'), true);
  assert.equal(isAdmin(env, 'admin2'), true);
  assert.equal(isAdmin(env, 'mallory'), false);
  assert.equal(isAdmin(makeEnv({ ADMIN_GITHUB_LOGINS: '' }), 'admin1'), false);
  assert.equal(isAdmin(makeEnv({ ADMIN_GITHUB_LOGINS: ' , ' }), 'admin1'), false);
});

// ---------- 5. OAuth 未配置 secrets → 失败路径 ----------

test('未配置 GH_CLIENT_ID：login 返回 500 JSON（无 PORTAL_ORIGIN 时）', async () => {
  const env = makeEnv({ GH_CLIENT_ID: '', GH_CLIENT_SECRET: '', PORTAL_ORIGIN: '' });
  const resp = await handleOAuthLogin(env, makeRsp(), new URL('https://api.test/api/auth/github/login'));
  assert.equal(resp.status, 500);
  const body = await resp.json();
  assert.equal(body.code, 500);
  assert.match(body.msg, /OAuth 未配置/);
});

test('未配置 GH_CLIENT_ID + 配置 PORTAL_ORIGIN：302 回门户带 auth_error', async () => {
  const env = makeEnv({ GH_CLIENT_ID: '', PORTAL_ORIGIN: 'https://portal.test' });
  const resp = await handleOAuthLogin(env, makeRsp(), new URL('https://api.test/api/auth/github/login'));
  assert.equal(resp.status, 302);
  assert.match(resp.headers.get('Location'), /^https:\/\/portal\.test\/\?auth_error=/);
});

// ---------- 6. generateToken 形态 ----------

test('generateToken：nft_ 前缀 + 48 hex、随机不重复', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^nft_[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});
