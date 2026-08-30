# nf-market-api — NF Client 插件市场 API（Cloudflare Workers）

阶段 2 实现：在零成本前提下为插件市场提供 **服务端搜索/分类筛选、下载统计、速率限制**。
契约与 `tools/plugin-market/server.js` 完全对齐，客户端 REST 分支零适配。

架构原则：**Workers 只做索引 + 统计 + 流控，不分发插件包**。
`/api/download` 302 重定向到官方仓库地址（前缀白名单校验），包的信任边界仍在客户端（checksum + Ed25519 强验签）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/plugins?keyword=&category=&page=&pageSize=&sort=` | 列表：服务端搜索/分类/分页/排序（`downloads` 默认 / `newest`） |
| GET | `/api/plugins/:id` | 详情（最新版本，含 checksum/signature/publicKey/绝对 downloadUrl） |
| GET | `/api/plugins/:id/versions` | 全部版本 + 兼容矩阵 |
| GET | `/api/download?id=&version=` | 302 分发 + 异步计数（同 IP 60s 同包去重） |
| GET | `/api/search?q=` | 等价 `/api/plugins?keyword=` |
| GET | `/api/categories` | 分类列表 |
| GET | `/api/stats` | `{ plugins, versions, totalDownloads }` |

超限返回 `429 + Retry-After: 60`。

## 本地开发

```bash
npm install
npm run migrate:local        # 本地 D1 模拟库应用迁移
npm run dev                  # wrangler dev，默认 8787 端口
curl http://127.0.0.1:8787/health
```

## 部署 Runbook（T7）

### 前置：登录 Cloudflare（交互式，仅本机一次）

```bash
cd market-api
npx wrangler login           # 浏览器 OAuth 授权
npx wrangler whoami          # 确认已登录
```

### 步骤 1：创建 D1 并回填 database_id

```bash
npx wrangler d1 create nf-market-stats
```

把输出中的 `database_id` 填入 `wrangler.toml` 的 `[[d1_databases]]`（替换 `REPLACE_WITH_REAL_D1_DATABASE_ID`）。

### 步骤 2：应用远程迁移

```bash
npx wrangler d1 migrations apply DB --remote
```

### 步骤 3：部署

```bash
npx wrangler deploy
```

输出实际地址，形如 `https://nf-market-api.<你的子域>.workers.dev`。

### 步骤 4：线上验证

```bash
BASE=https://nf-market-api.<你的子域>.workers.dev
curl $BASE/health
curl "$BASE/api/plugins?keyword=OCR"
curl -I "$BASE/api/download?id=nf.app.ocr&version=1.0.0"   # 期望 302
curl $BASE/api/stats
```

### 步骤 5：客户端指向实际域名

把 `electron-egg-demo/electron/controller/pluginMarket.ts` 中的
`DEFAULT_MARKET_URL` 替换为步骤 3 输出的实际域名（`NF_MARKET_URL` 环境变量可随时覆盖）。

### CI 自动部署（可选）

1. GitHub 仓库 Settings → Secrets and variables → Actions 添加：
   - `CLOUDFLARE_API_TOKEN`：Dashboard → My Profile → API Tokens → Create Token →
     选 **Edit Cloudflare Workers** 模板，并追加 **D1: Edit** 权限
   - `CLOUDFLARE_ACCOUNT_ID`：Dashboard 首页右侧 Account ID
2. `.github/workflows/deploy-api.yml` 已就位：`market-api/**` 变更 push 到 main 即自动执行
   迁移 + 部署，也支持手动触发（workflow_dispatch）。

### 注意事项

- Workers 拉取的是 **GitHub 上的 registry.json**：先 git push registry 仓库（含分类归一化结果），
  线上 API 才返回 16 类数据；发布新插件后最长 5 分钟可见（内存缓存 TTL）。
- 免费额度：Workers 10 万请求/天，D1 写 10 万行/天 / 读 500 万行/天，速率限制 binding 免费。
- 回滚：`npx wrangler rollback`；删除：`npx wrangler delete`（D1 数据需单独删库）。

## 绑定

- `DB`（D1）：下载统计，表结构见 `migrations/0001_download_stats.sql`
- `RATE_LIMITER_API`：`/api/*` 100 次/分/IP
- `RATE_LIMITER_DOWNLOAD`：`/api/download` 30 次/分/IP

限流 binding 异常时 fail-open（放行），统计不可用时列表 downloads 按 0 降级，均不影响主流程。