/**
 * 阶段 3 共享存储层：待发布包体（KV）+ submissions 表读写
 *
 * KV 键约定（设计 六：Workers 只暂存待发布包，审批通过后由核心成员本地 drain 合入 registry）：
 *   pkg:<pluginId>@<version>   → zip 原始字节（≤20MB，KV 单值上限 25MiB）
 *   meta:<pluginId>@<version>  → JSON 元信息（manifest / checksum / signature / publicKey / 开发者）
 *
 * 状态机（设计 七）：
 *   submitted → in_review → approved → published
 *         ↘ machine_check_failed   ↘ rejected
 *   任意已发布版本 → pulled（紧急下架）
 */
import type { Env, Submission } from './types';

// ---------- KV ----------

export function pkgKey(pluginId: string, version: string): string {
  return `pkg:${pluginId}@${version}`;
}

export function metaKey(pluginId: string, version: string): string {
  return `meta:${pluginId}@${version}`;
}

/** 待发布包元信息（drain 时用于重建 registry 条目） */
export interface PackageMeta {
  pluginId: string;
  version: string;
  developerId: string;
  login: string;
  manifest: Record<string, unknown>;
  /** zip 原始字节的 SHA-256 hex（客户端安装时的权威 checksum） */
  checksum: string;
  /** 开发者自有私钥对 zip 字节的 Ed25519 签名（base64） */
  signature: string;
  /** 开发者公钥 PEM（spki）；drain 后写入 registry 条目供客户端验签 */
  publicKey: string;
  size: number;
  changelog: string;
  submittedAt: string;
}

export async function putPackage(
  env: Env,
  meta: PackageMeta,
  zipBytes: Uint8Array,
): Promise<void> {
  await env.KV.put(pkgKey(meta.pluginId, meta.version), zipBytes);
  await env.KV.put(metaKey(meta.pluginId, meta.version), JSON.stringify(meta));
}

export async function getMeta(
  env: Env,
  pluginId: string,
  version: string,
): Promise<PackageMeta | null> {
  return env.KV.get<PackageMeta>(metaKey(pluginId, version), 'json');
}

export async function getPackageBytes(
  env: Env,
  pluginId: string,
  version: string,
): Promise<Uint8Array | null> {
  // arrayBuffer 读取：zip 为二进制，避免 JSON 解析失败
  const buf = await env.KV.get(pkgKey(pluginId, version), 'arrayBuffer');
  return buf ? new Uint8Array(buf) : null;
}

export async function deletePackage(env: Env, pluginId: string, version: string): Promise<void> {
  await env.KV.delete(pkgKey(pluginId, version));
  await env.KV.delete(metaKey(pluginId, version));
}

// ---------- submissions ----------

const SUBMISSION_COLUMNS = `plugin_id, version, developer_id, status, machine_report, reject_reason, submitted_at, reviewed_at, reviewer`;

export async function getSubmission(
  env: Env,
  pluginId: string,
  version: string,
): Promise<Submission | null> {
  return env.DB.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE plugin_id = ? AND version = ?`)
    .bind(pluginId, version)
    .first<Submission>();
}

/**
 * 写入/覆盖一条提交记录（同一 pluginId+version 视为同一提交）。
 * 只允许记录所有者操作；已 published / pulled 的版本不可被重新提交覆盖。
 *
 * @returns { ok: false, code, msg } 表示拒绝；{ ok: true } 表示已写入
 */
export async function upsertSubmission(
  env: Env,
  params: {
    pluginId: string;
    version: string;
    developerId: string;
    status: Submission['status'];
    machineReport?: string | null;
    rejectReason?: string | null;
    reviewer?: string | null;
    /** 是否覆盖已发布/已下架的终态记录（pulled 需要） */
    allowTerminal?: boolean;
  },
): Promise<{ ok: boolean; code?: number; msg?: string }> {
  const existing = await getSubmission(env, params.pluginId, params.version);
  if (existing && existing.developer_id !== params.developerId) {
    return { ok: false, code: 403, msg: '该插件 ID/版本属于其他开发者' };
  }
  if (existing && !params.allowTerminal && existing.status === 'published') {
    return { ok: false, code: 409, msg: '该版本已发布，请递增版本号后重新提交' };
  }

  const now = new Date().toISOString();
  const reviewedAt = ['approved', 'rejected', 'published', 'pulled'].includes(params.status)
    ? now
    : null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE submissions
         SET status = ?, machine_report = ?, reject_reason = ?, submitted_at = ?, reviewed_at = ?, reviewer = ?
       WHERE plugin_id = ? AND version = ?`,
    )
      .bind(
        params.status,
        params.machineReport ?? existing.machine_report ?? null,
        params.rejectReason ?? null,
        existing.submitted_at,
        reviewedAt,
        params.reviewer ?? null,
        params.pluginId,
        params.version,
      )
      .run();
    return { ok: true };
  }

  await env.DB.prepare(
    `INSERT INTO submissions (${SUBMISSION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      params.pluginId,
      params.version,
      params.developerId,
      params.status,
      params.machineReport ?? null,
      params.rejectReason ?? null,
      now,
      reviewedAt,
      params.reviewer ?? null,
    )
    .run();
  return { ok: true };
}

/** 审核队列：按状态过滤（管理员视角） */
export async function listSubmissions(
  env: Env,
  opts: { status?: string; developerId?: string; limit?: number } = {},
): Promise<Submission[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) {
    where.push('status = ?');
    args.push(opts.status);
  }
  if (opts.developerId) {
    where.push('developer_id = ?');
    args.push(opts.developerId);
  }
  const sql = `SELECT ${SUBMISSION_COLUMNS} FROM submissions${
    where.length ? ' WHERE ' + where.join(' AND ') : ''
  } ORDER BY submitted_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...args, limit)
    .all<Submission>();
  return results || [];
}

/**
 * 待发布队列（drain 目标）：status='approved' 且 KV 中包体仍在。
 * 包体缺失说明被清理/已 drain 但未回执，标记为 skip 由人工排查。
 */
export async function listReleaseQueue(env: Env): Promise<
  Array<{ submission: Submission; meta: PackageMeta | null; hasPackage: boolean }>
> {
  const approved = await listSubmissions(env, { status: 'approved', limit: 200 });
  const out: Array<{ submission: Submission; meta: PackageMeta | null; hasPackage: boolean }> = [];
  for (const s of approved) {
    const meta = await getMeta(env, s.plugin_id, s.version);
    const bytes = await getPackageBytes(env, s.plugin_id, s.version);
    out.push({ submission: s, meta, hasPackage: !!bytes });
  }
  return out;
}

// ---------- 工具 ----------

/** base64 → Uint8Array（同时拒绝非法字符，防服务端解析异常） */
export function decodeBase64(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length === 0) return null;
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 版本号粗校验：x.y.z（允许预发布后缀） */
export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
}
