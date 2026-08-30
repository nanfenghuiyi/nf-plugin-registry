# manifest.json 规范

manifest.json 是 NF Client 插件的核心描述文件，位于插件目录根目录。

## 必填字段

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `id` | string | 插件唯一标识（反向域名格式） | `nf.app.ocr` |
| `name` | string | 插件显示名称 | `OCR 文字识别` |
| `version` | string | 版本号（semver） | `1.0.0` |
| `type` | string | 插件类型 | `app`, `hardware`, `system`, `extension`, `device`, `skill` |
| `category` | string | 分类 | `tool`, `admin`, `serial`, `print`, `streamer` 等 |
| `main` | string | 主进程入口文件 | `index.js` |
| `permissions` | string[] | 权限声明列表 | `["storage:read", "ipc:register"]` |

## 推荐字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 插件描述 |
| `author` | string | 作者名 |
| `homepage` | string | 项目主页 URL |
| `icon` | string | 图标文件路径 |
| `engines` | object | 引擎版本要求 |
| `keywords` | string[] | 关键词（用于市场搜索） |
| `entrypoints` | object | 入口点声明 |
| `ui` | object | 窗口 UI 配置 |
| `depends` | array | 依赖的其他插件 |
| `autoStart` | boolean | 是否随客户端自动启动 |
| `exemptFromLimit` | boolean | 是否不限制（Pro 插件设为 false） |

## engines 字段

```json
{
  "nf-client": ">=1.0.8",
  "electron": "^32.1.0",
  "node": ">=20.16.0"
}
```

## 示例

参见仓库中 `packages/` 下各插件的 manifest.json。