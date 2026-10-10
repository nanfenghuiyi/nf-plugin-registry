// 市场许可证权威：Ed25519 签名 / 验签（WebCrypto）
//
// 设计约束：
//   - 同时运行在 Cloudflare Workers（crypto.subtle）与 Node 20+（globalThis.crypto.subtle），
//     因此统一用 WebCrypto，不依赖 Node `crypto` 的 Ed25519 p1363 实现。
//   - 令牌格式（JWT-like，裸 Ed25519 签名）：
//       token = b64url(header) + '.' + b64url(payload) + '.' + b64url(sig)
//       header  = { alg:'Ed25519', typ:'nf-license', v:1 }
//       payload = { pluginId, edition?, subject, issuedAt, exp, orderId }
//       sig     = Ed25519.sign(MARKET_LICENSE_KEY, ascii(`${header}.${payload}`))
//   - 私钥：Worker secret `MARKET_LICENSE_KEY`（PKCS8 PEM），永不出云、不进仓库。
//   - 公钥：SPKI PEM，随客户端发版内置（MARKET_LICENSE_PUBLIC_KEY），作为第三信任锚。

function b64urlEncode(buf) {
  let bytes;
  if (typeof buf === 'string') bytes = new TextEncoder().encode(buf);
  else if (buf instanceof Uint8Array) bytes = buf;
  else bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(str) {
  return new TextDecoder().decode(b64urlDecode(str));
}

/** PEM（-----BEGIN/END-----）-> DER ArrayBuffer */
function pemToBuf(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export const LIC_HEADER = { alg: 'Ed25519', typ: 'nf-license', v: 1 };

/**
 * 生成市场许可证权威密钥对。
 * @returns {{ publicKeyPem: string, privateKeyPem: string }}
 */
export async function generateMarketLicenseKeyPair() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('spki', pair.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    publicKeyPem: spkiToPem(new Uint8Array(pub)),
    privateKeyPem: pkcs8ToPem(new Uint8Array(priv)),
  };
}

function spkiToPem(bytes) {
  let b = '';
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return '-----BEGIN PUBLIC KEY-----\n' + btoa(b).replace(/(.{64})/g, '$1\n').trim() + '\n-----END PUBLIC KEY-----\n';
}

function pkcs8ToPem(bytes) {
  let b = '';
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return '-----BEGIN PRIVATE KEY-----\n' + btoa(b).replace(/(.{64})/g, '$1\n').trim() + '\n-----END PRIVATE KEY-----\n';
}

/**
 * 签发许可证令牌。
 * @param {object} payload {pluginId, edition?, subject, issuedAt, exp, orderId}
 * @param {string} privateKeyPem PKCS8 PEM
 * @returns {Promise<string>} token
 */
export async function signEntitlement(payload, privateKeyPem) {
  const headerB64 = b64urlEncode(JSON.stringify(LIC_HEADER));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const priv = await crypto.subtle.importKey('pkcs8', pemToBuf(privateKeyPem), 'Ed25519', false, ['sign']);
  const sig = await crypto.subtle.sign('Ed25519', priv, data);
  return `${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * 验证许可证令牌。
 * @param {string} token
 * @param {string} publicKeyPem SPKI PEM（MARKET_LICENSE_PUBLIC_KEY）
 * @param {string} subject 期望绑定的主体（machineId 或 account id）
 * @param {number} [now] 当前时间戳（ms），默认 Date.now()
 * @returns {Promise<object>} 验签通过的 payload
 * @throws {Error} BAD_TOKEN | BAD_SIGNATURE | SUBJECT_MISMATCH | EXPIRED
 */
export async function verifyEntitlement(token, publicKeyPem, subject, now = Date.now()) {
  if (typeof token !== 'string') throw new Error('BAD_TOKEN');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('BAD_TOKEN');
  const [h, p, s] = parts;

  // 解码签名：任何非法 base64 → 视为签名损坏
  let sigBytes;
  try {
    sigBytes = b64urlDecode(s);
  } catch {
    throw new Error('BAD_SIGNATURE');
  }

  let pub;
  try {
    pub = await crypto.subtle.importKey('spki', pemToBuf(publicKeyPem), 'Ed25519', false, ['verify']);
  } catch {
    throw new Error('BAD_SIGNATURE');
  }

  const data = new TextEncoder().encode(`${h}.${p}`);
  let ok = false;
  try {
    // 签名长度/内容非法时 WebCrypto 会抛错，统一归为 BAD_SIGNATURE
    ok = await crypto.subtle.verify('Ed25519', pub, sigBytes, data);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('BAD_SIGNATURE');

  let payload;
  try {
    payload = JSON.parse(b64urlToString(p));
  } catch {
    throw new Error('BAD_TOKEN');
  }
  if (!payload || typeof payload !== 'object') throw new Error('BAD_TOKEN');
  if (payload.subject !== subject) throw new Error('SUBJECT_MISMATCH');
  if (payload.exp && payload.exp < now) throw new Error('EXPIRED');
  return payload;
}

export { b64urlEncode, b64urlDecode };
