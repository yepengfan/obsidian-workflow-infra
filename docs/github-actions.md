# GitHub Actions and native storage import

This branch prepares adoption of the two existing buckets. No AWS resource has
been deployed or imported, and no object has been copied or deleted. The user
reviews and merges the App-authored PR, then reviews each concrete AWS plan.

## 1. CI on the PR

`.github/workflows/ci.yml` runs type checking, ESLint, unit tests, actionlint,
dependency audit and offline CDK synth on pull requests and main. It has only
Contents read, no AWS OIDC token and no App private key. The two templates and
native import mapping are available as a review artifact.

The audit fails on high/critical reports and displays the known CDK-bundled
moderate minimatch issue described in README. The separately installed
minimatch copy is overridden to its fixed version.

## 2. One-time AWS foundation, after separate review

`config/github.json` identifies the immutable repository subject, native
GitHub OIDC provider and bootstrap qualifier. `infra/github-stack.ts` defines
the OIDC trust and two separate roles:

- PlanRole, production-plan environment: reads bucket configuration and creates
  unexecuted change sets for ObsidianWorkflowStorage. It cannot execute them.
- DeployRole, production environment: executes reviewed change sets for that
  stack. It cannot create a substitute plan or assume bootstrap roles.
- Neither GitHub role can GetObject, PutObject or DeleteObject in the note
  buckets. There is no runtime note reader in this storage-only branch.

Both trust the exact immutable repository/environment OIDC subject and the
sts.amazonaws.com audience. Configure main-only deployment branches on both
GitHub environments. The repository's private GitHub plan currently does not
support required environment reviewers, so do not advertise a native reviewer
gate: execution uses explicit manual dispatch and the enable flag below.

The Sydney bootstrap SSM parameter is currently absent and the account has no
GitHub OIDC provider. A native CDK record-only attempt stopped at that missing
bootstrap prerequisite; it made no import or configuration change.

Preview the foundation without deploying:

```sh
npx --no-install cdk bootstrap --show-template > /tmp/obsidian-bootstrap.yaml
npx --no-install cdk diff ObsidianGitHubTrust \
  --app 'npx --no-install tsx bin/github.ts' \
  --template config/empty-template.json --no-lookups --output cdk.github.out
```

Review both the actual bootstrap template and GitHub trust diff with the user.
The standard bootstrap includes a CloudFormation execution role with
AdministratorAccess by default. This is a material foundation permission,
separate from the narrower GitHub roles. The PlanRole can pass only that fixed
role to CloudFormation, only for the configured storage stack and the S3
Bucket/BucketPolicy resource types. Do not silently deploy or broaden it.

Only after explicit confirmation, execute the reviewed foundation from the
local SSO session. The local `obsidian-admin` profile is not uploaded to CI.
Typical approved-session commands are:

```sh
npx --no-install cdk bootstrap aws://391824190072/ap-southeast-2 \
  --profile obsidian-admin
npx --no-install cdk deploy ObsidianGitHubTrust \
  --app 'npx --no-install tsx bin/github.ts' \
  --profile obsidian-admin --no-lookups --require-approval broadening \
  --outputs-file cdk-outputs-github.json
```

Set repository/environment variables from the actual stack outputs:
`AWS_PLAN_ROLE_ARN` and `AWS_DEPLOY_ROLE_ARN`. Keep `ENABLE_AWS_APPLY` unset
until the user is ready to execute a reviewed plan. No static AWS key is needed.
No GitHub App key is used in AWS jobs.

## 3. Plan without executing bucket changes

After the PR is merged, manually run **Plan storage change set** on main:
choose `import` for first adoption, `update` only for later reviewed changes.

The job validates and synthesizes the storage code before obtaining AWS OIDC
credentials. It then calls native CloudFormation CreateChangeSet with IMPORT
and `config/import-resources.json`, or UPDATE for later changes. This creates
plan metadata, and may create an empty REVIEW_IN_PROGRESS stack placeholder.
It does not execute the plan or alter bucket configuration.

The native change set holds the exact template. Its description binds the
repository ID, full commit SHA and operation; the summary shows the immutable
ChangeSet ARN. Review the resource actions, physical bucket identifiers and
artifact. For initial adoption require exactly Vault and Library Import actions
for the original buckets. No BucketPolicy, lifecycle, IAM or object operation
belongs in that first import.

`config/import-resources.json` is CloudFormation's `--resources-to-import`
format, not CDK's separate resource-mapping format. No custom import controller
is used. CDK's ordinary diff adds two resource *definitions* relative to an
empty stack; that is not permission to create two new physical buckets.
The native IMPORT change set is the concrete execution plan.

## 4. Apply only the exact plan the user approved

After the user reviews and confirms that AWS plan, enable `ENABLE_AWS_APPLY=true`
and manually run **Apply storage change set** on main. Enter the exact reviewed
ChangeSet ARN, matching operation and `execute` confirmation.

The job requires an available, unexecuted change set for the expected stack,
repository and current full main SHA. If main advanced, make a fresh plan.
Initial import is restricted to the two expected bucket logical IDs. Updates
reject removals, replacements, new buckets and non-S3 resource types; adding
an S3 BucketPolicy is allowed for a later reviewed HTTPS policy.

The job executes the existing ARN. It never re-synthesizes or regenerates a
template after review. Plan and Apply share a non-cancelling concurrency group.
Execution then waits for completion, enables stack termination protection and
checks modeled resource drift with a bounded native API poll.

An AWS operation may finish even if a job later fails during drift verification.
Inspect actual stack/change-set status before retrying; do not blindly re-import.
Only IMPORT_COMPLETE, original physical IDs, IN_SYNC modeled properties and
read-only client/sync-preview verification establish successful adoption.
Drift does not inspect unmodeled properties or validate note contents.

Normal configuration updates use the same Plan/Apply flow with `update`.
Bucket names, Region and logical IDs must stay stable; changing them requires
a separately designed migration.

## 5. Post-import improvements are separate

Library versioning, HTTPS-only policy and the selected 90-day historical
retention are not enabled by the baseline. See
[the post-import plan](post-import-plan.md). Complete the historical-impact
review before activating expiry; it can permanently delete eligible old
versions. Retain does not stop lifecycle deletion.

Keep the source notes, original sync client configuration and existing history
untouched during import. Do not create canary notes or turn on synchronization
as an implicit test. Resume MCP/Cognito design after storage adoption.

References: [CDK import](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-import.html),
[CloudFormation manual import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/import-resources-manually.html),
[CloudFormation IAM conditions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudformation.html).
