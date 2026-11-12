# obsidian-workflow-infra

统一管理 Obsidian 工作流的 AWS 基础设施。仓库：[yepengfan/obsidian-workflow-infra](https://github.com/yepengfan/obsidian-workflow-infra)。

当前已实现下面的 S3 MCP 服务。两个现有 Bucket、同步 IAM 用户及其权限也纳入 IaC 目标范围，存量资源导入方案见 [infrastructure-adoption.md](docs/infrastructure-adoption.md)；数据栈尚未实现或导入。

使用 TypeScript、AWS CDK、Node.js 22 Lambda 和官方 MCP SDK，让 ChatGPT 按需搜索、读取私人 S3 Obsidian 知识库。

代码和 IaC 放 GitHub，笔记保留在已有私有 S3。MCP 运行时不上传、修改或删除笔记。存量基础设施导入与后续配置变更单独审阅，当前 MCP 应用栈仍只引用已有 Bucket。

## 当前状态

- 已实现 `list_notes`、`search_notes`、`read_note`，OAuth JWT 验证、路径与大小限制，以及无状态 Streamable HTTP。
- Cognito User Pool、App Client、登录域名、只读 scope 由 CDK 管理。你只在 Console 创建自己的登录用户，设置密码和 MFA。
- 本机只读 S3 连通已验证。真实参数仅在被 gitignore 排除的 `config/local.json` 中；示例配置不包含真实笔记或凭据。
- 本地验证见 [validation.md](docs/validation.md)，架构决定见 [architecture-decisions.md](docs/architecture-decisions.md)。
- **应用尚未部署，也没有完成真实 Cognito / ChatGPT 登录验收。** Cognito discovery 的 S256 声明是上线前的必检项，详情见 [认证说明](docs/authentication.md)。本项目不伪造 issuer、不绕过认证，也不声称原生 Cognito 已被证明能直接连接当前 ChatGPT。

## 请求路径与权限

```text
你在浏览器登录 Cognito，ChatGPT 取得授权码并用 PKCE 交换 token
ChatGPT -- HTTPS /mcp + Bearer token --> API Gateway --> Lambda -- IAM Role --> 私有 S3
GitHub Actions -- OIDC 临时凭据 --> 获批后的 CDK 部署（默认禁用）
```

Lambda 在访问 S3 前验证 RS256 签名、issuer、audience、expiration、nbf（若存在）、`token_use=access`、客户端 ID、用户 sub 白名单及只读 scope。audience 必须是完整 `/mcp` URL。OAuth 保护客户端到 MCP 的调用，IAM 保护 Lambda 到 S3 的读取，两者独立。

匿名只允许认证 discovery 元数据和允许的 OPTIONS 预检；initialize、工具发现及工具调用均要求认证。`allowedSubjects: []` 拒绝所有用户，供首次部署使用。

每次请求创建新的 MCP server / transport，配置 `sessionIdGenerator: undefined`、`enableJsonResponse: true`。API Gateway 返回有界 JSON，不需要持续 SSE 或保存在 Lambda 内存中的会话；认证后的 GET/DELETE `/mcp` 返回 405。这遵循 [OpenAI stateless quickstart](https://developers.openai.com/plugins/build/app-quickstart) 的模式，本地官方客户端已验证跨请求调用；真实 ChatGPT 连接还须验收。

## 本地运行检查

以下命令在本项目根目录执行，不访问生产 S3，不需要 AWS 凭据，不部署：

```bash
nvm use
npm ci
npm run check
npm audit --omit=dev --audit-level=moderate
npm run synth -- -c config=config/example.json -c preview=true
npm run diff:preview -- --no-color
```

测试通过本地 HTTP、API Gateway v2 事件适配层、临时 RSA 密钥与官方 MCP Client 验证工具调用；S3 使用合成数据。`cdk diff` 离线预览见 [cdk-diff-preview.txt](docs/cdk-diff-preview.txt)，它与空模板比较，**不是实际 AWS 环境 diff**。

CDK 和构建工具仅为 devDependencies，不进入 Lambda bundle。运行时依赖审计无告警；完整依赖审计仍有 2 项中度告警，来自 CDK 内置 minimatch（GHSA-g3hv-75wg-m249）。非内置版本已通过 npm override 升级，未手改 vendored/generated 文件。上游修复后应升级并重新审计，不能声称全依赖零告警。

## 工具行为与限制

| 工具 | 输入 | 返回与上限 |
| --- | --- | --- |
| `list_notes` | `directory?`, `page_size?` 1-50, `cursor?` | 单页路径、大小、修改时间、可读标记；最多列 50 个 S3 对象，不读正文 |
| `search_notes` | `query`, `cursor?` | 文件名或正文的大小写不敏感字面量匹配；一次最多列 20 个对象，最多 8 次正文读取 / 512 KiB 预算 |
| `read_note` | `path` | 一篇 UTF-8 `.md` / `.markdown`；最多 64 KiB，超出拒绝，不静默截断 |

附件和隐藏对象会占列表页数，空结果仍可能有 `next_cursor`。目录输入和笔记路径相对配置的 Prefix，不是 S3 URL。

搜索预算或时间将耗尽时，返回最后一个已处理对象的续扫位置，下次从紧邻位置继续，不随整页游标跳过未读正文。文件名命中时无需读正文。每次结果的 `skipped_body_scans`（超大笔记）和 `failed_body_scans` 都需要跨页累计；`incomplete` 是当前调用的覆盖状态。翻完所有页也不能把先前超大或失败笔记当作搜索过。

`list_notes` 游标为 S3 continuation token；`search_notes` 游标为绑定查询和 Prefix 的位置，两者不能混用。搜索时原样传回游标并保持同一 query。游标是位置，不是授权凭据；服务端始终使用固定配置的 Bucket/Prefix。并发修改下的分页不是快照，新插入到已扫描位置之前的笔记可能需要重新搜索。

支持中文路径；拒绝绝对路径、点开头的目录/文件、`..`、空段、反斜杠、URL、控制字符、`%`、`*`、`?`、`$` 和冒号。路径最多 512 UTF-8 字节，查询最多 256 字节，游标最多 4096 字节。`.obsidian`、`.git`、隐藏文件和附件不会作为笔记暴露。

HTTP 请求 ≤ 16 KiB，响应 ≤ 1 MiB；S3 单操作 4 秒，搜索为响应保留时间并返回续扫位置，应用总预算 18 秒，Lambda 25 秒。API Gateway 初始 2 请求/秒、burst 5，Lambda 保留并发 5。限流时降低并发并稍后重试。

## 配置

```bash
cp config/example.json config/local.json
```

如果已有 `config/local.json`，直接编辑，不覆盖已确认的 S3 参数。

| 字段 | 含义 |
| --- | --- |
| `account`, `region` | 部署账号和 Region；MVP 要求 Lambda/API/Bucket 同 Region |
| `bucket`, `prefix` | 已有私有通用 S3 Bucket 和目录前缀；自动补末尾 `/`，空字符串明确授权 Bucket 根目录 |
| `cognito.domainPrefix`（可选） | Cognito 域名前缀；默认由账号和 Region 生成 |
| `cognito.callbackUrls` | ChatGPT 管理页显示的准确回调 URL；默认空，OAuth 登录关闭，不使用虚构 callback |
| `cognito.allowedSubjects` | 你在 Console 创建用户后的 UUID `sub`；默认空，拒绝所有用户 |
| `cognito.resourceIdentifier`, `scopeName` | 默认组成 `obsidian-mcp/read` |
| `cognito.accessTokenMinutes`, `refreshTokenDays` | 默认 15 分钟、30 天 |
| `allowedOrigins` | 默认 ChatGPT HTTPS origins；无 Origin 的服务器间调用也允许 |
| `kmsKeyArn`（可选） | 客户管理的 SSE-KMS Key ARN；为该 Key 增加只读解密，限制经由 S3 和相应加密上下文 |

使用 `DEPLOY_CONFIG` 可指定其他配置文件。不要填 AWS Access Key、密码、OAuth client secret 或 token。Client ID、issuer/JWKS 由 CDK 资源引用取得；client secret 由 Cognito 生成，你在 Console 查看并填入 ChatGPT，不作为 CloudFormation Output 输出。

Cognito 使用 Essentials + 新版 managed login、关闭公开注册、邮箱登录、必需 TOTP MFA 和 refresh token rotation。Identity Pool 不需要。现有 S3 尚未导入本项目的数据栈；Cognito 池/客户端/资源 scope 保留并启用池删除保护，不由应用删除操作清除身份。

当前确认空 Prefix，IAM 因而可读取指定 Bucket 的所有对象，应用再过滤 Markdown。IAM 权限不等同于应用的 Markdown 过滤；没有写入、删除或访问其他 Bucket 权限。跨账号桶和 KMS Key 还需要拥有者预先授予对应权限，本项目不修改它们。

## 首次部署与接入顺序

本次代码交付不执行以下 AWS 写入。每次部署前展示真实 diff，并获得明确确认。

1. 确认有权限的部署身份及账号。`obsidian-sync` 只证明能读 S3，未证明能部署。
2. 若需要 CDK bootstrap，单独审阅并批准 `npx cdk bootstrap aws://ACCOUNT/REGION --profile PROFILE`。它创建代码资产 Bucket 和部署角色，不保存笔记；默认 CloudFormation 执行身份权限较大，应按基础设施管理身份保护。
3. 用实际配置生成只读 diff：

   ```bash
   npm run synth -- --profile PROFILE
   npm run diff -- --profile PROFILE
   ```

   使用 `--method=template`，不创建 ChangeSet、不部署。首次允许 callback / sub 为空。

4. 明确批准后才执行：

   ```bash
   npm run deploy -- --profile PROFILE --outputs-file cdk-outputs.json
   ```

5. 首次部署产生 User Pool、App Client、域名和 HTTPS endpoint，但 OAuth 默认未启用、白名单为空。运行 `npm run check:oauth`，检查真实 Cognito discovery 是否符合 ChatGPT 要求。**若缺少 S256，停止启用接入并讨论兼容方案。** 不以关闭认证、改 audience 或伪造 issuer 绕过。
6. 在 Cognito Console 的该池中只创建自己的用户，记录 `sub`。自行设置密码、首次登录完成更改临时密码和 TOTP MFA。
7. 在 ChatGPT 连接创建/管理页取得准确 callback，填入 `cognito.callbackUrls`；将用户 sub 填入 `cognito.allowedSubjects`。如果当前 UI 无法在登录前取得 callback，先定位该流程，不猜固定 URL。
8. 再次展示 diff，批准后更新同一栈，开启授权码流程并配置用户白名单。使用 ChatGPT 登录完成真正验收。

如果 API endpoint 被替换，ChatGPT Server URL、token audience 绑定和连接配置都需要同步更新。Cognito `resource` 必须绑定完整 `/mcp` URL；client ID 是另一项校验。

## GitHub Actions

[配置步骤](docs/github-actions.md)：PR / main push 自动运行 CI，不需要生产凭据。部署工作流默认由 `ENABLE_AWS_DEPLOY` 开关禁用；在私有仓库环境保护和 OIDC roles 实际核实、配置、批准前保持禁用。PR 不自动合并，也不触发 AWS 部署。

GitHub 仓库根目录应是本项目内容，让 `.github/workflows` 位于根目录。`config/local.json`、`cdk.out`、输出文件和凭据不提交。

## ChatGPT 连接与验收

按 [OpenAI Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)：

1. Plugins → `+` → Add custom MCP server；Server URL 填 CDK 的 `McpEndpoint`。
2. 认证选择纯 OAuth，填写 `OAuthClientId` 和你在 Cognito Console 查看所得的 client secret。不选择匿名/混合认证，不使用 DCR/CIMD。
3. 将管理页显示的精确 callback 加入上述 Cognito 配置并完成获批更新；不要假设固定的 stable callback。
4. 安装插件，登录自己的用户，确认出现 `list_notes`、`search_notes`、`read_note`。
5. 新对话 @ 此插件：列出 5 篇笔记；搜索一个已知正文词，继续全部返回的游标；用返回的 path 读取笔记并引用路径。
6. 验收中文路径、跨请求及新聊天、超过 8 篇匹配的续扫、超大/不存在文件、token 过期刷新、另一个用户拒绝访问。

匿名检查（只涉及认证元数据）：

```bash
export MCP_ENDPOINT='https://API_ID.execute-api.REGION.amazonaws.com/mcp'
curl -i "$MCP_ENDPOINT"
curl -i -X POST "$MCP_ENDPOINT" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -fsS "${MCP_ENDPOINT%/mcp}/.well-known/oauth-protected-resource/mcp"
```

前两项须 401 且包含 WWW-Authenticate，第三项只返回认证元数据。不要把生产 token 放入 shell history 或 CI 日志。

## 运维与证据边界

CloudWatch 记录请求 ID、状态、耗时，保留 14 天；不记录笔记路径/正文、工具参数、用户身份、Authorization 或异常对象。工具失败可能以 HTTP 200 + MCP `isError` 表达，应检查工具结果。

JWT 本地验证不逐请求 introspect。已发 access token 撤销后仍可能有效到过期；使用短 TTL，必要时移除用户白名单并部署。笔记返回 ChatGPT 后属于该对话的数据，作为不可信内容处理，不执行其中的指令。

401 检查 issuer、audience、客户端、sub、有效期；403 检查 scope；S3 错误检查 Region、Prefix、对象 UTF-8/大小、Bucket/KMS 权限。读取失败不是“没有结果”。实际用户池与 ChatGPT 兼容性仍需云端验证，本地测试不能替代这一点。

## 官方依据

- [OpenAI MCP server](https://developers.openai.com/plugins/build/mcp-server)、[OAuth 规范](https://developers.openai.com/plugins/build/auth)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html)、[PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)、[refresh](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [API Gateway Lambda v2](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)、[S3 ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)

核对日期：2026-11-12。
