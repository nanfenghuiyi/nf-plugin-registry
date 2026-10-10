/**
 * 门户路由：GitHub OAuth + 会话 + CLI 令牌（阶段 3 设计 六）
 *
 * 流程：
 *   GET  /api/auth/github/login?client=nf-client?  → 302 GitHub 授权页（state 签名 cookie 防 CSRF）
 *   GET  /api/auth/github/callback                → 换 token → 拉用户 → upsert developer
 *                                                   ├─ 门户流程：签 HttpOnly 会话 cookie（7d）→ 回 PORTAL_ORIGIN
 *                                                   └─ client=nf-client：签发 API 令牌 → 深链 nf-client://auth/callback
 *   GET  /api/me                                  → 身份 + 我的提交 + 我的评论
 *   POST /api/tokens                              → 签发 CLI 令牌（明文仅返回一次）
 *   GET  /api/tokens                              → 我的令牌列表（仅前缀与元数据）
 *   DELETE /api/tokens/:hash                      → 吊销
 *
 * 响应统一通过 index.ts 按请求注入的 responder（rsp）构造，携带动态 CORS；
 * 多个 Set-Cookie 用数组传递（避免逗号拼接导致 cookie 值被截断）。
 */
import type { Env, Responder } from './types';
// 显式 .ts 后缀：wrangler(esbuild) 与 Node 原生 type-stripping 测试均可用
import {
  createOAuthState,
  createSessionToken,
  generateToken,
  getAuth,
  readCookie,
  sessionSetCookie,
  storeToken,
  upsertDeveloper,
  verifyOAuthState,
} from './auth.ts';

/** OAuth state cookie（10 分钟，防 CSRF） */
const STATE_COOKIE = 'nf_oauth_state';
const STATE_COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600';

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

// ---------- GET /api/auth/github/login ----------

export async function handleOAuthLogin(env: Env, rsp: Responder, url: URL): Promise<Response> {
  if (!env.GH_CLIENT_ID || !env.GH_CLIENT_SECRET) {
    return oauthError(env, rsp, '服务端 OAuth 未配置（GH_CLIENT_ID/GH_CLIENT_SECRET）', 500);
  }
  const forClient = url.searchParams.get('client') === 'nf-client';
  const state = await createOAuthState(env, forClient);
  const redirectUri = `${url.origin}/api/auth/github/callback`;
  const authorizeUrl =
    'https://github.com/login/oauth/authorize' +
    `?client_id=${encodeURIComponent(env.GH_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent('read:user')}`;
  return rsp.redirect(authorizeUrl, [`${STATE_COOKIE}=${state}; ${STATE_COOKIE_ATTRS}`]);
}

// ---------- GET /api/auth/github/callback ----------

interface GhUser {
  login: string;
  name: string | null;
  created_at: string | null;
}

async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string | null> {
  try {
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GH_CLIENT_ID,
        client_secret: env.GH_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data: unknown = await resp.json();
    return (data as { access_token?: string }).access_token || null;
  } catch {
    return null;
  }
}

async function fetchGhUser(accessToken: string): Promise<GhUser | null> {
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'nf-market-api',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const user: unknown = await resp.json();
    const { login, name, created_at } = user as GhUser;
    return login ? { login, name: name ?? null, created_at: created_at ?? null } : null;
  } catch {
    return null;
  }
}

export async function handleOAuthCallback(
  env: Env,
  rsp: Responder,
  request: Request,
  url: URL,
): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const stateCookie = readCookie(request, STATE_COOKIE);

  // state 防 CSRF：参数必须存在且与会话 cookie 完全一致，且签名/有效期有效
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return oauthError(env, rsp, 'state 校验失败，请重新登录');
  }
  const st = await verifyOAuthState(env, state);
  if (!st) return oauthError(env, rsp, 'state 已过期，请重新登录');

  const redirectUri = `${url.origin}/api/auth/github/callback`;
  const accessToken = await exchangeCode(env, code, redirectUri);
  if (!accessToken) return oauthError(env, rsp, 'GitHub 授权失败（code 换取 token）', 401);

  const ghUser = await fetchGhUser(accessToken);
  if (!ghUser) return oauthError(env, rsp, '获取 GitHub 用户信息失败', 401);

  const dev = await upsertDeveloper(env, ghUser);
  if (dev.status === 'banned') return oauthError(env, rsp, '账号已被禁用', 403);

  // 客户端深链流程：签发 API 令牌（与 CLI 令牌同表，可吊销），经 URL 一次性下发
  if (st.client) {
    if (!env.CLIENT_DEEP_LINK) return oauthError(env, rsp, '服务端未配置 CLIENT_DEEP_LINK', 500);
    const token = generateToken();
    await storeToken(env, dev.id, token, 'client-session');
    const deep =
      `${env.CLIENT_DEEP_LINK}?token=${encodeURIComponent(token)}` +
      `&login=${encodeURIComponent(dev.github_login)}`;
    return rsp.redirect(deep, [clearStateCookie()]);
  }

  // 门户流程：HttpOnly 会话 cookie（7d）+ 清理 state
  const session = await createSessionToken(env, dev);
  const target = env.PORTAL_ORIGIN || url.origin;
  return rsp.redirect(target, [sessionSetCookie(session), clearStateCookie()]);
}

/** OAuth 流程错误：可跳回门户则 302 带 error 参数，否则 JSON */
function oauthError(env: Env, rsp: Responder, message: string, status = 400): Response {
  if (env.PORTAL_ORIGIN) {
    return rsp.redirect(`${env.PORTAL_ORIGIN}/?auth_error=${encodeURIComponent(message)}`, [
      clearStateCookie(),
    ]);
  }
  return rsp.json({ code: status, msg: message }, status);
}

// ---------- GET /api/me ----------

export async function handleMe(env: Env, rsp: Responder, request: Request): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);

  const dev = await env.DB.prepare(
    `SELECT id, github_login, display_name, github_created_at, status, created_at
     FROM developers WHERE id = ?`,
  )
    .bind(auth.developerId)
    .first();
  if (!dev) return rsp.json({ code: 401, msg: '身份不存在' }, 401);

  const submissions = await env.DB.prepare(
    `SELECT plugin_id, version, status, machine_report, reject_reason, submitted_at, reviewed_at, reviewer
     FROM submissions WHERE developer_id = ? ORDER BY submitted_at DESC LIMIT 200`,
  )
    .bind(auth.developerId)
    .all();

  const reviews = await env.DB.prepare(
    `SELECT plugin_id, stars, comment, status, created_at, updated_at
     FROM reviews WHERE user_login = ? ORDER BY updated_at DESC LIMIT 200`,
  )
    .bind(auth.login)
    .all();

  return rsp.json({
    code: 200,
    msg: 'success',
    data: {
      login: auth.login,
      isAdmin: auth.isAdmin,
      via: auth.via,
      developer: dev,
      plugins: submissions.results || [],
      reviews: reviews.results || [],
    },
  });
}

// ---------- /api/tokens ----------

export async function handleTokens(env: Env, rsp: Responder, request: Request): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);

  if (request.method === 'GET') {
    return rsp.json({
      code: 200,
      msg: 'success',
      data: { tokens: await listTokens(env, auth.developerId) },
    });
  }

  if (request.method === 'POST') {
    let name = 'cli';
    try {
      const body: unknown = await request.json();
      const parsed = (body as { name?: unknown }).name;
      if (typeof parsed === 'string' && parsed.trim()) name = parsed.trim().slice(0, 64);
    } catch {
      // 无 body 或非 JSON：用默认名
    }
    const token = generateToken();
    await storeToken(env, auth.developerId, token, name);
    // 明文 token 仅此响应出现一次（库存 SHA-256 哈希）
    return rsp.json({
      code: 200,
      msg: 'success',
      data: { token, tokens: await listTokens(env, auth.developerId) },
    });
  }

  return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
}

/** DELETE /api/tokens/:hash — 按完整哈希或前 12 位前缀吊销本人的令牌 */
export async function handleTokenRevoke(
  env: Env,
  rsp: Responder,
  request: Request,
  hashParam: string,
): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);
  if (request.method !== 'DELETE') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);

  const hash = hashParam.toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(hash)) {
    return rsp.json({ code: 400, msg: '非法令牌哈希' }, 400);
  }

  // 只允许吊销本人令牌
  const result = await env.DB.prepare(
    `UPDATE api_tokens SET revoked = 1
     WHERE developer_id = ? AND revoked = 0 AND (token_hash = ? OR substr(token_hash, 1, length(?)) = ?)`,
  )
    .bind(auth.developerId, hash, hash, hash)
    .run();
  if (!result.meta.changes) {
    return rsp.json({ code: 404, msg: '令牌不存在或不属于当前用户' }, 404);
  }
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { tokens: await listTokens(env, auth.developerId) },
  });
}

async function listTokens(env: Env, developerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT substr(token_hash, 1, 12) AS token_hash_prefix, name, created_at, last_used_at, revoked
     FROM api_tokens WHERE developer_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(developerId)
    .all();
  return results || [];
}
