'use strict';
/**
 * 开发者门户静态校验（阶段 3 / T3）
 *
 * 门户是零构建静态 SPA：无法在 Node 里跑 DOM，因此这里做「不变量校验」，
 * 把设计 十二 的安全约定固化为回归测试：
 *   1. 禁止 innerHTML / eval / document.write（评论与 manifest 文本一律 textContent）
 *   2. 请求必须带 credentials: 'include'（HttpOnly cookie 会话）
 *   3. index.html 引用的本地资源必须存在
 *   4. 所有 API 路径以 /api/ 开头（避免写死绝对域名导致 CORS 失败）
 *   5. 路由与关键能力关键字齐全（登录 / 提交审核 / 审批 / 下架 / 令牌）
 *
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const PORTAL_DIR = path.resolve(__dirname, '..');
const APP_JS = fs.readFileSync(path.join(PORTAL_DIR, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PORTAL_DIR, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PORTAL_DIR, 'style.css'), 'utf8');

test('app.js 语法可通过 node --check', () => {
  execFileSync(process.execPath, ['--check', path.join(PORTAL_DIR, 'app.js')]);
  assert.ok(true);
});

test('XSS：源文件中不含 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval', () => {
  const forbidden = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval('];
  // 去掉注释行后再检查（注释里会提到这些词以说明约定）
  const code = APP_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of forbidden) {
    assert.equal(code.includes(bad), false, `app.js 不得出现 ${bad}（应使用 textContent）`);
  }
});

test('DOM 写入统一走 helper：仅 textContent / createTextNode 赋值文本', () => {
  const code = APP_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /node\.textContent = /, '应有统一的文本写入 helper');
  assert.match(code, /createTextNode/, '追加文本应使用 createTextNode');
});

test('请求统一带 credentials: include（会话依赖 HttpOnly cookie）', () => {
  assert.match(APP_JS, /credentials:\s*'include'/);
});

test('index.html 引用的本地资源均存在', () => {
  const refs = [...INDEX_HTML.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, '应引用 style.css 与 app.js');
  for (const ref of refs) {
    const abs = path.join(PORTAL_DIR, ref);
    assert.ok(fs.existsSync(abs), `引用不存在: ${ref}`);
  }
});

test('index.html 声明 UTF-8 与 viewport（中文与移动端）', () => {
  assert.match(INDEX_HTML, /<meta charset="UTF-8">/);
  assert.match(INDEX_HTML, /name="viewport"/);
});

test('API 路径：所有 request() 调用以 /api/ 开头，不写死域名', () => {
  const paths = [...APP_JS.matchAll(/request\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)].map((m) => m[2]);
  assert.ok(paths.length > 0, '应至少有若干 API 调用');
  for (const p of paths) {
    assert.ok(p.startsWith('/api/'), `API 路径必须以 /api/ 开头: ${p}`);
    assert.equal(p.startsWith('http'), false, `不得写死绝对地址: ${p}`);
  }
  // 模板拼接路径（含 encodeURIComponent）单独校验前缀
  const dynamic = [...APP_JS.matchAll(/request\(\s*'(?:POST|DELETE)'\s*,\s*'(\/api\/[^']*)'/g)].map((m) => m[1]);
  for (const p of dynamic) assert.ok(p.startsWith('/api/'));
});

test('API 地址可配置且持久化到 localStorage（Pages 与 API 不同域）', () => {
  assert.match(APP_JS, /localStorage\.getItem\(API_KEY\)/);
  assert.match(APP_JS, /localStorage\.setItem\(API_KEY/);
  assert.match(APP_JS, /DEFAULT_API\s*=/);
});

test('关键能力关键字齐全', () => {
  const required = [
    '/api/auth/github/login', // 登录
    '/api/me', // 身份
    '/api/tokens', // 令牌
    '/api/submissions', // 我的提交
    '/submit', // 提交审核
    '/api/admin/submissions', // 审批台
    '/review', // 通过/拒绝
    '/pull', // 下架
    '/unpull', // 恢复
    '/api/admin/queue', // 待发布队列
    'isAdmin', // 管理员门控
  ];
  for (const key of required) {
    assert.ok(APP_JS.includes(key), `门户应包含能力: ${key}`);
  }
});

test('审批台入口按 isAdmin 显隐（不暴露给普通用户）', () => {
  assert.match(APP_JS, /navAdmin\.hidden = !\(me && me\.isAdmin\)/);
  assert.match(INDEX_HTML, /id="nav-admin"[^>]*hidden/);
});

test('导航栏与路由一一对应', () => {
  const routes = [...INDEX_HTML.matchAll(/data-route="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(routes.sort(), ['admin', 'home', 'mine', 'tokens']);
  for (const r of routes) {
    assert.ok(APP_JS.includes(r + ': view'), `缺少路由处理: ${r}`);
  }
});

test('样式文件非空且定义了状态徽章（含 pulled / machine_check_failed）', () => {
  assert.ok(CSS.length > 500);
  for (const cls of ['pulled', 'machine_check_failed', 'in_review', 'approved', 'published']) {
    assert.ok(CSS.includes('.badge.' + cls), `缺少状态样式: ${cls}`);
  }
});
