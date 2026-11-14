# Selected-note MCP rollout

The approved design lets the caller browse a structured catalog and select notes
before retrieval. See [tools and retrieval](mcp-server.md#tools-and-retrieval) for
the authoritative tool scope, paging and no-scan contract.

## Review and deployment order

`config/mcp-deployment.json` selects the stage in reviewed source. A merge is not
a deployment. Each stage uses the same `validate` and `plan and apply` workflows,
one synthesis, one combined native Plan and one production approval. The stage
is retained in the template and manifest; Apply rejects a mismatch.

1. Set `stage` to `identity`. CI updates only the existing pool/domain template
   to publish its pool ARN export and binding metadata. Review and approve that
   CI Apply first. No runtime ZIP, code bucket or OAuth client is created.
2. Follow the [foundation procedure](github-actions.md#one-time-foundation-and-github-environment-setup)
   to prepare the IAM UPDATE via local SSO, review its actual change set and
   obtain approval before execution. CI cannot apply this foundation or expand
   its own permissions. The native pool export must already exist.
3. Open a Bot PR setting `stage` to `code-storage`. After review/merge, approve
   the CI plan creating the separate private code bucket and its HTTPS-only
   policy. No ZIP is built or uploaded. Wait for Apply to complete.
4. Open a Bot PR setting `stage` to `runtime`. Plan builds the ZIP and records
   its digest; it still refuses delivery until modeled code storage is deployed.
   Production approval precedes conditional immutable upload and execution of
   exact reviewed change sets. Configure the owner and callback as below.

The stage has no environment-variable or GitHub-variable override. Invalid
configuration fails synthesis. Stage rollback cannot omit live resources: the
native identity/binding guards and no-removal/no-replacement guards still apply.
Do not advance the stage while an earlier Apply is awaiting approval. New merges
make older plans stale; rerunning an old revision cannot deploy it. If only the
latest revision's CI needs retrying, rerun its `validate` workflow to generate a
new Plan rather than approving an older source-bound plan.

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
  Stage creation has one separate tag-on-create grant on regional
  `/apis/*/stages` collections, requiring the matching `Project` request tag.
  It cannot tag the API itself, change an existing named stage, or replace the
  normal project-guarded `POST` permission required to create a stage.
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
auto-empty behavior or note replication. See the [resource retention guide](artifact-retention.md)
for proposed multipart cleanup and deployment-aware code cleanup, including their
separate activation approvals.

The `code-storage` stage adds only `CodeArtifacts` and
`CodeArtifactsPolicy`, preserving the original identity and storage resources.
It uploads no ZIP. The runtime extends this stack afterward; the current
[Plan](github-actions.md#one-infrastructure-plan) and
[Apply guards](github-actions.md#one-approval-and-infrastructure-apply) require
already-deployed code storage and bind the runtime to the exact reviewed native
template. Follow the [deployment order](#review-and-deployment-order)
before advancing to runtime delivery.
Offline synthesis and fake-AWS CLI checks do not establish native bucket/policy
creation, CloudFormation handler permissions or S3 security enforcement. Verify
those during the separately approved rollout after the IAM prerequisite is
applied; validation must not modify either original note bucket or its files.

If a rollout partially fails, inspect native stack events and retained resources
before retrying. A retained bucket from a failed rollback may need an explicit
reviewed recovery/import; never delete it or bypass the native binding guards.
Follow the [retention activation order](artifact-retention.md#permissions-and-activation-order)
before enabling code cleanup.

## Runtime stage

The configured stage is `runtime`. The identity and private code bucket are
deployed. Before another runtime Plan or Apply, follow the
[first-Apply recovery procedure](#recovering-the-first-runtime-apply) for the
outstanding IAM prerequisite and retained resources.

The full runtime template models the Lambda function, API Gateway HTTP
API/integration/routes/stage, invoke permission, 14-day log group, Cognito read
resource server, confidential ChatGPT client and managed-login branding. The
application template preserves the existing pool/domain and code bucket; the
separate foundation owns IAM. Existing note buckets remain unchanged. Reject
resource removals, replacements, unexpected IAM changes or a new note bucket.

The deployment builds a source-bound, deterministic ZIP and conditionally uploads
it to the existing private code bucket only after approval. Publication tags
protect the deployed and immediate rollback code from retention cleanup. Inspect
actual stack events and retained resources before retrying a partial failure.

The owner list and callback list remain empty. The endpoint exposes public OAuth
resource metadata and returns 401 to anonymous MCP requests; note access remains
denied even for otherwise valid tokens while the owner list is empty. OAuth
authorization-code login remains disabled until a reviewed follow-up supplies
ChatGPT's exact callback. Do not add placeholder identities or callbacks to make
bootstrap verification pass.

After approved Apply, check the deployed code checksum, public resource metadata,
anonymous 401 challenge and 14-day log retention. Those checks do not access notes
or establish a completed ChatGPT OAuth exchange. Complete the
[owner setup and connection checks](mcp-server.md#owner-setup-and-chatgpt-connection)
in the follow-up configuration. Keep passwords, MFA secrets and the app-client
secret out of Git, logs and chat.

## Recovering the first runtime Apply

The first runtime Apply failed at `McpStage`: API Gateway rejected
`apigateway:TagResource` on the stage collection. The regional CloudFormation
`AWS::ApiGatewayV2::Stage` schema lists that literal action for its create
handler. IAM Access Analyzer instead reports `INVALID_ACTION`, and the public
authorization reference maps tagging to HTTP verbs. Treat this discrepancy as
an explicit compatibility exception, not a clean Analyzer pass. The scoped
grant in `infra/mcp-permissions.ts` follows the native schema and observed
denial; its request-tag conditions still need validation during an approved
live retry. Do not add administrator access or wildcard actions as a workaround.
The IAM custom-policy simulator also rejected the proposed literal action as
invalid policy content, so it supplies no authorization evidence for this grant.

Inspect the current registry with `aws cloudformation describe-type --type
RESOURCE --type-name AWS::ApiGatewayV2::Stage --query Schema --output text` in
the deployment Region. Recheck this discrepancy when AWS changes the provider.

The stack rolled back to `UPDATE_ROLLBACK_COMPLETE`, retaining the eleven
successfully created runtime resources outside stack management. The failed
stage was not present in the subsequent `get-stages` inventory. The original
pool/domain and code bucket/policy remain managed. A plain CI rerun is unsafe:
the named function/log group and Cognito resource server already exist, and
artifact publication correctly refuses a function absent from the native
stack's template. Do not weaken that guard or delete the retained resources.

Use a one-off native CloudFormation recovery, with separate reviewed plans:

1. Merge the permission correction, then prepare the local-SSO IAM-only UPDATE.
   Review its concrete diff/change set and obtain approval before execution.
2. Read the latest stack events and service inventories. Match all retained
   resources to their logical IDs, original stack, properties and code digest.
   Read Cognito identifiers only; do not export an app-client secret. Leave the
   existing user pool, users, notes, code objects and retention rules untouched.
3. Prepare an unexecuted `IMPORT` change set for the eleven existing runtime
   resources. Start with the exact approved runtime template, omit only the
   nonexistent `McpStage`, and preserve the currently deployed resources,
   outputs and metadata. Use native `get-template-summary` identifiers, not
   CDK's mapping format. These resource types support
   [native import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html).
   Review that the change set contains only those imports. Stop for any
   unsupported import, unexpected existing-resource change or property mismatch;
   do not substitute automatic cleanup. Execution requires approval.
4. After approved import reaches `IMPORT_COMPLETE`, verify physical IDs and
   the deployed checksum. Rerun current-main `validate` to generate a fresh CI
   Plan. The expected remaining addition is `McpStage`; review the entire plan
   and approve Apply separately. Do not rerun the old failed Apply job.
5. Verify public metadata, anonymous MCP rejection, stage throttles and 14-day
   log-event retention. The empty owner/callback lists must still deny note
   access and disable OAuth login. Real owner login remains a later check.

Source validation and IAM simulation do not prove that the service honors an
undocumented action or that import/retry succeeds. Keep those limits visible
until the separately approved operations have completed. This recovery uses
native AWS commands, not a new deployment workflow or control plane.
