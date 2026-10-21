#!/usr/bin/env node
'use strict';
/**
 * build-all.js — 批量打包所有插件并生成 registry.json
 *
 * 用法:
 *   node scripts/build-all.js <plugins-src-dir>
 *
 * 示例:
 *   node scripts/build-all.js d:/Workspace/Projects/Personal/electron/electron-egg-demo/plugins
 *
 * 流程:
 *   1. 扫描 plugins-src-dir 下所有子目录（排除 test/）
 *   2. 对每个含 manifest.json 的目录：收集文件 → 混淆 JS → 打包 zip → 签名 → AES 加密 → 存入 packages/<id>/<version>.nfpkg
 *   3. 生成 registry.json
 *
 * 本文件同时作为公共构建库，供 build-incremental.js 复用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

const { createZip } = require('../lib/zip');
const signLib = require('../lib/sign');
const encryptLib = require('../lib/encrypt');
const registrySig = require('../lib/registrySig');

// ============ 配置 ============

const REGISTRY_DIR = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(REGISTRY_DIR, 'packages');
const KEYS_DIR = path.join(REGISTRY_DIR, 'keys');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');

// 打包时排除的目录/文件
// 注意：node_modules 必须随包分发（宿主不提供依赖回落），构建前会自动安装生产依赖
const EXCLUDE = new Set(['.git', '.DS_Store', 'package-lock.json']);

// 依赖目录不参与混淆（第三方库自身已压缩/混淆，再混淆会破坏其内部 require 与性能）
const NO_OBFUSCATE_PREFIX = 'node_modules/';

// 插件图标候选文件名：.nfpkg 整体加密，市场端无法解包取图标，
// 构建时把图标以明文复制到 packages/<id>/ 供市场 API 分发
const ICON_FILE_CANDIDATES = ['icon.svg', 'icon.png', 'icon.webp', 'icon.jpg', 'icon.jpeg'];

// GitHub 仓库信息
const GITHUB_OWNER = 'nanfenghuiyi';
const GITHUB_REPO = 'nf-plugin-registry';
const GITHUB_BRANCH = 'main';
const DOWNLOAD_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/packages`;

// 分类名称映射
const categoryNames = {
  'app': '应用',
  'application': '应用',
  'tool': '工具',
  'admin': '管理后台',
  'hardware': '硬件',
  'device': '设备',
  'camera': '摄像头',
  'media': '媒体',
  'streamer': '流媒体',
  'system': '系统',
  'extension': '扩展',
  'developer': '开发者',
  'service': '服务',
  'gateway': '网关',
  'serial': '串口',
  'socket': 'Socket',
  'websocket': 'WebSocket',
  'print': '打印',
  'scale': '电子秤',
  'scanner': '扫描器',
  'skill': '技能',
  'other': '其他',
};

// ============ 工具函数 ============

function log(msg) {
  process.stdout.write(msg + '\n');
}

function err(msg) {
  process.stderr.write('错误: ' + msg + '\n');
}

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
 * 确保插件生产依赖已安装到 <pluginDir>/node_modules。
 * 宿主只从插件目录解析裸模块，因此依赖必须随包分发。
 * @param {string} pluginDir - 插件源码目录
 */
function ensureDependencies(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  let deps = {};
  try {
    deps = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies || {};
  } catch (e) {
    err(`  ${path.basename(pluginDir)}: package.json 解析失败，跳过依赖安装 (${e.message})`);
    return;
  }

  const names = Object.keys(deps);
  if (names.length === 0) return;

  // 每次都执行 npm install：既补齐缺失依赖，也按 package.json 清理已移除的依赖
  log(`    📥 安装生产依赖: ${names.join(', ')}`);
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: pluginDir,
      stdio: 'inherit',
      shell: true,
    });
  } catch (e) {
    throw new Error(`依赖安装失败: ${e.message}`);
  }
}

/** 混淆配置：中等强度，不破坏插件执行 */
const OBFUSCATOR_OPTIONS = {
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  rotateStringArray: true,
  selfDefending: false,
  disableConsoleOutput: false,
};

/**
 * 对 JS 源码做混淆
 * @param {string} source - 源码
 * @returns {string} 混淆后的代码（失败时返回原文）
 */
function obfuscateSource(source) {
  try {
    const result = JavaScriptObfuscator.obfuscate(source, OBFUSCATOR_OPTIONS);
    return result.getObfuscatedCode();
  } catch (e) {
    err('混淆失败: ' + e.message);
    return source;
  }
}

// 从 manifest 中推断出合理的分类
function inferCategory(manifest) {
  // 优先使用 manifest 中定义的 category
  if (manifest.category) {
    return manifest.category;
  }
  // 根据 type 映射
  const typeMap = {
    'app': 'tool',
    'application': 'admin',
    'hardware': 'hardware',
    'device': 'device',
    'media': 'streamer',
    'system': 'system',
    'extension': 'extension',
    'skill': 'skill'
  };
  return typeMap[manifest.type] || 'other';
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

// ============ 扫描与构建 ============

/**
 * 扫描插件源码目录，返回所有含 manifest.json 的插件目录
 * @param {string} pluginsSrcDir - 插件源码根目录（下按类型分子目录）
 * @returns {Array<{type: string, id: string, manifestPath: string, dir: string}>}
 */
function scanPluginDirs(pluginsSrcDir) {
  const pluginDirs = [];
  const entries = fs.readdirSync(pluginsSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'test' || entry.name === 'skills' || entry.name === 'config') continue;
    // 排除 test. 开头的目录
    if (entry.name.startsWith('test.')) continue;

    const typeDir = path.join(pluginsSrcDir, entry.name);
    const subEntries = fs.readdirSync(typeDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const manifestPath = path.join(typeDir, sub.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        pluginDirs.push({ type: entry.name, id: sub.name, manifestPath, dir: path.join(typeDir, sub.name) });
      } else {
        log(`  ⚠ 跳过 ${entry.name}/${sub.name}: 无 manifest.json`);
      }
    }
  }
  return pluginDirs;
}

/**
 * 挑选可公开分发的插件图标文件（仅限插件根目录下的单层文件名）。
 * manifest.icon 优先，缺失或不存在时按常见命名回退。
 * @param {string} pluginDir - 插件源码目录
 * @param {string} declared - manifest.icon 声明值
 * @returns {string|null} 图标文件绝对路径
 */
function pickPublicIcon(pluginDir, declared) {
  const names = [];
  for (const name of [declared, ...ICON_FILE_CANDIDATES]) {
    const base = String(name || '').trim().replace(/^\.\//, '');
    if (!base || base.includes('/') || base.includes('\\') || names.includes(base)) continue;
    names.push(base);
  }
  for (const name of names) {
    const filePath = path.join(pluginDir, name);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  }
  return null;
}

/**
 * 构建单个插件：收集文件 → 混淆 → 打包 → 签名 → 加密 → 写入 packages/
 * @param {{type: string, id: string, manifestPath: string, dir: string}} p - 插件目录信息
 * @param {string} privPem - 私钥
 * @param {string} pubPem - 公钥
 * @returns {object|null} registry 记录（无文件时返回 null）
 * @throws {Error} 打包失败时抛出异常
 */
function buildPlugin(p, privPem, pubPem) {
  const manifest = JSON.parse(fs.readFileSync(p.manifestPath, 'utf8'));
  const pluginId = manifest.id;
  const version = manifest.version;
  const name = manifest.name;
  const description = manifest.description || '';
  const author = manifest.author || 'NF Team';
  const homepage = manifest.homepage || '';
  const icon = manifest.icon || '';
  const type = manifest.type || 'unknown';
  const category = inferCategory(manifest);
  const minAppVersion = manifest.engines && manifest.engines['nf-client']
    ? manifest.engines['nf-client']
    : '>=1.0.8';
  const requiresPro = manifest.exemptFromLimit !== true;

  // 安装生产依赖（随包分发，宿主不做应用级模块回落）
  ensureDependencies(p.dir);

  // 收集文件
  const files = [];
  walk(p.dir, p.dir, files);
  if (files.length === 0) {
    log(`    ⚠ 跳过 ${pluginId}@${version}：无文件`);
    return null;
  }

  // 对插件自身 JS 做混淆（替换 .js 文件内容；node_modules 保持原样）
  let obfuscatedCount = 0;
  for (const f of files) {
    if (f.name.endsWith('.js') && !f.name.startsWith(NO_OBFUSCATE_PREFIX)) {
      const obfuscated = obfuscateSource(f.data.toString('utf8'));
      if (obfuscated !== f.data.toString('utf8')) {
        f.data = Buffer.from(obfuscated, 'utf8');
        obfuscatedCount++;
      }
    }
  }
  if (obfuscatedCount > 0) {
    log(`    🔒 混淆 ${obfuscatedCount} 个 JS 文件`);
  }

  // 打包 zip
  const zipBuf = createZip(files);
  const checksum = sha256(zipBuf);

  // 签名（对 zip 字节）
  const sig = signLib.sign(zipBuf, privPem);
  const sigBase64 = sig.toString('base64');

  // AES-256-GCM 加密 zip 字节，输出 .nfpkg
  const nfpkgBuf = encryptLib.encrypt(zipBuf);

  // 写入 packages/<id>/<version>.nfpkg
  const pkgDir = path.join(PACKAGES_DIR, pluginId);
  fs.mkdirSync(pkgDir, { recursive: true });
  const nfpkgPath = path.join(pkgDir, `${version}.nfpkg`);
  fs.writeFileSync(nfpkgPath, nfpkgBuf);

  // 写入 .sig 文件（base64 签名文本，对 zip 的签名）
  fs.writeFileSync(path.join(pkgDir, `${version}.sig`), sigBase64, 'utf8');

  // 导出明文图标（市场列表展示用；不在加密包内，需与包同目录分发）
  const iconFile = pickPublicIcon(p.dir, icon);
  if (iconFile) {
    fs.copyFileSync(iconFile, path.join(pkgDir, path.basename(iconFile)));
  }

  log(`  ✅ ${pluginId}@${version} (${zipBuf.length} bytes, checksum: ${checksum.slice(0, 8)}...)`);

  return {
    id: pluginId,
    name,
    description,
    category,
    type,
    author,
    icon,
    homepage,
    version,
    checksum,
    signature: sigBase64,
    publicKey: pubPem,
    minAppVersion,
    requiresPro,
    size: zipBuf.length,
    keywords: manifest.keywords || [],
    permissions: manifest.permissions || [],
    engines: manifest.engines || {},
    limits: manifest.limits || {},
    entrypoints: manifest.entrypoints || {},
    ui: manifest.ui || {},
    main: manifest.main || '',
  };
}

// ============ 全量构建 ============

async function buildAll(pluginsSrcDir) {
  if (!fs.existsSync(pluginsSrcDir)) {
    err('插件源码目录不存在: ' + pluginsSrcDir);
    process.exit(1);
  }

  // 1. 确保密钥对存在
  log('🔑 确保签名密钥对...');
  const { priv, pub, created } = signLib.ensureKeys(KEYS_DIR);
  if (created) {
    log('   已生成新密钥对: ' + KEYS_DIR);
  } else {
    log('   使用已有密钥对');
  }
  const privPem = fs.readFileSync(priv, 'utf8');
  const pubPem = fs.readFileSync(pub, 'utf8');

  // 2. 扫描所有插件目录
  const pluginDirs = scanPluginDirs(pluginsSrcDir);

  log(`📦 发现 ${pluginDirs.length} 个插件目录`);
  if (pluginDirs.length === 0) {
    err('未找到任何插件，请检查路径');
    process.exit(1);
  }

  // 3. 逐个打包
  const registryPlugins = [];
  let totalSuccess = 0;
  let totalFail = 0;

  for (const p of pluginDirs) {
    try {
      const record = buildPlugin(p, privPem, pubPem);
      if (!record) continue;
      registryPlugins.push(record);
      totalSuccess++;
    } catch (e) {
      totalFail++;
      err(`  ❌ ${p.id} 打包失败: ${e.message}`);
    }
  }

  log(`\n📊 打包完成: ${totalSuccess} 成功, ${totalFail} 失败`);

  // 4. 生成 registry.json
  log('\n📝 生成 registry.json...');

  // 分类统计
  const categories = {};
  for (const p of registryPlugins) {
    if (!categories[p.category]) {
      categories[p.category] = { name: categoryNames[p.category] || p.category, count: 0 };
    }
    categories[p.category].count++;
  }

  // 构建 plugins 数组（按 id 聚合版本）
  const pluginMap = {};
  for (const p of registryPlugins) {
    if (!pluginMap[p.id]) {
      pluginMap[p.id] = {
        id: p.id,
        name: p.name,
        description: p.description,
        category: p.category,
        type: p.type,
        author: p.author,
        icon: p.icon,
        homepage: p.homepage,
        keywords: p.keywords,
        permissions: p.permissions,
        engines: p.engines,
        limits: p.limits,
        entrypoints: p.entrypoints,
        ui: p.ui,
        main: p.main,
        versions: {},
        latestVersion: p.version,
      };
    }
    const entry = pluginMap[p.id];
    entry.versions[p.version] = {
      minAppVersion: p.minAppVersion,
      requiresPro: p.requiresPro,
      size: p.size,
      downloadUrl: `${DOWNLOAD_BASE}/${p.id}/${p.version}.nfpkg`,
      checksum: p.checksum,
      signature: p.signature,
      publicKey: p.publicKey,
      format: 'nfpkg',
      encrypted: true,
      encryptionVersion: 1,
      publishedAt: new Date().toISOString(),
    };
    // 更新最新版本（按 semver 比较）
    if (compareVersions(p.version, entry.latestVersion) > 0) {
      entry.latestVersion = p.version;
    }
  }

  const plugins = Object.values(pluginMap).sort((a, b) => a.id.localeCompare(b.id));

  const registry = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totalPlugins: plugins.length,
    categories,
    plugins,
  };

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
  log(`  已写入: ${REGISTRY_PATH}`);

  // registry.json 变更后必须重新签名，否则客户端验签失败会判定索引不可信
  if (registrySig.signRegistryFile(REGISTRY_DIR, KEYS_DIR)) {
    log('  🔏 registry.sig 已重新签名');
  } else {
    log('  ⚠ 未生成 registry.sig（缺少 keys/priv.pem）');
  }
  log(`  总计 ${plugins.length} 个插件, ${Object.keys(categories).length} 个分类`);

  // 5. 写入构建摘要
  log(`\n🎉 构建完成！`);
  log(`  插件包: ${PACKAGES_DIR}`);
  log(`  registry.json: ${REGISTRY_PATH}`);
  log(`  密钥: ${KEYS_DIR}`);
}

// ============ 导出（供增量构建复用） ============

module.exports = {
  REGISTRY_DIR,
  PACKAGES_DIR,
  KEYS_DIR,
  REGISTRY_PATH,
  DOWNLOAD_BASE,
  categoryNames,
  log,
  err,
  walk,
  sha256,
  inferCategory,
  compareVersions,
  scanPluginDirs,
  buildPlugin,
};

// ============ 执行 ============

if (require.main === module) {
  const pluginsSrc = process.argv[2];
  if (!pluginsSrc) {
    err('用法: node scripts/build-all.js <plugins-src-dir>');
    log('\n示例:');
    log('  node scripts/build-all.js d:/Workspace/Projects/Personal/electron/electron-egg-demo/plugins');
    process.exit(1);
  }

  buildAll(path.resolve(pluginsSrc))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
