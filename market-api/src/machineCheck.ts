/**
 * 机器检查（阶段 3 设计 六：/api/publish 时执行）
 *
 * 检查项：包结构校验、签名/公钥匹配、checksum 一致、权限声明 lint、
 *          manifest 白名单字段、包体积上限（≤ 20MB）、重名/重 ID 检查。
 * 规则对齐客户端 electron/service/plugin/pluginVerifier.ts（必填字段 / ID 格式 / 权限白名单）。
 *
 * 边界：服务端只做格式/完整性校验，不接触任何私钥（设计 4.2）。
 */
import { unzipSync } from 'fflate';
import type { RegistryData } from './types';

/** 包体积上限（设计 六）：zip 原始字节 ≤ 20MB */
export const MAX_PACKAGE_SIZE = 20 * 1024 * 1024;
/** 解压后总大小上限（zip 炸弹防护） */
export const MAX_UNCOMPRESSED_SIZE = 60 * 1024 * 1024;
/** 解压后条目数上限 */
export const MAX_ENTRIES = 2000;

/** 权限白名单（对齐客户端 pluginVerifier.ts PERMISSION_WHITELIST） */
export const PERMISSION_WHITELIST = [
  'hardware:serial',
  'hardware:socket',
  'hardware:websocket',
  'hardware:print',
  'hardware:streamer',
  'hardware:scale',
  'hardware:scanner',
  'storage:read',
  'storage:write',
  'network:request',
  'window:manage',
  'job:exec',
  'ipc:register',
  'shortcut:register',
  'notification:create',
  'system:info',
  'system:service',
  'system:speech',
  'system:extension',
  'system:globalInput',
  'plugin:invoke',
  'plugin:reload',
  'database:manage',
  'tray:menu',
];

/** manifest 必填字段（对齐客户端 pluginVerifier.requiredFields） */
const REQUIRED_FIELDS = ['id', 'name', 'version', 'type', 'category', 'main', 'permissions'];

export interface MachineCheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface MachineCheckResult {
  ok: boolean;
  checks: MachineCheckItem[];
  /** 结构检查通过时回填（供路由层使用） */
  manifest?: Record<string, unknown>;
  /** zip 原始字节的 SHA-256 hex（即发布后的权威 checksum） */
  checksum?: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Ed25519（WebCrypto，raw 64 字节签名，与客户端 ieee-p1363 一致） ----------

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 验证 zip 原始字节的 Ed25519 签名（spki PEM 公钥 + base64 签名） */
export async function verifyPackageSignature(
  zipBytes: Uint8Array,
  signatureB64: string,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    if (!signatureB64 || !publicKeyPem) return false;
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    if (sig.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      'spki',
      pemToDer(publicKeyPem) as unknown as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sig as unknown as ArrayBuffer,
      zipBytes as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

// ---------- manifest 校验 ----------

interface ManifestCheck {
  ok: boolean;
  detail?: string;
  manifest?: Record<string, unknown>;
}

export function checkManifest(raw: unknown): ManifestCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'manifest 必须是对象' };
  }
  const m = raw as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (m[field] === undefined || m[field] === null) {
      return { ok: false, detail: `manifest 缺少必填字段: ${field}` };
    }
  }
  if (!/^[\w-]+(\.[\w-]+)+$/.test(String(m.id))) {
    return { ok: false, detail: `manifest.id 格式不正确: ${m.id}（应为反向域名格式）` };
  }
  if (!/^\d+\.\d+\.\d+/.test(String(m.version))) {
    return { ok: false, detail: `manifest.version 格式不正确: ${m.version}` };
  }
  if (!Array.isArray(m.permissions)) {
    return { ok: false, detail: 'manifest.permissions 必须是数组' };
  }
  return { ok: true, manifest: m };
}

/** 权限声明 lint：未知权限返回列表 */
export function lintPermissions(manifest: Record<string, unknown>): string[] {
  const perms = (manifest.permissions as unknown[]) || [];
  return perms
    .map((p) => String(p))
    .filter((p) => !PERMISSION_WHITELIST.includes(p));
}

// ---------- 包结构校验 ----------

function normalizeEntryName(name: string): string {
  return name.replace(/^\.\//, '');
}

/** zip 结构：可解压、无路径穿越、manifest.json 与 main/icon 入口存在 */
export function checkPackageStructure(
  zipBytes: Uint8Array,
  manifest: Record<string, unknown>,
): { ok: boolean; detail?: string } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes, {
      // 解压体积护栏（zip 炸弹防护），在 filter 阶段无法拿到累计大小，解压后校验
    });
  } catch (e: any) {
    return { ok: false, detail: 'zip 解析失败: ' + (e?.message || e) };
  }

  const names = Object.keys(entries);
  if (names.length === 0) return { ok: false, detail: 'zip 为空' };
  if (names.length > MAX_ENTRIES) {
    return { ok: false, detail: `zip 条目数超限（${names.length} > ${MAX_ENTRIES}）` };
  }

  let total = 0;
  for (const name of names) {
    const norm = normalizeEntryName(name);
    // 路径穿越防护
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
      return { ok: false, detail: `zip 存在非法路径: ${name}` };
    }
    total += entries[name].length;
    if (total > MAX_UNCOMPRESSED_SIZE) {
      return { ok: false, detail: `解压后总大小超限（> ${MAX_UNCOMPRESSED_SIZE} 字节）` };
    }
  }

  if (!entries['manifest.json']) {
    return { ok: false, detail: 'zip 缺少 manifest.json' };
  }
  const main = String(manifest.main || '');
  if (main && !entries[normalizeEntryName(main)]) {
    return { ok: false, detail: `入口文件不存在: ${main}` };
  }
  const icon = String(manifest.icon || '');
  if (icon && !entries[normalizeEntryName(icon)]) {
    return { ok: false, detail: `图标文件不存在: ${icon}` };
  }
  return { ok: true };
}

// ---------- 重名/重 ID 检查 ----------

/**
 * 重 ID 检查：registry 已存在同 ID 时——
 *   - official 条目：拒绝（第三方不得覆盖官方插件）
 *   - developer 条目且 developerId 一致：允许（本人更新）
 *   - developer 条目但归属他人：拒绝
 * 同时拒绝与他人待审提交同 ID 同版本的冲突（避免 PK 覆盖）。
 */
export async function checkDuplicates(
  db: D1Database,
  registry: RegistryData,
  pluginId: string,
  version: string,
  developerId: string,
): Promise<{ ok: boolean; detail?: string }> {
  const existing = registry.plugins.find((p) => p.id === pluginId);
  if (existing) {
    const owner = (existing as { developerId?: string }).developerId;
    if (!owner) {
      return { ok: false, detail: `插件 ID 已被官方插件占用: ${pluginId}` };
    }
    if (owner !== developerId) {
      return { ok: false, detail: `插件 ID 已被其他开发者占用: ${pluginId}` };
    }
  }

  const row = await db
    .prepare(`SELECT developer_id FROM submissions WHERE plugin_id = ? AND version = ?`)
    .bind(pluginId, version)
    .first<{ developer_id: string }>();
  if (row && row.developer_id !== developerId) {
    return { ok: false, detail: `相同 ID/版本的提交已在审核队列中（他人提交）` };
  }
  return { ok: true };
}

// ---------- 汇总入口 ----------

export interface MachineCheckInput {
  manifestRaw: unknown;
  zipBytes: Uint8Array;
  signatureB64: string;
  publicKeyPem: string;
}

/**
 * 机器检查主入口（不含需要 registry/D1 的重 ID 检查，见 checkDuplicates）。
 * 任何一项失败即 ok=false；结果 JSON 直接作为 machine_report 落库。
 */
export async function runMachineCheck(input: MachineCheckInput): Promise<MachineCheckResult> {
  const checks: MachineCheckItem[] = [];

  // 1. 体积上限
  const sizeOk = input.zipBytes.length > 0 && input.zipBytes.length <= MAX_PACKAGE_SIZE;
  checks.push({
    name: 'size',
    ok: sizeOk,
    detail: sizeOk ? `zip ${input.zipBytes.length} 字节` : `超过体积上限 ${MAX_PACKAGE_SIZE} 字节`,
  });

  // 2. manifest 白名单字段
  const manifestCheck = checkManifest(input.manifestRaw);
  checks.push({ name: 'manifest', ok: manifestCheck.ok, detail: manifestCheck.detail });

  // 3. 权限 lint（结构通过后才有意义）
  let manifest: Record<string, unknown> | undefined = manifestCheck.manifest;
  if (manifestCheck.ok && manifest) {
    const invalid = lintPermissions(manifest);
    checks.push({
      name: 'permissions',
      ok: invalid.length === 0,
      detail: invalid.length === 0 ? undefined : `未授权权限: ${invalid.join(', ')}`,
    });

    // 4. 包结构
    const struct = checkPackageStructure(input.zipBytes, manifest);
    checks.push({ name: 'structure', ok: struct.ok, detail: struct.detail });
  } else {
    checks.push({ name: 'permissions', ok: false, detail: 'manifest 无效，跳过' });
    checks.push({ name: 'structure', ok: false, detail: 'manifest 无效，跳过' });
  }

  // 5. checksum（服务端计算，作为发布后的权威值；manifest 内声明值不一致时报错）
  const checksum = await sha256Hex(input.zipBytes);
  if (manifest && typeof manifest.checksum === 'string' && manifest.checksum) {
    checks.push({
      name: 'checksum',
      ok: manifest.checksum === checksum,
      detail: manifest.checksum === checksum ? checksum : `manifest.checksum(${manifest.checksum}) 与实际(${checksum})不一致`,
    });
  } else {
    checks.push({ name: 'checksum', ok: true, detail: checksum });
  }

  // 6. 签名/公钥匹配
  const sigOk = await verifyPackageSignature(input.zipBytes, input.signatureB64, input.publicKeyPem);
  checks.push({
    name: 'signature',
    ok: sigOk,
    detail: sigOk ? undefined : 'Ed25519 验签失败（签名与公钥/包体不匹配）',
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks, manifest: manifestCheck.ok ? manifestCheck.manifest : undefined, checksum };
}

/** machine_report 落库格式 */
export function buildMachineReport(result: MachineCheckResult, extra: MachineCheckItem[] = []): string {
  return JSON.stringify({
    ok: result.ok && extra.every((c) => c.ok),
    checks: [...result.checks, ...extra],
    checkedAt: new Date().toISOString(),
  });
}
