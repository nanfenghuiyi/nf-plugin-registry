/**
 * 发布通道（阶段 3 设计 六：POST /api/publish）
 *
 * 流程：CLI 令牌鉴权 → 解码包体 → 机器检查（machineCheck.ts）→ 重名/重 ID 检查
 *       → 通过：包体存 KV + submissions(submitted)；失败：submissions(machine_check_failed) + 报告
 *
 * 边界（设计 4.2）：服务端只做格式/完整性校验，不接触任何私钥；
 *                  开发者本地用自己的密钥签名后上传，服务端仅验证签名与公钥匹配。
 */
import type { Env, Responder } from './types';
import { getAuth } from './auth.ts';
import { getRegistry } from './registry.ts';
import {
  MAX_PACKAGE_SIZE,
  buildMachineReport,
  checkDuplicates,
  runMachineCheck,
  type MachineCheckItem,
} from './machineCheck.ts';
import {
  decodeBase64,
  isValidVersion,
  putPackage,
  upsertSubmission,
  type PackageMeta,
} from './store.ts';

/** 请求体最大字节（JSON 文本；base64 膨胀 4/3，20MB 包 ≈ 26.7MB，放宽到 32MB） */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

interface PublishBody {
  manifest?: unknown;
  zipBase64?: unknown;
  signature?: unknown;
  publicKey?: unknown;
  changelog?: unknown;
}

/**
 * POST /api/publish — 仅接受 CLI/客户端 Bearer 令牌（门户会话不可直接发版）。
 * 返回：{ code, msg, data: { pluginId, version, status, report } }
 */
export async function handlePublish(
  env: Env,
  rsp: Responder,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') return rsp.json({ code: 405, msg: 'Method Not Allowed' }, 405);

  const auth = await getAuth(request, env);
  if (!auth) return rsp.json({ code: 401, msg: '未授权：需要 CLI 发布令牌' }, 401);
  if (auth.via !== 'token') {
    return rsp.json({ code: 401, msg: '发布需使用 CLI 令牌（Bearer），门户会话不可直接发版' }, 401);
  }

  // 1. 解析请求体（先按文本读，便于体积上限与 JSON 错误区分）
  let body: PublishBody;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return rsp.json(
        { code: 413, msg: `请求体过大（${text.length} > ${MAX_BODY_BYTES} 字节）` },
        413,
      );
    }
    body = JSON.parse(text) as PublishBody;
  } catch {
    return rsp.json({ code: 400, msg: '请求体不是合法 JSON' }, 400);
  }

  const { manifest, zipBase64, signature, publicKey, changelog } = body;
  if (typeof zipBase64 !== 'string' || !zipBase64) {
    return rsp.json({ code: 400, msg: '缺少 zipBase64' }, 400);
  }
  if (typeof signature !== 'string' || !signature) {
    return rsp.json({ code: 400, msg: '缺少 signature（开发者自有密钥对 zip 的 Ed25519 签名）' }, 400);
  }
  if (typeof publicKey !== 'string' || !publicKey) {
    return rsp.json({ code: 400, msg: '缺少 publicKey（开发者公钥 PEM）' }, 400);
  }

  const zipBytes = decodeBase64(zipBase64);
  if (!zipBytes) return rsp.json({ code: 400, msg: 'zipBase64 解码失败' }, 400);
  if (zipBytes.length > MAX_PACKAGE_SIZE) {
    return rsp.json(
      { code: 413, msg: `包体超限（${zipBytes.length} > ${MAX_PACKAGE_SIZE} 字节）` },
      413,
    );
  }

  // 2. 机器检查（结构 / manifest / 权限 / 签名 / checksum）
  const result = await runMachineCheck({
    manifestRaw: manifest,
    zipBytes,
    signatureB64: signature,
    publicKeyPem: publicKey,
  });

  if (!result.ok || !result.manifest) {
    const report = buildMachineReport(result);
    const pid = String((manifest as Record<string, unknown> | undefined)?.id || '');
    const ver = String((manifest as Record<string, unknown> | undefined)?.version || '');
    if (pid && ver && isValidVersion(ver)) {
      await upsertSubmission(env, {
        pluginId: pid,
        version: ver,
        developerId: auth.developerId,
        status: 'machine_check_failed',
        machineReport: report,
      });
    }
    return rsp.json(
      { code: 422, msg: '机器检查未通过', data: { status: 'machine_check_failed', report } },
      422,
    );
  }

  const pluginId = String(result.manifest.id);
  const version = String(result.manifest.version);
  if (!isValidVersion(version)) {
    return rsp.json({ code: 400, msg: `版本号格式不正确: ${version}` }, 400);
  }

  // 3. 重名 / 重 ID / 终态检查（需 registry 与 D1）
  const registry = await getRegistry(env);
  const dupCheck = await checkDuplicates(env.DB, registry, pluginId, version, auth.developerId);
  const dup: MachineCheckItem = {
    name: 'duplicates',
    ok: dupCheck.ok,
    detail: dupCheck.detail,
  };
  const report = buildMachineReport(result, [dup]);
  if (!dup.ok) {
    await upsertSubmission(env, {
      pluginId,
      version,
      developerId: auth.developerId,
      status: 'machine_check_failed',
      machineReport: report,
    });
    return rsp.json(
      { code: 422, msg: '机器检查未通过', data: { pluginId, version, status: 'machine_check_failed', report } },
      422,
    );
  }

  // 4. 暂存包体 + 落库 submitted
  const meta: PackageMeta = {
    pluginId,
    version,
    developerId: auth.developerId,
    login: auth.login,
    manifest: result.manifest,
    checksum: result.checksum || '',
    signature,
    publicKey,
    size: zipBytes.length,
    changelog: typeof changelog === 'string' ? changelog.slice(0, 2000) : '',
    submittedAt: new Date().toISOString(),
  };
  await putPackage(env, meta, zipBytes);

  const saved = await upsertSubmission(env, {
    pluginId,
    version,
    developerId: auth.developerId,
    status: 'submitted',
    machineReport: report,
  });
  if (!saved.ok) {
    // 已发布版本被复用等情况：清理刚写入的 KV，避免脏数据
    return rsp.json({ code: saved.code || 409, msg: saved.msg || '提交被拒绝' }, saved.code || 409);
  }

  return rsp.json({
    code: 200,
    msg: 'success',
    data: { pluginId, version, status: 'submitted', report },
  });
}
