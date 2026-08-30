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

// ============ 配置 ============

const REGISTRY_DIR = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(REGISTRY_DIR, 'packages');
const KEYS_DIR = path.join(REGISTRY_DIR, 'keys');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');

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

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// ============ 发布命令 ============

async function cmdPublish(argv) {
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

  // 2. 签名（如果密钥存在）
  const doSign = flags.sign !== false;
  let sigBase64 = '';
  let pubPem = '';
  if (doSign && fs.existsSync(signLib.keyPaths(KEYS_DIR).priv)) {
    const privPem = fs.readFileSync(signLib.keyPaths(KEYS_DIR).priv, 'utf8');
    pubPem = fs.readFileSync(signLib.keyPaths(KEYS_DIR).pub, 'utf8');
    const sig = signLib.sign(zipBuf, privPem);
    sigBase64 = sig.toString('base64');
    log('   ✔ 已用 Ed25519 签名');
  } else {
    log('   ⚠ 未签名（密钥不存在，使用 --sign 首次签名会自动生成）');
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

  const categoryNames = {
    'app': '应用', 'tool': '工具', 'admin': '管理后台',
    'hardware': '硬件', 'device': '设备', 'camera': '摄像头',
    'media': '媒体', 'streamer': '流媒体', 'system': '系统',
    'extension': '扩展', 'developer': '开发者', 'service': '服务',
    'gateway': '网关', 'serial': '串口', 'socket': 'Socket',
    'websocket': 'WebSocket', 'print': '打印', 'scale': '电子秤',
    'scanner': '扫描器', 'skill': '技能', 'other': '其他',
  };

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
    if (compareVersions(version, existing.latestVersion) > 0) {
      existing.latestVersion = version;
    }
  } else {
    registry.plugins.push({
      id: pluginId,
      name: manifest.name,
      description: manifest.description || '',
      category: manifest.category || 'other',
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
    const cat = p.category || 'other';
    if (!cats[cat]) cats[cat] = { name: categoryNames[cat] || cat, count: 0 };
    cats[cat].count++;
  }
  registry.categories = cats;

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
  log(`   ✔ registry.json 已更新 (${registry.totalPlugins} 个插件)`);

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

// ============ 帮助 ============

function usage() {
  log(`nf-plugin — NF Client 插件发布工具（Registry 仓库版）

用法:
  node publish/nf-plugin-cli.js publish <plugin-dir> [options]
  node publish/nf-plugin-cli.js help

publish 选项:
  --no-push      跳过 git 提交推送（仅本地写入）
  --no-sign      跳过签名

示例:
  node publish/nf-plugin-cli.js publish ../my-plugin
  node publish/nf-plugin-cli.js publish ../my-plugin --no-push
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

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });