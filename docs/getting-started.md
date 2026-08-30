# 插件开发入门

本文档介绍如何从零开始开发一个 NF Client 插件，并发布到插件市场。

## 前置条件

- NF Client v1.0.8+
- Node.js 20+
- 本插件市场仓库已 clone 到本地

## 快速开始

### 1. 创建插件脚手架

```bash
# 克隆本仓库
git clone https://github.com/nanfenghuiyi/nf-plugin-registry.git
cd nf-plugin-registry

# 使用主项目 CLI 创建脚手架（需要 electron-egg-demo 项目）
node <electron-egg-demo>/tools/nf-plugin/cli.js create app nf.app.demo --name "Demo 工具"
```

### 2. 编写插件代码

编辑 `index.js` 实现业务逻辑，编辑 `renderer/dist/` 实现界面。

### 3. 发布插件

```bash
node publish/nf-plugin-cli.js publish <plugin-dir>
```

该命令会自动：
1. 打包插件目录为 zip
2. 计算 SHA-256 checksum
3. 用官方密钥 Ed25519 签名
4. 写入 `packages/<id>/<version>.zip`
5. 更新 `registry.json`
6. git commit + git push

### 4. 验证

更新后，客户端下次拉取 registry.json 即可看到新插件。

## 目录结构

```
my-plugin/
├── manifest.json        # 必填：插件清单
├── index.js             # 必填：主进程入口
├── renderer/            # 可选：前端界面
│   └── dist/
│       └── index.html
├── icon.svg             # 可选：图标
└── package.json         # 可选：npm 依赖声明
```

## 发布注意事项

- 确保 `manifest.json` 中的 `version` 已更新（semver 格式）
- 插件包大小不超过 50MB（GitHub 单文件限制）
- 首次发布会自动生成 Ed25519 密钥对
- 使用 `--no-push` 可跳过 git 推送，仅本地写入