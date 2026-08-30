'use strict';
/**
 * 插件包 AES-256-GCM 加密/解密
 *
 * 密钥来源（优先级）：
 *   1. 环境变量 PLUGIN_ENCRYPTION_KEY
 *   2. 内置默认密钥（开发/演示用，生产应覆盖）
 *
 * 输出格式： [iv(12)][authTag(16)][ciphertext]
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM 推荐 12 字节
const TAG_LEN = 16;  // GCM 认证标签

/** 默认密钥（32 字节 hex，SHA-256 派生自固定 seed） */
const DEFAULT_KEY_SEED = 'nf-plugin-encryption-key-v1';

/**
 * 从密钥材料派生 32 字节 AES 密钥
 * @param {string|Buffer} secret
 * @returns {Buffer} 32 字节
 */
function deriveKey(secret) {
  const seed = secret || DEFAULT_KEY_SEED;
  return crypto.createHash('sha256').update(seed).digest();
}

/**
 * 获取加密密钥（环境变量优先）
 * @returns {Buffer} 32 字节
 */
function getKey() {
  const envKey = process.env.PLUGIN_ENCRYPTION_KEY;
  if (envKey && envKey.length > 0) {
    return deriveKey(envKey);
  }
  return deriveKey(DEFAULT_KEY_SEED);
}

/**
 * AES-256-GCM 加密
 *
 * @param {Buffer} plaintext - 明文数据
 * @param {Buffer} [key] - 32 字节密钥，不传则用 getKey()
 * @returns {Buffer} [iv(12)][authTag(16)][ciphertext]
 */
function encrypt(plaintext, key) {
  const k = key || getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * AES-256-GCM 解密
 *
 * @param {Buffer} packet - [iv(12)][authTag(16)][ciphertext]
 * @param {Buffer} [key] - 32 字节密钥，不传则用 getKey()
 * @returns {Buffer} 明文
 */
function decrypt(packet, key) {
  const k = key || getKey();
  if (packet.length < IV_LEN + TAG_LEN) {
    throw new Error('密文数据不完整');
  }
  const iv = packet.subarray(0, IV_LEN);
  const authTag = packet.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = packet.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, k, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { encrypt, decrypt, deriveKey, getKey, ALGO, IV_LEN, TAG_LEN };