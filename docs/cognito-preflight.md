# Cognito compatibility prerequisite

The separate `obsidian-mcp-execution` service role is the IAM prerequisite for
the `ObsidianMcp` stack. Its Cognito user pool and AWS prefix domain
form a compatibility probe, not an enabled MCP application. The later
[code-storage stage](mcp-rollout.md#code-storage-stage) and
[authenticated runtime](mcp-server.md) extend that stack.
Reviewing or merging the resource PR does not approve its AWS change set. No users, app clients, registration endpoint, Lambda, API,
note access or credentials are part of this stage.

`infra/cognito-stack.ts` defines the resources. Account and Region come from
`config/storage.json`; pool name and AWS domain prefix are configured in
`config/cognito.json`.

## Deployment order

1. Start from the existing deployed identity probe. Follow the
   [foundation and export procedure](github-actions.md#one-time-foundation-and-github-environment-setup)
   and [resource deployment procedure](github-actions.md#automatic-deployment-run)
   for the required ordering, native approval and retained-identity guards.
2. Read the real issuer's discovery metadata. Require a matching issuer, HTTPS
   endpoints and `code_challenge_methods_supported` containing `S256`.
   Stop if the metadata fails; do not fake discovery, disable authentication or
   relax token audience checks to work around incompatibility.
3. Follow the [staged MCP rollout](mcp-rollout.md#review-and-deployment-order)
   for code storage and the authenticated application. The owner creates their
   Cognito user in the Console and handles passwords, MFA and ChatGPT's exact
   callback URI. Never put credentials or note content in Git, logs or chat.

The shared pipeline coordinates the existing native stacks without moving
resources or broadening IAM. It is not an atomic transaction across stacks;
inspect actual AWS state after partial failure. The protected pool disables
public signup, requires TOTP MFA, uses email sign-in and the Essentials
tier, and has a 14-character password policy. The prefix domain uses managed
login v2. Both resources have `DeletionPolicy` and `UpdateReplacePolicy` Retain.
Failed creation can leave retained resources or a failed stack: inspect native
AWS status before retrying. The deployment role cannot delete either resource;
do not delete or recreate retained identity resources as automatic recovery.

## Local checks and post-deployment discovery

```sh
npm ci
npm run check
npm run synth
actionlint
```

Tests execute the workflow's shell steps with controlled AWS/GitHub responses,
including no-change updates, stale source, unavailable plans, access errors,
missing approval protection, destructive plans and pool-ARN output mismatch. They
also synthesize the actual CDK entry point and exercise discovery validation.
These checks do not prove hosted OIDC, native reviewer routing, the Cognito
CloudFormation handler, live metadata or OAuth login. Those require the
separately approved resource deployment.

After successful Apply, the workflow reads the stack's non-secret outputs and
runs `npm run check:cognito -- infrastructure-apply/ObsidianMcp.stack.json`. It uses at most six attempts
with ten-second gaps for propagation when `ObsidianMcp` has changes, including
code-storage or metadata/output changes; otherwise it makes
one attempt. Each attempt tries standard OAuth
authorization-server metadata, falling back to OIDC discovery if needed, with
five-second timeouts per HTTP request, no redirects and a 64 KiB limit per response.
The fallback can make a second request within an attempt. It requires the expected
issuer/JWKS, exact AWS-domain authorize/token endpoints, authorization-code
support, `S256` and supported confidential-client authentication. It never
registers a client or requests tokens, and errors omit remote bodies.
When `McpEndpoint` is present, the same command also validates the public
protected-resource metadata against that endpoint and Cognito issuer, then
requires an anonymous MCP initialization request to return 401 with the expected
resource-metadata challenge. It never authenticates or requests a note. These
public checks do not establish an authenticated OAuth exchange.
When the entire infrastructure is unchanged, Plan runs this check once.

To repeat the check locally after an approved deployment:

```sh
aws cloudformation describe-stacks --stack-name ObsidianMcp \
  --profile obsidian-admin --region ap-southeast-2 > /tmp/obsidian-cognito-stack.json
npm run check:cognito -- /tmp/obsidian-cognito-stack.json
```

A red discovery check after successful CloudFormation execution means the
identity resources exist but compatibility is **not established**. It does not
roll back or remove the pool. Keep OAuth and private-note access disabled,
inspect the actual metadata, and review the next approach before changing auth.
Do not invent metadata, add a proxy/broker silently or weaken validation.

## Permission boundary

The authoritative [MCP permission scope](mcp-rollout.md#permission-scope)
includes the pinned Cognito pool and the reserved runtime/delivery grants.
For the current Plan/Apply guards, see the
[deployment workflow](github-actions.md#automatic-deployment-run). IAM prerequisites alone
do not create an application or expand the script checks.

The probe does not use SMS, custom sender encryption or custom domains. Prefix
domains must not be replaced with custom domains under this grant. Pools and
domains must be retained; the role cannot delete either resource. The AWS
registry's optional KMS and CloudFront handler permissions are not granted.

## Authentication checks after the probe

The [runtime connection guide](mcp-server.md#owner-setup-and-chatgpt-connection)
owns predefined-client setup and the required live authentication checks.
Discovery alone does not prove authorization-code/PKCE, token audience, refresh
or owner-only access.

References:
[OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth),
[Cognito issuer metadata](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html),
[Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html),
[Cognito IAM action and condition support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cognito-idp.html).
