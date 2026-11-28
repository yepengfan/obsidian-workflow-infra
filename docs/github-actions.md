# GitHub Actions: automatic Plan, approval, Apply

The deployment path uses two workflows. `validate` checks pull requests
and main without AWS credentials. After a successful validation **push on main**,
`plan and apply`
automatically plans the exact verified commit, waits for the owner's native
GitHub environment approval, then applies those exact CloudFormation change sets.
There is no routine Run workflow action, operation input, ARN copy, or second
manual Apply trigger. First import is planned automatically too.

The user reviews and merges App-authored PRs and separately approves concrete
AWS changes. Repository changes alone do not execute the permission foundation,
import existing buckets, copy objects or activate lifecycle cleanup.
See the [`artifact retention` guide](artifact-retention.md) for the separate
maintenance workflow, preview mode and required activation approvals.

## What to review in CI

Open a `validate` run's Summary. It includes the synthesized storage and MCP
application definitions and GitHub OIDC / IAM diff against `config/empty-template.json`.
Download `cloudformation-review` for the full templates and diff files.
Artifacts are retained for seven days.

This is an **offline first-adoption preview**, not a live AWS plan or a diff
against the PR's base commit. The original note-bucket definitions are for
import, never replacement. The separate [code-storage stage](mcp-rollout.md#code-storage-stage) creates new
deployment storage only after approval. CI has only Contents read,
no AWS OIDC permission and no App private key. Type checking, lint, tests,
actionlint and dependency audit remain in Verify; see README for the known
moderate CDK-bundled dependency findings and the unpatched picomatch build finding.
`npm run audit:ci` audits runtime dependencies without exceptions, then audits
all dependencies with the single advisory exception in `audit-ci.jsonc`, expiring
2026-12-18 UTC. Other high/critical findings and every runtime high/critical
finding remain blocking; the allowed build advisory stays visible in logs.
For metadata search, review the additional vault metadata configuration,
regional Glue catalog, Athena workgroup and foundation grants. Check/import an
existing regional catalog before applying; see [activation](metadata-search.md#infrastructure-and-deployment-order).

## One-time foundation and GitHub environment setup

The permission foundation is `ObsidianGitHubTrust`, defined in
`infra/github-stack.ts`. It contains the native GitHub OIDC provider, PlanRole,
DeployRole, dedicated CloudFormation storage and MCP execution roles, and the
reserved Lambda runtime role, and proposed code-only retention role.
See [MCP permission scope](mcp-rollout.md#permission-scope)
for the application grants. `config/github.json` contains only the immutable
GitHub OIDC repository subject and IAM role names. Fixed application resource
names are defined once in `infra/mcp-resources.ts`; account and Region are in
`config/storage.json`. CDK and CI use the same role names. No role has a managed
policy attached.

The deployment workflow handles the infrastructure as one unit: one CDK app,
one synthesis, one combined Plan, and one native production approval/Apply.
`bin/infrastructure.ts` synthesizes storage, the MCP business stack and the IAM
foundation into `cdk.out`. Native stack IDs and scoped CloudFormation service
roles remain stable, so no existing resources need to move between stacks.
The foundation is part of the shared review preview; its permissions remain
outside CI deployment and require the approved local SSO procedure.
Before Plan creates any change set, `bin/check-foundation.sh` compares the
deployed foundation template with this commit's synthesized one and fails the
run if they differ, naming the differing resources. An application change
therefore never reaches production ahead of the IAM it needs. After a
foundation change merges, apply it with the procedure below, then re-run the
failed `plan and apply` run.
See [Cognito preflight](cognito-preflight.md) for discovery and authentication checks.

Follow the [staged rollout](mcp-rollout.md#review-and-deployment-order) for
configuration ownership, deployment prerequisites and stage advancement.
Prerequisite stages synthesize no code bundle and perform no S3 code upload or
Lambda checksum check. Plan requests only the resource types in that stage's
template, so publishing the identity export uses the existing pre-expansion role.
All stages preserve the Plan and Apply guards described below.

Before updating the IAM foundation for the MCP runtime permissions, publish the
existing `ObsidianMcp` application stack's native `ObsidianMcp:UserPoolArn`
CloudFormation export through the approved resource CI Plan/Apply. Resource
metadata makes the output update detectable without changing Cognito resource
properties; an UPDATE change set may have no resource actions. Only after that
export is published, synthesize and review the local SSO foundation UPDATE and
obtain owner approval of its concrete IAM change set before execution. The
foundation uses `Fn::ImportValue` for the exact pool ARN and fails closed if the
export is missing. The imported export cannot change while the foundation uses
it. Do not copy a deployed pool ID into GitHub configuration.
This export publication uses existing resource permissions; ordinary CI cannot
apply the IAM foundation or widen its own permissions.

All three stacks are asset-free. CDK generates the templates, and the AWS CLI sends
those templates directly to CloudFormation. They have no bootstrap-version SSM
parameter. **Do not run standard `cdk bootstrap` or `cdk deploy` for this setup.**
No CDKToolkit stack, staging bucket, ECR repository, or administrator execution
role is required. The AWS CLI does not need an assets publishing role.

Use the local `obsidian-admin` SSO session for the reviewed foundation only.
That caller must be allowed to manage this foundation's IAM/OIDC resources and
CloudFormation stack; full AdministratorAccess is not intrinsically required.
Its credentials are never uploaded to GitHub. CloudFormation uses the caller's
session for this foundation; it is not assigned a permanent administrator role.

The foundation already exists. From the reviewed, merged revision, create and
inspect an unexecuted foundation UPDATE plan (these commands create
CloudFormation metadata, not IAM resources). Only when setting up a new,
absent foundation, use `CREATE` and `stack-create-complete` instead of the
UPDATE type and waiter below.

```sh
AWS_PROFILE=obsidian-admin bash bin/production-config.sh
npx --no-install cdk synth ObsidianGitHubTrust \
  --app 'npx --no-install tsx bin/github.ts' --no-lookups \
  --output cdk.github.out --quiet
# CloudFormation limits an inline template body to 51,200 bytes. Upload the
# same JSON without whitespace; test/github.test.ts keeps it under that limit.
node -e 'const fs = require("fs"), f = "cdk.github.out/ObsidianGitHubTrust.template.json"; fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8"))))'
FOUNDATION_CHANGE_SET="obsidian-foundation-$(git rev-parse --short=12 HEAD)"
aws cloudformation create-change-set \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --change-set-type UPDATE --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://cdk.github.out/ObsidianGitHubTrust.template.json \
  --description "Reviewed foundation $(git rev-parse HEAD)" \
  --profile obsidian-admin
aws cloudformation wait change-set-create-complete \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --profile obsidian-admin
aws cloudformation describe-change-set \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --profile obsidian-admin
```

Only after the user confirms that actual plan and its IAM policies:

```sh
aws cloudformation execute-change-set \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --profile obsidian-admin
aws cloudformation wait stack-update-complete \
  --stack-name ObsidianGitHubTrust \
  --profile obsidian-admin
aws cloudformation update-termination-protection --enable-termination-protection \
  --stack-name ObsidianGitHubTrust \
  --profile obsidian-admin
aws cloudformation describe-stacks --stack-name ObsidianGitHubTrust \
  --query 'Stacks[0].Outputs' --profile obsidian-admin
```

Then re-run the `plan and apply` run for that commit if its foundation check
failed. The check passes once the executed template matches the commit's
synthesis.

Set the repository Actions secrets `AWS_ACCOUNT_ID` and `AWS_REGION` to the
production account number and region before enabling this revision. The jobs
use these values to configure AWS OIDC and resolve the regional role names.
After authentication they restore the pinned SSM values with
`bin/production-config.sh`. Plan and Apply can read the storage and app
parameters. Artifact retention reads only storage. Restore production settings
locally before synthesizing a foundation update. See the
[recovery commands](../README.md#recover-deployment-settings-on-another-computer).

If the previous standard-bootstrap preview still exists, delete its unexecuted
change set after verifying it was not executed; do not execute that
administrator-role proposal.

### Migrate the existing automatically named CI roles

This procedure applies only to installations still using generated CI role
names. The current foundation already uses the configured stable names.

The first foundation deployment created PlanRole and DeployRole with generated
names. Adopting the configured stable names replaces **those two IAM roles**.
Their policy attachments follow the replacements. The storage execution role,
OIDC provider, permission documents and existing S3 resources do not need changes.
Review the actual foundation diff before applying this migration. Avoid an
active Plan or Apply run during role replacement.

After the role-name migration PR is reviewed and merged, synthesize the exact
merged revision and follow the local SSO foundation UPDATE procedure above, including inspection,
user confirmation, execution and the completion waiter. Verify that PlanRoleArn / DeployRoleArn use
the configured names and that execution permissions have not broadened.

A main deployment that starts between the merge and the foundation update can
fail OIDC login because the new names do not exist yet. It must not fall back to
the old roles or a broader identity. Once the approved foundation update succeeds,
rerun `validate` for current main once; its completion automatically
starts the infrastructure Plan.
Review the import plan before production approval. No ARN copy, Repository
variable update, or extra configuration service is part of this migration.
Subsequent normal deployments remain automatic Plan, approval, automatic Apply.

### Permission scope and future changes

The storage execution role grants bucket metadata reads required by the native
`AWS::S3::Bucket` read handler and five writes on **only the two configured
bucket ARNs**: encryption, public-access blocks, ownership controls,
versioning, and lifecycle configuration. `ListBucket` supports HeadBucket and
can also enumerate keys; it does not grant object-body access. The role cannot
directly read/write/delete object bodies or versions, create/delete buckets,
manage IAM, or change bucket policies. Lifecycle permission is limited to the
same two bucket ARNs, but can indirectly cause permanent historical-version
deletion by S3. IAM does not constrain lifecycle rules to the
[selected retention policy](retention.md); the separate resource update
must encode that policy in the bucket template. No lifecycle rule is enabled by
the IAM-only permission update. Read actions follow the regional CloudFormation
registry schema checked on 2026-11-13, excluding its unrecognized
`GetBucketDefaultStorageClass` action (AWS Access Analyzer reports INVALID_ACTION;
that property is not modeled here). Granting every advertised create/update
handler permission would unnecessarily include object deletion and PassRole;
those permissions are deliberately absent.

After any prerequisite updates described above, permission expansion follows
a separate, infrequent path:

1. Open a Bot-authored PR changing the foundation policy to cover the intended
   IaC scope. Review the IAM diff and merge it yourself.
2. From that reviewed revision, use the local SSO session to synthesize the
   foundation and create an **UPDATE** change set as shown above. Review
   and approve it, execute it, then wait with `stack-update-complete`.
   Keep role names stable during ordinary permission updates; CI calculates
   the ARN from the same reviewed configuration.
3. Open the resource-change PR after that permission update has succeeded.
   CI can then Plan and, after production approval, Apply those resource changes.

Do not merge resource changes that require new permissions before step 2. If
permissions are missing, CI fails closed; it never falls back to SSO or an
administrator role and cannot update its own foundation. No extra CI permission
updater or long-lived AWS key is introduced. A future stack or resource type
also needs corresponding reviewed workflow/IAM scope changes: the shared
pipeline validates the original storage stack against the two buckets and a
reviewed later BucketPolicy, whose write permission must first be added here.
For the separate MCP execution role and its staged permission expansion, see
[the MCP rollout](mcp-rollout.md).

Configure repository Settings > Environments:

- `production-plan`: only the `main` branch; no manual reviewer gate.
- `production`: only `main`; Required reviewers must include repository owner
  `yepengfan`. This public repository supports native environment reviewers.
- If the owner initiates the upstream main push and is the sole approver, enabling
  Prevent self-review can prevent that owner from approving the deployment.
  Choose that option consistently with the actual approval participants.
- Disable administrator bypass if all deployments must use the reviewer gate.

The owner configured the production Required reviewer after the initial audit.
Workflow YAML alone does not create environment protection. Both Plan and Apply check for the
owner's reviewer rule before AWS authentication and stop if it is absent or
cannot be read. This addresses the observed missing-rule configuration; it is
not a substitute for the native environment approval itself.

`infra/github-stack.ts` defines native OIDC trust for the exact immutable
repository/environment subjects and `sts.amazonaws.com` audience. PlanRole can
create an unexecuted storage change set and pass its dedicated execution role.
Separate statements permit `ObsidianMcp` change sets with the dedicated MCP
role and the [reviewed application scope](mcp-rollout.md#permission-scope).
The [Plan](#one-infrastructure-plan) and [Apply](#one-approval-and-infrastructure-apply)
guards below define the shared resource boundary; expanding IAM alone does not
expand those script checks or deploy resources.
The storage execution role and its resource checks remain unchanged.
DeployRole can execute reviewed change sets but cannot create substitute plans
or pass roles. Neither GitHub role has direct GetObject, PutObject or DeleteObject
permissions on the note buckets.

## Automatic deployment run

`.github/workflows/plan-and-apply.yml` listens to successful completed `validate`
runs. The `plan` job accepts only pushes to main in this repository, checks out
the verified SHA, rejects a superseded revision, and requires the actual native
production reviewer rule before AWS authentication. The same checks protect
`apply`. PR and fork validation never starts this deployment path.

### One infrastructure Plan

The Plan job uses `production-plan` and the fixed Plan role. It synthesizes the
entire CDK app once for the reviewed stage, then runs `bin/plan-infrastructure.sh`.
Only the `runtime` stage builds a deterministic ZIP and source-bound SHA-256
manifest in `cdk.out`. No AWS code upload occurs during Plan:

1. Inspect actual state for both deployment stacks. Storage selects IMPORT only
   on an exact stack-not-found response or unexecuted `REVIEW_IN_PROGRESS`
   placeholder; stable storage must match the original two bucket physical IDs.
   Cognito stops on that same absence/placeholder condition; never silently
   recreate retained identity resources. A future new-account bootstrap requires
   separately reviewed authorization. Stable Cognito must contain the expected
   pool/domain logical IDs. Every live resource must match a logical ID and type
   in the emitted `ObsidianMcp` template; code-bucket/policy physical IDs and the
   runtime function name must match that model. For `runtime`, the code bucket
   and policy must already exist from the approved `code-storage` deployment.
   The `identity` and `code-storage` stages do not require that later prerequisite.
   Other errors and unsupported states fail the entire Plan.
2. Prepare native source-bound change sets for both stacks using their dedicated
   service roles and reviewed resource-type scopes. The IAM foundation is never
   included in this execution list. Plan creates metadata, not resources.
3. Publish a summary with the change-set names, actions and replacements, plus
   an artifact with account-independent change-set identifiers, the template
   digest and the exact runtime ZIP and digest manifest when applicable. Open
   the named change sets in the AWS console to review production values.
   A failed second plan prevents any Apply.

Only a recognized no-change UPDATE is tolerated as unchanged. Approval is
skipped only when **all** deployment stacks are unchanged; that path still
runs the [public discovery check](cognito-preflight.md#local-checks-and-post-deployment-discovery)
once. Artifact retention is seven days.

### One approval and infrastructure Apply

The `apply` job depends on the combined Plan and uses the native `production`
environment. Review both named change sets and their templates in AWS, then
use **Review deployments** to approve or reject once. Apply reconstructs the
manifest from the same run's artifact and verifies it against the Plan digest.
It synthesizes the pinned configuration locally to verify the original MCP
template digest. AWS executes the original change sets and the workflow uses
the original runtime ZIP.

`bin/apply-infrastructure.sh` verifies the manifest's source/repository/account/
Region, template-bound rollout stage and exact deployment stack set. It inspects **every changed native plan
before any code upload or stack execution**. Each must be available, bound to
the expected stack and source, and pass its existing resource checks: storage IMPORT is exactly Vault /
Library; storage UPDATE permits original bucket modifications or reviewed later
BucketPolicy changes. MCP accepts only UPDATE, compares the complete native
change-set template with the digest-verified template, and permits only
additions/modifications whose logical IDs and resource types match that model,
excluding IAM roles/policies. An UPDATE with no resource actions is allowed for
native metadata/output changes. Removals are rejected. There are two replacement
exceptions, each a `Modify` in `ObsidianMcp` with `Replacement` set to `True` or
`Conditional`:

- `NotesResourceServer` of type `AWS::Cognito::UserPoolResourceServer`: the
  reviewed template's identifier must equal its Lambda `MCP_RESOURCE` expression
  and its pool must remain `Ref: UserPool`. This lets a reviewed scope-registry
  migration bind custom scopes to the resource URL.
- `IndexReconcilePermission` of type `AWS::Lambda::Permission`, which holds no
  state: the reviewed template must still let only `events.amazonaws.com` invoke
  `IndexerFunction`, from the reviewed reconcile rule. This allows the one-time
  move of its `SourceArn` to a name-derived ARN.

All other replacements, including conditional replacements, stay blocked.

For a changed MCP stack in the `runtime` stage, Apply checks that live main still matches the verified
source and that the downloaded code manifest matches the combined plan. It
verifies the ZIP digest, size, source revision and template code key, then writes
`releases/<sha256>.zip` to the modeled private code bucket using AES256, SHA-256
and `If-None-Match: *`. A preexisting-key 412 is accepted only after checking
stored size, checksum and encryption; conflicts and other upload errors fail.
No overwrite or delete is attempted.
Publication also enforces the [artifact protection contract](artifact-retention.md#why-code-cleanup-needs-deployment-awareness).

Apply rechecks live main immediately before each execution, enables termination
protection, executes the exact approved ARN and waits for the correct import
or update completion. It preserves the bounded storage drift check and
verifies the changed Lambda's `CodeSha256`, `State` and `LastUpdateStatus` in the runtime stage, then
runs the [public discovery check](cognito-preflight.md#local-checks-and-post-deployment-discovery),
with propagation retries only if that stack changed. A discovery failure leaves
OAuth/private-note access disabled.

One approval coordinates the infrastructure; CloudFormation execution remains
per stack and is **not a transaction across stacks**. A later failure may leave
earlier stacks completed. The Apply summary records each successful stack;
inspect actual AWS stack/change-set status before retrying. Do not recreate
retained resources or blindly re-import. A fresh successful validation of current
main prepares a new combined plan against actual state.

Deployment and code cleanup use the [shared concurrency contract](artifact-retention.md#why-code-cleanup-needs-deployment-awareness).
Reject or cancel an older waiting run when main advances, so the latest revision
can plan. The live
main check rejects stale approvals/reruns. Ordinary CI never uses SSO, expands
its own permissions, or reads/writes note bodies.

## Recovery and successful adoption

An AWS operation may complete even if a later waiter or drift check fails.
Inspect stack and change-set status before retrying; do not blindly re-import.
Successful adoption requires IMPORT_COMPLETE, the original physical bucket IDs,
IN_SYNC modeled properties and read-only client access / sync-preview checks.
Drift does not inspect unmodeled properties or validate note contents. Do not
create canary notes or activate sync as an implicit test.

Keep bucket names, Region and logical IDs stable. Later configuration changes use
reviewed PRs and the same automatic Plan / approved Apply flow. See
[the retention procedure](retention.md) for policy status, historical-version
impact review and verification limits.

References: [IAM role names and replacement](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-role.html#cfn-iam-role-rolename),
[CloudFormation service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html),
[CDK synthesizer bootstrap checks](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.DefaultStackSynthesizerProps.html#generatebootstrapversionrule),
[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[environment approval](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[CloudFormation change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html).
