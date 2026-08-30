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

## 部署（需要 Cloudflare 账号）

```bash
npx wrangler d1 create nf-market-stats          # 输出的 database_id 填入 wrangler.toml
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

CI 部署（可选）：在 GitHub 仓库 secrets 配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 后添加 wrangler-action 工作流。

## 绑定

- `DB`（D1）：下载统计，表结构见 `migrations/0001_download_stats.sql`
- `RATE_LIMITER_API`：`/api/*` 100 次/分/IP
- `RATE_LIMITER_DOWNLOAD`：`/api/download` 30 次/分/IP

限流 binding 异常时 fail-open（放行），统计不可用时列表 downloads 按 0 降级，均不影响主流程。