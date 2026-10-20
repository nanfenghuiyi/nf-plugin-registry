#!/usr/bin/env node
'use strict';
/**
 * build-incremental.js — 增量构建：只重建有修改的插件
 *
 * 用法:
 *   node scripts/build-incremental.js [--src <plugins-src-dir>] [--dry-run] [--no-commit]
 *
 * 流程:
 *   1. 扫描插件源码目录，计算每个插件目录的内容哈希（缓存在 build-cache.json）
 *   2. 哈希无变化 → 跳过（不重新打包、不改版本）
 *   3. 哈希有变化 → 自动 patch 版本号 +1 写回 manifest.json → 重新打包签名加密
 *   4. 合并更新 registry.json（未变更插件的条目保持原样）
 *   5. git add 相关文件并提交
 *
 * 首次运行时缓存为空：已在 registry 中发布过的版本仅记录哈希（懒初始化），不重建。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const B = require('./build-all');
const signLib = require('../lib/sign');

// ============ 配置 ============

const DEFAULT_SRC_DIR = 'd:/Workspace/Projects/Personal/electron/electron-egg-demo/plugins';
const CACHE_PATH = path.join(B.REGISTRY_DIR, 'build-cache.json');

// ============ 工具函数 ============

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 计算插件目录内容哈希：排序后的 `相对路径=文件哈希` 列表再取整体哈希 */
function computeDirHash(dir) {
  const files = [];
  B.walk(dir, dir, files);
  const parts = files.map((f) => `${f.name}=${B.sha256(f.data)}`);
  return B.sha256(Buffer.from(parts.sort().join('\n'), 'utf8'));
}

/** patch 版本号 +1：1.2.3 -> 1.2.4；格式非法返回 null */
function bumpPatch(version) {
  const m = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

/** registry 中是否已发布该插件的该版本 */
function registryHasVersion(registry, pluginId, version) {
  if (!registry || !Array.isArray(registry.plugins)) return false;
  const entry = registry.plugins.find((x) => x.id === pluginId);
  return !!(entry && entry.versions && entry.versions[version]);
}

/** 将新构建的记录合并进 registry（保留未变更插件条目） */
function mergeRegistry(registry, records) {
  if (!registry.plugins) registry.plugins = [];
  const map = new Map(registry.plugins.map((x) => [x.id, x]));
  const now = new Date().toISOString();

  for (const r of records) {
    let entry = map.get(r.id);
    if (!entry) {
      entry = { id: r.id, versions: {}, latestVersion: r.version };
      map.set(r.id, entry);
      registry.plugins.push(entry);
    }
    // 更新插件元数据
    Object.assign(entry, {
      name: r.name,
      description: r.description,
      category: r.category,
      type: r.type,
      author: r.author,
      icon: r.icon,
      homepage: r.homepage,
      keywords: r.keywords,
      permissions: r.permissions,
      engines: r.engines,
      limits: r.limits,
      entrypoints: r.entrypoints,
      ui: r.ui,
      main: r.main,
    });
    // 追加版本
    entry.versions[r.version] = {
      minAppVersion: r.minAppVersion,
      requiresPro: r.requiresPro,
      size: r.size,
      downloadUrl: `${B.DOWNLOAD_BASE}/${r.id}/${r.version}.nfpkg`,
      checksum: r.checksum,
      signature: r.signature,
      publicKey: r.publicKey,
      format: 'nfpkg',
      encrypted: true,
      encryptionVersion: 1,
      publishedAt: now,
    };
    // 更新最新版本
    if (!entry.latestVersion || B.compareVersions(r.version, entry.latestVersion) > 0) {
      entry.latestVersion = r.version;
    }
  }

  // 重算分类统计与总数
  const categories = {};
  for (const p of registry.plugins) {
    if (!categories[p.category]) {
      categories[p.category] = { name: B.categoryNames[p.category] || p.category, count: 0 };
    }
    categories[p.category].count++;
  }
  registry.version = registry.version || 1;
  registry.updatedAt = now;
  registry.totalPlugins = registry.plugins.length;
  registry.categories = categories;
  registry.plugins.sort((a, b) => a.id.localeCompare(b.id));
}

// ============ 主流程 ============

function main() {
  // 解析参数
  const argv = process.argv.slice(2);
  let srcDir = DEFAULT_SRC_DIR;
  let dryRun = false;
  let noCommit = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') srcDir = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--no-commit') noCommit = true;
    else {
      B.err('未知参数: ' + argv[i]);
      B.log('用法: node scripts/build-incremental.js [--src <dir>] [--dry-run] [--no-commit]');
      process.exit(1);
    }
  }
  srcDir = path.resolve(srcDir);
  if (!fs.existsSync(srcDir)) {
    B.err('插件源码目录不存在: ' + srcDir);
    process.exit(1);
  }

  // 读取 registry 与缓存
  const registry = fs.existsSync(B.REGISTRY_PATH) ? readJson(B.REGISTRY_PATH) : null;
  const cacheExisted = fs.existsSync(CACHE_PATH);
  const cache = cacheExisted ? readJson(CACHE_PATH) : { updatedAt: null, plugins: {} };
  if (!cache.plugins) cache.plugins = {};

  // 密钥
  const { priv, pub } = signLib.ensureKeys(B.KEYS_DIR);
  const privPem = fs.readFileSync(priv, 'utf8');
  const pubPem = fs.readFileSync(pub, 'utf8');

  // 扫描 + 变更检测
  const pluginDirs = B.scanPluginDirs(srcDir);
  B.log(`📦 发现 ${pluginDirs.length} 个插件目录\n`);

  const changed = []; // 待重建 {p, manifest, oldVersion, newVersion}
  const initialized = []; // 首扫且已发布，仅记录哈希

  for (const p of pluginDirs) {
    let manifest;
    try {
      manifest = readJson(p.manifestPath);
    } catch (e) {
      B.err(`  ❌ ${p.id}: manifest.json 解析失败，跳过 (${e.message})`);
      continue;
    }
    const key = `${p.type}/${p.id}`;
    const hash = computeDirHash(p.dir);
    const cached = cache.plugins[key];

    if (cached === hash) {
      B.log(`  ⏭ ${p.id}@${manifest.version}: 无变化`);
      continue;
    }

    if (!cached && registryHasVersion(registry, manifest.id, manifest.version)) {
      // 首次扫描且该版本已发布：仅记录哈希，不重建
      cache.plugins[key] = hash;
      initialized.push(p.id);
      B.log(`  🆕 ${p.id}@${manifest.version}: 首次扫描且已发布，仅记录哈希`);
      continue;
    }

    // 需要构建：缓存已存在但内容变化 → 升 patch 版本；全新插件 → 保持当前版本
    const oldVersion = manifest.version;
    const newVersion = cached ? bumpPatch(oldVersion) : oldVersion;
    if (!newVersion) {
      B.err(`  ❌ ${p.id}: 版本号 ${oldVersion} 格式非法（应为 x.y.z），跳过`);
      continue;
    }
    changed.push({ p, manifest, oldVersion, newVersion });
    B.log(
      `  🔧 ${p.id}: ${cached ? `${oldVersion} -> ${newVersion}（内容有变化）` : `新增插件 ${newVersion}`}`
    );
  }

  B.log(
    `\n📊 检测完成: ${changed.length} 个待构建, ${initialized.length} 个仅初始化缓存, ${pluginDirs.length - changed.length - initialized.length} 个无变化`
  );

  // dry-run：只预览
  if (dryRun) {
    B.log('\n🔍 dry-run 模式，未写入任何文件。');
    process.exit(0);
  }

  // 无任何变化
  if (changed.length === 0 && initialized.length === 0) {
    B.log('\n✅ 所有插件均无变化，无需构建。');
    process.exit(0);
  }

  // 仅缓存初始化：写入缓存并提交
  if (changed.length === 0) {
    cache.updatedAt = new Date().toISOString();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    B.log(`\n📝 已写入构建缓存: ${CACHE_PATH}`);
    if (!noCommit) {
      try {
        execFileSync('git', ['add', '--', CACHE_PATH], { cwd: B.REGISTRY_DIR });
        execFileSync(
          'git',
          ['commit', '-m', 'chore(build): 初始化插件构建缓存'],
          { cwd: B.REGISTRY_DIR }
        );
        B.log('✅ 已提交缓存初始化');
      } catch (e) {
        B.err('git 提交失败: ' + e.message);
      }
    }
    process.exit(0);
  }

  // 构建变更插件
  B.log('\n🚀 开始构建...\n');
  const records = [];
  const stagedFiles = [];
  let failCount = 0;

  for (const c of changed) {
    const manifestText = fs.readFileSync(c.p.manifestPath, 'utf8');
    try {
      // 写回新版本号
      c.manifest.version = c.newVersion;
      fs.writeFileSync(c.p.manifestPath, JSON.stringify(c.manifest, null, 2) + '\n', 'utf8');

      const record = B.buildPlugin(c.p, privPem, pubPem);
      if (!record) {
        // 无文件等异常：回滚 manifest 并移除缓存，下次可重试
        fs.writeFileSync(c.p.manifestPath, manifestText, 'utf8');
        delete cache.plugins[`${c.p.type}/${c.p.id}`];
        B.err(`  ⚠ ${c.p.id}: 构建返回空（无文件?），已回滚`);
        failCount++;
        continue;
      }
      records.push(record);
      stagedFiles.push(
        path.join(B.PACKAGES_DIR, record.id, `${record.version}.nfpkg`),
        path.join(B.PACKAGES_DIR, record.id, `${record.version}.sig`)
      );
    } catch (e) {
      // 失败：回滚 manifest
      fs.writeFileSync(c.p.manifestPath, manifestText, 'utf8');
      B.err(`  ❌ ${c.p.id} 打包失败，已回滚 manifest: ${e.message}`);
      failCount++;
    }
  }

  if (records.length === 0) {
    B.err('\n所有变更插件均构建失败，未更新 registry。');
    process.exit(1);
  }

  // 合并写入 registry.json 与缓存
  B.log('\n📝 合并更新 registry.json...');
  mergeRegistry(registry, records);
  fs.writeFileSync(B.REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');

  cache.updatedAt = new Date().toISOString();
  for (const r of records) {
    const c = changed.find((x) => x.p.id === r.id);
    cache.plugins[`${c.p.type}/${c.p.id}`] = computeDirHash(c.p.dir);
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');

  stagedFiles.push(B.REGISTRY_PATH, CACHE_PATH);

  // git 提交
  if (!noCommit) {
    let subject;
    let body = '';
    if (records.length === 1) {
      const r = records[0];
      const c = changed.find((x) => x.p.id === r.id);
      subject = `chore(${r.id}): 发布 ${r.version} 更新插件包`;
      if (c.oldVersion !== c.newVersion) {
        body = `${r.id}: ${c.oldVersion} -> ${c.newVersion}`;
      }
    } else {
      subject = `chore(packages): 发布 ${records.length} 个插件更新`;
      body = records
        .map((r) => {
          const c = changed.find((x) => x.p.id === r.id);
          return `${r.id}: ${c.oldVersion} -> ${c.newVersion}`;
        })
        .join('\n');
    }
    const message = body ? `${subject}\n\n${body}` : subject;
    try {
      execFileSync('git', ['add', '--', ...stagedFiles], { cwd: B.REGISTRY_DIR });
      execFileSync('git', ['commit', '-m', message], { cwd: B.REGISTRY_DIR });
      B.log('\n✅ 已提交 registry 变更');
    } catch (e) {
      B.err('git 提交失败: ' + e.message);
    }
  } else {
    B.log('\n⏭ --no-commit: 跳过 git 提交');
  }

  // 摘要
  B.log(`\n🎉 增量构建完成: ${records.length} 成功, ${failCount} 失败`);
  B.log(`  registry.json: ${B.REGISTRY_PATH}`);
  B.log('\n后续步骤:');
  B.log('  1. 推送本仓库: git push origin main && git push gitee main');
  B.log('  2. 源码 manifest.json 已升版，请在源码仓库（electron-egg-demo）自行提交');
}

main();
