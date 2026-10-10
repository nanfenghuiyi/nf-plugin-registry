'use strict';
/**
 * 门户 API 客户端（阶段 3 / T6）
 *
 * 只依赖 Node 18+ 内置 fetch 与 https（零 npm 依赖），供 nf-plugin-cli 的
 * `--server` 发布与 `release --drain` 两段式发布使用。
 *
 * 约定：
 *   - 鉴权：Authorization: Bearer <CLI/管理员令牌>
 *   - 响应：统一 { code, msg, data }；code!==200 视为失败并抛出带 msg 的错误
 */

const DEFAULT_TIMEOUT = 60000;

class PortalError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/**
 * 发起门户 API 请求
 * @param {string} baseUrl 门户根地址（如 https://registry.htnf.dpdns.org）
 * @param {string} token   Bearer 令牌
 * @param {string} method  GET / POST / DELETE
 * @param {string} apiPath 以 / 开头的路径
 * @param {object} [body]  JSON 请求体
 * @param {{ timeout?: number, raw?: boolean }} [opts] raw=true 时返回原始 Response
 */
async function portalRequest(baseUrl, token, method, apiPath, body, opts = {}) {
  const url = String(baseUrl).replace(/\/+$/, '') + apiPath;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || DEFAULT_TIMEOUT);
  let resp;
  try {
    resp = await fetch(url, { method, headers, body: payload, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || e;
    throw new PortalError(`无法连接门户 ${url}（${reason}）`, 0, 0);
  }
  clearTimeout(timer);

  if (opts.raw) return resp;

  let json = null;
  const text = await resp.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new PortalError(`门户返回非 JSON 响应（HTTP ${resp.status}）: ${text.slice(0, 200)}`, resp.status, resp.status);
  }

  if (!resp.ok || !json || json.code !== 200) {
    throw new PortalError(
      (json && json.msg) || `门户请求失败（HTTP ${resp.status}）`,
      resp.status,
      json ? json.code : resp.status,
      json ? json.data : undefined,
    );
  }
  return json.data;
}

/** 拉取待发布队列：GET /api/admin/queue */
function fetchQueue(baseUrl, token) {
  return portalRequest(baseUrl, token, 'GET', '/api/admin/queue');
}

/** 拉取单个待发布包体：POST /api/admin/queue/item */
function fetchQueueItem(baseUrl, token, pluginId, version) {
  return portalRequest(baseUrl, token, 'POST', '/api/admin/queue/item', { pluginId, version });
}

/** drain 回执：POST /api/admin/queue/ack */
function ackQueue(baseUrl, token, items) {
  return portalRequest(baseUrl, token, 'POST', '/api/admin/queue/ack', { items });
}

/** 提交插件包：POST /api/publish */
function publishPackage(baseUrl, token, payload) {
  return portalRequest(baseUrl, token, 'POST', '/api/publish', payload, { timeout: 120000 });
}

module.exports = {
  PortalError,
  portalRequest,
  fetchQueue,
  fetchQueueItem,
  ackQueue,
  publishPackage,
};
