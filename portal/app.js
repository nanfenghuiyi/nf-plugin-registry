/* eslint-env browser */
/**
 * NF Client 开发者门户（阶段 3 / T3）
 *
 * 零构建静态 SPA：原生 ES5+ 语法 + hash 路由，直接部署 Cloudflare Pages。
 *
 * 安全约定（设计 十二）：
 *   - 所有后端返回文本一律经 textContent 写入，禁止 innerHTML 拼接（防 XSS）
 *   - 会话依赖 HttpOnly cookie，请求统一 credentials: 'include'
 *   - 跨站写请求依赖服务端 SameSite=None + Secure cookie，门户不持有令牌明文
 */
(function () {
  'use strict';

  var DEFAULT_API = 'https://registry.htnf.dpdns.org';
  var API_KEY = 'nf-portal-api-base';

  var state = {
    apiBase: localStorage.getItem(API_KEY) || DEFAULT_API,
    me: null,
    route: '',
  };

  var app = document.getElementById('app');
  var bannerEl = document.getElementById('banner');
  var whoEl = document.getElementById('who');
  var btnLogin = document.getElementById('btn-login');
  var btnLogout = document.getElementById('btn-logout');
  var navAdmin = document.getElementById('nav-admin');
  var apiInput = document.getElementById('api-base');

  // ---------- 工具 ----------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function banner(message, kind) {
    if (!message) {
      bannerEl.hidden = true;
      bannerEl.textContent = '';
      return;
    }
    bannerEl.hidden = false;
    bannerEl.className = 'banner ' + (kind || 'info');
    bannerEl.textContent = message;
  }

  function api(path) {
    return state.apiBase.replace(/\/+$/, '') + path;
  }

  /** 统一请求；非 2xx 或 code!==200 抛 Error（msg 来自服务端） */
  async function request(method, path, body) {
    var init = { method: method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var resp;
    try {
      resp = await fetch(api(path), init);
    } catch (e) {
      throw new Error('无法连接 API（' + (state.apiBase) + '），请检查地址与网络');
    }
    var json = null;
    try {
      json = await resp.json();
    } catch (e) {
      throw new Error('API 返回非 JSON（HTTP ' + resp.status + '）');
    }
    if (!resp.ok || !json || json.code !== 200) {
      throw new Error((json && json.msg) || ('请求失败（HTTP ' + resp.status + '）'));
    }
    return json.data;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  function statusBadge(status) {
    var span = el('span', 'badge ' + status, STATUS_TEXT[status] || status);
    return span;
  }

  var STATUS_TEXT = {
    submitted: '待提交审核',
    machine_check_failed: '机器检查失败',
    in_review: '审核中',
    approved: '待发布',
    published: '已发布',
    rejected: '已拒绝',
    pulled: '已下架',
  };

  function stars(n) {
    var full = Math.round(Number(n) || 0);
    return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
  }

  /** 异步按钮：执行期间禁用，抛错上抛由调用方处理 */
  async function withBusy(button, fn) {
    var original = button.textContent;
    button.disabled = true;
    button.textContent = '处理中…';
    try {
      await fn();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // ---------- 身份 ----------

  async function loadMe() {
    try {
      state.me = await request('GET', '/api/me');
    } catch (e) {
      state.me = null;
    }
    renderAccount();
  }

  function renderAccount() {
    var me = state.me;
    clear(whoEl);
    if (me) {
      whoEl.appendChild(document.createTextNode('已登录 '));
      whoEl.appendChild(el('b', null, me.login));
      if (me.isAdmin) whoEl.appendChild(el('span', 'badge approved', '管理员'));
    } else {
      whoEl.textContent = '未登录';
    }
    btnLogin.hidden = !!me;
    btnLogout.hidden = !me;
    navAdmin.hidden = !(me && me.isAdmin);
  }

  btnLogin.addEventListener('click', function () {
    window.location.href = api('/api/auth/github/login');
  });

  btnLogout.addEventListener('click', function () {
    // 会话是 HttpOnly cookie，前端无法直接清除；引导用户到服务端登出不存在时，
    // 采用「清本地态 + 提示」的方式（cookie 7 天后自然过期）。
    state.me = null;
    renderAccount();
    banner('已在本页登出。服务端会话 cookie 将在 7 天后自动过期；如需立即失效，请在门户令牌页吊销全部令牌。', 'info');
    go('#/');
  });

  document.getElementById('btn-save-api').addEventListener('click', function () {
    var value = (apiInput.value || '').trim().replace(/\/+$/, '');
    if (!value) {
      banner('API 地址不能为空', 'error');
      return;
    }
    state.apiBase = value;
    localStorage.setItem(API_KEY, value);
    banner('API 地址已保存：' + value, 'success');
    route();
  });

  // ---------- 视图：插件市场 ----------

  async function viewHome() {
    app.appendChild(section('插件市场', '来自 registry 索引，含评分聚合（下架版本已剔除）'));
    var grid = el('div', 'plugin-grid');
    app.lastChild.appendChild(grid);

    var data;
    try {
      data = await request('GET', '/api/plugins?page=1&pageSize=60');
    } catch (e) {
      clear(grid);
      grid.appendChild(el('div', 'empty', e.message));
      return;
    }
    clear(grid);
    var list = (data && data.list) || [];
    if (!list.length) {
      grid.appendChild(el('div', 'empty', '暂无插件'));
      return;
    }
    list.forEach(function (p) {
      var card = el('div', 'plugin');
      card.appendChild(el('div', 'pname', p.name));
      card.appendChild(el('div', 'pid', p.id + ' · v' + (p.latestVersion || p.version || '')));
      card.appendChild(el('div', 'pdesc', p.description || ''));

      var meta = el('div', 'pmeta');
      meta.appendChild(el('span', null, '⬇ ' + (p.downloads || 0)));
      var rate = el('span', null);
      rate.appendChild(el('span', 'stars', stars(p.rating)));
      rate.appendChild(document.createTextNode(' ' + (p.ratingCount || 0) + ' 条'));
      meta.appendChild(rate);
      if (p.category) meta.appendChild(el('span', null, p.category));
      card.appendChild(meta);

      grid.appendChild(card);
    });
  }

  // ---------- 视图：我的提交 ----------

  function renderReport(container, reportRaw) {
    if (!reportRaw) return;
    var report = reportRaw;
    if (typeof report === 'string') {
      try {
        report = JSON.parse(report);
      } catch (e) {
        return;
      }
    }
    if (!report || !Array.isArray(report.checks)) return;
    var box = el('div', 'report');
    report.checks.forEach(function (c) {
      box.appendChild(
        el('div', 'report-row ' + (c.ok ? 'good' : 'bad'), (c.ok ? '✔ ' : '✘ ') + c.name + (c.detail ? ' — ' + c.detail : '')),
      );
    });
    container.appendChild(box);
  }

  async function viewMine() {
    if (!state.me) return needLogin();
    app.appendChild(section('我的提交', '发布用 CLI：node publish/nf-plugin-cli.js publish <dir> --token <令牌>'));

    var data = await request('GET', '/api/submissions');
    var list = (data && data.list) || [];

    if (!list.length) {
      app.lastChild.appendChild(el('div', 'empty', '还没有提交记录。先用 CLI 发布一个版本。'));
      return;
    }

    var table = el('table');
    var thead = el('thead');
    var hrow = el('tr');
    ['插件 / 版本', '状态', '机器检查', '时间', '操作'].forEach(function (t) {
      hrow.appendChild(el('th', null, t));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el('tbody');
    list.forEach(function (s) {
      var tr = el('tr');

      var tdId = el('td');
      tdId.appendChild(el('div', null, s.plugin_id));
      tdId.appendChild(el('div', 'pid', 'v' + s.version));
      tr.appendChild(tdId);

      var tdStatus = el('td');
      tdStatus.appendChild(statusBadge(s.status));
      if (s.reject_reason) {
        tdStatus.appendChild(el('div', 'pid', '理由：' + s.reject_reason));
      }
      tr.appendChild(tdStatus);

      var tdReport = el('td');
      renderReport(tdReport, s.machine_report);
      tr.appendChild(tdReport);

      var tdTime = el('td');
      tdTime.appendChild(el('div', null, fmtTime(s.submitted_at)));
      if (s.reviewed_at) tdTime.appendChild(el('div', 'pid', '审核 ' + fmtTime(s.reviewed_at)));
      tr.appendChild(tdTime);

      var tdOps = el('td', 'actions');
      if (s.status === 'submitted') {
        var btn = el('button', 'btn btn-sm btn-primary', '提交审核');
        btn.addEventListener('click', function () {
          withBusy(btn, async function () {
            try {
              await request('POST', '/api/submissions/' + encodeURIComponent(s.plugin_id) + '/' + encodeURIComponent(s.version) + '/submit');
              banner('已提交审核：' + s.plugin_id + '@' + s.version, 'success');
              await route();
            } catch (e) {
              banner(e.message, 'error');
            }
          });
        });
        tdOps.appendChild(btn);
      } else if (s.status === 'machine_check_failed') {
        tdOps.appendChild(el('span', 'pid', '修正后重新 publish'));
      } else {
        tdOps.appendChild(el('span', 'pid', '—'));
      }
      tr.appendChild(tdOps);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    app.lastChild.appendChild(table);
  }

  // ---------- 视图：发布令牌 ----------

  async function viewTokens() {
    if (!state.me) return needLogin();
    app.appendChild(section('发布令牌', '令牌明文仅在签发时显示一次，服务端只存 SHA-256 哈希；丢失请吊销后重新签发。'));

    var data = await request('GET', '/api/tokens');
    var list = (data && data.tokens) || [];

    var table = el('table');
    var thead = el('thead');
    var hrow = el('tr');
    ['前缀', '名称', '创建', '最近使用', '状态', '操作'].forEach(function (t) {
      hrow.appendChild(el('th', null, t));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el('tbody');
    if (!list.length) {
      var tr0 = el('tr');
      var td0 = el('td', 'empty', '还没有令牌');
      td0.colSpan = 6;
      tr0.appendChild(td0);
      tbody.appendChild(tr0);
    }
    list.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', 'token-value', t.token_hash_prefix));
      tr.appendChild(el('td', null, t.name || '—'));
      tr.appendChild(el('td', null, fmtTime(t.created_at)));
      tr.appendChild(el('td', null, fmtTime(t.last_used_at)));
      tr.appendChild(el('td', null, t.revoked ? '已吊销' : '有效'));

      var td = el('td', 'actions');
      if (!t.revoked) {
        var btn = el('button', 'btn btn-sm btn-danger', '吊销');
        btn.addEventListener('click', function () {
          withBusy(btn, async function () {
            try {
              await request('DELETE', '/api/tokens/' + encodeURIComponent(t.token_hash_prefix));
              banner('已吊销令牌 ' + t.token_hash_prefix, 'success');
              await route();
            } catch (e) {
              banner(e.message, 'error');
            }
          });
        });
        td.appendChild(btn);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    app.lastChild.appendChild(table);

    // 签发新令牌
    var form = el('div', 'card');
    form.appendChild(el('h2', null, '签发新令牌'));
    var field = el('div', 'field');
    field.appendChild(el('label', null, '令牌名称'));
    var nameInput = el('input');
    nameInput.type = 'text';
    nameInput.placeholder = '例如：my-laptop';
    field.appendChild(nameInput);
    var issueBtn = el('button', 'btn btn-primary', '签发');
    field.appendChild(issueBtn);
    form.appendChild(field);

    var result = el('div');
    form.appendChild(result);

    issueBtn.addEventListener('click', function () {
      withBusy(issueBtn, async function () {
        try {
          var data = await request('POST', '/api/tokens', { name: nameInput.value.trim() || 'cli' });
          clear(result);
          result.appendChild(el('div', 'hint', '请立即保存，关闭后无法再次查看：'));
          result.appendChild(el('div', 'token-value', data.token));
          banner('令牌已签发', 'success');
          renderTokensTable();
        } catch (e) {
          banner(e.message, 'error');
        }
      });
    });

    app.appendChild(form);

    // 复用：签发后刷新表格
    async function renderTokensTable() {
      var fresh = await request('GET', '/api/tokens');
      renderTokenRows((fresh && fresh.tokens) || []);
    }

    function renderTokenRows(rows) {
      clear(tbody);
      if (!rows.length) {
        var tr0 = el('tr');
        var td0 = el('td', 'empty', '还没有令牌');
        td0.colSpan = 6;
        tr0.appendChild(td0);
        tbody.appendChild(tr0);
        return;
      }
      rows.forEach(function (t) {
        var tr = el('tr');
        tr.appendChild(el('td', 'token-value', t.token_hash_prefix));
        tr.appendChild(el('td', null, t.name || '—'));
        tr.appendChild(el('td', null, fmtTime(t.created_at)));
        tr.appendChild(el('td', null, fmtTime(t.last_used_at)));
        tr.appendChild(el('td', null, t.revoked ? '已吊销' : '有效'));
        tr.appendChild(el('td', 'actions'));
        tbody.appendChild(tr);
      });
    }
  }

  // ---------- 视图：审批台 ----------

  async function viewAdmin() {
    if (!state.me) return needLogin();
    if (!state.me.isAdmin) {
      app.appendChild(section('无权限', ''));
      app.lastChild.appendChild(el('div', 'empty', '当前账号不在 ADMIN_GITHUB_LOGINS 白名单内。'));
      return;
    }

    app.appendChild(section('审批台', '审核通过后进入待发布队列，由核心成员本地 release --drain 合入 registry 并签名。'));

    var data = await request('GET', '/api/admin/submissions?limit=200');
    var list = (data && data.list) || [];
    if (!list.length) {
      app.lastChild.appendChild(el('div', 'empty', '队列为空'));
      return;
    }

    var table = el('table');
    var thead = el('thead');
    var hrow = el('tr');
    ['插件 / 版本', '开发者', '状态', '机器检查', '时间', '操作'].forEach(function (t) {
      hrow.appendChild(el('th', null, t));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el('tbody');
    list.forEach(function (s) {
      var tr = el('tr');

      var tdId = el('td');
      tdId.appendChild(el('div', null, s.plugin_id));
      tdId.appendChild(el('div', 'pid', 'v' + s.version));
      tr.appendChild(tdId);

      tr.appendChild(el('td', 'pid', s.developer_id));

      var tdStatus = el('td');
      tdStatus.appendChild(statusBadge(s.status));
      if (s.reject_reason) tdStatus.appendChild(el('div', 'pid', s.reject_reason));
      tr.appendChild(tdStatus);

      var tdReport = el('td');
      renderReport(tdReport, s.machine_report);
      tr.appendChild(tdReport);

      var tdTime = el('td');
      tdTime.appendChild(el('div', null, fmtTime(s.submitted_at)));
      if (s.reviewed_at) tdTime.appendChild(el('div', 'pid', '审核 ' + fmtTime(s.reviewed_at)));
      tr.appendChild(tdTime);

      var tdOps = el('td', 'actions');
      var base = '/api/admin/submissions/' + encodeURIComponent(s.plugin_id) + '/' + encodeURIComponent(s.version);

      if (s.status === 'in_review' || s.status === 'submitted') {
        var okBtn = el('button', 'btn btn-sm btn-primary', '通过');
        okBtn.addEventListener('click', function () {
          withBusy(okBtn, async function () {
            try {
              await request('POST', base + '/review', { decision: 'approved' });
              banner('已通过：' + s.plugin_id + '@' + s.version + '，进入待发布队列', 'success');
              await route();
            } catch (e) {
              banner(e.message, 'error');
            }
          });
        });
        tdOps.appendChild(okBtn);

        var noBtn = el('button', 'btn btn-sm btn-danger', '拒绝');
        noBtn.addEventListener('click', function () {
          var reason = window.prompt('拒绝理由（必填，将展示给开发者）：');
          if (!reason || !reason.trim()) return;
          withBusy(noBtn, async function () {
            try {
              await request('POST', base + '/review', { decision: 'rejected', reason: reason.trim() });
              banner('已拒绝：' + s.plugin_id + '@' + s.version, 'success');
              await route();
            } catch (e) {
              banner(e.message, 'error');
            }
          });
        });
        tdOps.appendChild(noBtn);
      }

      if (s.status === 'published') {
        var pullBtn = el('button', 'btn btn-sm btn-danger', '下架');
        pullBtn.addEventListener('click', function () {
          var reason = window.prompt('下架理由（可选）：') || '';
          withBusy(pullBtn, async function () {
            try {
              await request('POST', base + '/pull', { reason: reason.trim() });
              banner('已下架：' + s.plugin_id + '@' + s.version + '（索引层立即剔除）', 'success');
              await route();
            } catch (e) {
              banner(e.message, 'error');
            }
          });
        });
        tdOps.appendChild(pullBtn);
      }

      if (s.status === 'pulled') {
        var unBtn = el('button', 'btn btn-sm', '恢复');
        unBtn.addEventListener('click', function () {
          withBusy(unBtn, async function () {
            try {
              await request('POST', base + '/unpull', {});
              banner('已恢复：' + s.plugin_id + '@' + s.version, 'success');
              await route();
            } catch (e) {
              banner(e.message, 'error');
            }
          });
        });
        tdOps.appendChild(unBtn);
      }

      tr.appendChild(tdOps);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    app.lastChild.appendChild(table);

    // 待发布队列（供 drain 参考）
    var q = await request('GET', '/api/admin/queue');
    var qCard = el('div', 'card');
    qCard.appendChild(el('h2', null, '待发布队列（' + ((q && q.total) || 0) + '）'));
    qCard.appendChild(
      el('p', 'hint', '核心成员执行：node publish/nf-plugin-cli.js release --drain --token <管理员令牌>'),
    );
    if (q && q.items && q.items.length) {
      q.items.forEach(function (it) {
        qCard.appendChild(
          el('div', 'report-row', it.pluginId + '@' + it.version + ' — 包体' + (it.hasPackage ? '就绪' : '缺失')),
        );
      });
    }
    app.appendChild(qCard);
  }

  // ---------- 视图：发布指引 ----------

  function viewGuide() {
    app.appendChild(section('第三方插件发布流程', '完整链路：本地签名 → 上传 → 机器检查 → 人工审核 → 核心成员 drain 合入'));

    var steps = el('div', 'card');
    steps.appendChild(el('h2', null, '1. 生成开发者密钥（一次性）'));
    var code1 = el('pre', 'code');
    code1.textContent = 'node publish/nf-plugin-cli.js keygen\n# 生成 keys/dev/priv.pem（本地保留，切勿提交）与 pub.pem';
    steps.appendChild(code1);
    app.appendChild(steps);

    var step2 = el('div', 'card');
    step2.appendChild(el('h2', null, '2. 在「发布令牌」页签发 CLI 令牌'));
    var code2 = el('pre', 'code');
    code2.textContent = '令牌格式 nft_<48 hex>，明文仅显示一次；服务端只存 SHA-256 哈希，可随时吊销。';
    step2.appendChild(code2);
    app.appendChild(step2);

    var step3 = el('div', 'card');
    step3.appendChild(el('h2', null, '3. 发布（本地用开发者私钥签名后上传）'));
    var code3 = el('pre', 'code');
    code3.textContent =
      'node publish/nf-plugin-cli.js publish ./my-plugin \\\n' +
      '  --token <CLI令牌>\n' +
      '\n' +
      '# 上传后状态为 submitted；在本门户「我的提交」页点「提交审核」推进到 in_review';
    step3.appendChild(code3);
    app.appendChild(step3);

    var step4 = el('div', 'card');
    step4.appendChild(el('h2', null, '4. 审核通过后'));
    var code4 = el('pre', 'code');
    code4.textContent =
      'status = approved → 进入待发布队列\n' +
      '核心成员本地执行：node publish/nf-plugin-cli.js release --drain --token <管理员令牌>\n' +
      '  · 复验 checksum 与开发者签名\n' +
      '  · 加密为 .nfpkg 写入 packages/<id>/<ver>.nfpkg\n' +
      '  · 更新 registry.json（publisher=developer）并重签 registry.sig\n' +
      '  · 回执 ack → published';
    step4.appendChild(code4);
    app.appendChild(step4);
  }

  // ---------- 通用组件 ----------

  function section(title, hint) {
    var card = el('div', 'card');
    card.appendChild(el('h2', null, title));
    if (hint) card.appendChild(el('p', 'hint', hint));
    return card;
  }

  function needLogin() {
    var card = el('div', 'card');
    card.appendChild(el('h2', null, '需要登录'));
    card.appendChild(el('p', 'hint', '用 GitHub 账号登录后可管理自己的插件提交与发布令牌。'));
    var btn = el('button', 'btn btn-primary', '用 GitHub 登录');
    btn.addEventListener('click', function () {
      window.location.href = api('/api/auth/github/login');
    });
    card.appendChild(btn);
    app.appendChild(card);
    viewGuide();
  }

  // ---------- 路由 ----------

  var routes = {
    home: viewHome,
    mine: viewMine,
    tokens: viewTokens,
    admin: viewAdmin,
    guide: viewGuide,
  };

  async function route() {
    var hash = window.location.hash || '#/';
    var name = hash.replace(/^#\/?/, '').split('?')[0] || 'home';
    if (!routes[name]) name = 'home';
    state.route = name;

    Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === name);
    });

    clear(app);
    banner(null);
    try {
      await routes[name]();
    } catch (e) {
      clear(app);
      var card = el('div', 'card');
      card.appendChild(el('h2', null, '加载失败'));
      card.appendChild(el('p', 'hint', e.message));
      app.appendChild(card);
    }
  }

  function go(hash) {
    if (window.location.hash === hash) route();
    else window.location.hash = hash;
  }

  // ---------- 启动 ----------

  window.addEventListener('hashchange', route);

  apiInput.value = state.apiBase;

  // OAuth 回调可能带 ?auth_error=
  var params = new URLSearchParams(window.location.search);
  var authError = params.get('auth_error');

  loadMe().then(function () {
    if (authError) banner('登录失败：' + authError, 'error');
    return route();
  });

  // 暴露给手动调试
  window.NFPortal = { state: state, request: request, go: go };
})();
