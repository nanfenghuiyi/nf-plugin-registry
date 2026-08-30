# 客户端接入说明

NF Client 支持**双模式**接入本插件市场，默认零配置即可使用 GitHub raw 分发，也可通过环境变量切换到 REST 模式。

---

## 双模式架构

```
┌─────────────────────────────────────────────────────────────┐
│                      NF Client                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  PluginMarket Controller (pluginMarket.ts)            │  │
│  │                                                       │  │
│  │  ┌─ isGitHubMode() ────────────────────────────────┐  │  │
│  │  │  true = 默认模式（环境变量 NF_MARKET_URL 和      │  │  │
│  │  │         NF_REGISTRY_URL 都未设置）               │  │  │
│  │  │  false = REST 模式（任一环境变量被设置）          │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │                                                       │  │
│  │  ┌─ GitHub raw 模式（默认）────────────────────────┐  │  │
│  │  │  • 从 registry.json 读取插件列表、版本、下载地址  │  │  │
│  │  │  • 主源：raw.githubusercontent.com               │  │  │
│  │  │  • 回退：cdn.jsdelivr.net                        │  │  │
│  │  │  • 10 分钟内存缓存                               │  │  │
│  │  │  • 验签数据（signature/publicKey/checksum）       │  │  │
│  │  │    从 registry.json 直接透传，不依赖 REST API     │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │                                                       │  │
│  │  ┌─ REST 模式（环境变量启用）──────────────────────┐  │  │
│  │  │  • 通过 REST API 获取插件列表和详情               │  │  │
│  │  │  • 下载地址由服务端返回                          │  │  │
│  │  │  • 验签数据从 fetchDetail 拉取                    │  │  │
│  │  │  • 回退到 mock 数据                              │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │                                                       │  │
│  │  前端 IPC 接口（零改动）                                │  │
│  │  { code, msg, data: { list, total, page, pageSize } } │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 模式一：GitHub raw（默认，零成本）

### 数据流

```
1. 客户端启动 / 插件市场页面加载
2. PluginMarketController 检测环境变量（NF_MARKET_URL / NF_REGISTRY_URL 均未设置）
3. 切换到 GitHub raw 模式
4. 获取 registry.json（主源 → 回退 jsdelivr）
   └── https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/registry.json
   └── https://cdn.jsdelivr.net/gh/nanfenghuiyi/nf-plugin-registry@main/registry.json
5. 解析 registry.json → 返回前端列表（IPC 格式不变）
6. 用户点击安装
7. 从 registry.json 中获取目标版本的：
   - downloadUrl（插件包下载地址）
   - checksum（SHA256 校验和）
   - signature（Ed25519 签名 base64）
   - publicKey（签名者公钥 PEM）
8. 下载器 pluginDownloader 使用 downloadUrl 直连下载
9. 下载完成后，pluginVerifier 做完整性校验：
   - SHA256 checksum 验证
   - Ed25519 签名验证（含信任根校验）
10. 安装完毕
```

### 特征

- **零成本**：GitHub raw 和 jsdelivr CDN 均免费
- **零配置**：开箱即用，无需设置任何环境变量
- **高可用**：主源 + CDN 回退，registry.json 10 分钟内存缓存
- **安全**：Ed25519 签名 + SHA256 校验和 + 信任根公钥三重验证

---

## 模式二：REST（环境变量启用）

### 数据流

```
1. 设置环境变量（任选其一）：
   └── set NF_MARKET_URL=http://your-market-server.com
   └── set NF_REGISTRY_URL=http://your-market-server.com/registry.json
2. 客户端通过 REST API 获取数据：
   - GET /api/plugins?page=1&pageSize=20&category=xxx
   - GET /api/plugins/:id
   - GET /api/download?id=xxx&version=xxx
3. 验签数据从 REST API 返回
```

### 兼容性

| 接口 | GitHub raw 模式 | REST 模式 |
|---|---|---|
| 获取插件列表 | 解析 registry.json | GET /api/plugins |
| 获取插件详情 | 解析 registry.json | GET /api/plugins/:id |
| 安装插件 | downloadUrl 直连 + 透传权威值 | GET /api/download + fetchDetail |
| 检查更新 | 解析 registry.json | GET /api/plugins/updates |
| 返回格式 | `{ code, msg, data: { list, total, page, pageSize } }` | 同左 |

---

## 环境变量参考

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `NF_MARKET_URL` | REST 模式市场地址（设置后切换到 REST API） | 空（GitHub raw 模式） |
| `NF_REGISTRY_URL` | REST 模式 registry 地址（设置后切换到 REST API，优先级低于 NF_MARKET_URL） | 空（GitHub raw 模式） |
| `NF_TRUSTED_PUBLIC_KEYS` | 受信公钥列表（逗号分隔 PEM，覆盖内置信任根） | 空（使用内置 ROOT_PUBLIC_KEY） |
| `NF_REQUIRE_PLUGIN_SIGNATURE` | 是否强制验签（`true` 时签名无效或缺失拒绝安装） | `false` |

---

## 信任根验证

客户端内置 Ed25519 信任根公钥（`ROOT_PUBLIC_KEY`），在安装插件时强制校验：

1. 从 registry.json 获取 `publicKey`（作者签名用公钥）
2. 检查该公钥是否命中信任根（`trustedKeys.some(k => k.trim() === pub.trim())`）
3. 未命中 → 拒绝安装（防「换钥匙」攻击）
4. 用该公钥验证 `signature` 对插件包的签名
5. 上述任一验证失败 → 安装中断并报错

信任根公钥文件：[keys/pub.pem](../keys/pub.pem)

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAg6Rcdt1brXE9uhDnNuUVelCnAQos2yje1vsufcexZ60=
-----END PUBLIC KEY-----
```

---

## 插件包 URL 格式

### GitHub raw（注册表 downloadUrl）

```
https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/packages/<id>/<version>.zip
```

### jsdelivr CDN（回退下载）

```
https://cdn.jsdelivr.net/gh/nanfenghuiyi/nf-plugin-registry@main/packages/<id>/<version>.zip
```

---

## 测试验证

正常启动 NF Client，打开"设置 → 插件市场"，无需配置任何环境变量即可看到 34 个可用插件。选择任意插件安装，验证：

- 插件列表正常加载（GitHub raw registry.json 解析）
- 安装进度正常显示
- 安装完成后插件出现在已安装列表
- 插件功能正常使用