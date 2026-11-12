# Cognito 接入与兼容性验收

已选择 Cognito。User Pool、App Client、登录域名、resource server scope 由 CDK 管理；真实用户由你在 AWS Console 创建。应用不创建用户、不保存密码、不自行签发 OAuth token，也不需要 Identity Pool。

## 首次创建和安全默认值

`infra/cognito.ts` 创建 Essentials User Pool、新版 managed login 和默认 branding，关闭公开注册，邮箱登录、TOTP MFA 必需，密码最少 14 字符。客户端使用 Cognito 生成的 secret、短期 access token、30 天 refresh 和 refresh rotation。

初始 `callbackUrls: []` 时，App Client 的 OAuth 功能关闭；初始 `allowedSubjects: []` 时，即使存在有效 JWT，Lambda 也拒绝所有用户。没有虚构 callback、临时匿名端点或预设用户。Secret 不作为栈 Output，也不注入 Lambda。

第一次获批部署后，你进入 Cognito → User pools → 输出的池 ID → Users → Create user，只创建自己的账号。自行保管临时密码，首次登录完成密码更改与 TOTP 设置，提供非密钥的用户 `sub`。不要把密码、验证码、secret、授权码或 token 发到聊天或代码仓库。

## 先核对 discovery，再宣称可以连接

Cognito 支持授权码 + PKCE S256 与 `resource` audience 绑定。但 [OpenAI 当前要求](https://developers.openai.com/plugins/build/auth) 授权服务器 discovery 明确包含 `code_challenge_methods_supported: ["S256"]`。支持 PKCE 本身并不证明 discovery 满足要求。

当前尚无已部署池可检查，所以兼容性仍未得到真实验证。初次创建资源后执行：

```bash
npm run check:oauth
```

默认从 `cdk-outputs.json` 的 `ObsidianS3Mcp.OAuthIssuer` 获取 issuer。可设置 `CDK_OUTPUTS_FILE` 指向另一份输出，或仅用 `OAUTH_ISSUER` 指定已知的 Cognito issuer。此检查不获取 token、不需要用户密码。

检查：准确 issuer/JWKS、HTTPS authorization/token 端点、S256 声明、客户端 secret 的 token endpoint auth 方法。它不等同于完整授权码或 refresh 验收。

若实际 Cognito discovery 缺少 S256，检查会失败。保持登录未启用及白名单关闭，记录不含凭据的元数据缺口，再讨论兼容方案。当前代码没有实现发现元数据代理、token broker 或其他认证兼容层，不通过改写 issuer、放宽 audience 验证或匿名访问隐藏问题。这是本 PR 明确保留的上线验收风险。

## 连接字段和启用顺序

- **Issuer/JWKS**：Cognito 用户池的 `https://cognito-idp.REGION.amazonaws.com/POOL_ID` 及其 `/.well-known/jwks.json`。
- **登录域名**：Cognito 托管的 `https://PREFIX.auth.REGION.amazoncognito.com`，用于浏览器登录。它与 issuer 不同。
- **Client ID**：由 CDK 创建，填入 ChatGPT 并用于 token 的客户端校验。
- **Client secret**：在 Cognito Console 查看并直接填入 ChatGPT，服务端不需要。
- **只读 scope**：默认 `obsidian-mcp/read`；OpenID scopes 为 openid/email/profile/phone。Cognito discovery 可能声明 OIDC scopes，ChatGPT 会按其声明请求，因此 App Client 也允许这些 scopes；用户无需配置电话或 SMS 登录。
- **Audience**：完整 MCP `/mcp` URL，由 ChatGPT 的 `resource` 参数绑定到 access token `aud`。不是 Client ID，也不要求把自定义 scope identifier 当作 audience。
- **Callback**：从 ChatGPT 该连接的创建/管理页复制准确 URL，存入 `cognito.callbackUrls`，不猜 stable callback。
- **用户**：Console 创建后，将 UUID sub 存入 `cognito.allowedSubjects`。应用只接受该名单。

discovery 通过后，配置准确 callback 和用户 sub，再次展示真实 diff并获批更新栈。此时才启用 authorization-code grant，未启用 implicit / client credentials。Cognito 的授权码流程会签发 refresh token，因此资源元数据不请求 Auth0 风格的 offline_access。

## 必须执行的真实验收

1. OAuth discovery 预检通过，issuer 完全一致，metadata 声明 S256。
2. ChatGPT 发起授权码 + PKCE，Cognito 登录成功，回调 URL 匹配。
3. access token 的签名、iss、aud、exp、token_use、client_id、sub、scope 全部通过服务端校验。
4. 三个工具可用，新聊天和不同 Lambda 请求间正常调用。
5. access token 过期后刷新正常，`aud` 在 refresh 后仍绑定 MCP resource。
6. 未获准用户和匿名请求不能列工具或读取笔记；没有为了测试开放匿名访问。

JWT 通过本地公钥验证，不逐请求 introspect；撤销 refresh 不立即失效已发 access token。Cognito 池和身份资源保留且启用删除保护，删除应用栈不是注销身份的操作。

依据：[OpenAI authentication](https://developers.openai.com/plugins/build/auth)、[Cognito authorization](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)、[Cognito token](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)、[AWS managed login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html)。
