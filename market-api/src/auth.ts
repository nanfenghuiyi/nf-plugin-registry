/**
 * 阶段 3 鉴权模块（设计 六 / 十二）
 *
 * 三类身份：
 *   1. 门户会话 cookie（GitHub OAuth 签发，HMAC 签名载荷，HttpOnly，7d）
 *   2. CLI 发布令牌（Bearer，api_tokens 表只存 SHA-256 哈希，可吊销）
 *   3. 客户端令牌（与 CLI 令牌同表；OAuth 回调带 client=nf-client 时经深链下发）
 *
 * 安全约定（设计 十二）：
 *   - 令牌明文仅签发响应中出现一次，库存哈希；校验用常数时间比较
 *   - cookie HttpOnly + Secure + SameSite=None（门户 Pages 与 API 跨站）
 *   - 管理员由 ADMIN_GITHUB_LOGINS 白名单判定
 */
import type { ApiToken, AuthContext, Developer, Env } from './types';

// ---------- base64url ----------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- HMAC 签名载荷（会话 cookie / OAuth state） ----------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** 载荷 = base64url(json).base64url(hmac) */
async function signPayload(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64urlEncode(utf8(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(body));
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

/** 校验并解析载荷；过期/签名不符返回 null */
async function verifyPayload<T>(secret: string, token: string): Promise<T | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign('HMAC', key, utf8(body));
  // 常数时间比较
  const got = b64urlDecode(mac);
  const exp = new Uint8Array(expected);
  if (got.length !== exp.length) return null;
  let diff = 0;
  for (let i = 0; i < exp.length; i++) diff |= got[i] ^ exp[i];
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
    return payload as T;
  } catch {
    return null;
  }
}

// ---------- 会话 cookie ----------

export const SESSION_COOKIE = 'nf_session';
/** 会话有效期：7 天（设计 六） */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 签发门户会话 cookie 值 */
export function createSessionToken(env: Env, dev: Developer): Promise<string> {
  return signPayload(env.COOKIE_SECRET, {
    v: 1,
    devId: dev.id,
    login: dev.github_login,
    exp: Date.now() + SESSION_TTL_MS,
  });
}

/** 会话 Set-Cookie（HttpOnly + Secure + SameSite=None，跨站门户需要） */
export function sessionSetCookie(token: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

// ---------- OAuth state（防 CSRF，设计 六） ----------

interface OAuthState {
  r: string; // 随机数
  client: boolean; // 是否客户端深链流程
  exp: number;
}

export function createOAuthState(env: Env, forClient: boolean): Promise<string> {
  const payload: OAuthState = {
    r: crypto.randomUUID(),
    client: forClient,
    exp: Date.now() + 10 * 60 * 1000, // 10 分钟有效
  };
  return signPayload(env.COOKIE_SECRET, payload as unknown as Record<string, unknown>);
}

export function verifyOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  return verifyPayload<OAuthState>(env.COOKIE_SECRET, state);
}

// ---------- CLI / 客户端 API 令牌 ----------

export function sha256Hex(s: string): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', utf8(s))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

/** 生成一次性展示的明文令牌（nft_<48 hex>） */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'nft_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 写入 api_tokens（只存哈希）。返回明文令牌 */
export async function storeToken(
  env: Env,
  developerId: string,
  token: string,
  name: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO api_tokens (token_hash, developer_id, name, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), developerId, name, new Date().toISOString())
    .run();
}

/** 用明文令牌查身份；无效/吊销返回 null。命中时顺带更新 last_used_at */
export async function tokenAuth(env: Env, token: string): Promise<AuthContext | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT t.token_hash, t.developer_id, t.revoked, d.github_login, d.status
     FROM api_tokens t JOIN developers d ON d.id = t.developer_id
     WHERE t.token_hash = ?`,
  )
    .bind(hash)
    .first<ApiToken & { github_login: string; status: string }>();
  if (!row || row.revoked) return null;
  if (row.status !== 'active') return null;
  // 异步更新 last_used_at 不阻塞（失败无害）
  env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`)
    .bind(new Date().toISOString(), hash)
    .run()
    .catch(() => {});
  return {
    developerId: row.developer_id,
    login: row.github_login,
    isAdmin: isAdmin(env, row.github_login),
    via: 'token',
  };
}

// ---------- 请求统一鉴权 ----------

export function isAdmin(env: Env, login: string): boolean {
  return (env.ADMIN_GITHUB_LOGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(login.toLowerCase());
}

/** 从请求解析身份：优先 Authorization: Bearer，其次门户会话 cookie */
export async function getAuth(request: Request, env: Env): Promise<AuthContext | null> {
  const authz = request.headers.get('Authorization') || '';
  if (authz.toLowerCase().startsWith('bearer ')) {
    const token = authz.slice(7).trim();
    if (token) return tokenAuth(env, token);
  }
  const cookieToken = readCookie(request, SESSION_COOKIE);
  if (!cookieToken) return null;
  const payload = await verifyPayload<{ devId: string; login: string }>(
    env.COOKIE_SECRET,
    cookieToken,
  );
  if (!payload) return null;
  // 账号可能事后被封禁：实时查状态
  const dev = await env.DB.prepare(`SELECT * FROM developers WHERE id = ?`)
    .bind(payload.devId)
    .first<Developer>();
  if (!dev || dev.status !== 'active') return null;
  return { developerId: dev.id, login: dev.github_login, isAdmin: isAdmin(env, dev.github_login), via: 'session' };
}

/** 读取 cookie 值（无则返回 null） */
export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

// ---------- 开发者 upsert（GitHub OAuth 回调） ----------

export async function upsertDeveloper(env: Env, ghUser: {
  login: string;
  name: string | null;
  created_at: string | null;
}): Promise<Developer> {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT * FROM developers WHERE github_login = ?`,
  )
    .bind(ghUser.login)
    .first<Developer>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE developers SET display_name = ?, github_created_at = ? WHERE id = ?`,
    )
      .bind(ghUser.name, ghUser.created_at, existing.id)
      .run();
    return { ...existing, display_name: ghUser.name, github_created_at: ghUser.created_at };
  }
  const id = 'dev_' + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(
    `INSERT INTO developers (id, github_login, display_name, github_created_at, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, ghUser.login, ghUser.name, ghUser.created_at, now)
    .run();
  return {
    id,
    github_login: ghUser.login,
    display_name: ghUser.name,
    github_created_at: ghUser.created_at,
    status: 'active',
    created_at: now,
  };
}
