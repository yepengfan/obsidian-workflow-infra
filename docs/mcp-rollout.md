# Selected-note MCP rollout

The approved design exposes a structured, paginated folder/note catalog. The
caller chooses notes before retrieval. There is no full-vault scan, recursive
listing, folder-expanded body search, background index or automatic widening.
Body search takes an explicit bounded selection of note paths and reads them
in parallel. Filename search examines one bounded direct-child metadata page.
Selected notes can be read in chunks without editing S3 objects.

## Review and deployment order

1. Review the permission-foundation PR. `config/github.json` pins the existing
   Cognito pool and defines the reserved runtime, function, API and code-bucket
   names. `infra/mcp-permissions.ts` grants only the modeled capabilities.
   Synthesize the complete app and review the foundation template diff.
   Apply only a concrete, approved foundation change set through local SSO,
   following [the foundation procedure](github-actions.md). This PR does not
   create a Lambda, API, OAuth client, code bucket or note-reading endpoint.
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
  to Lambda. Function management is restricted to the named function, logs to
  its named group, and code reads/bucket configuration to the separate code
  bucket. It cannot edit IAM policies or read private note bodies.
- Cognito configuration is pinned to the deployed, tagged user pool. Bootstrap
  pool creation and the unowned-pool initial tagging grant are removed. Client,
  resource-server and managed-login-branding configuration is allowed only there;
  user/password administration is not granted.
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
and pinned identity. They do not prove live AWS handler permissions or an OAuth
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
