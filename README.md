# NF Client 插件市场（Registry）

> 完全免费、基于 GitHub 仓库的 NF Client 插件市场后端。

本仓库托管 NF Client 所有可用插件的**索引（registry.json）**与**插件包（packages/）**，
通过 GitHub Raw / jsdelivr CDN 免费分发。发布流程 = `git push`。

## 仓库结构

```
nf-plugin-registry/
├── registry.json            # 插件索引（客户端拉取的核心文件）
├── packages/                # 插件包：packages/<id>/<version>.zip + <version>.sig
├── publish/                 # 发布工具（nf-plugin-cli.js）
├── scripts/                 # 维护脚本（build-all.js 批量打包并重建索引）
├── lib/                     # 共享库（zip 打包 / Ed25519 签名）
├── docs/                    # 插件开发文档
└── keys/                    # 官方签名密钥（仅提交 pub.pem）
```

## 快速开始

### 客户端地址

- registry.json（GitHub Raw）：`https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/registry.json`
- registry.json（jsdelivr CDN）：`https://cdn.jsdelivr.net/gh/nanfenghuiyi/nf-plugin-registry@main/registry.json`
- 插件包：`https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/packages/<id>/<version>.zip`

### 发布插件

```bash
# 在插件源码目录执行（需要本仓库已 clone 到本地）
node <registry>/publish/nf-plugin-cli.js publish <plugin-dir>
```

详见 [docs/getting-started.md](docs/getting-started.md)。

### 维护：重建索引

当批量新增/更新插件包后，重新生成 registry.json：

```bash
node scripts/build-all.js <plugins-src-dir>
```

## 分类说明

| 分类 | 说明 |
|------|------|
| app | 应用类（管理后台、工具） |
| hardware | 硬件类（串口、打印、扫码等） |
| device | 设备类 |
| media | 媒体类（流媒体、语音） |
| system | 系统类 |
| extension | 扩展类 |

## 签名体系

- 打包后的 zip 使用 **Ed25519** 签名（官方密钥对，`keys/pub.pem` 为信任根）。
- 每个版本记录 `checksum`（SHA-256）、`signature`（Ed25519）、`publicKey`。
- 客户端安装时对下载到的 zip 字节用公钥验签，防止包被篡改。

## 相关文档

- [插件开发入门](docs/getting-started.md)
- [manifest 规范](docs/manifest-spec.md)
- [客户端接入说明](docs/client-integration.md)
