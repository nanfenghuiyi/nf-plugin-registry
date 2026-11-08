'use strict';
/**
 * lib/bundle.js — 插件入口依赖打包（esbuild）
 *
 * 为什么必须「先 bundle 后混淆」：
 * javascript-obfuscator 会把 `require('socket.io')` 改写成
 * `require(_0x1a2b(0x3))`，bundler 无法再静态解析依赖图，打包会直接失败。
 * 因此构建顺序固定为：
 *   ensureDependencies → esbuild bundle → 混淆 → zip → 签名 → 加密
 *
 * 打包收益（实测）：node_modules 501 文件 → 1 个入口文件，
 * 冷启动 `spawn → onEnable` 从 3263 ms 降到百毫秒级（详见验收报告）。
 */

const fs = require('fs');
const path = require('path');

/**
 * 宿主注入的虚拟模块：node_modules 中不存在，运行时由 sidecar-host 通过
 * `Module._resolveFilename` 劫持提供，必须保持 external。
 */
const HOST_VIRTUAL_MODULES = ['nf-plugin-sdk', 'electron'];

/**
 * 原生扩展（.node）与可选原生加速模块：esbuild 无对应 loader，
 * 且运行时按平台分发，必须保持 external。
 */
const NATIVE_EXTERNALS = ['*.node', 'bufferutil', 'utf-8-validate', 'uws'];

/**
 * 读取插件的打包开关（package.json 的 `nf.bundle`）。
 *
 * 支持两种写法：
 *   "nf": { "bundle": true }
 *   "nf": { "bundle": { "entry": "index.js", "external": ["sharp"] } }
 *
 * @param {string} pluginDir 插件目录
 * @returns {{entry?: string, external: string[]}|null} 未开启返回 null
 */
function readBundleConfig(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    throw new Error(`package.json 解析失败: ${e.message}`);
  }
  const raw = pkg.nf && pkg.nf.bundle;
  if (!raw) return null;
  if (raw === true) {
    return { entry: pkg.main || 'index.js', external: [] };
  }
  if (typeof raw !== 'object') {
    throw new Error('package.json 的 nf.bundle 必须是 true 或对象');
  }
  return {
    entry: raw.entry || pkg.main || 'index.js',
    external: Array.isArray(raw.external) ? raw.external : [],
  };
}

/** 统一成 '/' 分隔的相对路径，便于与 zip 内条目名比对 */
function toPosixRel(pluginDir, absPath) {
  return path.relative(pluginDir, absPath).split(path.sep).join('/');
}

/**
 * 把插件入口及其全部静态依赖打成单文件（CJS，面向 node20）。
 *
 * @param {string} pluginDir 插件源码目录（依赖需已安装到其 node_modules）
 * @param {{entry?: string}} options entry 缺省为 package.json 的 main
 * @returns {null | {
 *   outputName: string,      // 产物在包内的相对路径（= 入口，保证 manifest.main 不变）
 *   output: Buffer,          // 打包产物
 *   consumed: string[],      // 已被打进产物的源文件（相对路径，包内不再单独分发）
 *   dropNodeModules: boolean,// 是否可以把整个 node_modules 从包中移除
 *   keptExternals: string[], // 仍需随包分发的 external 包名
 *   inputCount: number,      // 参与打包的模块数
 *   ms: number               // 打包耗时
 * }}
 */
function bundlePlugin(pluginDir, options) {
  const cfg = readBundleConfig(pluginDir);
  if (!cfg) return null;

  const entry = (options && options.entry) || cfg.entry;
  const entryAbs = path.join(pluginDir, entry);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(`打包入口不存在: ${entry}`);
  }

  const externals = Array.from(
    new Set([...HOST_VIRTUAL_MODULES, ...NATIVE_EXTERNALS, ...cfg.external]),
  );

  const esbuild = require('esbuild');
  const started = Date.now();
  const result = esbuild.buildSync({
    absWorkingDir: pluginDir,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    metafile: true,
    logLevel: 'silent',
    legalComments: 'none',
    external: externals,
  });
  const ms = Date.now() - started;

  const out = result.outputFiles[0];
  const inputs = Object.keys(result.metafile.inputs);
  // 未被打进产物的 external 若在本目录真实存在，必须随包分发（否则运行时找不到）
  const hostVirtual = new Set(HOST_VIRTUAL_MODULES);
  const keptExternals = cfg.external.filter(
    (spec) => !hostVirtual.has(spec) && fs.existsSync(path.join(pluginDir, 'node_modules', spec)),
  );

  return {
    outputName: entry.split(path.sep).join('/'),
    output: Buffer.from(out.text, 'utf8'),
    consumed: inputs.map((p) => p.split(path.sep).join('/')),
    // 有真实存在的 external 时保守起见保留 node_modules，避免误删依赖
    dropNodeModules: keptExternals.length === 0,
    keptExternals,
    inputCount: inputs.length,
    ms,
  };
}

/** 便于测试与调试：只算打包体积，不产出文件 */
function measureBundle(pluginDir, options) {
  const b = bundlePlugin(pluginDir, options);
  if (!b) return null;
  return {
    outputName: b.outputName,
    bytes: b.output.length,
    inputCount: b.inputCount,
    keptExternals: b.keptExternals,
    dropNodeModules: b.dropNodeModules,
    ms: b.ms,
  };
}

module.exports = {
  HOST_VIRTUAL_MODULES,
  NATIVE_EXTERNALS,
  readBundleConfig,
  bundlePlugin,
  measureBundle,
  toPosixRel,
};
