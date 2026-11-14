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

If the exact ChatGPT callback is unavailable before the runtime PR, leave OAuth
disabled and make the final configuration change in a reviewed follow-up. Group
membership is managed in Cognito after successful Apply, not through IaC. Never
use a placeholder user identifier or an overly broad callback.
Implementation-plan approval does not authorize an AWS Apply.

## Permission scope

- The Lambda runtime trusts only the Lambda service. It can list the configured
  Vault prefix with delimiter `/` and at most 100 entries per request, read
  objects under that prefix, and write its own log streams. It cannot access
  the ebook/code bucket, write notes, delete versions or change infrastructure.
  S3 IAM does not express caller-selected note batches; the handler must enforce
  that additional boundary, supported formats, cursor validity and total budgets.
- The application CloudFormation role can pass only that named runtime role
  to Lambda. Function management is restricted to the IaC-defined function,
  log-group operations follow the metadata exceptions below, and code reads/bucket
  configuration are restricted to the separate code bucket. It cannot edit IAM
  policies or read private note bodies.
  Native rollback can delete only the configured function and its named log
  group. The CI roles cannot delete either resource directly. Existing Cognito
  and API management scope covers rollback of their runtime child resources.
- Cognito configuration imports the exact ARN of the deployed, tagged user pool. Bootstrap
  pool creation and the unowned-pool initial tagging grant are removed. Client,
  resource-server, group and managed-login-branding configuration is allowed only
  there; user/password administration and adding/removing group members are not
  granted. Group CRUD covers all groups within this one pool because Cognito
  authorizes these actions on the user-pool ARN, not individual group ARNs.
  No group `RoleArn` is configured and no new `iam:PassRole` or
  `iam:PutRolePolicy` permission is granted. Native handler behavior remains an
  approved deployment check. Pool operations require the
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
  The native log-group read handler also needs `logs:DescribeIndexPolicies` and
  `logs:DescribeResourcePolicies`. Like `DescribeLogGroups`, AWS requires
  `Resource: "*"` for these metadata APIs; `aws:RequestedRegion` limits them to
  the configured Region. They may expose other log groups' policy metadata in
  that Region, but grant no log-event reads or policy writes. The companion
  `logs:GetDataProtectionPolicy` read is restricted to the named MCP log group.
  These grants belong only to the application CloudFormation role. See the
  [CloudWatch Logs authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_logs.html).

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

The configured stage is `runtime`; the private runtime, identity and code bucket
are already deployed. The [first-Apply recovery procedure](#recovering-the-first-runtime-apply)
records the earlier failed rollout; inspect current native stack state before
using any recovery steps.

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

The pool/domain and code bucket/policy retain their existing protection. The
twelve reconstructible runtime resources use `Delete` for deletion and
replacement, so newly created runtime resources can be removed by native failure
rollback. This includes the log group: its events expire after 14 days during
normal operation; deleting the group during rollback or stack removal deletes
its remaining events. Current notes/books and user-pool accounts are unaffected
by the runtime deletion policy. See
[CloudFormation deletion policies](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html).

The owners-group name and exact ChatGPT callback are configured in
[`config/mcp-runtime.json`](../config/mcp-runtime.json); no individual user
identifiers or memberships belong in that configuration. The reviewed local-SSO
IAM prerequisite adds only `CreateGroup`, `GetGroup`, `UpdateGroup`, and
`DeleteGroup` on the pinned tagged pool to the application CloudFormation role,
plus the group resource type to Plan's existing change-set allowlist. CI cannot
manage users or group membership, and Lambda needs no additional IAM.

Apply that separately approved IAM foundation before merging/starting the ordinary
CI Plan for this change. The application plan adds one `OwnersGroup` and updates
the existing `ChatGptClient` OAuth settings and `McpFunction` environment/code.
There are no storage changes or resource replacements. The group uses
`RetainExceptOnCreate` with replacement retention: a failed first creation removes
the empty group, while later stack deletion or replacement preserves externally
managed membership. It has no associated IAM role. After successful Apply, add
the owner user to this group in Cognito. Live authorization-code/PKCE/refresh and
actual ChatGPT interoperability remain pending until Apply and owner sign-in.

After approved Apply, check the deployed code checksum, public resource metadata,
anonymous 401 challenge and 14-day log retention. Those checks do not access notes
or establish a completed ChatGPT OAuth exchange. Complete the
[owner setup and connection checks](mcp-server.md#owner-setup-and-chatgpt-connection)
after activation. Keep passwords, MFA secrets and the app-client
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
With a structured `--cli-input-json` request, the IAM custom-policy simulator
evaluates the intended stage-tagging grant as allowed. The earlier invalid-policy
response came from CLI list-argument parsing, not the literal action. Simulation
does not establish which request context API Gateway supplies or whether the
live service honors the action; the Analyzer discrepancy remains unresolved.

After PR #23 merged, the next Plan failed before Apply: native early validation
reported that the retained function and Cognito resource server already exist.
It also skipped the log-group existence check because
`logs:DescribeIndexPolicies` was denied. The foundation must cover the native
log-group metadata reads described in [Permission scope](#permission-scope)
before recovery; do not treat
a skipped validation or an available import change set as proof that the
eventual read handler is authorized. No log policy, index or retention setting
is changed by the metadata permissions.

Inspect the current registry with `aws cloudformation describe-type --type
RESOURCE --type-name AWS::ApiGatewayV2::Stage --query Schema --output text` in
the deployment Region. Recheck this discrepancy when AWS changes the provider.

The stack rolled back to `UPDATE_ROLLBACK_COMPLETE`, retaining the eleven
successfully created runtime resources outside stack management. The failed
stage was not present in the subsequent `get-stages` inventory. The original
pool/domain and code bucket/policy remain managed. A plain CI rerun is unsafe:
the named function/log group and Cognito resource server already exist, and
artifact publication correctly refuses a function absent from the native
stack's template. Do not weaken that guard or clean up resources without an
approved physical-resource list.

The owner chose to review cleanup of the unused runtime and rebuild it, rather
than import the retained resources. The available eleven-resource import preview
must remain unexecuted. The original blanket `Retain` on reconstructible runtime
resources caused the orphaned state; the runtime deletion policies and tightly
scoped rollback permissions above prevent repeating that lifecycle mistake.

Use direct native AWS commands for this one-off recovery, with separate reviews:

1. Review and merge the complete correction. Prepare a fresh local-SSO IAM-only
   UPDATE from current main, including stage tagging, log metadata reads and
   deletion of only the named function/log group. The earlier stage-tagging-only
   plan is incomplete; keep it unexecuted. Review the concrete diff/change set
   and obtain approval before execution. CI cannot update this foundation.
2. Read fresh stack events and service inventories. Match the eleven orphaned
   resources to the failed operation and physical identifiers. Confirm the
   function digest and state, API children, client with OAuth disabled, empty
   callbacks/owner list, and original four managed resources. Do not export a
   client secret or read note/log-event bodies. Stop for an active stack update,
   unexpected identity/property, new use, or an ownership mismatch.
3. Present the exact cleanup list and effects for approval: managed-login
   branding, its app client, the `obsidian.notes` resource server, the HTTP API
   and its integration/three routes, the function and its invoke permission,
   and the named log group. API/function deletion removes their children; count
   those cascades once. The log-group deletion loses any remaining debug logs;
   metadata reporting zero stored bytes does not prove it contains no events.
   Rebuilding changes API URL, client ID and client secret. Exclude the user
   pool and users, domain, all three S3 buckets and objects, retention settings,
   and IAM resources. Selecting this recovery method is not deletion approval.
4. After the approved IAM update succeeds, execute only the separately approved
   cleanup using local SSO, rechecking the reviewed bindings immediately before
   each operation. Never delete the stack or introduce automatic cleanup. Stop
   on an unexpected response and inspect partial completion before continuing.
5. Verify the orphaned resources are absent and the original pool/domain and
   code bucket/policy remain managed with their original physical IDs. Verify
   termination protection and stable stack state. Rerun current-main `validate`
   for a fresh CI Plan; expect the twelve runtime additions with the reviewed
   deletion policies, no removal/replacement of existing resources. Review the
   complete Plan and approve production Apply separately. Do not rerun the old
   failed Apply job or approve the obsolete import preview.
6. Verify public metadata, anonymous MCP rejection, throttles, deployed checksum
   and 14-day log-event retention. The empty owner/callback lists must still deny
   note access and disable OAuth login. Real owner login remains a later check.

Source validation and IAM simulation do not prove that the service honors an
undocumented action or that cleanup, rollback or redeployment succeeds. Keep those limits visible
until the separately approved operations have completed. This recovery uses
native AWS commands, not a new deployment workflow or control plane.
