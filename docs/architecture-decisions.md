# 架构讨论中的已确认决定

此文件记录已确认的产品和管理边界；尚未确认的设计不能视为实施或部署授权。

## Cognito 分工

- 使用 Amazon Cognito。
- User Pool、App Client、Cognito 登录域名、scope 和相关认证基础设施由 CDK 管理。
- 用户只在 AWS Console 创建自己的登录用户，并自行设置密码和 MFA；真实用户不写入 CDK。
- 登录用户创建后，将非密钥的 sub 配入服务端允许名单。用户池 ID、客户端 ID、issuer/JWKS 通过 IaC 引用或输出取得。
- client secret 自动生成，不写入仓库、CloudFormation Output 或日志；用户在 Console 查看并填入 ChatGPT。
- 首次创建用户池后须验证实际 discovery 的 S256 兼容性。尚未验证兼容性，也未选择额外认证代理方案。
- Cognito 资源应采用保留策略，避免移除应用栈时误删登录身份。

## 交付顺序

- 用户已在 Lavish 明确确认架构讨论完成，授权继续实现、验证、配置 GitHub CI 和创建 PR。
- PR / main push 运行不访问生产 AWS 的检查 CI。AWS 部署工作流默认关闭，OIDC roles / bootstrap 和环境保护须另行配置、批准。
- 展示真实 CDK diff，并获得用户明确确认后，才可部署 AWS；创建 Cognito 和 bootstrap 同样属于 AWS 写入。
- 不修改现有笔记或 S3 中的文件。

## S3 读取范围

- 用户已明确选择保留空 Prefix，与现有 Remotely Save 配置一致。
- IAM 可列出、读取指定 Bucket 的所有对象，应用层再过滤 Markdown 和隐藏路径。
- 不移动笔记、不调整同步布局，不授予写入、删除或其他 Bucket 的访问权限。

## 搜索正确性

- 已修正预算耗尽时的精确续扫，保留有界读取，不跳过未检查正文。端到端回归用例先复现 30 篇只找到 16 篇，修复后找到全部 30 篇，见 test/http.e2e.test.ts。
- 超大和不可读笔记仍明确报告为未覆盖，不能把分批扫描等同于已实现完整全文检索。

本次交付不部署 AWS、不合并 PR。Cognito 实际 discovery、ChatGPT callback、真实用户 sub 与 AWS 部署身份在后续获批部署及接入时验证，不把这些尚未完成的验证表述为已通过。
