/**
 * 评分/评论（阶段 3 设计 八）
 *
 * 规则：
 *   - 身份：GitHub 登录用户（门户 cookie 会话或客户端 Bearer 令牌）
 *   - 每账号每插件一条（重评覆盖，PK = plugin_id + user_login）
 *   - 发布限流：1 条/分钟（isolate 内内存窗口，MVP 级；多 isolate 下为软限流）
 *   - 反刷：GitHub 注册 < 30 天的评分标记 new_account=1（后台可见，默认不展示）
 *   - 聚合：avg 保留 1 位小数 + count，回填进 /api/plugins 与 /api/plugins/:id
 *
 * 路由：
 *   GET    /api/plugins/:id/reviews?page=       评论列表（visible）+ 聚合
 *   POST   /api/plugins/:id/reviews             五星 + 短评（upsert）
 *   DELETE /api/plugins/:id/reviews             撤评（本人）
 *   POST   /api/admin/reviews/hide              管理员隐藏/恢复违规评论
 */
import type { Env, Responder } from './types';
import { getAuth } from './auth.ts';

export interface ReviewRow {
  plugin_id: string;
  user_login: string;
  stars: number;
  comment: string | null;
  status: 'visible' | 'hidden';
  new_account: number;
  created_at: string;
  updated_at: string;
}

export interface RatingAgg {
  avg: number;
  count: number;
}

/** 新账号阈值：GitHub 注册不足 30 天（设计 八 反刷） */
const NEW_ACCOUNT_DAYS = 30;
/** 发布限流窗口 */
const POST_WINDOW_MS = 60_000;
const PAGE_SIZE = 20;

// ---------- 限流（isolate 内软限流） ----------
const lastPostAt = new Map<string, number>();
function allowPost(key: string): boolean {
  const now = Date.now();
  const last = lastPostAt.get(key);
  if (last && now - last < POST_WINDOW_MS) return false;
  lastPostAt.set(key, now);
  if (lastPostAt.size > 5000) {
    for (const [k, t] of lastPostAt) if (now - t >= POST_WINDOW_MS) lastPostAt.delete(k);
  }
  return true;
}

// ---------- 聚合查询 ----------

/**
 * 批量查询插件评分聚合（一次 IN 查询，避免 N+1）。
 * 只统计 visible 评论。
 */
export async function getRatings(
  env: Env,
  pluginIds: string[],
): Promise<Map<string, RatingAgg>> {
  const map = new Map<string, RatingAgg>();
  if (pluginIds.length === 0) return map;

  // D1 单次参数上限 100，分片查询
  const CHUNK = 100;
  for (let i = 0; i < pluginIds.length; i += CHUNK) {
    const slice = pluginIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT plugin_id, COUNT(*) AS count, AVG(stars) AS avg
         FROM reviews
        WHERE status = 'visible' AND plugin_id IN (${placeholders})
        GROUP BY plugin_id`,
    )
      .bind(...slice)
      .all<{ plugin_id: string; count: number; avg: number }>();
    for (const r of results || []) {
      map.set(r.plugin_id, {
        count: Number(r.count) || 0,
        avg: Math.round((Number(r.avg) || 0) * 10) / 10,
      });
    }
  }
  return map;
}

/** 单插件聚合（详情用） */
export async function getRating(env: Env, pluginId: string): Promise<RatingAgg> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count, AVG(stars) AS avg FROM reviews WHERE plugin_id = ? AND status = 'visible'`,
  )
    .bind(pluginId)
    .first<{ count: number; avg: number }>();
  return {
    count: Number(row?.count) || 0,
    avg: Math.round((Number(row?.avg) || 0) * 10) / 10,
  };
}

// ---------- GET /api/plugins/:id/reviews ----------

export async function handleListReviews(
  env: Env,
  rsp: Responder,
  url: URL,
  pluginId: string,
): Promise<Response> {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const agg = await getRating(env, pluginId);
  const { results } = await env.DB.prepare(
    `SELECT plugin_id, user_login, stars, comment, status, new_account, created_at, updated_at
       FROM reviews
      WHERE plugin_id = ? AND status = 'visible'
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(pluginId, PAGE_SIZE, offset)
    .all<ReviewRow>();

  return rsp.json({
    code: 200,
    msg: 'success',
    data: {
      pluginId,
      rating: agg.avg,
      ratingCount: agg.count,
      page,
      pageSize: PAGE_SIZE,
      list: (results || []).map((r) => ({
        user: r.user_login,
        stars: r.stars,
        comment: r.comment || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // newAccount 评分仍计入平均数，仅前端标注（设计 八：后台可见）
        newAccount: r.new_account === 1,
      })),
    },
  });
}

// ---------- POST /api/plugins/:id/reviews ----------

interface ReviewBody {
  stars?: unknown;
  comment?: unknown;
}

export async function handlePostReview(
  env: Env,
  rsp: Responder,
  request: Request,
  pluginId: string,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);

  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '请先用 GitHub 登录后再评价' }, 401);

  let body: ReviewBody = {};
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    return rsp.json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }

  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return rsp.json({ code: 400, msg: 'stars 必须是 1..5 的整数' }, 400);
  }
  const comment =
    typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';

  if (!allowPost(`${auth.login}:${pluginId}`)) {
    return rsp.json({ code: 429, msg: '评价过于频繁，请稍后再试' }, 429, {
      'Retry-After': '60',
    });
  }

  // 新账号标记：GitHub 注册时间不足 30 天
  const dev = await env.DB.prepare(
    `SELECT github_created_at FROM developers WHERE id = ?`,
  )
    .bind(auth.developerId)
    .first<{ github_created_at: string | null }>();
  const createdAt = dev?.github_created_at ? Date.parse(dev.github_created_at) : NaN;
  const isNewAccount =
    Number.isFinite(createdAt) && Date.now() - createdAt < NEW_ACCOUNT_DAYS * 24 * 3600 * 1000;

  const now = new Date().toISOString();
  // upsert：同一用户重评覆盖（PK = plugin_id + user_login）
  await env.DB.prepare(
    `INSERT INTO reviews (plugin_id, user_login, stars, comment, status, new_account, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'visible', ?, ?, ?)
     ON CONFLICT(plugin_id, user_login) DO UPDATE SET
       stars = excluded.stars,
       comment = excluded.comment,
       status = 'visible',
       new_account = excluded.new_account,
       updated_at = excluded.updated_at`,
  )
    .bind(pluginId, auth.login, stars, comment || null, isNewAccount ? 1 : 0, now, now)
    .run();

  const agg = await getRating(env, pluginId);
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, stars, comment, rating: agg.avg, ratingCount: agg.count },
  });
}

// ---------- DELETE /api/plugins/:id/reviews（撤评） ----------

export async function handleDeleteReview(
  env: Env,
  rsp: Responder,
  request: Request,
  pluginId: string,
): Promise<Response> {
  if (request.method !== 'DELETE') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);

  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);

  const result = await env.DB.prepare(
    `DELETE FROM reviews WHERE plugin_id = ? AND user_login = ?`,
  )
    .bind(pluginId, auth.login)
    .run();
  if (!result.meta.changes) return rsp.json({ code: 404, msg: '没有可撤销的评价' }, 404);

  const agg = await getRating(env, pluginId);
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, rating: agg.avg, ratingCount: agg.count },
  });
}

// ---------- POST /api/admin/reviews/hide ----------

interface HideBody {
  pluginId?: unknown;
  userLogin?: unknown;
  hidden?: unknown;
}

/** 管理员隐藏/恢复评论（隐藏后不计入聚合：status='hidden'） */
export async function handleHideReview(
  env: Env,
  rsp: Responder,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);

  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);
  if (!auth.isAdmin) return rsp.json({ code: 403, msg: '需要管理员权限' }, 403);

  let body: HideBody = {};
  try {
    body = (await request.json()) as HideBody;
  } catch {
    return rsp.json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }
  const pluginId = String(body.pluginId || '');
  const userLogin = String(body.userLogin || '');
  if (!pluginId || !userLogin) {
    return rsp.json({ code: 400, msg: '缺少 pluginId 或 userLogin' }, 400);
  }
  const hidden = body.hidden === undefined ? true : Boolean(body.hidden);

  const result = await env.DB.prepare(
    `UPDATE reviews SET status = ?, updated_at = ? WHERE plugin_id = ? AND user_login = ?`,
  )
    .bind(hidden ? 'hidden' : 'visible', new Date().toISOString(), pluginId, userLogin)
    .run();
  if (!result.meta.changes) return rsp.json({ code: 404, msg: '评论不存在' }, 404);

  const agg = await getRating(env, pluginId);
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, userLogin, status: hidden ? 'hidden' : 'visible', rating: agg.avg, ratingCount: agg.count },
  });
}
