// 阶段 4：付费插件授权验证 —— 签名/验签核心 + 下单→签发→拉取 数据契约
// 运行：node --test market-api/test/payments.test.mjs
// 零外部依赖：WebCrypto（Node 20+ globalThis.crypto.subtle）+ 内存模拟 D1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMarketLicenseKeyPair,
  signEntitlement,
  verifyEntitlement,
} from '../src/lib/licenseSign.mjs';

// ---- 内存模拟 D1（仅识别 payments.ts 使用的 SQL 子串，验证数据契约）----
function makeMockDB() {
  const orders = new Map();
  const licenses = new Map();
  const payouts = [];
  return {
    orders,
    licenses,
    payouts,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith('INSERT INTO orders')) {
                orders.set(args[0], {
                  id: args[0], plugin_id: args[1], edition: args[2], buyer: args[3],
                  amount: args[4], currency: args[5], provider: args[6],
                  provider_order_id: null, status: 'created', created_at: args[7], paid_at: null,
                });
              } else if (sql.startsWith('INSERT INTO licenses')) {
                licenses.set(args[0], {
                  id: args[0], order_id: args[1], plugin_id: args[2], edition: args[3],
                  subject: args[4], token: args[5], exp: args[6], created_at: args[7],
                });
              } else if (sql.startsWith('INSERT INTO payouts')) {
                payouts.push({
                  id: args[0], order_id: args[1], plugin_id: args[2], gross: args[3],
                  platform_fee: args[4], developer_amount: args[5], currency: args[6],
                  status: args[7], created_at: args[8],
                });
              } else if (sql.startsWith('UPDATE orders')) {
                const o = orders.get(args[2]);
                if (o) { o.status = 'paid'; o.paid_at = args[0]; o.provider_order_id = args[1]; }
              }
              return {};
            },
            async all() { return { results: [] }; },
            async first() {
              if (sql.startsWith('SELECT * FROM orders WHERE id')) return orders.get(args[0]) || null;
              if (sql.startsWith('SELECT token, exp FROM licenses')) {
                for (const l of licenses.values()) {
                  if (l.plugin_id === args[0] && l.subject === args[1]) return { token: l.token, exp: l.exp };
                }
                return null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

test('生成密钥对：SPKI 公钥 / PKCS8 私钥格式', async () => {
  const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();
  assert.match(publicKeyPem, /-----BEGIN PUBLIC KEY-----/);
  assert.match(privateKeyPem, /-----BEGIN PRIVATE KEY-----/);
});

test('signEntitlement → verifyEntitlement：有效令牌通过', async () => {
  const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();
  const payload = {
    pluginId: 'nf.app.demo', edition: 'pro', subject: 'machine-abc',
    issuedAt: Date.now(), exp: null, orderId: 'ord-1',
  };
  const token = await signEntitlement(payload, privateKeyPem);
  const got = await verifyEntitlement(token, publicKeyPem, 'machine-abc');
  assert.equal(got.pluginId, 'nf.app.demo');
  assert.equal(got.edition, 'pro');
  assert.equal(got.orderId, 'ord-1');
});

test('verifyEntitlement：篡改签名 → BAD_SIGNATURE', async () => {
  const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();
  const token = await signEntitlement(
    { pluginId: 'p', subject: 's', issuedAt: Date.now(), exp: null, orderId: 'o' },
    privateKeyPem,
  );
  const tampered = token.slice(0, -2) + (token.slice(-1) === 'A' ? 'B' : 'A');
  await assert.rejects(() => verifyEntitlement(tampered, publicKeyPem, 's'), /BAD_SIGNATURE/);
});

test('verifyEntitlement：错密钥 → BAD_SIGNATURE', async () => {
  const a = await generateMarketLicenseKeyPair();
  const b = await generateMarketLicenseKeyPair();
  const token = await signEntitlement(
    { pluginId: 'p', subject: 's', issuedAt: Date.now(), exp: null, orderId: 'o' },
    a.privateKeyPem,
  );
  await assert.rejects(() => verifyEntitlement(token, b.publicKeyPem, 's'), /BAD_SIGNATURE/);
});

test('verifyEntitlement：过期 → EXPIRED', async () => {
  const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();
  const token = await signEntitlement(
    { pluginId: 'p', subject: 's', issuedAt: Date.now(), exp: Date.now() - 1000, orderId: 'o' },
    privateKeyPem,
  );
  await assert.rejects(() => verifyEntitlement(token, publicKeyPem, 's'), /EXPIRED/);
});

test('verifyEntitlement：subject 不匹配 → SUBJECT_MISMATCH', async () => {
  const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();
  const token = await signEntitlement(
    { pluginId: 'p', subject: 's1', issuedAt: Date.now(), exp: null, orderId: 'o' },
    privateKeyPem,
  );
  await assert.rejects(() => verifyEntitlement(token, publicKeyPem, 's2'), /SUBJECT_MISMATCH/);
});

test('verifyEntitlement：令牌格式错误（段数不对）→ BAD_TOKEN', async () => {
  const { publicKeyPem } = await generateMarketLicenseKeyPair();
  await assert.rejects(() => verifyEntitlement('notatoken', publicKeyPem, 's'), /BAD_TOKEN/);
  await assert.rejects(() => verifyEntitlement('a.b', publicKeyPem, 's'), /BAD_TOKEN/);
});

test('全链路契约：下单 → 模拟支付签发 → 拉取令牌后可验签', async () => {
  const db = makeMockDB();
  const { publicKeyPem, privateKeyPem } = await generateMarketLicenseKeyPair();
  const env = { DB: db, MARKET_LICENSE_KEY: privateKeyPem };

  // createOrder（复刻 payments.createOrder 写入形状）
  const orderId = 'ord-flow-1';
  await env.DB.prepare(
    `INSERT INTO orders (id, plugin_id, edition, buyer, amount, currency, provider, provider_order_id, status, created_at, paid_at) VALUES (?,?,?,?,?,?,?,NULL,'created',?,NULL)`,
  ).bind(orderId, 'nf.app.paid', 'pro', 'machine-xyz', 68, 'CNY', 'mock', new Date().toISOString()).run();

  // mockPay → issueLicense（复刻 payments.issueLicense）
  const order = db.orders.get(orderId);
  assert.equal(order.status, 'created');
  const payload = {
    pluginId: order.plugin_id, edition: order.edition ?? undefined, subject: order.buyer,
    issuedAt: Date.now(), exp: null, orderId: order.id,
  };
  const token = await signEntitlement(payload, privateKeyPem);
  await env.DB.prepare(
    `INSERT INTO licenses (id, order_id, plugin_id, edition, subject, token, exp, created_at) VALUES (?,?,?,?,?,?,NULL,?)`,
  ).bind('lic-1', order.id, order.plugin_id, order.edition ?? null, order.buyer, token, new Date().toISOString()).run();
  const share = 0.15;
  const gross = order.amount;
  const platformFee = Math.round(gross * share * 100) / 100;
  const devAmount = Math.round((gross - platformFee) * 100) / 100;
  await env.DB.prepare(
    `INSERT INTO payouts (id, order_id, plugin_id, gross, platform_fee, developer_amount, currency, status, created_at) VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
  ).bind('pay-1', order.id, order.plugin_id, gross, platformFee, devAmount, order.currency, new Date().toISOString()).run();

  // 拉取（复刻 payments.getLicenseForSubject）
  const lic = await env.DB.prepare(
    `SELECT token, exp FROM licenses WHERE plugin_id = ? AND subject = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind('nf.app.paid', 'machine-xyz').first();
  assert.ok(lic, '应拉到许可证');
  const verified = await verifyEntitlement(lic.token, publicKeyPem, 'machine-xyz');
  assert.equal(verified.pluginId, 'nf.app.paid');

  // 分成记账校验
  assert.equal(db.payouts.length, 1);
  assert.equal(db.payouts[0].gross, 68);
  assert.equal(db.payouts[0].platform_fee, 10.2);
  assert.equal(db.payouts[0].developer_amount, 57.8);
});
