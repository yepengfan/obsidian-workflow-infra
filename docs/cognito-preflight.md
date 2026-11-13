# Cognito compatibility prerequisite

The existing storage foundation is deployed. The MCP application and Cognito
pool are not deployed. This permission-only change prepares a separate
`obsidian-mcp-execution` CloudFormation service role for an `ObsidianMcp` stack.
It creates no Cognito resources and changes no bucket settings or note objects.

## Deployment order

1. Review and merge this IAM-only PR. From the merged revision, use the existing
   [local SSO foundation UPDATE procedure](github-actions.md#permission-scope-and-future-changes).
   Inspect the exact change set and obtain user confirmation before executing it.
2. Prepare a separate resource PR that extends the existing `plan and apply`
   workflow to the `ObsidianMcp` stack. Initially deploy only a Cognito user pool
   and AWS prefix domain, with public signup disabled, required TOTP MFA,
   deletion protection and retained identity resources. No app client, user,
   note-reading Lambda, API endpoint or registration endpoint is enabled by
   this initial compatibility probe. Keep the existing storage checks intact.
3. Read the real issuer's discovery metadata. Require a matching issuer, HTTPS
   endpoints and `code_challenge_methods_supported` containing `S256`.
   Stop if the metadata fails; do not fake discovery, disable authentication or
   relax token audience checks to work around incompatibility.
4. Add the actual pool ID as `mcpUserPoolId` in `config/github.json` through a
   reviewed IAM PR and local SSO update. This removes bootstrap pool creation
   and tagging permission and pins subsequent pool operations to that ARN.
   Do this before enabling OAuth or private-note access.
5. Integrate the authenticated MCP application, with reviewed Lambda/API/asset
   IAM scope added separately. The owner creates their Cognito user in the
   Console and handles passwords, MFA and ChatGPT's exact callback URI. Never
   put credentials or note content in Git, logs or chat.

The app resource workflow is deliberately a subsequent PR: applying this
foundation does not make the current storage workflow deploy an app stack.

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
Pinning the pool ID removes that initial tagging
grant and pool creation. `DescribeUserPoolDomain` remains Region-scoped with a
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
