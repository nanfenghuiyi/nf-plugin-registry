/**
 * 审核工作流（阶段 3 设计 七：状态机 + 审批台 + 待发布队列）
 *
 *   submitted ──机器检查──▶ in_review ──人工──▶ approved ──drain+签名──▶ published
 *        │                     │
 *        ▼                     ▼
 *   machine_check_failed    rejected（附理由，可改后重提）
 *   任意已发布版本 ──▶ pulled（紧急下架：索引层立即剔除 + blocklist 持久化）
 *
 * 路由：
 *   POST /api/submissions/:pid/:ver/submit          开发者提交审核（cookie）
 *   GET  /api/admin/submissions?status=             管理员审核队列
 *   POST /api/admin/submissions/:pid/:ver/review    管理员审批（approved|rejected）
 *   POST /api/admin/submissions/:pid/:ver/pull      管理员紧急下架（pulled）
 *   GET  /api/admin/queue                           待发布队列（drain 目标）
 *   POST /api/admin/queue/ack                       drain 回执（approved → published）
 *
 * 下架即刻生效：Workers 索引层（handleList/handleDetail）读取 blocklist 过滤，
 * 无需等待 registry 变更；registry 侧在 drain 时同步写入 pulled 标记。
 */
import type { Env, Responder, Submission } from './types';
import { getAuth } from './auth.ts';
import {
  deletePackage,
  getSubmission,
  listReleaseQueue,
  listSubmissions,
  upsertSubmission,
} from './store.ts';
import { addBlocked, removeBlocked } from './blocklist.ts';

/** 终态：不可再次提交审核 */
const TERMINAL_STATUSES = ['published', 'pulled'];

/** 需要管理员身份（cookie 会话或 Bearer 令牌，且 login 在 ADMIN_GITHUB_LOGINS） */
async function requireAdmin(
  env: Env,
  request: Request,
): Promise<{ ok: true; login: string } | { ok: false; response: (rsp: Responder) => Response }> {
  const auth = await getAuth(request, env);
  if (!auth) {
    return { ok: false, response: (rsp) => rsp.json({ code: 401, msg: '未登录' }, 401) };
  }
  if (!auth.isAdmin) {
    return { ok: false, response: (rsp) => rsp.json({ code: 403, msg: '需要管理员权限' }, 403) };
  }
  return { ok: true, login: auth.login };
}

/** 开发者（或管理员）身份；管理员可代操作（便于管理员协助重提） */
async function requireDeveloper(env: Env, request: Request) {
  return getAuth(request, env);
}

// ---------- POST /api/submissions/:pid/:ver/submit ----------

/**
 * 开发者把「机器检查已通过」的提交推进到人工审核队列。
 * 前置：submission 存在且属于本人、状态为 submitted（机器检查已通过）。
 */
export async function handleSubmitForReview(
  env: Env,
  rsp: Responder,
  request: Request,
  pluginId: string,
  version: string,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);

  const auth = await requireDeveloper(env, request);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);

  const sub = await getSubmission(env, pluginId, version);
  if (!sub) return rsp.json({ code: 404, msg: '提交记录不存在，请先调用 /api/publish' }, 404);
  if (sub.developer_id !== auth.developerId && !auth.isAdmin) {
    return rsp.json({ code: 403, msg: '无权操作他人的提交' }, 403);
  }
  if (sub.status === 'machine_check_failed') {
    return rsp.json(
      { code: 422, msg: '机器检查未通过，请修正后重新 publish', data: { report: sub.machine_report } },
      422,
    );
  }
  if (sub.status === 'published' || sub.status === 'pulled') {
    return rsp.json({ code: 409, msg: `该版本已处于终态（${sub.status}）` }, 409);
  }
  if (sub.status !== 'submitted') {
    return rsp.json({ code: 409, msg: `当前状态 ${sub.status} 不可重复提交审核` }, 409);
  }

  const saved = await upsertSubmission(env, {
    pluginId,
    version,
    developerId: sub.developer_id,
    status: 'in_review',
    machineReport: sub.machine_report,
  });
  if (!saved.ok) return rsp.json({ code: saved.code || 409, msg: saved.msg || '提交失败' }, saved.code || 409);

  return rsp.json({ code: 200, msg: 'success', data: { pluginId, version, status: 'in_review' } });
}

// ---------- GET /api/admin/submissions ----------

/** 审核队列：status 为空时返回全部（分页上限 200） */
export async function handleAdminSubmissions(
  env: Env,
  rsp: Responder,
  request: Request,
  url: URL,
): Promise<Response> {
  if (request.method !== 'GET') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  const status = url.searchParams.get('status') || '';
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const list = await listSubmissions(env, { status: status || undefined, limit });
  return rsp.json({ code: 200, msg: 'success', data: { list, total: list.length } });
}

// ---------- POST /api/admin/submissions/:pid/:ver/review ----------

interface ReviewBody {
  decision?: unknown;
  reason?: unknown;
}

/**
 * 人工审批：approved → 进入待发布队列（等待核心成员本地 drain 签名）；
 *           rejected → 附理由退回，开发者修正后可重新 publish 同版本。
 */
export async function handleReviewDecision(
  env: Env,
  rsp: Responder,
  request: Request,
  pluginId: string,
  version: string,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  let body: ReviewBody = {};
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    return rsp.json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }

  const decision = String(body.decision || '');
  if (decision !== 'approved' && decision !== 'rejected') {
    return rsp.json({ code: 400, msg: 'decision 必须为 approved 或 rejected' }, 400);
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 2000) : null;
  if (decision === 'rejected' && !reason) {
    return rsp.json({ code: 400, msg: '拒绝时必须填写理由' }, 400);
  }

  const sub = await getSubmission(env, pluginId, version);
  if (!sub) return rsp.json({ code: 404, msg: '提交记录不存在' }, 404);
  if (TERMINAL_STATUSES.includes(sub.status)) {
    return rsp.json({ code: 409, msg: `该版本已处于终态（${sub.status}）` }, 409);
  }
  if (sub.status === 'machine_check_failed') {
    return rsp.json({ code: 422, msg: '机器检查未通过的记录不可直接审批' }, 422);
  }

  if (decision === 'rejected') {
    await upsertSubmission(env, {
      pluginId,
      version,
      developerId: sub.developer_id,
      status: 'rejected',
      machineReport: sub.machine_report,
      rejectReason: reason,
      reviewer: gate.login,
    });
    // 拒绝后释放暂存包体（开发者需重新 publish 上传）
    await deletePackage(env, pluginId, version);
    return rsp.json({
      code: 200,
      msg: 'success',
      data: { pluginId, version, status: 'rejected', reason },
    });
  }

  await upsertSubmission(env, {
    pluginId,
    version,
    developerId: sub.developer_id,
    status: 'approved',
    machineReport: sub.machine_report,
    rejectReason: null,
    reviewer: gate.login,
  });
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, version, status: 'approved', next: '等待核心成员本地 release --drain' },
  });
}

// ---------- POST /api/admin/submissions/:pid/:ver/pull（紧急下架） ----------

/**
 * 紧急下架已发布版本：Workers 索引层立即剔除（blocklist 持久化为 KV），
 * 已安装插件保留运行（客户端 blocklist 仅拦安装/更新，见设计 九-5）。
 */
export async function handlePull(
  env: Env,
  rsp: Responder,
  request: Request,
  pluginId: string,
  version: string,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  let reason = '';
  try {
    const body = (await request.json()) as { reason?: unknown };
    if (typeof body?.reason === 'string') reason = body.reason.trim().slice(0, 2000);
  } catch {
    // 无 body 允许
  }

  const sub = await getSubmission(env, pluginId, version);
  if (!sub) return rsp.json({ code: 404, msg: '提交记录不存在' }, 404);
  if (sub.status !== 'published') {
    return rsp.json({ code: 409, msg: `仅已发布版本可下架（当前 ${sub.status}）` }, 409);
  }

  await addBlocked(env, `${pluginId}@${version}`);
  await upsertSubmission(env, {
    pluginId,
    version,
    developerId: sub.developer_id,
    status: 'pulled',
    machineReport: sub.machine_report,
    rejectReason: reason || '紧急下架',
    reviewer: gate.login,
    allowTerminal: true,
  });
  // 下架后不再保留包体
  await deletePackage(env, pluginId, version);

  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, version, status: 'pulled', reason: reason || '紧急下架' },
  });
}

// ---------- GET /api/admin/queue（待发布队列，drain 目标） ----------

/**
 * 返回 approved 且 KV 包体仍在的提交，含 drain 所需的完整元信息。
 * 响应体不含包体本身（由 POST /api/admin/queue/item 单独取，避免大响应体）。
 */
export async function handleReleaseQueue(
  env: Env,
  rsp: Responder,
  request: Request,
): Promise<Response> {
  if (request.method !== 'GET') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  const queue = await listReleaseQueue(env);
  return rsp.json({
    code: 200,
    msg: 'success',
    data: {
      total: queue.length,
      items: queue.map((q) => ({
        pluginId: q.submission.plugin_id,
        version: q.submission.version,
        developerId: q.submission.developer_id,
        status: q.submission.status,
        hasPackage: q.hasPackage,
        meta: q.meta,
      })),
    },
  });
}

// ---------- POST /api/admin/queue/item（drain 拉取单个包体） ----------

interface QueueItemBody {
  pluginId?: unknown;
  version?: unknown;
}

/** 取单个待发布包（zipBase64），供本地 release --drain 下载 */
export async function handleQueueItem(
  env: Env,
  rsp: Responder,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  let body: QueueItemBody = {};
  try {
    body = (await request.json()) as QueueItemBody;
  } catch {
    return rsp.json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }
  const pluginId = String(body.pluginId || '');
  const version = String(body.version || '');
  if (!pluginId || !version) return rsp.json({ code: 400, msg: '缺少 pluginId 或 version' }, 400);

  const sub = await getSubmission(env, pluginId, version);
  if (!sub || sub.status !== 'approved') {
    return rsp.json({ code: 404, msg: '该版本不在待发布队列中' }, 404);
  }
  const queue = await listReleaseQueue(env);
  const found = queue.find(
    (q) => q.submission.plugin_id === pluginId && q.submission.version === version,
  );
  if (!found?.meta || !found.hasPackage) {
    return rsp.json({ code: 404, msg: '包体不存在，可能已被清理' }, 404);
  }
  const bytes = await env.KV.get(`pkg:${pluginId}@${version}`, 'arrayBuffer');
  if (!bytes) return rsp.json({ code: 404, msg: '包体不存在' }, 404);

  // Uint8Array → base64（分块，避免 apply 参数上限）
  const u8 = new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, version, meta: found.meta, zipBase64: btoa(bin) },
  });
}

// ---------- POST /api/admin/queue/ack（drain 回执 → published） ----------

interface AckBody {
  items?: unknown;
}

/**
 * drain 完成回执：核心成员本地已写入 registry 并重签 registry.sig 后调用，
 * 标记 published 并释放 KV 包体。
 */
export async function handleQueueAck(
  env: Env,
  rsp: Responder,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  let items: Array<{ pluginId?: unknown; version?: unknown }> = [];
  try {
    const body = (await request.json()) as AckBody;
    if (Array.isArray(body.items)) items = body.items;
  } catch {
    return rsp.json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }
  if (items.length === 0 || items.length > 200) {
    return rsp.json({ code: 400, msg: 'items 必须是 1..200 的数组' }, 400);
  }

  const acked: Array<{ pluginId: string; version: string; status: string }> = [];
  const skipped: Array<{ pluginId: string; version: string; reason: string }> = [];

  for (const it of items) {
    const pluginId = String(it?.pluginId || '');
    const version = String(it?.version || '');
    const sub: Submission | null = await getSubmission(env, pluginId, version);
    if (!sub) {
      skipped.push({ pluginId, version, reason: '提交记录不存在' });
      continue;
    }
    if (sub.status !== 'approved') {
      skipped.push({ pluginId, version, reason: `状态为 ${sub.status}，非 approved` });
      continue;
    }
    await upsertSubmission(env, {
      pluginId,
      version,
      developerId: sub.developer_id,
      status: 'published',
      machineReport: sub.machine_report,
      reviewer: gate.login,
      allowTerminal: true,
    });
    await deletePackage(env, pluginId, version);
    acked.push({ pluginId, version, status: 'published' });
  }

  return rsp.json({ code: 200, msg: 'success', data: { acked, skipped } });
}

// ---------- 开发者视角：我的提交（/api/me 已含，此路由供门户刷新单条） ----------

export async function handleMySubmissions(
  env: Env,
  rsp: Responder,
  request: Request,
): Promise<Response> {
  const auth = await requireDeveloper(env, request);
  if (!auth) return rsp.json({ code: 401, msg: '未登录' }, 401);
  const list = await listSubmissions(env, { developerId: auth.developerId, limit: 200 });
  return rsp.json({ code: 200, msg: 'success', data: { list, total: list.length } });
}

/** 撤销下架（误操作时恢复）：仅在 pulled 状态可用 */
export async function handleUnpull(
  env: Env,
  rsp: Responder,
  request: Request,
  pluginId: string,
  version: string,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);
  const gate = await requireAdmin(env, request);
  if (!gate.ok) return gate.response(rsp);

  const sub = await getSubmission(env, pluginId, version);
  if (!sub) return rsp.json({ code: 404, msg: '提交记录不存在' }, 404);
  if (sub.status !== 'pulled') {
    return rsp.json({ code: 409, msg: `仅已下架版本可恢复（当前 ${sub.status}）` }, 409);
  }
  await removeBlocked(env, `${pluginId}@${version}`);
  await upsertSubmission(env, {
    pluginId,
    version,
    developerId: sub.developer_id,
    status: 'published',
    machineReport: sub.machine_report,
    reviewer: gate.login,
    allowTerminal: true,
  });
  return rsp.json({ code: 200, msg: 'success', data: { pluginId, version, status: 'published' } });
}
