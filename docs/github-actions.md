# GitHub Actions CI/CD

仓库根目录是本项目内容，让 `.github/workflows` 位于根目录。代码和 IaC 提交 GitHub，S3 笔记、`config/local.json`、Cognito secret、token 和 AWS keys 均不提交。

## 当前启用的 CI

`ci.yml` 在 PR 和 main push 运行：`npm ci`、typecheck、lint、单元与 HTTP 集成测试、运行时依赖审计、示例配置 synth。测试使用合成笔记和临时 RSA 密钥，不需要 AWS/OAuth 凭据，不读取生产知识库。产物只有示例 CloudFormation 模板。

本次授权是完成实现、配置 CI、开 PR；不自动合并，也不部署 AWS。

## 部署工作流默认关闭

`deploy.yml` 仅支持手动 dispatch，且要求 repository variable `ENABLE_AWS_DEPLOY=true`、main 分支、输入 `deploy` 三项同时满足，默认不会运行任何部署 job。

启用前必须独立完成并批准 AWS OIDC roles / bootstrap、实际配置以及私有仓库的审批保护。不要把仅写 `environment: production` 当作保护规则生效。

[GitHub 当前文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) 说明：私有仓库的 environment 和 required reviewers 受套餐限制。若无法提供所需保护，保持此工作流关闭，在聊天中审阅实际 diff 后使用本地获批部署，不把仓库改公开以获得保护功能。

工作流启用后：

1. `production-plan` 使用只读 plan role，重复 CI 后 synth 和 `cdk diff --method=template`，不创建 ChangeSet。
2. 上传 cloud assembly 和 diff，保留 3 天。
3. `production` 必须配置 required reviewers 与 main-only 部署分支；等待审批，部署前一个 job 的同一份 assembly，不重新 synth。
4. 部署后匿名 `/mcp` 必须 401、认证 discovery 必须 200，再检查真实 Cognito S256 discovery。
5. 第一次创建池后 discovery 检查可能失败。AWS 资源已创建不等于 ChatGPT 接入可用，保持 callback / sub 为空，处理兼容问题后再启用登录。

Cognito 资源首次创建前不存在可检查的真实 discovery，故检查安排在首次部署之后。后续更新前也应手动重新预检。

## 一次性 OIDC roles（当前不创建）

`infra/github-stack.ts` 管理与应用读取身份分离的 plan / deploy role：

- plan role 只读目标栈、CDKToolkit 状态/模板与 bootstrap 版本，不能 AssumeRole 到部署角色，不读取笔记。
- deploy role 可 AssumeRole 到限定账号/Region 的 CDK bootstrap deploy/file-publishing roles。默认 CloudFormation 执行身份权限较大，将该身份按基础设施管理权限保护。
- token audience 为 sts.amazonaws.com，subject 精确匹配指定仓库和 environment。

准备配置：

```bash
cp config/github.example.json config/github.local.json
```

设置 account、region、repositorySubject、createProvider、bootstrapQualifier。新仓库可能使用带不可变 ID 的 subject，例如 `repo:OWNER@OWNER_ID/REPO@REPO_ID`；旧格式为 `repo:OWNER/REPO`。必须核对真实 subject 格式，不能只从仓库显示名推测。CDK 附加 environment:production-plan / production，不使用 repo 通配符或依赖未确认支持的 GitHub ref 自定义 claim。

`createProvider=false` 引用已有 GitHub OIDC provider；只有确认账号没有相同 URL provider 时才设为 true，避免重复创建。

先审阅信任栈：

```bash
npx cdk diff ObsidianGitHubTrust --app 'npx --no-install tsx bin/github.ts' \
  --method=template --no-lookups --profile PROFILE
```

仅在明确批准后执行：

```bash
npx cdk deploy ObsidianGitHubTrust --app 'npx --no-install tsx bin/github.ts' \
  --require-approval broadening --no-lookups --profile PROFILE
```

bootstrap 同样需要单独批准。这些命令会写 AWS，本次代码交付不运行。

## 启用部署前的 GitHub 配置

- `production-plan`：main-only，Variables 为 AWS_PLAN_ROLE_ARN、AWS_ACCOUNT_ID、AWS_REGION、DEPLOY_CONFIG_JSON。
- `production`：main-only、Required reviewers，Variables 为 AWS_DEPLOY_ROLE_ARN、AWS_ACCOUNT_ID、AWS_REGION。个人自审场景不要启用 Prevent self-review。
- DEPLOY_CONFIG_JSON 与 config/local.json 同结构，不含任何密钥，Cognito ID/issuer 由栈资源引用生成。
- 确认保护规则、配置和 AWS roles 全部可用后，才设置 repository variable ENABLE_AWS_DEPLOY=true。本次不设置它。

Cloud assembly 包含代码、Bucket/Prefix、用户 sub 等配置，虽无笔记或凭据，仍应仅向可信仓库成员开放。审批前核对 commit、run 和 diff。

依据：[GitHub OIDC AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)、[AWS role trust](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html)、[CDK bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)。
