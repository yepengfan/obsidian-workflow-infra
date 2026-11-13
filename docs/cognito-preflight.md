# Cognito compatibility prerequisite

The separate `obsidian-mcp-execution` service role is the IAM prerequisite for
the `ObsidianMcp` stack. The resource definitions now contain only a Cognito
user pool and AWS prefix domain. These are a compatibility probe, not an
enabled MCP application. Reviewing or merging the resource PR does not approve
its AWS change set. No users, app clients, registration endpoint, Lambda, API,
note access or credentials are part of this stage.

`infra/cognito-stack.ts` defines the resources. Account and Region come from
`config/storage.json`; pool name and AWS domain prefix are configured in
`config/cognito.json`.

## Deployment order

1. Confirm the separate Cognito IAM prerequisite has been reviewed, merged and
   applied using the
   [local SSO foundation UPDATE procedure](github-actions.md#permission-scope-and-future-changes).
   That procedure requires inspection and user confirmation of the exact change
   set before execution. This resource PR does not change the IAM foundation.
2. Review the resource PR extending the existing `plan and apply`
   workflow to the `ObsidianMcp` stack. It initially defines only a Cognito user pool
   and AWS prefix domain, with public signup disabled, required TOTP MFA,
   deletion protection and retained identity resources. No app client, user,
   note-reading Lambda, API endpoint or registration endpoint is enabled by
   this initial compatibility probe. The existing storage checks remain intact.
   After merge, inspect the combined **Plan** in the Actions run and approve
   the single infrastructure **Apply** through the native `production` environment after
   reviewing all exact change-set ARNs, source SHA, resource actions and templates.
3. Read the real issuer's discovery metadata. Require a matching issuer, HTTPS
   endpoints and `code_challenge_methods_supported` containing `S256`.
   Stop if the metadata fails; do not fake discovery, disable authentication or
   relax token audience checks to work around incompatibility.
4. The pool remains defined by `infra/cognito-stack.ts`. Publish its native
   `ObsidianMcp:UserPoolArn` export through the approved resource workflow before
   applying the permission-foundation update via local SSO. IAM imports this ARN;
   no deployed pool ID is copied into GitHub configuration. See the
   [rollout order](mcp-rollout.md#review-and-deployment-order).
5. Follow the [staged MCP rollout](mcp-rollout.md#review-and-deployment-order)
   for code storage and the authenticated application. The owner creates their
   Cognito user in the Console and handles passwords, MFA and ChatGPT's exact
   callback URI. Never
   put credentials or note content in Git, logs or chat.

Applying only the IAM prerequisite does not deploy the pool. The resource
workflow starts after a successful `validate` push on main. The current resource
workflow requires the existing identity stack and never recreates it when absent.
Existing stable stacks must contain the expected pool/domain logical IDs and
resource types. Native plan and Apply guards reject replacement or removal;
CloudFormation export/import binding prevents changing the pool ARN while the
foundation imports it. Other failures and in-progress/failed states stop the
workflow. A future new-account bootstrap requires a separately reviewed IAM path.

See the [infrastructure deployment procedure](github-actions.md#automatic-deployment-run)
for the shared Plan/Apply identity, source and resource-action guards, native
approval, exact-ARN execution and completion checks.

The shared pipeline coordinates the existing native stacks without moving
resources or broadening IAM. It is not an atomic transaction across stacks;
inspect actual AWS state after partial failure. The protected pool requires
TOTP MFA, uses email sign-in and the Essentials
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
missing approval protection, destructive plans and pinned-pool mismatch. They
also synthesize the actual CDK entry point and exercise discovery validation.
These checks do not prove hosted OIDC, native reviewer routing, the Cognito
CloudFormation handler, live metadata or OAuth login. Those require the
separately approved resource deployment.

After successful Apply, the workflow reads the stack's non-secret outputs and
runs `npm run check:cognito -- infrastructure-apply/ObsidianMcp.stack.json`. It uses at most six attempts
with ten-second gaps for propagation when Cognito changed; otherwise it makes
one attempt. Each attempt tries standard OAuth
authorization-server metadata, falling back to OIDC discovery if needed, with
five-second timeouts per HTTP request, no redirects and a 64 KiB limit per response.
The fallback can make a second request within an attempt. It requires the expected
issuer/JWKS, exact AWS-domain authorize/token endpoints, authorization-code
support, `S256` and supported confidential-client authentication. It never
registers a client or requests tokens, and errors omit remote bodies.
When the entire infrastructure is unchanged, Plan runs discovery once.

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
The deployed probe's resource definitions and the current Plan/Apply resource
checks remain limited to the pool and prefix domain. IAM prerequisites do not
create an application or change those checks.

The probe does not use SMS, custom sender encryption or custom domains. Prefix
domains must not be replaced with custom domains under this grant. Pools and
domains must be retained; the role cannot delete either resource. The AWS
registry's optional KMS and CloudFront handler permissions are not granted.

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
