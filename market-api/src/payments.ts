/**
 * 阶段 4：付费插件支持 —— 接入支付（本期 mock）+ 授权验证（许可证签发）+ 收入分成（记账）
 *
 * 本期仅实现「mock 支付」闭环，验证全链路：
 *   下单(createOrder) → 模拟支付(mockPay) → 签发许可证(issueLicense) → 客户端拉取(getLicense)
 * 真实支付（Stripe / 微信 / 支付宝）在部署期接入：新增 provider webhook 校验后调用同等 issueLicense。
 *
 * 设计文档：docs/方案/NF Client 插件市场后端-阶段4-付费插件支持.md
 */
import { signEntitlement } from './lib/licenseSign.mjs';
import type { Env, Responder } from './types';

/** 平台默认抽成（开发者未声明时） */
export const DEFAULT_SHARE = 0.15;

export interface CreateOrderInput {
  pluginId: string;
  edition?: string;
  /** 绑定主体：machineId 或账户 id（粒度由 manifest.pricing.bind 决定） */
  buyer: string;
  amount: number;
  currency?: string;
  /** 平台抽成比例（0~1）；缺省取 DEFAULT_SHARE */
  share?: number;
  provider?: 'stripe' | 'wechat' | 'alipay' | 'mock';
}

export interface OrderRow {
  id: string;
  plugin_id: string;
  edition: string | null;
  buyer: string;
  amount: number;
  currency: string;
  provider: string;
  provider_order_id: string | null;
  status: string;
  created_at: string;
  paid_at: string | null;
}

/** 创建订单 */
export async function createOrder(env: Env, input: CreateOrderInput): Promise<OrderRow> {
  if (!input.pluginId || !input.buyer) throw new Error('pluginId 与 buyer 必填');
  if (!input.amount || input.amount <= 0) throw new Error('amount 必须为正');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO orders (id, plugin_id, edition, buyer, amount, currency, provider, provider_order_id, status, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'created', ?, NULL)`,
  )
    .bind(
      id,
      input.pluginId,
      input.edition ?? null,
      input.buyer,
      input.amount,
      input.currency ?? 'CNY',
      input.provider ?? 'mock',
      now,
    )
    .run();
  return (await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first()) as OrderRow;
}

/**
 * 模拟支付回调：标记已支付并签发许可证 + 记账分成。
 * 真实支付接入时，provider webhook 校验通过后调用相同逻辑（provider_order_id 填入回单号）。
 */
export async function mockPay(env: Env, orderId: string, providerOrderId?: string): Promise<{ order: OrderRow; token: string }> {
  const order = (await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first()) as OrderRow | null;
  if (!order) throw new Error('订单不存在');
  if (order.status === 'paid') {
    const existing = await getLicenseForSubject(env, order.plugin_id, order.buyer);
    if (existing) return { order, token: existing.token };
  }
  const paidAt = new Date().toISOString();
  await env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, provider_order_id = ? WHERE id = ?`)
    .bind(paidAt, providerOrderId ?? null, orderId)
    .run();
  const token = await issueLicense(env, order);
  return { order: (await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first()) as OrderRow, token };
}

/** 签发许可证令牌（用市场许可证权威私钥签名）并记账分成 */
export async function issueLicense(env: Env, order: OrderRow): Promise<string> {
  const privPem = (env as any).MARKET_LICENSE_KEY as string | undefined;
  if (!privPem) throw new Error('MARKET_LICENSE_KEY 未配置（Worker secret）');
  const payload = {
    pluginId: order.plugin_id,
    edition: order.edition ?? undefined,
    subject: order.buyer,
    issuedAt: Date.now(),
    exp: null,
    orderId: order.id,
  };
  const token = await signEntitlement(payload, privPem);
  const licId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO licenses (id, order_id, plugin_id, edition, subject, token, exp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(licId, order.id, order.plugin_id, order.edition ?? null, order.buyer, token, now)
    .run();

  // 收入分成记账
  const share = DEFAULT_SHARE;
  const gross = order.amount;
  const platformFee = Math.round(gross * share * 100) / 100;
  const developerAmount = Math.round((gross - platformFee) * 100) / 100;
  await env.DB.prepare(
    `INSERT INTO payouts (id, order_id, plugin_id, gross, platform_fee, developer_amount, currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(crypto.randomUUID(), order.id, order.plugin_id, gross, platformFee, developerAmount, order.currency, now)
    .run();

  return token;
}

/** 取某主体对某插件最新的有效许可证令牌 */
export async function getLicenseForSubject(env: Env, pluginId: string, subject: string): Promise<{ token: string; exp: number | null } | null> {
  const row = (await env.DB.prepare(
    `SELECT token, exp FROM licenses WHERE plugin_id = ? AND subject = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(pluginId, subject)
    .first()) as { token: string; exp: number | null } | null;
  return row ?? null;
}

// ============ HTTP 路由处理（由 index.ts 分发）============

/** POST /api/orders —— 创建订单 */
export async function handleCreateOrder(env: Env, rsp: Responder, request: Request): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return rsp.json({ code: 400, msg: '请求体非法' }, 400);
  }
  try {
    const order = await createOrder(env, {
      pluginId: body.pluginId,
      edition: body.edition,
      buyer: body.buyer,
      amount: Number(body.amount),
      currency: body.currency,
      share: body.share != null ? Number(body.share) : undefined,
      provider: body.provider ?? 'mock',
    });
    return rsp.json({ code: 0, msg: 'ok', data: { orderId: order.id, status: order.status } });
  } catch (e: any) {
    return rsp.json({ code: 400, msg: e.message }, 400);
  }
}

/** POST /api/orders/:id/pay —— 模拟支付（mock provider） */
export async function handleMockPay(env: Env, rsp: Responder, orderId: string): Promise<Response> {
  try {
    const { token } = await mockPay(env, orderId);
    return rsp.json({ code: 0, msg: 'ok', data: { orderId, status: 'paid', token } });
  } catch (e: any) {
    return rsp.json({ code: 400, msg: e.message }, 400);
  }
}

/** GET /api/plugins/:id/license?subject= —— 客户端拉取许可证令牌 */
export async function handleGetLicense(env: Env, rsp: Responder, pluginId: string, url: URL): Promise<Response> {
  const subject = url.searchParams.get('subject');
  if (!subject) return rsp.json({ code: 400, msg: 'subject 必填' }, 400);
  const lic = await getLicenseForSubject(env, pluginId, subject);
  if (!lic) return rsp.json({ code: 404, msg: '未找到许可证（可能未购买）' }, 404);
  return rsp.json({ code: 0, msg: 'ok', data: lic });
}
