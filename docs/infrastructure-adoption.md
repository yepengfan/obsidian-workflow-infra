# Obsidian 基础设施纳管方案

用户已确定仓库名称为 `obsidian-workflow-infra`，范围扩展为 Obsidian 工作流相关的全部基础设施。本文是待实施方案，不代表已经执行资源导入或部署。

## 当前已核实的资源

- 两个私有 Bucket：`obsidian-vault-sync-391824190072` 与 `obsidian-ebook-library-391824190072`，均位于 `ap-southeast-2`。
- IAM 用户 `obsidian-sync` 及内联策略 `ObsidianVaultSyncAccess`。该策略允许两个 Bucket 的对象读写删除；MCP 将使用独立只读角色。
- 笔记 Bucket 已启用版本控制，电子书 Bucket 未启用。两个 Bucket 均开启四项 Public Access Block，默认 SSE-S3 / AES256、BucketOwnerEnforced，均无 Bucket policy、生命周期或复制规则。
- 未找到当前 CloudFormation 纳管证据。创建者及原始创建方式尚无可验证记录，不将其推定为 Console 或 CLI 创建。
- 旧 `us-east-1` 的 `BedrockCostMonitoring` 和 `CDKToolkit` 已按用户明确授权删除；两个 Obsidian Bucket 未修改。新基础设施以 Sydney 为目标。

## 建议结构

| 栈 | 责任 | 交付状态 |
| --- | --- | --- |
| 数据与同步栈 | 两个既有 Bucket、同步 IAM 用户及内联策略 | 待实现并导入现有资源 |
| MCP 应用栈 | API、Lambda、Cognito、日志、Lambda 只读角色 | 代码已实现，尚未部署 |
| GitHub 信任栈 | GitHub OIDC provider、plan / deploy roles | 代码已实现，尚未部署 |
| CDKToolkit | Sydney 的代码资产和标准 CDK 部署角色 | 尚未创建；由锁定版本的 CDK 标准 bootstrap 模板管理 |

数据资源与应用资源分开管理，避免更换 MCP 服务时同时改变数据生命周期。现有 MCP 模块可以继续作为仓库内的服务；无需为每一类 AWS 资源建立一个项目或流水线。

## 存量资源采用 import

1. 将当前 Bucket / IAM 配置完整建模，并生成物理资源标识映射。拟导入的类型是 `AWS::S3::Bucket`、`AWS::IAM::User` 和 `AWS::IAM::UserPolicy`。
2. Bucket 名称、Region、版本控制、加密、公开访问保护、所有权、同步用户和现有权限先保持当前值。首次导入不夹带配置优化。
3. 对 Bucket 和同步身份设置保留策略，Bucket 不启用自动删除对象；数据栈拟开启终止保护。保留策略降低误删除风险，但不能代替权限和变更审阅。
4. 单独展示 import 资源清单、模板、映射与 IMPORT ChangeSet；确认后才执行。普通 `cdk deploy` 不用于首次创建同名 Bucket。
5. 导入完成后检查 drift，并检查同步权限和 Bucket 配置。验证期间不让代理上传、修改或删除笔记 / 电子书。
6. 后续版本控制、生命周期、备份或权限调整各自生成独立 diff，再批准更新。

`Bucket.fromBucketName` / `fromBucketArn` 只是引用，不能代替资源纳管。真正纳管需要 CloudFormation import。AWS 提醒 import 不验证所有属性是否完整、正确，因此必须准确建模并在之后检查 drift。

现有 Access Key 不复制进代码、模板或日志，导入时不轮换或重新生成。IAM 身份与策略纳入 IaC，凭据继续由用户管理。Cognito 基础设施由 IaC 管理，真实登录用户仍按已确认分工由用户创建并维护密码 / MFA。

## CI 与执行边界

仓库重命名后，GitHub OIDC subject 前缀已核实为 `repo:yepengfan@7143356/obsidian-workflow-infra@1455021757`。仓库 ID 保持不变，两个 environment 的 main-only 限制也保留。

当前私有仓库的 Required reviewers 配置被 GitHub 以套餐不支持拒绝。现有自动衔接部署工作流保持禁用。建议调整为 Plan 和 Deploy 两个手动入口：先审阅 diff，再明确指定 plan run / commit，部署同一份 assembly。此调整尚未实施；首次 import 也须单独审阅，不能被普通部署流程隐式触发。

下一步先完成数据栈代码、导入映射、文档和本地验证，再展示具体云端变更。不修改现有笔记、不自动合并 PR、不将本方案视为 AWS 写入授权。

依据：[CDK import](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-import.html)、[CloudFormation 支持的资源类型](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html)、[GitHub 环境保护限制](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。
