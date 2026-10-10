'use strict';
// registry.sig 信任链（阶段 3 / 设计 4.1、4.3）
//
// 作用：registry.json 全文由项目根密钥（keys/priv.pem）Ed25519 签名，生成 registry.sig。
//       客户端用内置根公钥校验索引完整性，防 API 层被攻破后换钥/换包。
//
// 签名口径：CLI 写入磁盘的 registry.json **原始字节**。
//   raw.githubusercontent / jsdelivr 均不改写仓库文件内容，客户端与 Workers
//   下载到的字节与签名时一致，因此无需 JSON 规范化序列化，直接对文件字节签名。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const signLib = require('./sign');

/** registry.sig 文件路径 */
function registrySigPath(registryDir) {
  return path.join(registryDir, 'registry.sig');
}

/**
 * 用根密钥对 registryDir/registry.json 原始字节签名并写 registry.sig（base64 + 换行）。
 * @returns {boolean} true=已签名写入；false=跳过（registry.json 或根私钥缺失）
 */
function signRegistryFile(registryDir, keysDir) {
  const registryPath = path.join(registryDir, 'registry.json');
  if (!fs.existsSync(registryPath)) return false;
  const { priv } = signLib.keyPaths(keysDir);
  if (!fs.existsSync(priv)) return false;

  const privPem = fs.readFileSync(priv, 'utf8');
  const buf = fs.readFileSync(registryPath);
  const sig = signLib.sign(buf, privPem);
  fs.writeFileSync(registrySigPath(registryDir), sig.toString('base64') + '\n', 'utf8');
  return true;
}

/**
 * 验证 registry.json 字节的根密钥签名。
 * @param {Buffer} registryBuf registry.json 原始字节
 * @param {string} sigBase64 registry.sig 内容（base64，允许尾部空白）
 * @param {string} pubPem 根公钥 PEM（spki）
 * @returns {boolean}
 */
function verifyRegistrySig(registryBuf, sigBase64, pubPem) {
  if (!sigBase64 || typeof sigBase64 !== 'string') return false;
  const sig = Buffer.from(sigBase64.trim(), 'base64');
  // Ed25519 签名恒为 64 字节，快速拒绝明显非法输入
  if (sig.length !== 64) return false;
  try {
    return signLib.verify(registryBuf, sig, pubPem);
  } catch {
    return false;
  }
}

module.exports = { registrySigPath, signRegistryFile, verifyRegistrySig };
