# 验证记录

日期：2026-11-12。没有部署 AWS、创建 Cognito/部署角色或修改笔记。

## 本地代码与基础设施

- `npm ci`；Node.js 22.18.0。
- `npm run check`：TypeScript、ESLint、6 个测试文件共 50 项测试通过。
- `npm audit --omit=dev --audit-level=moderate`：0 vulnerabilities。
- `actionlint .github/workflows/ci.yml .github/workflows/deploy.yml`：无错误。
- `npm run diff:preview -- --no-color`：示例配置与空模板的离线 diff，完整输出见 `cdk-diff-preview.txt`。不代表真实 AWS 环境差异。
- CDK 产物包含 19 个资源，含 5 个 Cognito 资源；应用栈没有 S3 Bucket / BucketPolicy 或用户创建资源。
- 直接导入打包 ESM Lambda，模拟 API Gateway v2 事件：匿名 /mcp 返回 401、protected-resource 元数据返回 200；不调用 AWS。
- Cognito 测试验证关闭公开注册、必需 TOTP、池删除保护/保留策略、默认关闭 OAuth、未输出 secret、配置回调后只启用授权码流程。空用户白名单拒绝有效签名的 token。

完整依赖审计仍有 2 项中度告警，来自 CDK 内置 minimatch。它不进入 Lambda bundle，不能用 npm override 替换其内置副本，尚待上游修复。没有手改依赖或 generated 文件。

## 分页缺口的端到端复现与修复

使用官方 MCP Client → 本地 HTTP → Lambda 事件适配器 → JWT 验证 → search_notes，对 30 篇都包含正文关键词的合成笔记连续搜索至无游标。

- 修复前：只找到 16 / 30 篇，回归测试按预期失败。
- 修复后：找到 30 / 30 篇，每次读取预算仍 ≤ 512 KiB。
- 预算耗尽时保留最后处理位置，以 StartAfter 继续，避免跳到下一整页而永久漏扫。
- 单元测试另验证 deadline 返回续扫位置、查询/Prefix 绑定、读取失败与超大文件的明确覆盖限制。

分页不是并发更新快照；超大/失败正文仍未覆盖，结果统计需要跨页累计。

## 本机 S3 只读连通（独立于 CI）

从本机 Obsidian Remotely Save 配置发现实际 S3 参数，使用现有 obsidian-sync profile 验证账号、Region 和有界 ListObjectsV2。通过项目 S3NotesStore 读取一篇 24,418 字节 UTF-8 Markdown，未输出路径/正文，未写入仓库或修改对象。同步插件未配置端到端加密密码。

当前同步身份没有 GetBucketPublicAccessBlock 权限，因此未确认该设置；没有修改桶策略或扩大权限。这仅证明本机身份能读，不能代替 Lambda Role 验收。

## 云端尚未执行的验收

- 真实环境 CDK diff、获批部署，以及 Lambda 的实际 S3/KMS 权限。
- 真实 Cognito discovery S256、PKCE 授权码交换、resource/audience 绑定及刷新。
- 用户自行在 Console 创建账号后的 sub 白名单、MFA 和 ChatGPT 网页实连。
- GitHub AWS OIDC roles、bootstrap 和私有仓库部署审批保护；部署工作流默认禁用。

GitHub CI 的执行结果以 PR checks 为准。测试和示例 synth 不使用生产 S3 或 OAuth 凭据。
