# Cognito compatibility prerequisite

The separate `obsidian-mcp-execution` service role is the IAM prerequisite for
the `ObsidianMcp` stack. The resource definitions now contain only a Cognito
user pool and AWS prefix domain. These are a compatibility probe, not an
enabled MCP application. Reviewing or merging the resource PR does not approve
its AWS change set. No users, app clients, registration endpoint, Lambda, API,
note access or credentials are part of this stage.

## Deployment order

1. Review and merge this IAM-only PR. From the merged revision, use the existing
   [local SSO foundation UPDATE procedure](github-actions.md#permission-scope-and-future-changes).
   Inspect the exact change set and obtain user confirmation before executing it.
2. Review the resource PR extending the existing `plan and apply`
   workflow to the `ObsidianMcp` stack. It initially defines only a Cognito user pool
   and AWS prefix domain, with public signup disabled, required TOTP MFA,
   deletion protection and retained identity resources. No app client, user,
   note-reading Lambda, API endpoint or registration endpoint is enabled by
   this initial compatibility probe. The existing storage checks remain intact.
   After merge, inspect **plan-cognito** in the Actions run and approve
   **apply-cognito** through the native `production` environment only after
   reviewing its exact change-set ARN, source SHA, resource actions and template.
3. Read the real issuer's discovery metadata. Require a matching issuer, HTTPS
   endpoints and `code_challenge_methods_supported` containing `S256`.
   Stop if the metadata fails; do not fake discovery, disable authentication or
   relax token audience checks to work around incompatibility.
4. Add the actual pool ID as `mcpUserPoolId` in `config/github.json` through a
   reviewed IAM PR and local SSO update. This removes pool creation and initial
   tagging permission and pins subsequent pool operations to that ARN.
   Do this before enabling OAuth or private-note access.
5. Integrate the authenticated MCP application, with reviewed Lambda/API/asset
   IAM scope added separately. The owner creates their Cognito user in the
   Console and handles passwords, MFA and ChatGPT's exact callback URI. Never
   put credentials or note content in Git, logs or chat.

Applying only the IAM prerequisite does not deploy the pool. The resource
workflow starts after a successful `validate` push on main. `plan-cognito`
depends on the guarded storage Plan; it selects CREATE only for an exact
stack-not-found response or unexecuted `REVIEW_IN_PROGRESS` placeholder. Existing
stable stacks must contain the expected pool/domain logical IDs and resource
types, and match the pinned pool ID when one is configured. Other failures and
in-progress/failed stack states stop the workflow. A pinned pool with an absent
stack never defaults to creating a replacement.

No AWS Repository variables, static keys, standard CDK bootstrap or IAM update
capability are added. The existing fixed Plan/Deploy role configuration and
GitHub OIDC environments are reused. `apply-cognito` validates the native plan's
account, Region, stack, source binding, available status and resource actions.
CREATE must add exactly `UserPool` and `UserPoolDomain`; UPDATE allows only
modification of those resources, with no replacements or removals. It rechecks
live main immediately before execution, enables termination protection,
executes the same ARN without resynthesis, and waits for the correct operation.

The protected pool requires TOTP MFA, uses email sign-in and the Essentials
tier, and has a 14-character password policy. The prefix domain uses managed
login v2. Both resources have `DeletionPolicy` and `UpdateReplacePolicy` Retain.
Failed creation can leave retained resources or a failed stack: inspect native
AWS status before retrying. The deployment role cannot delete either resource;
do not delete or recreate retained identity resources as automatic recovery.

## Local checks and post-deployment discovery

```sh
npm ci
npm run check
npm run synth:cognito
actionlint
```

Tests execute the workflow's shell steps with controlled AWS/GitHub responses,
including no-change updates, stale source, unavailable plans, access errors,
missing approval protection, destructive plans and pinned-pool mismatch. They
also synthesize the actual CDK entry point and exercise discovery validation.
These checks do not prove hosted OIDC, native reviewer routing, the Cognito
CloudFormation handler, live metadata or OAuth login. Those require the
separately approved resource deployment.

After successful Apply, the workflow reads the stack's non-secret outputs and
runs `npm run check:cognito -- cognito-stack.json`. It uses at most six attempts
with ten-second gaps for propagation. Each attempt tries standard OAuth
authorization-server metadata and OIDC discovery, with five-second request
timeouts, no redirects and a 64 KiB response limit. It requires the expected
issuer/JWKS, exact AWS-domain authorize/token endpoints, authorization-code
support, `S256` and supported confidential-client authentication. It never
registers a client or requests tokens, and errors omit remote bodies.
Unchanged stack plans run this read-only discovery check too.

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

Plan and Deploy retain separate responsibilities. The added app statements are
limited to the `ObsidianMcp` stack and `obsidian-mcp-*` change sets. Plan can pass
only the dedicated role to CloudFormation and create unexecuted change sets
whose resource-type list is present and contains only `AWS::Cognito::UserPool`
and `AWS::Cognito::UserPoolDomain`. Deploy executes those reviewed change sets
after the existing native production approval. Ordinary CI cannot update IAM.
No administrator execution role or standard CDK bootstrap is introduced.

The new service role configures only pool settings and a prefix domain. It has
no user creation/password/token operations, app-client operations, S3 access,
IAM mutation/PassRole, KMS or CloudFront permissions. The AWS registry lists
optional permissions for SMS, custom sender encryption and custom domains;
those features are not authorized or part of this probe. Prefix domains must
not be replaced with custom domains under this grant. Pools and domains must be
retained; the role cannot delete either resource. Tag removal is not granted.

Cognito assigns pool IDs. Until the first pool ID is known, `CreateUserPool`
requires a wildcard resource, restricted to the configured Region and the
request tag `Project=obsidian-mcp`. Initial `TagResource` permission is limited
to pool ARNs in the configured account/Region and that requested project tag.
It can also label another unowned pool in that account/Region, so it is a bootstrap
capability, not proof of exclusive ownership. All pool configuration operations
require the matching resource tag. An explicit deny blocks changing the project
tag to a different value or claiming a pool tagged for another project.
Pinning the pool ID removes that initial tagging grant and pool creation;
tagging the pinned, already-owned pool remains allowed subject to the project-tag
denies. `DescribeUserPoolDomain` remains Region-scoped with a
wildcard resource because AWS does not support resource-level authorization for
that read-only operation. IAM validation cannot prove the actual deployment;
the resource PR must verify the real CloudFormation handler path.

## Authentication checks after the probe

OpenAI supports predefined OAuth clients, so this private MVP does not require
open dynamic client registration. A client ID/secret can be configured directly
in ChatGPT. Supporting PKCE is insufficient if discovery does not advertise it.
Later authorization-code/PKCE and refresh tests must verify the access token's
audience matches the MCP resource URL and that only the owner's subject and
read-only scope are accepted. Discovery checks alone do not prove these flows.

References:
[OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth),
[Cognito issuer metadata](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html),
[Cognito resource binding](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html),
[Cognito IAM action and condition support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cognito-idp.html).
