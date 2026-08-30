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
 *   2. 对每个含 manifest.json 的目录：打包 zip → 签名 → 存入 packages/<id>/<version>.zip
 *   3. 生成 registry.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createZip } = require('../lib/zip');
const signLib = require('../lib/sign');

// ============ 配置 ============

const REGISTRY_DIR = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(REGISTRY_DIR, 'packages');
const KEYS_DIR = path.join(REGISTRY_DIR, 'keys');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');

// 打包时排除的目录/文件
const EXCLUDE = new Set(['node_modules', '.git', '.DS_Store', 'package-lock.json']);

// GitHub 仓库信息
const GITHUB_OWNER = 'nanfenghuiyi';
const GITHUB_REPO = 'nf-plugin-registry';
const GITHUB_BRANCH = 'main';
const DOWNLOAD_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/packages`;

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

// ============ 主流程 ============

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
  const pluginDirs = [];
  const entries = fs.readdirSync(pluginsSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'test' || entry.name === 'test' || entry.name === 'skills' || entry.name === 'config') continue;
    // 排除 test. 开头的目录
    if (entry.name.startsWith('test.')) continue;

    const typeDir = path.join(pluginsSrcDir, entry.name);
    const subEntries = fs.readdirSync(typeDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const manifestPath = path.join(typeDir, sub.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        pluginDirs.push({ type: entry.name, id: sub.name, manifestPath, dir: path.join(typeDir, sub.name) });
      }
    }
  }

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

      // 收集文件
      const files = [];
      walk(p.dir, p.dir, files);
      if (files.length === 0) {
        log(`    ⚠ 跳过 ${pluginId}@${version}：无文件`);
        continue;
      }

      // 打包 zip
      const zipBuf = createZip(files);
      const checksum = sha256(zipBuf);

      // 签名
      const sig = signLib.sign(zipBuf, privPem);
      const sigBase64 = sig.toString('base64');

      // 写入 packages/<id>/<version>.zip
      const pkgDir = path.join(PACKAGES_DIR, pluginId);
      fs.mkdirSync(pkgDir, { recursive: true });
      const zipPath = path.join(pkgDir, `${version}.zip`);
      fs.writeFileSync(zipPath, zipBuf);

      // 写入 .sig 文件（base64 签名文本）
      fs.writeFileSync(path.join(pkgDir, `${version}.sig`), sigBase64, 'utf8');

      // 记录
      registryPlugins.push({
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
      });

      totalSuccess++;
      log(`  ✅ ${pluginId}@${version} (${zipBuf.length} bytes, checksum: ${checksum.slice(0, 8)}...)`);
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
      downloadUrl: `${DOWNLOAD_BASE}/${p.id}/${p.version}.zip`,
      checksum: p.checksum,
      signature: p.signature,
      publicKey: p.publicKey,
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
  log(`  总计 ${plugins.length} 个插件, ${Object.keys(categories).length} 个分类`);

  // 5. 写入构建摘要
  log(`\n🎉 构建完成！`);
  log(`  插件包: ${PACKAGES_DIR}`);
  log(`  registry.json: ${REGISTRY_PATH}`);
  log(`  密钥: ${KEYS_DIR}`);
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

// ============ 执行 ============

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