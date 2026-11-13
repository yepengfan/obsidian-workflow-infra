# Selected-note MCP rollout

The approved design lets the caller browse a structured catalog and select notes
before retrieval. See [tools and retrieval](mcp-server.md#tools-and-retrieval) for
the authoritative tool scope, paging and no-scan contract.

## Review and deployment order

1. Review the permission-foundation PR and follow the
   [foundation and export procedure](github-actions.md#one-time-foundation-and-github-environment-setup)
   for resource identities, configuration ownership and prerequisite deployment order.
   That foundation stage creates no Lambda, API, OAuth client, code bucket or note endpoint.
2. Review the code-storage PR and its native CI plan. Create the separate private
   code-artifact bucket before uploading any Lambda ZIP. Keep existing bucket
   identities and protections; never copy notes into deployment storage.
3. Review the runtime/CI PR. Plan builds the ZIP and records its digest. Production
   approval precedes the conditional immutable upload and execution of exact
   reviewed change sets. Existing workflow names, OIDC subjects and the single
   business-resource approval remain unchanged. The owner creates the Cognito
   account in Console and configures its allowlist before enabling note access.

The expected three implementation PRs can be reviewed in dependency order.
If the owner identifier or exact ChatGPT callback is unavailable before the
runtime PR, keep access denied and make the final configuration change in a
reviewed follow-up. Never use a placeholder owner or an overly broad callback.
Implementation-plan approval does not authorize an AWS Apply.

## Permission scope

- The Lambda runtime trusts only the Lambda service. It can list the configured
  Vault prefix with delimiter `/` and at most 100 entries per request, read
  objects under that prefix, and write its own log streams. It cannot access
  the ebook/code bucket, write notes, delete versions or change infrastructure.
  S3 IAM does not express caller-selected note batches; the handler must enforce
  that additional boundary, supported formats, cursor validity and total budgets.
- The application CloudFormation role can pass only that named runtime role
  to Lambda. Function management is restricted to the IaC-defined function, logs to
  its named group, and code reads/bucket configuration to the separate code
  bucket. It cannot edit IAM policies or read private note bodies.
- Cognito configuration imports the exact ARN of the deployed, tagged user pool. Bootstrap
  pool creation and the unowned-pool initial tagging grant are removed. Client,
  resource-server and managed-login-branding configuration is allowed only there;
  user/password administration is not granted. Pool operations require the
  matching `Project` resource tag; tag removal is not granted. Explicit denies
  prevent changing that tag or claiming a pool owned by another project.
  Tagging the pinned, already-owned pool remains allowed under those guards.
- HTTP API creation requires the configured API name and `Project=obsidian-mcp`.
  Management is limited to project-tagged API resources in the configured Region.
  API IDs are AWS-generated, so the initial API ARN pattern contains a wildcard;
  it is not account-wide administrator access. The role cannot attach ownership
  to an unowned API or remove/change its ownership tag. Verify native handler/tag
  behavior during the approved rollout and pin the physical API ID in a later
  permission reduction if needed. Do not remove tag conditions to fix a failure.
- The production Deploy role can upload only `releases/*` in the code bucket,
  using AES256 and `If-None-Match: *`. Its code-read permission supports checksum
  verification and safe retries. Plan has no upload or note-body permission.
  Deploy can also read `CodeSha256`, `State` and `LastUpdateStatus` through
  `lambda:GetFunctionConfiguration` on only the configured function to verify
  deployed code after Apply. Neither CI role receives `lambda:GetFunction`
  code-download URLs, and Plan has no Lambda configuration-read permission.
  Neither CI role can update the IAM foundation or assume another role.
- Metadata APIs without resource-level authorization retain explicit exceptions:
  CloudFormation summary/status reads and regional Cognito-domain/log-group
  discovery. No wildcard action or managed administrator policy is introduced.

The existing storage execution role still manages only the two original note
buckets. The lifecycle grant's indirect deletion capability is unchanged; see
[its reviewed scope](github-actions.md#permission-scope-and-future-changes).
The new code bucket has no note-object deletion or replication permission.

## Verification and remaining live checks

Run `npm ci`, `npm run check` and `npm run synth`. Tests inspect the synthesized
IAM contracts, role separation, prefix/listing conditions, code-upload conditions
and the native exported identity binding. They do not prove live AWS handler permissions or an OAuth
exchange. No AWS changes or private note-body reads are needed for these checks.

After separately approved deployment, verify native resource creation, Cognito
code + S256 PKCE, the exact resource audience and refresh behavior, owner-only
access, and a real ChatGPT catalog/select/read session. Benchmark selected-note
batches, not whole-vault scans. Never create canary files in the private vault;
use representative local fixtures for negative and oversized-note tests.

Sources: [API Gateway V2 authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigatewayv2.html),
[S3 listing conditions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html),
[conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[Cognito rollout](cognito-preflight.md).

## Code-storage stage

`infra/code-artifacts.ts` models the one new code bucket and its HTTPS-only deny
policy inside the existing `ObsidianMcp` stack. Its name comes from the shared
`mcpResources` contract in `infra/mcp-resources.ts`. All public access is blocked; ownership is
bucket-enforced, default encryption is AES256 with SSE-C blocked, and versioning
is enabled. Both resources are retained on deletion/replacement. There is no
auto-empty behavior, lifecycle expiry, object deletion or note replication.

The code-storage prerequisite adds only `CodeArtifacts` and
`CodeArtifactsPolicy`, preserving the original identity and storage resources.
It uploads no ZIP. The runtime extends this stack afterward; the current
[Plan](github-actions.md#one-infrastructure-plan) and
[Apply guards](github-actions.md#one-approval-and-infrastructure-apply) require
already-deployed code storage and bind the runtime to the exact reviewed native
template. Follow the
[foundation and export procedure](github-actions.md#one-time-foundation-and-github-environment-setup)
for prerequisite ordering, then review the code-storage CI plan and approve
production to create that bucket before runtime delivery.
Offline synthesis and fake-AWS CLI checks do not establish native bucket/policy
creation, CloudFormation handler permissions or S3 security enforcement. Verify
those during the separately approved rollout after the IAM prerequisite is
applied; validation must not modify either original note bucket or its files.

If a rollout partially fails, inspect native stack events and retained resources
before retrying. A retained bucket from a failed rollback may need an explicit
reviewed recovery/import; never delete it or bypass the native binding guards.
Code versions remain retained initially. Revisit code-only retention if measured
build growth justifies it, through a reviewed change, without touching notes.
