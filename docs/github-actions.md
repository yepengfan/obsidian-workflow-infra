# GitHub Actions: automatic Plan, approval, Apply

The repository uses two workflows. `Validate infrastructure` checks pull requests
and main without AWS credentials. After a successful validation **push on main**,
`Plan and deploy S3 storage`
automatically plans the exact verified commit, waits for the owner's native
GitHub environment approval, then applies that same CloudFormation change set.
There is no routine Run workflow action, operation input, ARN copy, or second
manual Apply trigger. First import is planned automatically too.

The user reviews and merges App-authored PRs and separately approves concrete
AWS changes. Repository changes alone do not execute the permission foundation,
import existing buckets, copy objects or activate lifecycle cleanup.

## What to review in CI

Open a `Validate infrastructure` run's Summary. It includes the synthesized storage definitions and
GitHub OIDC / IAM diff against `config/empty-template.json`, including the
dedicated storage execution role and its bucket-scoped policy. Download `cloudformation-review` for the full templates and diff files.
Artifacts are retained for seven days.

This is an **offline first-adoption preview**, not a live AWS plan or a diff
against the PR's base commit. Added bucket definitions mean definitions to
import, not permission to create replacement buckets. CI has only Contents read,
no AWS OIDC permission and no App private key. Type checking, lint, tests,
actionlint and dependency audit remain in Verify; see README for the known
moderate CDK-bundled dependency findings.

## One-time foundation and GitHub environment setup

The permission foundation is `ObsidianGitHubTrust`, defined in
`infra/github-stack.ts`. It contains the native GitHub OIDC provider, PlanRole,
DeployRole, and a dedicated CloudFormation storage execution role. All three
role names are versioned in `config/github.json`; account and Region are in
`config/storage.json`. CDK and CI use the same role names. No role has a managed
policy attached.

Both stacks are asset-free. CDK generates the templates, and the AWS CLI sends
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
npx --no-install cdk synth ObsidianGitHubTrust \
  --app 'npx --no-install tsx bin/github.ts' --no-lookups \
  --output cdk.github.out --quiet
FOUNDATION_CHANGE_SET="obsidian-foundation-$(git rev-parse --short=12 HEAD)"
aws cloudformation create-change-set \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --change-set-type UPDATE --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://cdk.github.out/ObsidianGitHubTrust.template.json \
  --description "Reviewed foundation $(git rev-parse HEAD)" \
  --profile obsidian-admin --region ap-southeast-2
aws cloudformation wait change-set-create-complete \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --profile obsidian-admin --region ap-southeast-2
aws cloudformation describe-change-set \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --profile obsidian-admin --region ap-southeast-2
```

Only after the user confirms that actual plan and its IAM policies:

```sh
aws cloudformation execute-change-set \
  --stack-name ObsidianGitHubTrust --change-set-name "$FOUNDATION_CHANGE_SET" \
  --profile obsidian-admin --region ap-southeast-2
aws cloudformation wait stack-update-complete \
  --stack-name ObsidianGitHubTrust \
  --profile obsidian-admin --region ap-southeast-2
aws cloudformation update-termination-protection --enable-termination-protection \
  --stack-name ObsidianGitHubTrust \
  --profile obsidian-admin --region ap-southeast-2
aws cloudformation describe-stacks --stack-name ObsidianGitHubTrust \
  --query 'Stacks[0].Outputs' --profile obsidian-admin --region ap-southeast-2
```

No AWS Repository variables or AWS static-key Secrets are required. Plan and
Apply calculate their own role ARN from the versioned account and the respective
`planRoleName` / `deployRoleName`. CloudFormation outputs are diagnostic values,
not values to copy into GitHub settings. The storage execution role uses the
same `executionRoleName` declared by CDK. Do not introduce a discovery role,
SSM parameter mirror, or credentials just to look up these predictable ARNs.

If the previous standard-bootstrap preview still exists, delete its unexecuted
change set after verifying it was not executed; do not execute that
administrator-role proposal.

### Migrate the existing automatically named CI roles

The first foundation deployment created PlanRole and DeployRole with generated
names. Adopting the configured stable names replaces **those two IAM roles**.
Their policy attachments follow the replacements. The storage execution role,
OIDC provider, permission documents and existing S3 resources do not need changes.
Review the actual foundation diff before applying this migration. Avoid an
active Plan or Apply run during role replacement.

After this PR is reviewed and merged, synthesize the exact merged revision and
follow the local SSO foundation UPDATE procedure above, including inspection,
user confirmation, execution and the completion waiter. Verify that PlanRoleArn / DeployRoleArn use
the configured names and that execution permissions have not broadened.

A main deployment that starts between the merge and the foundation update can
fail OIDC login because the new names do not exist yet. It must not fall back to
the old roles or a broader identity. Once the approved foundation update succeeds,
rerun the current main CI once; its completion automatically starts storage Plan.
Review the import plan before production approval. No ARN copy, Repository
variable update, or extra configuration service is part of this migration.
Subsequent normal deployments remain automatic Plan, approval, automatic Apply.

### Permission scope and future changes

The execution role grants bucket metadata reads required by the native
`AWS::S3::Bucket` read handler and five writes on **only the two configured
bucket ARNs**: encryption, public-access blocks, ownership controls,
versioning, and lifecycle configuration. `ListBucket` supports HeadBucket and
can also enumerate keys; it does not grant object-body access. The role cannot
directly read/write/delete object bodies or versions, create/delete buckets,
manage IAM, or change bucket policies. Lifecycle permission is limited to the
same two bucket ARNs, but can indirectly cause permanent historical-version
deletion by S3. IAM does not constrain lifecycle rules to the
[selected retention policy](post-import-plan.md); the separate resource update
must encode that policy in the bucket template. No lifecycle rule is enabled by
the IAM-only permission update. Read actions follow the Sydney CloudFormation
registry schema checked on 2026-11-13, excluding its unrecognized
`GetBucketDefaultStorageClass` action (AWS Access Analyzer reports INVALID_ACTION;
that property is not modeled here). Granting every advertised create/update
handler permission would unnecessarily include object deletion and PassRole;
those permissions are deliberately absent.

Permission changes follow a separate, infrequent path:

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
also needs corresponding reviewed workflow/IAM scope changes: the current
storage workflow intentionally accepts only the original two buckets and a
reviewed later BucketPolicy, whose write permission must first be added here.
Future Lambda/MCP deployment should have its own scoped execution role rather
than giving this storage role unrelated service access.

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
create an unexecuted change set and pass only the dedicated storage execution role.
DeployRole can execute reviewed change sets but cannot create substitute plans
or pass roles. Neither GitHub role has direct GetObject, PutObject or DeleteObject
permissions on the note buckets.

## Automatic deployment run

`deploy-storage.yml` listens to successful completed `Validate infrastructure` runs. It accepts only
pushes to main in this repository, never PR or fork runs. It checks out the
upstream run's exact `head_sha`, rejects a superseded main revision before AWS
authentication, and binds that SHA into the native change-set description.
It does not download or execute artifacts from untrusted PR runs.

### Plan

The Plan job uses the unapproved `production-plan` environment and PlanRole:

1. Synthesize storage from the verified commit.
2. Read actual `ObsidianWorkflowStorage` state. An exact stack-not-found response
   or an unexecuted `REVIEW_IN_PROGRESS` placeholder selects IMPORT. A stable
   imported/created/updated stack selects UPDATE only after its two bucket
   physical IDs match the versioned import mapping. Unsupported states,
   permission failures and network errors stop; they never default to import.
3. Create an unexecuted native CloudFormation change set. IMPORT passes
   `config/import-resources.json`; no object copying or note reads are involved.
4. Publish account, region, stack, full SHA, operation, ARN, resource actions,
   replacement indicators and original bucket mapping in the job Summary.
   Full plan/template/mapping are attached to this run's artifact.

A no-change UPDATE is reported without requesting approval or running Apply.
Other change-set creation failures fail the run. Plan creates metadata and may
create an empty stack placeholder; it does not execute changes to bucket
configuration. An IMPORT plan must contain only the two original buckets.
Library versioning, policies and lifecycle changes remain separate updates.

### Approval and Apply

For a plan with changes, Apply depends on Plan and references `production`.
GitHub waits for Required reviewers before starting that job. In the deployment
run, read the **Plan** Summary/artifact, then use **Review deployments** to
approve or reject. Approval starts Apply automatically; no ARN needs copying.

Apply receives the exact ARN and operation through job outputs. It checks the
native plan's available status, stack, repository, verified SHA and allowed
resource actions. IMPORT is exactly Vault / Library; UPDATE rejects removals,
replacements, new buckets and non-S3 resources, while permitting a later reviewed
BucketPolicy addition. Immediately before execution it queries live main again,
rejecting a superseded commit even on a rerun. It executes that ARN without
resynthesizing, waits for AWS completion, enables termination protection, and
checks modeled resource drift with a bounded poll.

The workflow concurrency group does not interrupt an in-flight deployment.
A newer main can queue while an old run awaits approval: reject or cancel the
superseded waiting run so the current one can plan. Approving an old run cannot
bypass the live-main check. If a deployment needs replanning, rerun CI for the
current main commit; successful CI completion automatically triggers deployment.
An old CI rerun is rejected if main advanced.

## Recovery and successful adoption

An AWS operation may complete even if a later waiter or drift check fails.
Inspect stack and change-set status before retrying; do not blindly re-import.
Successful adoption requires IMPORT_COMPLETE, the original physical bucket IDs,
IN_SYNC modeled properties and read-only client access / sync-preview checks.
Drift does not inspect unmodeled properties or validate note contents. Do not
create canary notes or activate sync as an implicit test.

Keep bucket names, Region and logical IDs stable. Later configuration changes use
reviewed PRs and the same automatic Plan / approved Apply flow. See
[the post-import plan](post-import-plan.md) for the selected, not-yet-enabled
historical retention policy and its separate impact review.

References: [IAM role names and replacement](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-role.html#cfn-iam-role-rolename),
[CloudFormation service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html),
[CDK synthesizer bootstrap checks](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.DefaultStackSynthesizerProps.html#generatebootstrapversionrule),
[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[environment approval](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[CloudFormation change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html).
