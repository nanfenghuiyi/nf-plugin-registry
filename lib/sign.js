'use strict';
// 插件签名 / 校验：基于 Node 内置 crypto 的 Ed25519。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function keyPaths(keysDir) {
  return { priv: path.join(keysDir, 'priv.pem'), pub: path.join(keysDir, 'pub.pem') };
}

// 若密钥对不存在则生成。返回 { priv, pub, created }
function ensureKeys(keysDir) {
  fs.mkdirSync(keysDir, { recursive: true });
  const { priv, pub } = keyPaths(keysDir);
  if (fs.existsSync(priv) && fs.existsSync(pub)) {
    return { priv, pub, created: false };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  fs.chmodSync(priv, 0o600);
  return { priv, pub, created: true };
}

// 对 buffer 签名，返回原始 64 字节 Buffer
function sign(buffer, privPem) {
  const key = crypto.createPrivateKey(privPem);
  return crypto.sign(null, buffer, { key, dsaEncoding: 'ieee-p1363' });
}

function verify(buffer, sig, pubPem) {
  const key = crypto.createPublicKey(pubPem);
  return crypto.verify(null, buffer, { key, dsaEncoding: 'ieee-p1363' }, sig);
}

module.exports = { ensureKeys, sign, verify, keyPaths };