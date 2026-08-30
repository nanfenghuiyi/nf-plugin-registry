---
alwaysApply: true
scene: git_message
---

# Git Commit Message 规范
请严格遵循以下格式生成提交信息：

## 格式
<类型>(<范围>): <主题>

## 类型说明
- feat: 新增功能
- fix: 修复 Bug  
- docs: 文档变更
- style: 代码格式（不影响功能）
- refactor: 重构（不是新功能也不是修复）
- perf: 性能优化
- test: 测试相关
- chore: 构建/工具变动

## 规则
1. 主题使用中文，不超过 50 字符
2. 主题不以句号结尾
3. 正文每行不超过 72 字符
4. 如有破坏性变更，在脚注中说明

## 示例
feat(utils.js): 添加格式化时间函数

fix(api/user.js): 修复用户列表分页参数错误
