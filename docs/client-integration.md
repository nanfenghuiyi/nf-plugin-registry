# 客户端接入说明

NF Client 通过以下方式接入本插件市场：

## 数据源配置

### 方式一：环境变量覆盖

```bash
# 指向 registry.json 的 GitHub raw 地址
set NF_REGISTRY_URL=https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/registry.json
```

### 方式二：jsdelivr CDN（国内加速）

```bash
set NF_REGISTRY_URL=https://cdn.jsdelivr.net/gh/nanfenghuiyi/nf-plugin-registry@main/registry.json
```

## 插件下载地址

插件包地址格式：
```
https://raw.githubusercontent.com/nanfenghuiyi/nf-plugin-registry/main/packages/<id>/<version>.zip
```

jsdelivr CDN 版本：
```
https://cdn.jsdelivr.net/gh/nanfenghuiyi/nf-plugin-registry@main/packages/<id>/<version>.zip
```

## 签名验证

客户端使用 Ed25519 验证插件包签名。信任根公钥（`keys/pub.pem`）需内置在客户端中。