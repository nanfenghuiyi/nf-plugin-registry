#!/usr/bin/env node
'use strict';
/**
 * nf-plugin-cli.js — NF Client 插件发布工具（Registry 仓库版）
 *
 * 用法:
 *   node publish/nf-plugin-cli.js publish <plugin-dir> [--sign] [--no-push]
 *   node publish/nf-plugin-cli.js help
 *
 * 流程:
 *   1. 读取插件目录 manifest.json
 *   2. 打包 zip（复用 lib/zip.js 的 createZip）
 *   3. 计算 SHA-256 checksum
 *   4. 用官方密钥 Ed25519 签名
 *   5. 写入 packages/<id>/<version>.zip + .sig
 *   6. 更新 registry.json
 *   7. git add + git commit + git push（--no-push 跳过）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { createZip } = require('../lib/zip');
const signLib = require('../lib/sign');
const registrySig = require('../lib/registrySig');
const encryptLib = require('../lib/encrypt');
const portalClient = require('./lib/portalClient');

// ============ 分类归一化 ============

// 分类白名单（code -> 中文名）
const CATEGORY_WHITELIST = {
  'app': '应用', 'tool': '工具', 'admin': '管理后台',
  'hardware': '硬件', 'device': '设备', 'camera': '摄像头',
  'media': '媒体', 'streamer': '流媒体', 'system': '系统',
  'extension': '扩展', 'developer': '开发者', 'service': '服务',
  'gateway': '网关', 'serial': '串口', 'socket': 'Socket',
  'websocket': 'WebSocket', 'print': '打印', 'scale': '电子秤',
  'scanner': '扫描器', 'skill': '技能', 'other': '其他',
};

// 中文/历史分类名 -> 标准 code
const CATEGORY_ALIASES = {
  '应用': 'app', '工具': 'tool', '管理后台': 'admin',
  '硬件': 'hardware', '设备': 'device', '摄像头': 'camera',
  '媒体': 'media', '流媒体': 'streamer', '系统': 'system',
  '扩展': 'extension', '开发者': 'developer', '服务': 'service',
  '网关': 'gateway', '串口': 'serial', '打印': 'print',
  '电子秤': 'scale', '扫描器': 'scanner', '技能': 'skill',
  'Socket': 'socket', 'WebSocket': 'websocket', '其他': 'other',
};

/**
 * 归一化分类：白名单 code 原样保留，中文/历史名映射到标准 code，未知值落到 other
 */
function normalizeCategory(cat) {
  const c = String(cat || '').trim();
  if (!c) return 'other';
  if (CATEGORY_WHITELIST[c]) return c;
  if (CATEGORY_ALIASES[c]) return CATEGORY_ALIASES[c];
  const lower = c.toLowerCase();
  if (CATEGORY_WHITELIST[lower]) return lower;
  if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
  return 'other';
}

// ============ 配置 ============

const REGISTRY_DIR = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(REGISTRY_DIR, 'packages');
const KEYS_DIR = path.join(REGISTRY_DIR, 'keys');
/** 第三方开发者密钥目录（keygen 生成；与项目根密钥 keys/ 隔离，见设计 4.2） */
const DEV_KEYS_DIR = path.join(KEYS_DIR, 'dev');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');
const REGISTRY_SIG_PATH = registrySig.registrySigPath(REGISTRY_DIR);
/** 门户默认地址（阶段 2 Workers；可用 --server / NF_MARKET_URL 覆盖） */
const DEFAULT_PORTAL_URL = 'https://registry.htnf.dpdns.org';

const EXCLUDE = new Set(['node_modules', '.git', '.DS_Store', 'package-lock.json']);

const GITHUB_OWNER = 'nanfenghuiyi';
const GITHUB_REPO = 'nf-plugin-registry';
const GITHUB_BRANCH = 'main';
const DOWNLOAD_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/packages`;

// ============ 工具函数 ============

function log(msg) { process.stdout.write(msg + '\n'); }
function err(msg) { process.stderr.write('错误: ' + msg + '\n'); }

function walk(dir, base, acc) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      walk(full, base, acc);
    } else if (entry.isFile()) {
      if (rel.endsWith('.zip')) continue;
      acc.push({ name: rel, data: fs.readFileSync(full) });
    }
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 解析命令行参数：--key value / --flag（布尔）/ 位置参数
 * @returns {{ positional: string[], flags: Record<string, string | true> }}
 */
function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// ============ registry.sig 签名（阶段 3 / 设计 4.3） ============

/**
 * 用项目根密钥对 registry.json 原始字节重签 registry.sig。
 * publish / normalize / drain 等任何 registry.json 变更后都必须调用，
 * 并随 git 一并提交（客户端与 Workers 依赖它校验索引完整性）。
 * @returns {boolean} false = 根私钥缺失或 registry.json 不存在而跳过
 */
function signRegistryFile() {
  const ok = registrySig.signRegistryFile(REGISTRY_DIR, KEYS_DIR);
  if (ok) {
    log(`   ✔ registry.sig 已生成（根密钥 Ed25519）: ${path.relative(REGISTRY_DIR, REGISTRY_SIG_PATH)}`);
  } else {
    log('   ⚠ 跳过 registry.sig 签名（keys/priv.pem 或 registry.json 不存在）');
  }
  return ok;
}

/** 手动重签：node publish/nf-plugin-cli.js sig */
async function cmdSig() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    err('registry.json 不存在');
    return 2;
  }
  return signRegistryFile() ? 0 : 2;
}

// ============ 开发者密钥（阶段 3 / 设计 4.3：keygen） ============

/**
 * 加载开发者密钥对（私钥 + 公钥 PEM）
 * @param {string} dir 密钥目录
 * @returns {{ privPem: string, pubPem: string, priv: string, pub: string } | null}
 */
function loadDevKeys(dir) {
  const { priv, pub } = signLib.keyPaths(dir);
  if (!fs.existsSync(priv) || !fs.existsSync(pub)) return null;
  return {
    priv,
    pub,
    privPem: fs.readFileSync(priv, 'utf8'),
    pubPem: fs.readFileSync(pub, 'utf8'),
  };
}

/** 生成开发者自有 Ed25519 密钥对：node publish/nf-plugin-cli.js keygen [--dir <path>] [--force] */
function cmdKeygen(argv) {
  const flags = parseFlags(argv);
  const dir = flags.dir ? path.resolve(flags.dir) : DEV_KEYS_DIR;
  const { priv, pub } = signLib.keyPaths(dir);

  if ((fs.existsSync(priv) || fs.existsSync(pub)) && !flags.force) {
    err(`密钥已存在: ${dir}`);
    log('   覆盖会导致已发布插件无法验证，请确认后加 --force');
    return 2;
  }

  fs.mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  try {
    fs.chmodSync(priv, 0o600);
  } catch {
    // Windows 下 chmod 可能失败，忽略
  }

  log(`🔑 开发者密钥已生成: ${path.relative(REGISTRY_DIR, dir)}`);
  log(`   私钥 ${priv}  ← 仅保存在本地，切勿提交到 Git 或上传`);
  log(`   公钥 ${pub}   ← 发布时随包上传到门户`);
  log('');
  log('下一步：');
  log('   1. 在开发者门户用 GitHub 登录，签发 CLI 令牌');
  log(`   2. node publish/nf-plugin-cli.js publish <plugin-dir> --server ${DEFAULT_PORTAL_URL} --token <令牌>`);
  return 0;
}

// ============ 发布命令 ============

async function cmdPublish(argv) {
  const { positional, flags } = parseFlags(argv);

  const pluginDir = positional[0] ? path.resolve(positional[0]) : process.cwd();
  if (!fs.existsSync(pluginDir)) {
    err('目录不存在: ' + pluginDir);
    return 2;
  }

  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    err('未找到 manifest.json: ' + manifestPath);
    return 2;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    err('manifest.json 解析失败: ' + e.message);
    return 2;
  }

  const pluginId = manifest.id;
  const version = manifest.version;
  if (!pluginId || !version) {
    err('manifest 缺少 id 或 version');
    return 2;
  }

  log(`📦 发布插件: ${pluginId}@${version}`);

  // 1. 打包
  log('   打包中...');
  const files = [];
  walk(pluginDir, pluginDir, files);
  if (files.length === 0) {
    err('没有可打包的文件');
    return 2;
  }
  const zipBuf = createZip(files);
  const checksum = sha256(zipBuf);
  log(`   ✔ zip: ${zipBuf.length} bytes, ${files.length} 个文件`);

  // 2. 签名
  //    --server：第三方发布通道，必须用**开发者自有密钥**签名（设计 4.2：根私钥永不签第三方包）
  //    本地发布：沿用项目根密钥（官方插件链路不变）
  const isRemote = !!flags.server;
  const doSign = flags.sign !== false;
  let sigBase64 = '';
  let pubPem = '';

  if (isRemote) {
    const keyDir = flags.key ? path.resolve(flags.key) : DEV_KEYS_DIR;
    const devKeys = loadDevKeys(keyDir);
    if (!devKeys) {
      err(`未找到开发者密钥: ${keyDir}`);
      log('   先执行: node publish/nf-plugin-cli.js keygen [--dir <path>]');
      return 2;
    }
    if (!doSign) {
      err('远程发布必须签名（服务端会校验开发者签名，不能加 --no-sign）');
      return 2;
    }
    const sig = signLib.sign(zipBuf, devKeys.privPem);
    sigBase64 = sig.toString('base64');
    pubPem = devKeys.pubPem;
    log(`   ✔ 已用开发者密钥签名（${path.relative(REGISTRY_DIR, keyDir)}）`);
  } else if (doSign && fs.existsSync(signLib.keyPaths(KEYS_DIR).priv)) {
    const privPem = fs.readFileSync(signLib.keyPaths(KEYS_DIR).priv, 'utf8');
    pubPem = fs.readFileSync(signLib.keyPaths(KEYS_DIR).pub, 'utf8');
    const sig = signLib.sign(zipBuf, privPem);
    sigBase64 = sig.toString('base64');
    log('   ✔ 已用项目根密钥签名（官方链路）');
  } else {
    log('   ⚠ 未签名（密钥不存在）');
  }

  // 2.5 远程发布：上传门户后直接返回（不写本地 packages/ 与 registry.json）
  if (isRemote) {
    return await publishToPortal(flags, { manifest, pluginId, version, zipBuf, sigBase64, pubPem });
  }

  // 3. 写入 packages/<id>/<version>.zip
  const pkgDir = path.join(PACKAGES_DIR, pluginId);
  fs.mkdirSync(pkgDir, { recursive: true });
  const zipPath = path.join(pkgDir, `${version}.zip`);
  fs.writeFileSync(zipPath, zipBuf);
  log(`   ✔ 已写入: ${path.relative(REGISTRY_DIR, zipPath)}`);

  // 写入 .sig
  if (sigBase64) {
    fs.writeFileSync(path.join(pkgDir, `${version}.sig`), sigBase64, 'utf8');
  }

  // 4. 更新 registry.json
  log('   更新 registry.json...');
  let registry = { version: 1, updatedAt: new Date().toISOString(), totalPlugins: 0, categories: {}, plugins: [] };
  if (fs.existsSync(REGISTRY_PATH)) {
    try {
      registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    } catch (e) {
      err('registry.json 解析失败，将重新生成: ' + e.message);
    }
  }



  const existingIdx = registry.plugins.findIndex(p => p.id === pluginId);
  const versionEntry = {
    minAppVersion: (manifest.engines && manifest.engines['nf-client']) || '>=1.0.8',
    requiresPro: manifest.exemptFromLimit !== true,
    size: zipBuf.length,
    downloadUrl: `${DOWNLOAD_BASE}/${pluginId}/${version}.zip`,
    checksum,
    signature: sigBase64,
    publicKey: pubPem,
    publishedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    const existing = registry.plugins[existingIdx];
    existing.versions[version] = versionEntry;
    existing.name = manifest.name;
    existing.description = manifest.description || existing.description;
    if (manifest.category) existing.category = normalizeCategory(manifest.category);
    if (compareVersions(version, existing.latestVersion) > 0) {
      existing.latestVersion = version;
    }
  } else {
    registry.plugins.push({
      id: pluginId,
      name: manifest.name,
      description: manifest.description || '',
      category: normalizeCategory(manifest.category),
      type: manifest.type || 'unknown',
      author: manifest.author || 'NF Team',
      icon: manifest.icon || '',
      homepage: manifest.homepage || '',
      keywords: manifest.keywords || [],
      permissions: manifest.permissions || [],
      engines: manifest.engines || {},
      limits: manifest.limits || {},
      entrypoints: manifest.entrypoints || {},
      ui: manifest.ui || {},
      main: manifest.main || '',
      versions: { [version]: versionEntry },
      latestVersion: version,
    });
  }

  registry.updatedAt = new Date().toISOString();
  registry.totalPlugins = registry.plugins.length;

  // 重建分类统计
  const cats = {};
  for (const p of registry.plugins) {
    p.category = normalizeCategory(p.category);
    if (!cats[p.category]) cats[p.category] = { name: CATEGORY_WHITELIST[p.category] || p.category, count: 0 };
    cats[p.category].count++;
  }
  registry.categories = cats;

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
  log(`   ✔ registry.json 已更新 (${registry.totalPlugins} 个插件)`);

  // 4.5 重签 registry.sig（信任链：任何 registry 变更都随根密钥签名一并提交）
  signRegistryFile();

  // 5. git 提交
  if (flags['no-push']) {
    log('   ⏭ 跳过 git 推送 (--no-push)');
  } else {
    log('   提交到 Git...');
    try {
      execSync(`git add -A`, { cwd: REGISTRY_DIR, stdio: 'pipe' });
      execSync(`git commit -m "publish: ${pluginId}@${version}"`, { cwd: REGISTRY_DIR, stdio: 'pipe' });
      execSync(`git push`, { cwd: REGISTRY_DIR, stdio: 'pipe' });
      log('   ✔ 已推送到 GitHub');
    } catch (e) {
      err('Git 操作失败: ' + e.message);
      log('   请手动提交: cd ' + REGISTRY_DIR + ' && git add -A && git commit && git push');
    }
  }

  log(`\n🚀 发布完成: ${pluginId}@${version}`);
  log(`   下载地址: ${DOWNLOAD_BASE}/${pluginId}/${version}.zip`);
  return 0;
}

// ============ 远程发布（第三方开发者 → 门户） ============

/**
 * 上传插件包到门户（POST /api/publish）。
 * 服务端只做机器检查并暂存，不直接进 registry —— 需管理员审批后由 release --drain 合入。
 */
async function publishToPortal(flags, ctx) {
  const server = flags.server === true ? DEFAULT_PORTAL_URL : String(flags.server);
  const token = flags.token || process.env.NF_REGISTRY_TOKEN;
  if (!token || token === true) {
    err('远程发布需要 CLI 令牌: --token <令牌>（或在开发者门户签发后传入）');
    return 2;
  }

  log(`   上传中... ${server}`);
  let data;
  try {
    data = await portalClient.publishPackage(server, token, {
      manifest: ctx.manifest,
      zipBase64: ctx.zipBuf.toString('base64'),
      signature: ctx.sigBase64,
      publicKey: ctx.pubPem,
      changelog: (ctx.manifest && ctx.manifest.changelog) || '',
    });
  } catch (e) {
    err(`上传失败: ${e.message}`);
    if (e.data && e.data.report) printMachineReport(e.data.report);
    return 2;
  }

  log(`   ✔ 已提交: ${data.pluginId}@${data.version} → ${data.status}`);
  if (data.report) printMachineReport(data.report);
  log('');
  log('下一步：在开发者门户把提交推进到审核队列（submitted → in_review），等待管理员审批。');
  return 0;
}

/** 打印机器检查报告（每项 ✔/✘ + 说明） */
function printMachineReport(reportRaw) {
  let report = reportRaw;
  if (typeof report === 'string') {
    try {
      report = JSON.parse(report);
    } catch {
      return;
    }
  }
  if (!report || !Array.isArray(report.checks)) return;
  log('   机器检查:');
  for (const c of report.checks) {
    log(`      ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  }
}

// ============ 两段式发布：release --drain（设计 六 实现取舍记录） ============

/**
 * 把待发布队列合入 registry（核心成员本地执行，根私钥不上云）：
 *   拉队列 → 逐包下载 → 复验 checksum 与开发者签名 → 加密为 .nfpkg
 *   → 更新 registry.json（publisher=developer）→ 重签 registry.sig → ack 回执 → git 推送
 */
async function cmdRelease(argv) {
  const { flags } = parseFlags(argv);
  const server = flags.server === true ? DEFAULT_PORTAL_URL : String(flags.server || DEFAULT_PORTAL_URL);
  const token = flags.token || process.env.NF_REGISTRY_TOKEN;

  if (!token || token === true) {
    err('需要管理员令牌: --token <令牌> 或环境变量 NF_REGISTRY_TOKEN');
    return 2;
  }

  let queue;
  try {
    queue = await portalClient.fetchQueue(server, token);
  } catch (e) {
    err(`拉取待发布队列失败: ${e.message}`);
    return 2;
  }

  const all = (queue && queue.items) || [];
  if (all.length === 0) {
    log('待发布队列为空，无需 drain。');
    return 0;
  }

  if (flags.list) {
    log(`待发布队列 ${all.length} 项:`);
    for (const it of all) {
      log(`   ${it.pluginId}@${it.version}  developer=${it.developerId}  包体=${it.hasPackage ? '就绪' : '缺失'}`);
    }
    return all.length;
  }

  const ready = all.filter((it) => it.hasPackage && it.meta);
  const skipped = all.filter((it) => !(it.hasPackage && it.meta));
  if (ready.length === 0) {
    err('队列中没有包体就绪的条目（hasPackage=false），请检查 KV 是否留存');
    return 2;
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    err('registry.json 解析失败: ' + e.message);
    return 2;
  }
  if (!Array.isArray(registry.plugins)) registry.plugins = [];

  const acked = [];
  const failed = [];

  for (const item of ready) {
    const meta = item.meta;
    const pid = meta.pluginId;
    const ver = meta.version;
    log(`\n📦 drain ${pid}@${ver}（开发者 ${meta.login || meta.developerId}）`);

    try {
      const payload = await portalClient.fetchQueueItem(server, token, pid, ver);
      const zipBuf = Buffer.from(payload.zipBase64, 'base64');

      // ① 复验 checksum（服务端已算过，drain 是合入 registry 前的最后一道门）
      const actual = sha256(zipBuf);
      if (meta.checksum && meta.checksum !== actual) {
        throw new Error(`checksum 不一致（队列 ${meta.checksum} ≠ 实际 ${actual}）`);
      }

      // ② 复验开发者签名：确认包体确由该开发者私钥签出（双信任链，设计 4.1）
      const sigOk = signLib.verify(zipBuf, Buffer.from(meta.signature, 'base64'), meta.publicKey);
      if (!sigOk) throw new Error('开发者签名验证失败（签名/公钥/包体不匹配）');
      log('   ✔ checksum + 开发者签名验证通过');

      // ③ 加密为 .nfpkg（与官方包同格式，客户端下载后统一解密）
      const pkgDir = path.join(PACKAGES_DIR, pid);
      fs.mkdirSync(pkgDir, { recursive: true });
      const nfpkgPath = path.join(pkgDir, `${ver}.nfpkg`);
      fs.writeFileSync(nfpkgPath, encryptLib.encrypt(zipBuf));
      log(`   ✔ 已写入 ${path.relative(REGISTRY_DIR, nfpkgPath)} (${zipBuf.length} → ${fs.statSync(nfpkgPath).size} bytes)`);

      // ④ 更新 registry 条目
      upsertDeveloperEntry(registry, meta, zipBuf, actual);
      acked.push({ pluginId: pid, version: ver });
    } catch (e) {
      err(`   ✘ ${e.message}`);
      failed.push({ pluginId: pid, version: ver, reason: e.message });
    }
  }

  if (acked.length === 0) {
    err('全部条目 drain 失败，registry.json 未改动。');
    return 2;
  }

  // ⑤ 重建分类统计 + 补齐 publisher 字段（迁移期：无 publisher 的既有条目视为 official）
  registry.totalPlugins = registry.plugins.length;
  registry.updatedAt = new Date().toISOString();
  const cats = {};
  for (const p of registry.plugins) {
    p.category = normalizeCategory(p.category);
    if (!p.publisher) p.publisher = 'official';
    if (!cats[p.category]) cats[p.category] = { name: CATEGORY_WHITELIST[p.category] || p.category, count: 0 };
    cats[p.category].count++;
  }
  registry.categories = cats;

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
  log(`\n   ✔ registry.json 已更新 (${registry.totalPlugins} 个插件)`);

  // ⑥ 重签 registry.sig（根密钥，任何 registry 变更都随签名一并提交）
  signRegistryFile();

  // ⑦ ack 回执：标记 published 并释放 KV 包体
  try {
    const ackResult = await portalClient.ackQueue(server, token, acked);
    log(`   ✔ 已回执 ${(ackResult.acked || []).length} 项`);
    if (ackResult.skipped && ackResult.skipped.length) {
      log(`   ⚠ 回执跳过 ${ackResult.skipped.length} 项: ${JSON.stringify(ackResult.skipped)}`);
    }
  } catch (e) {
    err(`回执失败（registry 已本地更新，请稍后重跑 drain 的回执步骤）: ${e.message}`);
  }

  // ⑧ git 提交推送
  if (flags['no-push']) {
    log('   ⏭ 跳过 git 推送 (--no-push)');
  } else {
    log('   提交到 Git...');
    try {
      execSync('git add -A', { cwd: REGISTRY_DIR, stdio: 'pipe' });
      execSync(`git commit -m "release: drain ${acked.length} 个第三方插件"`, { cwd: REGISTRY_DIR, stdio: 'pipe' });
      execSync('git push', { cwd: REGISTRY_DIR, stdio: 'pipe' });
      log('   ✔ 已推送到 GitHub');
    } catch (e) {
      err('Git 操作失败: ' + e.message);
      log('   请手动提交: cd ' + REGISTRY_DIR + ' && git add -A && git commit && git push');
    }
  }

  log(`\n🚀 drain 完成：成功 ${acked.length} 项，失败 ${failed.length} 项，跳过 ${skipped.length} 项`);
  if (failed.length) failed.forEach((f) => log(`   ✘ ${f.pluginId}@${f.version}: ${f.reason}`));
  return failed.length ? 1 : 0;
}

/**
 * 把开发者插件条目写入 registry（新建或更新）。
 * 与 cmdPublish 的官方条目保持字段一致，额外带 publisher / developerId / developerLogin。
 */
function upsertDeveloperEntry(registry, meta, zipBuf, checksum) {
  const manifest = meta.manifest || {};
  const pid = meta.pluginId;
  const ver = meta.version;

  const versionEntry = {
    minAppVersion: (manifest.engines && manifest.engines['nf-client']) || '>=1.0.8',
    requiresPro: manifest.exemptFromLimit !== true,
    size: zipBuf.length,
    downloadUrl: `${DOWNLOAD_BASE}/${pid}/${ver}.nfpkg`,
    checksum,
    signature: meta.signature,
    publicKey: meta.publicKey,
    format: 'nfpkg',
    encrypted: true,
    encryptionVersion: 1,
    changelog: meta.changelog || '第三方插件发布',
    publishedAt: new Date().toISOString(),
  };

  const idx = registry.plugins.findIndex((p) => p.id === pid);
  if (idx >= 0) {
    const existing = registry.plugins[idx];
    existing.versions = existing.versions || {};
    existing.versions[ver] = versionEntry;
    existing.name = manifest.name || existing.name;
    existing.description = manifest.description || existing.description;
    if (manifest.category) existing.category = normalizeCategory(manifest.category);
    if (!existing.latestVersion || compareVersions(ver, existing.latestVersion) > 0) {
      existing.latestVersion = ver;
    }
    existing.publisher = 'developer';
    existing.developerId = meta.developerId;
    existing.developerLogin = meta.login || '';
    return;
  }

  registry.plugins.push({
    id: pid,
    name: manifest.name || pid,
    description: manifest.description || '',
    category: normalizeCategory(manifest.category),
    type: manifest.type || 'unknown',
    author: manifest.author || meta.login || 'unknown',
    icon: manifest.icon || '',
    homepage: manifest.homepage || '',
    keywords: manifest.keywords || [],
    permissions: manifest.permissions || [],
    engines: manifest.engines || {},
    limits: manifest.limits || {},
    entrypoints: manifest.entrypoints || {},
    ui: manifest.ui || {},
    main: manifest.main || '',
    publisher: 'developer',
    developerId: meta.developerId,
    developerLogin: meta.login || '',
    versions: { [ver]: versionEntry },
    latestVersion: ver,
  });
}

// ============ 帮助 ============

// ============ 分类归一化命令 ============

/**
 * 归一化 registry.json 中全部插件的分类并重建分类统计（只改本地文件，不做 git 操作）
 */
async function cmdNormalize() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    err('registry.json 不存在');
    return 2;
  }
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    err('registry.json 解析失败: ' + e.message);
    return 2;
  }
  const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];
  const changed = [];
  for (const p of plugins) {
    const norm = normalizeCategory(p.category);
    if (norm !== p.category) {
      changed.push(p.id + ': ' + p.category + ' -> ' + norm);
      p.category = norm;
    }
  }
  const cats = {};
  for (const p of plugins) {
    if (!cats[p.category]) cats[p.category] = { name: CATEGORY_WHITELIST[p.category] || p.category, count: 0 };
    cats[p.category].count++;
  }
  registry.categories = cats;
  registry.totalPlugins = plugins.length;
  registry.updatedAt = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  signRegistryFile();
  log('分类归一化完成，修正 ' + changed.length + ' 个插件:');
  changed.forEach((c) => log('   ' + c));
  log('当前分类 ' + Object.keys(cats).length + ' 个: ' + Object.keys(cats).join(', '));
  return 0;
}

function usage() {
  log(`nf-plugin — NF Client 插件发布工具（Registry 仓库版）

用法:
  node publish/nf-plugin-cli.js publish <plugin-dir> [options]       本地发布（官方链路，直接写 registry）
  node publish/nf-plugin-cli.js keygen [--dir <path>] [--force]      生成开发者自有密钥对
  node publish/nf-plugin-cli.js release --drain [options]            拉取待发布队列并合入 registry
  node publish/nf-plugin-cli.js sig                                  用根密钥重签 registry.sig
  node publish/nf-plugin-cli.js normalize                            归一化 registry.json 分类并重建统计
  node publish/nf-plugin-cli.js help

publish 选项:
  --no-push      跳过 git 提交推送（仅本地写入）
  --no-sign      跳过签名
  --server <url> 第三方发布：上传门户（需 --token，用开发者密钥签名）
  --token <令牌> CLI 发布令牌（门户签发，明文仅本地保存）
  --key   <dir>  开发者密钥目录（默认 keys/dev）

release 选项:
  --drain        执行两段式发布（拉队列 → 复验 → 加密 → 合入 registry → 回执 → git push）
  --list         只打印待发布队列，不合入
  --server <url> 门户地址（默认 ${DEFAULT_PORTAL_URL}）
  --token <令牌> 管理员令牌（也可设 NF_REGISTRY_TOKEN 环境变量）
  --no-push      跳过 git 推送

说明:
  · 第三方包由开发者自有密钥签名，项目根私钥永不签第三方包也不上云。
  · publish（远程）/ release --drain 的信任链：开发者签名 → 审核 → drain 复验 → registry.sig 根签名。
  · publish / normalize / drain 完成后会自动用根密钥重签 registry.sig。

示例:
  node publish/nf-plugin-cli.js publish ../my-plugin
  node publish/nf-plugin-cli.js publish ../my-plugin --no-push
  node publish/nf-plugin-cli.js keygen
  node publish/nf-plugin-cli.js publish ../my-plugin --token nft_xxx
  node publish/nf-plugin-cli.js release --drain --token nft_admin
  node publish/nf-plugin-cli.js release --drain --list --token nft_admin
`);
}

// ============ 入口 ============

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'publish':
      return await cmdPublish(rest);
    case 'normalize':
      return await cmdNormalize();
    case 'keygen':
      return cmdKeygen(rest);
    case 'release':
      return await cmdRelease(rest);
    case 'sig':
      return await cmdSig();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      usage();
      return 0;
    default:
      err('未知命令: ' + cmd);
      usage();
      return 2;
  }
}

// 被 require 时导出内部函数供单测调用；直接运行时才执行 CLI
module.exports = {
  normalizeCategory,
  parseFlags,
  loadDevKeys,
  upsertDeveloperEntry,
  signRegistryFile,
  printMachineReport,
  REGISTRY_DIR,
  PACKAGES_DIR,
  KEYS_DIR,
  DEV_KEYS_DIR,
  REGISTRY_PATH,
  REGISTRY_SIG_PATH,
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}